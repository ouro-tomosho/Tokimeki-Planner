// 求解接口：异步、带预算与协作式取消。
//
// 契约（见 .scratch/checkpoint-refactor/contracts.md 第 7 节）：
//   createSolver(rules, options) → async solve(input, { budgetMs, shouldStop })
//   → { assignments: { weekCommands, dayCommands }, metrics }
//
// `shouldStop()` 为真时立刻返回当前最优解并置 `metrics.cancelled = true`，不抛错。
//
// **搜索与汇报分离**（本项目最贵的一条教训）：
//   · 搜索（`descent.js`）用与 `apply()` 同口径的瘦重放评价，负责"找解"；
//   · 对外指标**一律**由 `plan()` 复核后给出——`goals.ok` / `goals.valid` /
//     `hardViolations` / `clubWeekViolations` / 逐条缺口。搜索层自评的数字只是排序用，
//     绝不作为结论。这样就不存在"工具说达标、重放对不上"的两套口径。

import { runDescent } from './descent.js';
import { createPlanner } from './plan.js';
import { commonSuccessRate, withSuccessRate } from './rules.js';

/** 可以由调用方指定的搜索工作量参数（其余一律交给 `descent.js` 的预算档位决定）。 */
const WORK_OPTION_KEYS = ['passes', 'ils', 'kick', 'seed', 'repairFirst', 'repairLast', 'gatesWeight', 'repairWeight', 'validityWeight', 'warmStart'];

/** 主线程降级路径的默认预算：必须短到界面还能响应取消。 */
export const MAIN_THREAD_BUDGET_MS = 5000;

/** Worker 路径的默认预算。 */
export const WORKER_BUDGET_MS = 30000;

export function createSolver(rules, options = {}) {
  const budgetMs = options.budgetMs ?? WORKER_BUDGET_MS;
  const plan = createPlanner(rules);

  return async function solve(input, runOptions = {}) {
    const shouldStop = runOptions.shouldStop ?? (() => false);
    const startedAt = Date.now();

    // 成功率覆盖：搜索与复核必须用**同一份**有效规则（见 rules.js 的 withSuccessRate）。
    const effective = withSuccessRate(rules, input.successRate);

    // **只转发调用方显式给出的工作量**：不在这里补默认值，否则会把 `descent.js` 按预算
    // 挑好的固定档位（见 `workProfileFor`）覆盖掉——实测那样会让 5 s 的主线程档跑成
    // 默认档，正好卡在预算上被墙钟切断。
    const searchOptions = { shouldStop, budgetMs: runOptions.budgetMs ?? budgetMs };
    for (const key of WORK_OPTION_KEYS) {
      const value = runOptions[key] ?? options[key];
      if (value !== undefined) searchOptions[key] = value;
    }
    const search = runDescent(effective, input, searchOptions);

    // 官方口径复核：同一个 plan()，界面与测试看到的是同一份判定。
    const verified = plan(input, { assignments: search.assignments });
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

    await Promise.resolve(); // 让出事件循环，界面上的取消按钮才真的可点

    return {
      assignments: search.assignments,
      metrics: {
        ...search.metrics,
        // 本次求解实际使用的成功率（缺省 = 规则常量）。
        successRate: input.successRate ?? commonSuccessRate(rules),
        elapsedMs: Date.now() - startedAt,
        cancelled: search.metrics.cancelled || shouldStop(),
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
//
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
  const solve = createSolver(rules, { budgetMs, passes: options.passes, ils: options.ils });
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
