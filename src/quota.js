// 周配额分配：先用**精确方法**求出"每条指令各用几周"，再交给排布层。
//
// 为什么需要它：每周只有一条周指令、作用于 6 个平日，所以**一个决策同时推动全部 10 个
// 属性**。束搜索逐状态选"当前最好"，会把资源堆到回报最快的一项上——实测反复出现某几项
// 严重超额、另几项归零（文科 286 而容姿 3.8、体力 950 而其余归零）。排序键换过 9 版
// （见 spec.md「排序键实验谱系」）都没解决，因为问题不在"怎么排序"。
//
// 关键性质（所有者确认的 H1）：指令**没有副作用**——今天做了什么不影响明天能做什么。
// 因此终值只取决于"每条指令用了几次"，与顺序无关：
//
//     终值_k = 起点_k + Σ_c （周内次数_c × 该指令在该周的日效果_k × 该周可用天数）
//
// 于是"把 152 周分给各条主攻指令"就是一个**变量很少的整数规划**。这里用
// 「缺口驱动的边际贪心 + 逐周最优分配」求解：每轮把一周交给"最能压低当前最大缺口"的
// 指令，直到全部达标或周数用尽。它不需要任何权重表——缺口按**归一化比例**比较。

import { addDays, weekStartOf } from './dates.js';
import { availableCommandIds, availableDayCommandIds, clubCommandId, createClubLookup } from './clubs.js';
import { CLUB_EXPERIENCE_ID, REST_DAY, WEEKDAY, expectedEffects } from './settlement.js';
import { buildCheckpointSchedule } from './checkpoints.js';

/** 一条属性的"要求"：终点目标（`>=` 或 `<`）。 */
function endTargetsOf(rules, schedule) {
  const targets = new Map();
  for (const checkpoint of schedule) {
    if (checkpoint.source !== 'ending' || checkpoint.attributes) continue;
    const current = targets.get(checkpoint.attribute);
    if (!current || checkpoint.date >= current.date) {
      targets.set(checkpoint.attribute, { op: checkpoint.op, value: checkpoint.value, date: checkpoint.date });
    }
  }
  return targets;
}

/**
 * 把某条指令施加到一整周上（该周每个结算日各一次），返回对每个属性的总变化。
 *
 * 按**真实日历**逐周算：该周有几个平日、几个休息日，周指令只作用于平日，休息日走日指令。
 * 不能用"7 × 单日效果"（周指令管不了周日）。
 */

/**
 * 某一周里"有结算的平日"与"有结算的休息日"分别是哪些天。
 *
 * **休息日不能按"i === 0（周日）"硬编码**：`rules.calendar.restDays` 里还有一批游戏内
 * 确定的节假日，它们落在周一至周六，同样走各自的日指令。漏掉它们会把配额算错。
 */
function weekStructure(rules, weekStart) {
  const fixedRest = new Set(rules.calendar?.restDays ?? []);
  const weekdays = [];
  const restDays = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(weekStart, i);
    if (date < rules.timeline.start || date > rules.timeline.lastSettlement) continue;
    if (date === rules.timeline.start) continue;
    const isRest = i === 0 || fixedRest.has(date);
    if (isRest) restDays.push(date);
    else weekdays.push(date);
  }
  return { weekdays, restDays };
}

/**
 * 求一份周配额：`{ quota: [ { weekStart, commandId, weekdayDates, restDates } ], unmet, weeks }`。
 *
 * @returns `{ plan, unmet, usedWeeks, weeks }`，`unmet` 是最终仍达不到的属性清单。
 */
export function allocateQuota(rules, input) {
  const weeks = buildCalendarWeeks(rules, input);
  const clubAt = createClubLookup(input);
  const schedule = buildCheckpointSchedule(rules, input);
  const targets = endTargetsOf(rules, schedule);

  // 每周的可用候选池与结构固定，先算一次。
  const structures = weeks.map((week) => ({
    weekStart: week.weekStart,
    weekdayDates: week.weekdays,
    restDates: week.restDays,
    pool: availableCommandIds(rules, clubAt(week.weekStart), week.weekStart),
  }));

  // **每条指令在整周上的效果向量**：只取决于该周的平日天数与指令本身。
  // 因为无副作用，终值 = 起点 + Σ（该指令用了几周 × 这个向量），与顺序无关。
  const vectors = new Map();
  for (const s of structures) {
    if (vectors.has(s.pool.join('|') + '|' + s.weekdayDates.length)) continue;
    const key = s.pool.join('|') + '|' + s.weekdayDates.length;
    const table = new Map();
    for (const commandId of s.pool) {
      const perDay = expectedEffects(rules, commandId, WEEKDAY);
      table.set(commandId, Object.fromEntries(
        rules.attributes.map((a) => [a.id, perDay[a.id] * s.weekdayDates.length]),
      ));
    }
    vectors.set(key, table);
  }
  const vectorFor = (s, commandId) => vectors.get(s.pool.join('|') + '|' + s.weekdayDates.length).get(commandId);

  const start = Object.fromEntries(rules.attributes.map((a) => [a.id, a.default]));
  const active = rules.attributes.filter((a) => targets.has(a.id) && a.id !== CLUB_EXPERIENCE_ID);

  /** 给定"每周选哪条"，算终值（含夹逼）。 */
  const evaluate = (choices) => {
    const state = { ...start };
    choices.forEach((commandId, index) => {
      if (commandId === null) return;
      const vector = vectorFor(structures[index], commandId);
      for (const a of rules.attributes) {
        state[a.id] = Math.max(a.min, Math.min(a.max, state[a.id] + vector[a.id]));
      }
    });
    return state;
  };

  /** 缺口键：最大归一化缺口优先，再比总和。 */
  const keyOf = (state) => {
    const gaps = [];
    for (const a of active) {
      const t = targets.get(a.id);
      const gap = t.op === '>=' ? t.value - state[a.id] : state[a.id] - (t.value - 1);
      gaps.push(gap > 0 ? gap / Math.max(1, t.value) : 0);
    }
    gaps.sort((x, y) => y - x);
    return { gaps, total: gaps.reduce((x, y) => x + y, 0) };
  };
  const better = (a, b) => {
    for (let i = 0; i < Math.max(a.gaps.length, b.gaps.length); i += 1) {
      const l = a.gaps[i] ?? 0;
      const r = b.gaps[i] ?? 0;
      if (Math.abs(l - r) > 1e-12) return l - r;
    }
    return a.total - b.total;
  };

  // 固定日历里的社团集训周：那段时间游戏里只能做社团指令，配额层照办、不再重选。
  const pinnedClubWeeks = new Set((rules.calendar?.clubWeeks ?? []).map((w) => w.date));

  // 初值：钉住的周用社团指令，其余先留空（下面迭代会填）。
  const choices = structures.map((s) => {
    if (!pinnedClubWeeks.has(s.weekStart)) return null;
    const command = clubCommandId(rules, clubAt(s.weekStart));
    return s.pool.includes(command) ? command : null;
  });
  let best = keyOf(evaluate(choices));
  let bestChoices = [...choices];

  // 逐周定点迭代：每轮扫全表，把每周换成"能让缺口键最小"的指令，直到不再改善。
  for (let pass = 0; pass < 40; pass += 1) {
    let improved = false;
    for (let index = 0; index < structures.length; index += 1) {
      // 固定日历钉住的社团集训周不参与重选。
      if (pinnedClubWeeks.has(structures[index].weekStart)) continue;
      const original = choices[index];
      let localBest = original;
      let localKey = null;
      for (const commandId of structures[index].pool) {
        choices[index] = commandId;
        const key = keyOf(evaluate(choices));
        if (localKey === null || better(key, localKey) < 0) {
          localKey = key;
          localBest = commandId;
        }
      }
      choices[index] = localBest;
      if (localBest !== original) improved = true;
      if (better(localKey, best) < 0) {
        best = localKey;
        bestChoices = [...choices];
        // 起点值为 0 的项不参与，避免"全 0"被当成最好
      }
    }
    if (!improved) break;
  }

  // 把最终选择整理成排布层要的形状；休息日按同一套"缺口驱动"逐日选。
  const state = { ...start };
  const plan = [];
  bestChoices.forEach((commandId, index) => {
    const s = structures[index];
    const vector = vectorFor(s, commandId);
    for (const a of rules.attributes) {
      state[a.id] = Math.max(a.min, Math.min(a.max, state[a.id] + vector[a.id]));
    }
    const restCommands = s.restDates.map((date) => {
      const dayPool = availableDayCommandIds(rules, clubAt(date), date);
      let restBest = null;
      let restKey = null;
      for (const candidate of dayPool) {
        const trial = { ...state };
        if (candidate !== 'skip') {
          const perDay = expectedEffects(rules, candidate, REST_DAY);
          for (const a of rules.attributes) {
            trial[a.id] = Math.max(a.min, Math.min(a.max, trial[a.id] + perDay[a.id]));
          }
        }
        const key = keyOf(trial);
        if (restKey === null || better(key, restKey) < 0) {
          restKey = key;
          restBest = candidate;
        }
      }
      if (restBest && restBest !== 'skip') {
        const perDay = expectedEffects(rules, restBest, REST_DAY);
        for (const a of rules.attributes) {
          state[a.id] = Math.max(a.min, Math.min(a.max, state[a.id] + perDay[a.id]));
        }
      }
      return { date, commandId: restBest };
    });
    plan.push({ weekStart: s.weekStart, commandId, weekdayDates: s.weekdayDates, restCommands });
  });

  return { plan, unmet: keyOf(state), state };
}

function buildCalendarWeeks(rules, input) {
  const weeks = [];
  for (let anchor = weekStartOf(rules.timeline.start); anchor <= rules.timeline.lastSettlement; anchor = addDays(anchor, 7)) {
    const structure = weekStructure(rules, anchor);
    weeks.push({ weekStart: anchor, ...structure });
  }
  return weeks;
}

/**
 * 缺口键：对每条**有终点目标**的属性算"归一化缺口比例"，返回按大小排序的向量。
 *
 * 用向量而不是标量：标量化和会掩盖"某一项差很多"，而验收要的是全达标。
 * 比较时**先比最大缺口**（先把最烂的一项补齐），再比缺口总和。
 */

/** 字典序比较两个缺口键：越小越好。 */
