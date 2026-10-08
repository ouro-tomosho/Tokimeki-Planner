// 求解接口：**三片固定分片 + 严格滚动 + HiGHS 精确 MILP**。
//
// 契约：`createSolver(rules, options) → async solve(input, { budgetMs, shouldStop })`
//   → `{ assignments: { weekCommands, dayCommands }, metrics }`
//
// 流程（所有者 2026-10-08 的裁决，见 ADR-0009）：
//
//   输入 → 日历 → 固定片界（52 / 52 / 48 周，从时间轴起点算起）
//        → 逐片：建模 → HiGHS 求这一片 → **逐日重放闸门** → 冻结这一片的指令 → 状态前推
//        → 最后一片之后：`plan()` 用真实引擎复核，指标一律以它为准
//
// 三条不可让步的纪律：
//
//   ① **模型可行 ≠ 真实可行**（ADR-0008）：每一片的解都要用 `settlement.apply()` 逐日重放，
//      与模型声明的属性值逐条比对（< 1e-6）。不过闸就报错，绝不静默降级。
//   ② **对外结论一律来自 `plan()`**，不来自搜索层自评。搜索层只负责找解。
//   ③ **无兜底**：HiGHS 不可用、某片不可行、重放对不上——一律抛出中文错误，由界面现有
//      的错误面显示（`web/worker.js` 的 catch → `web/app.js` 的「求解失败：…」）。

import { buildCalendar, resolveCommand } from './calendar.js';
import { interpolatedTargets, planChunks } from './chunks.js';
import { addDays } from './dates.js';
import { getHighs } from './highs.js';
import { buildChunkModel, extractAssignments, modelAchieved, modelState } from './milp.js';
import { createPlanner } from './plan.js';
import { commonSuccessRate, withSuccessRate } from './rules.js';
import { apply, REST_DAY, WEEKDAY } from './settlement.js';

/** 主线程降级路径的默认预算：必须短到界面还能响应取消。 */
export const MAIN_THREAD_BUDGET_MS = 5000;

/** Worker 路径的默认预算（所有者 2026-10-08：30 s → 60 s，换取更强的精确求解）。 */
export const WORKER_BUDGET_MS = 60000;

/** 单片至少给这么多预算，免得把时间切到连可行解都找不到。 */
const MIN_CHUNK_MS = 1000;

/**
 * 每次 MILP 求解的**内部滚动块**长度（自然周）。
 *
 * 为什么不是直接用 52 周的片去建模：实测 52 周（约 4700 个 0-1 变量）在这台机器上
 * **连一个可行解都找不到**（60 s，各种 presolve/启发式档位都试过），而 8 周（约 475 个
 * 0-1 变量）能在 1.1 s 内**证明最优**。片是所有者定的**结构与优先级单位**，块只是它的
 * 内部求解粒度；两者的关系是"一片 = 若干个块"，块的界永远落在片的界上。
 *
 * 块目标沿用**同一条插值线**，只是在更多判定日上取点：块尾越靠后，要求越高，
 * 最后一块的块尾就是片尾（最后一个块的块尾就是时间轴终点，目标恰为结局阈值）。
 */
export const SOLVE_BLOCK_WEEKS = 8;

/** 固定随机种子：同一输入在同一时间路径下结果稳定（不是可复现性承诺，见 README）。 */
const SEED = 20261008;

/** 重放闸门的容差：模型声明值与真实引擎逐日结算值必须一致到这个量级。 */
const REPLAY_TOLERANCE = 1e-6;

// ---------------------------------------------------------------- 目标构造

const namesOf = (checkpoint) =>
  checkpoint.attributes ?? (checkpoint.attribute ? [checkpoint.attribute] : []);

function actualOf(checkpoint, attributes) {
  return namesOf(checkpoint).reduce((sum, id) => sum + (attributes[id] ?? 0), 0);
}

function meets(checkpoint, actual) {
  return checkpoint.op === '>=' ? actual >= checkpoint.value : actual < checkpoint.value;
}

/**
 * 本片要判定的目标。
 *
 *   片目标：7 项插值目标（`chunks.js` 已按判定日取好值），落在片尾最后一个结算日。
 *   小目标：落点在片内的，以 `kind: 'mini'` 进入更高一层权重；判定基数是属性集合求和，
 *           基准日是"落点前一天的结算值"。
 *   结局目标：**只补片目标没覆盖的那几项**（默认就是体力与压力）。它们的中间插值被排除
 *           （线性插值用在上限方向会造出向上的斜线），但结局阈值本身必须保留——所有者明确。
 *
 * `day` 是"在本片 days 数组里的下标"：小目标的落点可能落在片的中间，不能用片尾代替。
 */
export function buildTargets({ rules, input, block, days, dayIndexByDate, lastSettledBefore }) {
  const targets = [];
  const covered = new Set();

  for (const target of interpolatedTargets(rules, input, block.landingDate)) {
    if (target.terms.length === 1) covered.add(target.terms[0].attribute);
    targets.push({
      key: `${target.key}@${block.endDate}`,
      // 小目标的"进度目标"仍然属于小目标层（权重更高），不因它被插值就降级。
      kind: target.kind === 'mini' ? 'mini' : 'target',
      day: days.length - 1,
      terms: target.terms,
      op: '>=',
      value: target.value,
    });
  }

  for (const checkpoint of input.checkpoints) {
    if (checkpoint.source === 'global') continue;
    const judged = lastSettledBefore(checkpoint.date);
    if (judged === null || judged < block.startDate || judged > block.endDate) continue;
    const day = dayIndexByDate.get(judged);
    if (day === undefined) continue;
    const names = namesOf(checkpoint);
    if (names.length === 0) continue;
    // 单属性结局目标若已被块目标覆盖就不重复加（最后一块的 7 项正是结局阈值本身）。
    if (checkpoint.source === 'ending' && names.length === 1 && covered.has(names[0])) continue;

    targets.push({
      key: checkpoint.id,
      kind: checkpoint.source === 'mini' ? 'mini' : 'target',
      day,
      terms: names.map((attribute) => ({ attribute, coefficient: 1 })),
      op: checkpoint.op,
      value: checkpoint.value,
    });
  }

  return targets;
}

// ---------------------------------------------------------------- 重放与闸门

/**
 * 用**真实引擎**逐日重放本片的指令，返回每一天结算后的属性。
 *
 * 口径必须与 `plan()` 完全一致：同一份 `resolveCommand`（使用者钉住的优先，其次求解器的
 * 选择）。这是把"模型说可行"翻译成"真实引擎说可行"的唯一入口。
 */
function replayChunk({ rules, input, days, incoming, assignments }) {
  let state = { attributes: { ...incoming } };
  const trajectory = [];
  for (const day of days) {
    const resolved = resolveCommand(input, assignments, day);
    if (resolved.commandId) {
      state = apply(rules, state, resolved.commandId, day.isRestDay ? REST_DAY : WEEKDAY, day);
    }
    trajectory.push({ ...state.attributes });
  }
  return trajectory;
}

/** 重放闸门：模型声明的 v 必须与真实引擎逐日一致（ADR-0008 的硬门槛）。 */
function assertModelMatchesEngine({ model, columns, trajectory }) {
  const declared = modelState(model, columns);
  let worst = 0;
  let where = null;
  for (let t = 0; t < trajectory.length; t += 1) {
    for (const id of model.ids) {
      const diff = Math.abs(declared(t, id) - trajectory[t][id]);
      if (diff > worst) {
        worst = diff;
        where = `第 ${t + 1} 天 ${id}`;
      }
    }
  }
  if (worst > REPLAY_TOLERANCE) {
    throw new Error(
      `求解缺陷：模型声明的属性值与真实引擎重放不一致（最大偏差 ${worst.toExponential(3)}，@ ${where}）。` +
        '按 ADR-0008 的纪律，这份结果不可信，已丢弃。',
    );
  }
  return worst;
}

// ---------------------------------------------------------------- 单片求解

/** 调 HiGHS 解一片，并把"没有可行解"与"模型畸形"如实分开报。 */
function solveChunkModel(highs, model, timeLimitMs, context = '') {
  const result = highs.solve(model.lp, {
    output_flag: false,
    time_limit: Math.max(0.05, timeLimitMs / 1000),
    // 要求真正的最优：否则 HiGHS 会在 1e-4 的相对间隙上就宣称 Optimal，而那可能正好
    // 抹掉一层优先级。到点没证完就用当前最好解（所有者接受非最优）。
    mip_rel_gap: 0,
    random_seed: SEED,
    presolve: 'on',
  });

  const status = result?.Status ?? 'Unknown';
  if (status === 'Empty') {
    throw new Error('求解缺陷：HiGHS 把模型读成了空模型（LP 文本畸形）——这是代码问题，不是数据问题。');
  }
  if (status === 'Unbounded') {
    throw new Error('求解缺陷：模型无界——这是代码问题，不是数据问题。');
  }
  if (status === 'Infeasible' || status === 'Primal infeasible or unbounded') {
    throw new Error(
      `这一片没有可行日程（${context}）：硬约束互相冲突。` +
        '按「先达成者先硬化」，全局约束一旦达成便不得跌破；如果这一片（含集训周的强制指令）' +
        '无法维持它，就是真的不可行。也请检查是否把某些周或日钉成了互相冲突的指令。',
    );
  }
  if (!result?.Columns || !Number.isFinite(result.ObjectiveValue)) {
    throw new Error(
      `这一片在 ${(timeLimitMs / 1000).toFixed(1)} s 预算内没有找到可行日程` +
        `（${context}，HiGHS 状态：${status}）。请重试，或放宽目标。`,
    );
  }
  return result;
}

// ---------------------------------------------------------------- 求解器

export function createSolver(rules, options = {}) {
  const defaultBudgetMs = options.budgetMs ?? WORKER_BUDGET_MS;
  const plan = createPlanner(rules);

  return async function solve(input, runOptions = {}) {
    const shouldStop = runOptions.shouldStop ?? (() => false);
    const budgetMs = runOptions.budgetMs ?? defaultBudgetMs;
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;

    // 成功率覆盖：建模与复核必须用**同一份**有效规则（见 rules.js 的 withSuccessRate）。
    const effective = withSuccessRate(rules, input.successRate);

    const calendar = buildCalendar(effective, input);
    const settled = calendar.days.filter((day) => day.isSettled);
    const settledDates = settled.map((day) => day.date);
    const active = planChunks(effective, input, settledDates).filter((chunk) => chunk.active);

    const globalRules = input.checkpoints.filter((checkpoint) => checkpoint.source === 'global');
    const achieved = Object.fromEntries(
      globalRules.map((rule) => [rule.id, meets(rule, actualOf(rule, input.attributes))]),
    );

    /** 严格早于某日的最后一个结算日；没有则 null。 */
    const lastSettledBefore = (date) => {
      let best = null;
      for (const candidate of settledDates) {
        if (candidate < date) best = candidate;
        else break;
      }
      return best;
    };

    // 早失败：HiGHS 不可用要在建第一个模型之前就报错，而不是解到一半才发现。
    const highs = await getHighs();

    const weekCommands = {};
    const dayCommands = {};
    let incoming = { ...input.attributes };
    const chunkReports = [];
    let cancelled = false;
    let worstReplay = 0;

    // 片 → 块：片是所有者定的结构与优先级单位，块是**内部求解粒度**（见 SOLVE_BLOCK_WEEKS）。
    // 每个块的界都落在自然周上，且每片的最后一块恰好在片尾结束——所以片目标必然被最后一个
    // 块原样要求（同一条插值线在同一个判定日取点）。
    const blocks = [];
    for (const chunk of active) {
      const chunkDays = settled.filter((day) => day.date >= chunk.startDate && day.date <= chunk.endDate);
      let current = [];
      let weekCount = 0;
      let lastWeek = null;
      const close = () => {
        if (current.length === 0) return;
        const endDate = current[current.length - 1].date;
        blocks.push({
          chunk,
          days: current,
          startDate: current[0].date,
          endDate,
          landingDate: addDays(endDate, 1),
        });
        current = [];
        weekCount = 0;
        lastWeek = null;
      };
      for (const day of chunkDays) {
        if (day.weekStart !== lastWeek) {
          if (weekCount >= SOLVE_BLOCK_WEEKS) close();
          weekCount += 1;
          lastWeek = day.weekStart;
        }
        current.push(day);
      }
      close();
    }

    for (let index = 0; index < blocks.length; index += 1) {
      if (shouldStop()) {
        cancelled = true;
        break;
      }
      const block = blocks[index];
      const { days } = block;
      const dayIndexByDate = new Map(days.map((day, i) => [day.date, i]));
      const targets = buildTargets({ rules: effective, input, block, days, dayIndexByDate, lastSettledBefore });

      // 预算按"剩余时间 ÷ 剩余块数"分，前面省下的留给后面；墙钟只作安全阀。
      // 8 周的块通常 1 s 出头就证明最优并提前返回，所以实际总耗时远小于预算。
      const remainingMs = Math.max(0, deadline - Date.now());
      const timeLimitMs = Math.max(MIN_CHUNK_MS, Math.floor(remainingMs / (blocks.length - index)));

      const model = buildChunkModel({ rules: effective, input, days, incoming, achieved, targets });

      const blockStartedAt = Date.now();
      const result = solveChunkModel(
        highs,
        model,
        timeLimitMs,
        `片 ${block.chunk.index + 1} 的第 ${index + 1} 块 ${block.startDate}→${block.endDate}`,
      );
      const blockAssignments = extractAssignments(model, result.Columns);

      // 先重放再采纳：闸门不过就不认这份解（也不会把它混进结果里）。
      const trajectory = replayChunk({
        rules: effective,
        input,
        days,
        incoming,
        assignments: blockAssignments,
      });
      worstReplay = Math.max(
        worstReplay,
        assertModelMatchesEngine({ model, columns: result.Columns, trajectory }),
      );

      Object.assign(weekCommands, blockAssignments.weekCommands);
      Object.assign(dayCommands, blockAssignments.dayCommands);

      // 状态前推 + 更新"已达成"的全局规则（严格滚动：这个块的指令从此冻结）。
      // **读模型自己的 g**，不读"轨迹里哪一天碰巧达标"：后者比模型的承诺更强，会把下一块
      // 逼进一个它无法维持的强制集合（实测过：那一块直接判不可行）。
      incoming = trajectory.length > 0 ? { ...trajectory[trajectory.length - 1] } : incoming;
      Object.assign(achieved, modelAchieved(model, result.Columns));

      const report = {
        chunkIndex: block.chunk.index + 1,
        startDate: block.startDate,
        endDate: block.endDate,
        landingDate: block.landingDate,
        settledDays: days.length,
        timeLimitMs,
        elapsedMs: Date.now() - blockStartedAt,
        status: result.Status,
        objective: result.objective ?? result.ObjectiveValue,
        binaries: model.counts.binaries,
        targets: targets.map((target) => ({
          key: target.key,
          kind: target.kind,
          op: target.op,
          value: target.value,
        })),
      };

      let chunkReport = chunkReports.find((entry) => entry.index === block.chunk.index + 1);
      if (!chunkReport) {
        chunkReport = {
          index: block.chunk.index + 1,
          startDate: block.chunk.startDate,
          endDate: block.chunk.endDate,
          landingDate: block.chunk.landingDate,
          targets: block.chunk.targets,
          blocks: [],
        };
        chunkReports.push(chunkReport);
      }
      chunkReport.blocks.push(report);
    }

    for (const chunkReport of chunkReports) {
      chunkReport.settledDays = chunkReport.blocks.reduce((sum, block) => sum + block.settledDays, 0);
      chunkReport.elapsedMs = chunkReport.blocks.reduce((sum, block) => sum + block.elapsedMs, 0);
      chunkReport.timeLimitMs = chunkReport.blocks.reduce((sum, block) => sum + block.timeLimitMs, 0);
      chunkReport.statuses = chunkReport.blocks.map((block) => block.status);
      // 片内所有块都证明最优才算"整片最优"，否则如实标"预算内未证最优"。
      chunkReport.provenOptimal = chunkReport.statuses.every((status) => status === 'Optimal');
      chunkReport.status = chunkReport.provenOptimal ? 'Optimal' : 'Time limit reached';
    }

    const assignments = { weekCommands, dayCommands };

    // 官方口径复核：同一个 plan()，界面与测试看到的是同一份判定。
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

    await Promise.resolve(); // 让出事件循环，界面上的取消按钮才真的可点

    return {
      assignments,
      metrics: {
        solver: 'highs-milp',
        chunks: chunkReports,
        seed: SEED,
        replayMaxDeviation: worstReplay,
        // 本次求解实际使用的成功率（缺省 = 规则常量）。
        successRate: input.successRate ?? commonSuccessRate(rules),
        elapsedMs: Date.now() - startedAt,
        cancelled,
        // `incomplete` = 只有被取消、或没能跑完三片时才为真。墙钟到点用当前最好解**不算**
        // 未完成（所有者 2026-10-08：界面不需要标注是否最优）。
        incomplete: cancelled,
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
  const budgetMs = options.budgetMs ?? WORKER_BUDGET_MS;
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
