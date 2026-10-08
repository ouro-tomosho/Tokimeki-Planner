// 构造式启发式排布搜索：直接对**真实结算内核**（`settlement.js` 的 `apply`）做逐槽最速下降。
//
// **它现在的角色是"候选生成器"，不是产品求解器**（所有者 2026-10-08 裁决，见 ADR-0009）。
// 产品求解器是 HiGHS 精确求解（`src/solve.js` + `src/milp.js`）。为什么还要留着它：
// 精确求解按 8 周块**严格滚动**，丢掉了跨期的容量分配——实测默认输入下它 10/11，
// 而本模块在**整条时间轴上一次性**分配，15 s 就能拿到 11/11（含毅力 100），
// 且同样过当前 `plan()` 判定（ok/valid、硬违反 0）。于是两者**并列产出候选**，
// 由 `plan()` 这个唯一判定器挑更好的那一份。这是"排布器对体面负责、判定器对真实语义负责"
// 的分层（ADR-0007），不是退回旧方案。
//
// 为什么当年不直接用它当结论：它靠**启发式排序**找解，没有最优性保证；把每日夹逼写成 MILP
// 之后 LP 松弛里「凭空抬高」
// （L>0 而 v>0）与真实吸收**同价**，整数最优解会大量靠假抬高去满足目标——开发期实测
// 35% 全约束跑 600s，抽出的解有 1103 条终值与真实重放不一致。所以：
//
//   · 本模块负责**找解**：每一次评价都是真实引擎的一次逐日推进，不存在"声明值与重放值
//     两套数"的问题；
//   · 求解结果最终还要由 `plan()` + 逐日重放复核（见 `solve.js` 的指标口径）。
//
// 结构（本文件头已自述）：
//   决策槽 = 每个"有结算平日的自然周"一个周指令 + 每个结算休息日一个日指令（含跳过）
//   评价   = 一次瘦重放（与 apply 同口径），算 ① gate 归一化缺口 ② 全局硬违反 ③ 夹逼吸收
//   搜索   = 逐槽最速下降（枚举该槽全部候选）+ 迭代局部搜索（扰动 k 槽再下降）
//
// **确定性**：PRNG 固定种子、槽遍历顺序固定、候选顺序固定、轮数与预算都只做"是否继续"
// 的判断。同一输入连续求解两次结果逐位相同。
//
// **协作式取消**：每完成一个槽位就查一次 `shouldStop()`；为真则立刻返回当前最优。

import { buildCalendar } from './calendar.js';
import { clubWeekMandate } from './checkpoints.js';
import { availableCommandIds, availableDayCommandIds, clubCommandId, createClubLookup } from './clubs.js';
import { clubExperienceGainOn, expectedEffects, REST_DAY, WEEKDAY } from './settlement.js';
import { allocateQuota } from './quota.js';

/**
 * 默认工作量（**确定性**预算，与挂钟无关）：
 *   · 每个阶段先做 5 轮全槽下降，把配额暖启动推到局部最优；
 *   · 再按 `DEFAULT_ILS` / `DEFAULT_REPAIR_FIRST` / `DEFAULT_REPAIR_LAST` 跑扰动式改进。
 *
 * 这组数在本机标定为 14–21 s（Worker 预算 30 s），给更慢的浏览器留了余量。它是**主判据**：
 * 跑完它就停，与机器快慢无关；墙钟只作安全阀（见 `MIN_VIABLE_BUDGET_MS` 与 metrics
 * 的 `stopped` / `reproducible`）。
 */
export const DEFAULT_PASSES = 5;
/** 迭代局部搜索的轮数（每轮 = 扰动 + 下降）。 */
export const DEFAULT_ILS = 10;
/** 扰动槽数上限（IL-搜索的"踢一脚"）。 */
export const DEFAULT_KICK = 8;
/** A 阶段（冲目标）里全局硬违反的权重：低权重 = 先把目标补齐。 */
export const DEFAULT_GATES_WEIGHT = 1;
/** 修硬约束阶段里全局硬违反的权重：高权重 = 在不丢目标的前提下压违反。 */
export const DEFAULT_VALIDITY_WEIGHT = 200;

/** 阶段 2（先修硬约束）的轮数。 */
export const DEFAULT_REPAIR_FIRST = 10;
/** 阶段 4（再修一次）的轮数。 */
export const DEFAULT_REPAIR_LAST = 6;
/** 主线程降级路径的默认预算：必须短到界面还能响应取消。 */
export const DEFAULT_BUDGET_MS = 30000;

/**
 * 低于这个预算**不启动搜索**：直接返回确定性基线（暖启动的那份配额日程）。
 *
 * 为什么要有这条：几百毫秒连一次全槽下降都跑不完，而"跑到一半被挂钟切断"会让同一输入
 * 每次停在不同迭代上——那正是确定性承诺被破坏的地方。与其给出一个不可复现的结果，
 * 不如**明确地**退回确定性基线，并在 metrics 里写清 `stopped: 'budget-too-small'`。
 */
export const MIN_VIABLE_BUDGET_MS = 3000;

/**
 * 按**请求的预算**挑一档固定工作量。它读的是 `budgetMs` 这个**输入数字**，不是跑出来的
 * 耗时——所以同一输入永远挑到同一档，工作量因此确定。
 *
 *   · `< 3000 ms`  不搜索，直接给确定性基线；
 *   · `< 8000 ms`  （主线程降级路径）轻量档：一两秒内跑完，主线程不卡；
 *   · 其余（Worker 路径）默认档。
 */
export function workProfileFor(budgetMs) {
  if (!(budgetMs >= MIN_VIABLE_BUDGET_MS)) {
    return { name: 'none', search: false, passes: 0, ils: 0, repairFirst: 0, repairLast: 0 };
  }
  // 轻量档只做**一次初始下降**（阶段 2/3/4 的轮数为 0 时会被整段跳过）：
  // 主线程降级路径只有 5 s，实测"2 轮下降 + 3 轮改进"要 4–5 s，正好卡在预算上被墙钟切断
  // ——那又不可复现了。一次下降约 0.5 s（配额暖启动之上），既留足余量又是确定结果。
  if (budgetMs < 8000) return { name: 'light', search: true, passes: 1, ils: 0, repairFirst: 0, repairLast: 0 };
  return {
    name: 'default',
    search: true,
    passes: DEFAULT_PASSES,
    ils: DEFAULT_ILS,
    repairFirst: DEFAULT_REPAIR_FIRST,
    repairLast: DEFAULT_REPAIR_LAST,
  };
}

/** 固定种子 PRNG（mulberry32）：不掷骰子，同输入同输出。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLUB_EXPERIENCE = 'clubExperience';

// ---------------------------------------------------------------- 问题构造

function buildProblem(rules, input) {
  const attributes = rules.attributes;
  const ids = attributes.map((a) => a.id);
  const index = Object.fromEntries(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const mins = Float64Array.from(attributes.map((a) => a.min));
  const maxs = Float64Array.from(attributes.map((a) => a.max));
  const start = Float64Array.from(attributes.map((a) => input.attributes[a.id]));

  const calendar = buildCalendar(rules, input);
  const clubAt = createClubLookup(input);
  const settled = calendar.days.filter((day) => day.isSettled);

  // 系数唯一来源：引擎的 expectedEffects（含成功率、休息日 ×4、失败分支）与
  // clubExperienceGainOn（含 8 月集训周加成）。工具与引擎不得各算一套。
  const cache = new Map();
  const effectOf = (commandId, isRestDay, weekStart) => {
    const key = `${commandId}|${isRestDay ? 'r' : 'w'}|${weekStart}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const out = new Float64Array(n);
    if (commandId && commandId !== 'skip') {
      const command = rules.commands.find((c) => c.id === commandId);
      if (!command) throw new Error(`未知指令：${commandId}`);
      const base = expectedEffects(rules, command, isRestDay ? REST_DAY : WEEKDAY);
      for (let i = 0; i < n; i += 1) {
        let value = base[ids[i]];
        if (ids[i] === CLUB_EXPERIENCE && command.kind === 'club') {
          value += clubExperienceGainOn(rules, isRestDay ? REST_DAY : WEEKDAY, { weekStart });
        }
        out[i] = value;
      }
    }
    cache.set(key, out);
    return out;
  };

  // ---- 决策槽 ----
  const slots = [];
  const daySlot = new Int32Array(settled.length);
  const weekSlotOf = new Map();
  const daySlotOf = new Map();
  for (let i = 0; i < settled.length; i += 1) {
    const day = settled[i];
    if (day.isRestDay) continue;
    if (weekSlotOf.has(day.weekStart)) continue;
    const club = clubAt(day.weekStart);
    const mandate = clubWeekMandate(rules, club, day.weekStart);
    const cands = mandate ? [mandate] : availableCommandIds(rules, club, day.weekStart);
    weekSlotOf.set(day.weekStart, slots.length);
    slots.push({ kind: 'week', key: day.weekStart, isRestDay: false, cands, dayIdxs: [] });
  }
  for (let i = 0; i < settled.length; i += 1) {
    const day = settled[i];
    if (!day.isRestDay) {
      slots[weekSlotOf.get(day.weekStart)].dayIdxs.push(i);
      continue;
    }
    const club = clubAt(day.date);
    // 集训周强制的是**周指令**（该周全部平日）；休息日没有这条强制（所有者 2026-10-06 明确）。
    daySlotOf.set(day.date, slots.length);
    slots.push({ kind: 'day', key: day.date, isRestDay: true, cands: availableDayCommandIds(rules, club, day.date), dayIdxs: [i] });
  }
  for (const [start2, slot] of weekSlotOf) for (const i of slots[slot].dayIdxs) daySlot[i] = slot;
  for (const [, slot] of daySlotOf) daySlot[slots[slot].dayIdxs[0]] = slot;

  const slotEff = slots.map((slot) => slot.cands.map((cmd) => effectOf(cmd, slot.isRestDay, slot.key)));

  // ---- 目标 ----
  const checkpoints = input.checkpoints;
  const ending = checkpoints.filter((c) => c.source === 'ending');
  const mini = checkpoints.filter((c) => c.source === 'mini');
  const global = checkpoints.filter((c) => c.source === 'global');
  const lastIdx = settled.length - 1;
  const miniIdx = new Map();
  for (const cp of mini) {
    let best = 0;
    for (let i = 0; i < settled.length; i += 1) if (settled[i].date <= cp.date) best = i;
    miniIdx.set(cp.id, best);
  }
  const makeGlobals = () =>
    global.map((cp) => {
      const id = cp.attribute ?? cp.attributes[0];
      const ai = index[id];
      const startMet = cp.op === '>=' ? start[ai] >= cp.value : start[ai] < cp.value;
      return { ai, op: cp.op, value: cp.value, id: cp.id, hard: startMet };
    });

  const state = new Float64Array(n);
  return {
    rules, input, calendar, settled, slots, daySlot, slotEff, ids, index, n, start, mins, maxs,
    ending, mini, global, lastIdx, miniIdx, makeGlobals, state, weekSlotOf, daySlotOf,
  };
}

// ---------------------------------------------------------------- 评价

/**
 * 一次全量评价：瘦重放（与 `apply` 同口径）+ 三类指标。
 * 返回的 `score` 只用于**搜索排序**；对外汇报的达标状态一律以 `plan()` 为准。
 */
function evaluate(problem, x, validityWeight) {
  problem.evaluations += 1;
  const { settled, slotEff, daySlot, state, n, start, mins, maxs, ending, mini, miniIdx, lastIdx, index } = problem;
  state.set(start);
  let absorb = 0;
  let globalPenalty = 0;
  let globalDays = 0;
  const globals = problem.makeGlobals();
  let finalState = null;
  const miniState = new Map();

  for (let i = 0; i < settled.length; i += 1) {
    const s = daySlot[i];
    const ci = x[s];
    if (ci >= 0) {
      const eff = slotEff[s][ci];
      for (let a = 0; a < n; a += 1) {
        const pre = state[a] + eff[a];
        const v = pre < mins[a] ? mins[a] : pre > maxs[a] ? maxs[a] : pre;
        state[a] = v;
        if (v > pre) absorb += v - pre;
      }
    }
    for (const g of globals) {
      const v = state[g.ai];
      const met = g.op === '>=' ? v >= g.value : v < g.value;
      if (met) g.hard = true;
      else if (g.hard) {
        globalPenalty += g.op === '>=' ? (g.value - v) / g.value : (v - g.value) / g.value;
        globalDays += 1;
      }
    }
    for (const [cpId, i0] of miniIdx) if (i0 === i) miniState.set(cpId, Float64Array.from(state));
    if (i === lastIdx) finalState = Float64Array.from(state);
  }

  const items = [];
  for (const cp of ending) {
    const id = cp.attribute ?? cp.attributes[0];
    const v = (finalState ?? state)[index[id]];
    items.push({ id: cp.id, actual: v, op: cp.op, value: cp.value, ok: cp.op === '>=' ? v >= cp.value : v < cp.value });
  }
  for (const cp of mini) {
    const snap = miniState.get(cp.id);
    const names = cp.attributes ?? [cp.attribute];
    const v = names.reduce((sum, id) => sum + (snap ? snap[index[id]] : 0), 0);
    items.push({ id: cp.id, actual: v, op: cp.op, value: cp.value, ok: cp.op === '>=' ? v >= cp.value : v < cp.value });
  }
  let shortfall = 0;
  let unmet = 0;
  for (const item of items) {
    if (item.ok) continue;
    unmet += 1;
    const need = item.op === '>=' ? item.value - item.actual : item.actual - item.value + 1e-9;
    shortfall += Math.max(0, need) / Math.max(1, Math.abs(item.value));
  }
  // **字典序**（所有者口径：不要为了凑 valid 去牺牲 ok）：
  //   ① 未达标的目标条数最少 ② 缺口合计最小 ③ 全局硬违反最少 ④ 夹逼吸收最少（不推荐套利）
  // 用大权重把四层压成一个标量，但层与层之间**不共享刻度**——这是刻意的：
  // 少一条未达标优先于任何其他层的改善。
  const score = unmet * 1e6 + shortfall * 1e3 + globalPenalty * validityWeight + 1e-6 * absorb;
  return { score, unmet, shortfall, globalPenalty, globalDays, absorb, items };
}

// ---------------------------------------------------------------- 搜索

function toAssignments(problem, x) {
  const weekCommands = {};
  const dayCommands = {};
  for (let s = 0; s < problem.slots.length; s += 1) {
    const slot = problem.slots[s];
    const cmd = slot.cands[x[s]];
    if (slot.kind === 'week') weekCommands[slot.key] = cmd;
    else dayCommands[slot.key] = cmd;
  }
  return { weekCommands, dayCommands };
}

/**
 * **规范序**（与搜索的加权代价无关）：未达标条数 → 缺口合计 → 全局硬违反 → 夹逼吸收。
 *
 * 搜索用加权标量只是为了有梯度；**选优**必须回到这个规范序，否则换一个权重就可能选出
 * 更差的解。两个阶段（先冲目标、再修硬约束）的产物也用这个序比较。
 */
function betterThan(a, b) {
  if (a.unmet !== b.unmet) return a.unmet < b.unmet;
  if (Math.abs(a.shortfall - b.shortfall) > 1e-9) return a.shortfall < b.shortfall;
  if (Math.abs(a.globalPenalty - b.globalPenalty) > 1e-9) return a.globalPenalty < b.globalPenalty;
  return a.absorb < b.absorb;
}

/** 兜底初始解：全部休息周 + 休息日日指令（确定性、与数据无关）。 */
function restVector(problem) {
  const x = new Int32Array(problem.slots.length);
  for (let s = 0; s < problem.slots.length; s += 1) {
    const ci = problem.slots[s].cands.indexOf('cmd-rest');
    x[s] = ci >= 0 ? ci : 0;
  }
  return x;
}

/**
 * 暖启动种子：配额层的"缺口驱动贪心"（`src/quota.js`）。
 *
 * 为什么需要：从"全休息"冷启动时，30 s 预算内的下降只能爬到 6–7/11；配额层先用
 * **与顺序无关**的性质（指令无副作用 ⇒ 终值只取决于各条用了几次）把资源摊到最缺的
 * 那几项上，给下降一个"主攻方向已经对了"的起点。
 *
 * 配额层与下降层同口径（都用 `expectedEffects`），所以它给的是同一个世界里的解，
 * 不会把搜索带偏。失败时退回兜底起点，不让求解整体失败。
 */
function quotaVector(problem) {
  const x = restVector(problem);
  try {
    const quota = allocateQuota(problem.rules, problem.input);
    for (const week of quota.plan ?? []) {
      const slot = problem.weekSlotOf.get(week.weekStart);
      if (slot !== undefined) {
        const ci = problem.slots[slot].cands.indexOf(week.commandId);
        if (ci >= 0) x[slot] = ci;
      }
      for (const rest of week.restCommands ?? []) {
        const dayIndex = problem.daySlotOf.get(rest.date);
        if (dayIndex === undefined) continue;
        const ci = problem.slots[dayIndex].cands.indexOf(rest.commandId ?? 'skip');
        if (ci >= 0) x[dayIndex] = ci;
      }
    }
    return { x, quotaUnmet: quota.unmet ?? null };
  } catch {
    return { x, quotaUnmet: null };
  }
}

export function runDescent(rules, input, options = {}) {
  const shouldStop = options.shouldStop ?? (() => false);
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  // 工作量：显式给定优先；否则由**请求的预算**决定一档固定值（见 workProfileFor）。
  const profile = workProfileFor(budgetMs);
  const passes = options.passes ?? profile.passes;
  const ils = options.ils ?? profile.ils;
  const kick = options.kick ?? DEFAULT_KICK;
  const seed = options.seed ?? 20261006;
  // 各阶段里"全局硬违反"的权重：冲目标阶段低（权重 1，先把目标补齐），
  // 修硬约束阶段高（在不丢目标的前提下压违反）。阶段顺序见 `runDescent` 上方的说明。
  const gatesWeight = options.gatesWeight ?? DEFAULT_GATES_WEIGHT;
  const repairWeight = options.repairWeight ?? DEFAULT_VALIDITY_WEIGHT;
  const repairFirst = options.repairFirst ?? profile.repairFirst;
  const repairLast = options.repairLast ?? profile.repairLast;
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;

  const problem = { ...buildProblem(rules, input), evaluations: 0 };
  const rng = mulberry32(seed);
  const warm = options.warmStart === false ? { x: restVector(problem), quotaUnmet: null } : quotaVector(problem);
  const x = warm.x;

  const order = [...problem.slots.keys()];
  let current = evaluate(problem, x, gatesWeight);
  let best = current;
  const bestX = Int32Array.from(x);
  let cancelled = false;
  let iterations = 0;
  let repairIterations = 0;

  // **墙钟只是安全阀**：主判据是上面那组固定工作量（passes / ils / repairFirst / repairLast），
  // 它在进入搜索前就定死了，所以"跑完计划工作量"这条路径与机器快慢无关。
  // 安全阀触发时结果会停在不同迭代上——那种情况必须**标注**出来（`reproducible: false`），
  // 不能假装它和平时一样可复现。
  const outOfTime = () => Date.now() >= deadline || shouldStop();
  let stoppedBy = 'work-limit';

  /**
   * 一次全槽最速下降。`weight` 只影响**方向**；是否更优由加权代价判断（同阶段内可比）。
   *
   * 取消/超时**不改变**已完成的轮数语义：它是安全阀，触发时把 `cancelled` 置真并立刻返回。
   */
  function descend(weight) {
    for (let pass = 0; pass < passes; pass += 1) {
      let improved = false;
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (const s of order) {
        const original = x[s];
        let bestCand = original;
        let bestScore = current.score;
        for (let ci = 0; ci < problem.slots[s].cands.length; ci += 1) {
          if (ci === original) continue;
          x[s] = ci;
          const result = evaluate(problem, x, weight);
          if (result.score < bestScore - 1e-12) {
            bestScore = result.score;
            bestCand = ci;
            current = result;
          }
        }
        x[s] = bestCand;
        if (bestCand !== original) improved = true;
        if (outOfTime()) {
          stoppedBy = shouldStop() ? 'cancelled' : 'wall-clock';
          cancelled = true;
          return improved;
        }
      }
      if (!improved) break;
    }
    return false;
  }

  const snapshot = () => {
    bestX.set(x);
    best = current;
  };

  /** 迭代局部搜索：扰动 k 个槽再下降，只接受**规范序**更优者。 */
  function iterate(count, weight) {
    let done = 0;
    for (let it = 0; it < count; it += 1) {
      const y = Int32Array.from(bestX);
      const k = 1 + Math.floor(rng() * kick);
      for (let t = 0; t < k; t += 1) {
        const s = Math.floor(rng() * y.length);
        y[s] = Math.floor(rng() * problem.slots[s].cands.length);
      }
      x.set(y);
      current = evaluate(problem, x, weight);
      descend(weight);
      done += 1;
      if (betterThan(current, best)) {
        if (typeof process !== 'undefined' && process.env?.DESCENT_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`[iter ${it}] 改善：best(${best.unmet},${best.shortfall.toFixed(4)},${best.globalDays},${best.absorb.toFixed(1)}) → (${current.unmet},${current.shortfall.toFixed(4)},${current.globalDays},${current.absorb.toFixed(1)})`);
        }
        snapshot();
      }
      if (outOfTime()) {
        stoppedBy = shouldStop() ? 'cancelled' : 'wall-clock';
        cancelled = true;
        break;
      }
    }
    return done;
  }

  /**
   * 统一收尾：两条出口（"预算过小直接退回基线"与"跑完阶段"）共用一份 metrics 组装，
   * 免得两处口径分叉。
   */
  function finish(overrides = {}) {
    const stopped = overrides.stoppedBy ?? stoppedBy;
    const wasCancelled = overrides.cancelled ?? cancelled;
    return {
      assignments: toAssignments(problem, bestX),
      metrics: {
        seed,
        passes,
        ils,
        kick,
        repairFirst,
        repairLast,
        // 计划工作量（确定性）与"本次实际跑了多少"分开报：前者是承诺，后者是实际。
        work: { passes, ils, repairFirst, repairLast },
        workProfile: profile.name,
        evaluations: problem.evaluations,
        budgetMs,
        elapsedMs: Date.now() - startedAt,
        ilsDone: overrides.iterations ?? iterations,
        repairIterations: overrides.repairs ?? repairIterations,
        cancelled: wasCancelled,
        stopped,
        // `incomplete` = 没跑完计划工作量（被取消 / 被墙钟切断 / 预算过小）。
        incomplete: wasCancelled,
        // `reproducible` = 这份结果是否可复现。只有**被墙钟切断**时才是 false：
        // 那种情况下停在第几轮取决于机器快慢，同一输入两次可能不同。
        reproducible: stopped !== 'wall-clock',
        // 搜索层自评（只用于排序，**不作为对外结论**）
        searchUnmet: best.unmet,
        searchShortfall: best.shortfall,
        searchHardViolationDays: best.globalDays,
        absorption: best.absorb,
        slots: problem.slots.length,
        warmStart: options.warmStart === false ? 'rest' : 'quota',
      },
    };
  }

  if (!profile.search) {
    // 预算太小：**不启动搜索**，直接返回确定性基线（配额暖启动）并如实标注。
    // 必须真的返回：只置标志的话，下面的阶段仍会被墙钟切断，同一输入会停在不同迭代上
    // （实测 5 次跑出 4 种结果，且因为系统时钟被校正出现过负的耗时）。
    return finish({ stoppedBy: 'budget-too-small', cancelled: true });
  }

  // ---- 四个**确定性阶段**，一路往下走，每个阶段结束都按规范序取一次优 ----
  //
  // 为什么不是"跑一种参数"：这两个验收点要的工作量互相矛盾——
  //   · 低成功率（35%）要把目标条数冲上去，必须多跑"冲目标"的 ILS；
  //   · 高成功率（70%+）一旦 ILS 跑多，会被带进"11/11 但几百天硬违反"的角落，
  //     而**初始下降 + 修硬约束**反而能直接拿到 11/11 且零违反。
  // 所以按"先修硬约束 → 再冲目标 → 再修一次"的顺序走一遍，每个阶段结束都记录当前最好，
  // 最后按**规范序**（与搜索权重无关）取优。阶段之间不重复劳动，整体仍然确定性。
  descend(gatesWeight);
  snapshot();
  if (typeof process !== 'undefined' && process.env?.DESCENT_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(`[阶段1 初始下降] passes=${passes} → (${best.unmet},${best.shortfall.toFixed(4)},${best.globalDays},${best.absorb.toFixed(1)})`);
  }

  /** 从当前最好解出发，用给定权重跑一轮下降 + ILS，返回是否被取消。 */
  function stage(label, weight, count, isRepair = false) {
    if (cancelled || count <= 0) return;
    x.set(bestX);
    current = evaluate(problem, x, weight);
    descend(weight);
    if (betterThan(current, best)) snapshot();
    const done = iterate(count, weight);
    iterations += done;
    if (isRepair) repairIterations += done;
    if (typeof process !== 'undefined' && process.env?.DESCENT_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[${label}] → (${best.unmet},${best.shortfall.toFixed(4)},${best.globalDays},${best.absorb.toFixed(1)})`);
    }
  }

  // 阶段 2：先修硬约束（高成功率下这一步就能给出"全达标 + 零违反"）
  stage('阶段2 修硬约束', repairWeight, repairFirst, true);
  const afterRepair = best;
  const afterRepairX = Int32Array.from(bestX);
  // 阶段 3：冲目标（低成功率下靠它把未达标条数压下去）
  stage('阶段3 冲目标', gatesWeight, ils);
  // 阶段 4：再修一次硬约束（只在没有丢掉目标的前提下）
  stage('阶段4 再修', repairWeight, repairLast, true);
  void afterRepair;
  void afterRepairX;

  if (typeof process !== 'undefined' && process.env?.DESCENT_DEBUG) {
    const check = evaluate(problem, bestX, gatesWeight);
    // eslint-disable-next-line no-console
    console.log('[descent-debug] best', { unmet: best.unmet, shortfall: best.shortfall, days: best.globalDays, absorb: best.absorb },
      'bestX', { unmet: check.unmet, shortfall: check.shortfall, days: check.globalDays, absorb: check.absorb });
  }

  return finish();
}
