// 求解接口：**构造式启发式**找解，`plan()` 判定。
//
// 契约：`createSolver(rules, options) → async solve(input, { budgetMs, shouldStop })`
//   → `{ assignments: { weekCommands, dayCommands }, metrics }`
//
// 流程：
//
//   输入 → 有效规则（成功率覆盖） → 启发式搜索（唯一求解器） → `plan()` 用真实引擎复核 → 指标
//
// 为什么只有启发式（所有者 2026-10-09 裁决，见 ADR-0009）：
//
//   精确求解（HiGHS MILP，按 8 周块严格滚动）曾经与启发式**并列产出候选**，由 `plan()` 取优。
//   但实测它**从来没有赢过**：默认输入 8/9 结局（启发式 9/9）、35% 成功率 4/9（启发式 7/9）、
//   放松结局目标时它守住全局约束的能力也与启发式相同或更差。而它代价极高——内联的 WASM
//   占产物 94%（5.18 MB 里的 4.88 MB），块与块的滚动还丢掉了跨期的容量分配。
//   所以在启发式的评价口径补齐"全局约束优先"之后，精确求解整个被移除。
//
// 三条不可让步的纪律：
//
//   ① **对外结论一律来自 `plan()`**，不来自搜索层自评（ADR-0007：排布器对体面负责，
//      判定器对真实语义负责）。
//   ② **搜索与复核必须用同一份有效规则**（`withSuccessRate`）：否则搜索按 35% 找解、
//      判定按 70% 复核，两边不在同一个世界里（开发期实测踩过）。
//   ③ **无兜底**：求解抛错就抛中文错误，由界面现有的错误面显示
//      （`web/worker.js` 的 catch → `web/app.js` 的「求解失败：…」）。

import { runDescent } from './descent.js';
import { createPlanner } from './plan.js';
import { commonSuccessRate, withSuccessRate } from './rules.js';

/** 主线程降级路径的默认预算：必须短到界面还能响应取消。 */
export const MAIN_THREAD_BUDGET_MS = 5000;

/** Worker 路径的默认预算（所有者 2026-10-08：30 s → 60 s）。 */
export const WORKER_BUDGET_MS = 60000;

export function createSolver(rules, options = {}) {
  const defaultBudgetMs = options.budgetMs ?? WORKER_BUDGET_MS;
  const plan = createPlanner(rules);

  return async function solve(input, runOptions = {}) {
    const startedAt = Date.now();
    const budgetMs = runOptions.budgetMs ?? defaultBudgetMs;
    const shouldStop = runOptions.shouldStop ?? (() => false);

    // 成功率覆盖：搜索与复核必须用**同一份**有效规则（见 rules.js 的 withSuccessRate）。
    const effective = withSuccessRate(rules, input.successRate);

    const search = await runDescent(effective, input, { shouldStop, budgetMs });
    const { assignments, metrics: searchMetrics } = search;

    // 让出一次事件循环：Worker 才有机会处理已经到达的取消消息（消息事件是宏任务）。
    await Promise.resolve();

    // 官方口径复核：同一个 `plan()`，界面与测试看到的是同一份判定。
    const verified = plan(input, { assignments });
    const goals = verified.ok ? verified.goals : null;
    const gated = goals ? goals.gated : [];
    const unmet = goals
      ? goals.items
          .filter((item) => item.gate !== false && item.state !== 'met')
          .map((item) => ({
            id: item.id,
            attribute: item.attribute,
            attributes: item.attributes,
            actual: item.actual,
            op: item.op,
            value: item.value,
            shortfall: item.shortfall,
            state: item.state,
          }))
      : [];

    return {
      assignments,
      metrics: {
        solver: 'descent-heuristic',
        seed: searchMetrics.seed,
        // 搜索层自评与工作量（**只作诊断**，不作为对外结论）。
        search: searchMetrics,
        // 本次求解实际使用的成功率（缺省 = 规则常量）。
        successRate: input.successRate ?? commonSuccessRate(rules),
        elapsedMs: Date.now() - startedAt,
        cancelled: searchMetrics.cancelled,
        // `incomplete` = 只有被取消、或预算小到没启动搜索时才为真。
        incomplete: searchMetrics.cancelled,
        // ---- 对外结论（全部来自 plan() 复核）----
        planned: verified.ok === true,
        goalsOk: goals ? goals.ok : false,
        goalsValid: goals ? goals.valid : false,
        gatesMet: gated.filter((item) => item.state === 'met').length,
        gatesTotal: gated.length,
        hardViolations: goals ? goals.hardViolations : null,
        clubWeekViolations: goals ? goals.clubWeekViolations : null,
        unmet,
      },
    };
  };
}

// ---------------------------------------------------------------- 成功率建议

// 所有者的要求：目标在真实成功率下做不到时，要能给出一条**可执行的建议**——
// "把成功率放宽到多少就能同时满足 ok 与 valid"。这就是把开发期那条阶梯做成可调用的。
//
// 它是**构造性证据**（找到一份 ok+valid 的日程），不是可行性证明；找不到时如实报
// `found: false`，绝不推荐一个没有验证过的数字。

/** 默认阶梯：所有者口径（35% 出厂 → 40% 起按 10% 上调 → 上限 90%）。 */
export const SUGGEST_LADDER = [0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/**
 * 逐档试算，返回**最低**的"能同时满足 ok 与 valid"的成功率。
 *
 * @returns `{ rate, found, trials }`，`trials` 是每一档的读数（达标数 / ok / valid / 硬违反）。
 */
export async function suggestSuccessRate(rules, input, options = {}) {
  const ladder = options.ladder ?? SUGGEST_LADDER;
  const budgetMs = options.budgetMs ?? 8000;
  const shouldStop = options.shouldStop ?? (() => false);
  const solve = createSolver(rules, { budgetMs });
  const trials = [];
  for (const rate of ladder) {
    if (shouldStop()) return { rate: null, found: false, trials, cancelled: true };
    const { metrics } = await solve({ ...input, successRate: rate }, { budgetMs, shouldStop });
    trials.push({
      successRate: rate,
      gatesMet: metrics.gatesMet,
      gatesTotal: metrics.gatesTotal,
      ok: metrics.goalsOk,
      valid: metrics.goalsValid,
      hardViolations: metrics.hardViolations,
    });
    if (metrics.goalsOk && metrics.goalsValid) return { rate, found: true, trials, cancelled: false };
  }
  return { rate: null, found: false, trials, cancelled: false };
}
