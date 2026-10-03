// 使用者输入的形状与校验。JSON 只承载输入，不承载结果。
//
// 约定：`weekCommands` 的键是**周锚点**，即该自然周的周日；`dayCommands` 的键是
// 某个休息日的日期。同一个周日可以既是一个周锚点、又拥有自己的日指令——这两者
// 并存是正确模型，不是冲突。
//
// 用「显式的 null」表示空过，用「键不存在」表示尚未指定（交由求解器决定）。
// 这两种状态必须能穿过 JSON 往返而不被混淆。

import { isDate, weekdayOf, weekStartOf } from './dates.js';
import { goalProblems, miniGoalProblems } from './goals.js';
import { attributeIds } from './lookup.js';

export const CURRENT_VERSION = 2;

export function defaultInput(rules) {
  return {
    version: CURRENT_VERSION,
    // 「已玩到」：使用者已经在游戏里玩到的那一天，同时也是**时间轴的起点**。
    // 它是状态快照——当天不结算，规划从次日开始（见 ADR-0004）。
    // 默认等于时间轴起点，也就是"还没玩过"。
    playedUpTo: rules.timeline.start,
    attributes: { ...rules.defaultStart },
    // 起点那一刻各社团已经攒下的经验，`{ clubId: 值 }`；缺席的社团按 0 起算。
    // 合并起点与已玩到之后，时间轴以内没有历史可供"照旧演一遍"，所以这份状态必须由输入直接承载。
    // 用映射而不是单个数：社团经验是**每个社团各自一份**，只留当前社团会把别的社团的计数丢掉。
    clubExperience: {},
    globalConstraints: structuredClone(rules.defaultGlobalConstraints),
    endingGoals: structuredClone(rules.defaultEndingGoals),
    miniGoals: structuredClone(rules.defaultMiniGoals),
    initialClub: null,
    clubChanges: [],
    weekCommands: {},
    dayCommands: {},
    restDays: [],
    skippedDays: [],
  };
}

export function toJson(input) {
  return JSON.stringify(input, null, 2);
}

/**
 * 把界面手输的值夹进 `[min, max]` 并取整。
 *
 * `type=number` 的 min/max 拦不住键盘，而越界值与小数会让整份输入在下次校验时失败；
 * 那时调用方只剩"丢掉整份存档"这一条路（见 web/session.js），代价不对称，所以落库前先夹住。
 */
export function clampToLimits(value, { min, max }) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 导出的文件名：就用「已玩到」这一天的裸日期，多份文件一眼分得清。 */
export function exportFileName(input) {
  return `${input.playedUpTo}.json`;
}

/** 解析并校验；不合法时抛出带原因的错误。 */
export function fromJson(text, rules) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`不是合法的 JSON：${error.message}`);
  }
  const migrated = migrate(parsed);
  const problems = validateInput(migrated, rules);
  if (problems.length > 0) throw new Error(`输入不合法：${problems[0]}`);
  return migrated;
}

/**
 * v1 → v2：两个日期合成一个。
 *
 * v1 允许「起点」早于「已玩到」，于是需要冻结前缀那套机器；v2 里起点恒为已玩到。
 * 合并时取两者的**较晚者**：宁可少算一段，也不能把已玩过的那天再结算一遍。
 */
function migrate(input) {
  if (!input || typeof input !== 'object') return input;
  if (input.version !== 1) return input;

  const dates = [input.startDate, input.playedUpTo].filter(isDate).sort();
  const { startDate, ...rest } = input;
  return {
    ...rest,
    version: CURRENT_VERSION,
    // v1 没有起点社团经验：历史前缀被删掉之后它才有必要存在，老文件按"全都没攒过"起算。
    clubExperience: isClubExperienceMap(input.clubExperience) ? input.clubExperience : {},
    playedUpTo: dates.length > 0 ? dates[dates.length - 1] : input.playedUpTo,
  };
}

/** @returns {string[]} 问题列表，空数组表示通过 */
export function validateInput(input, rules) {
  if (!input || typeof input !== 'object') return ['输入不是对象'];

  const problems = [];
  const attributeIdSet = new Set(attributeIds(rules));
  const commandIds = new Set(rules.commands.map((c) => c.id));
  const clubIds = new Set(rules.clubs.map((c) => c.id));
  const ceId = rules.clubExperience.id;

  // version 不在票 01 列举的输入字段里，是刻意加的：这份 JSON 会随后续票继续长大，
  // 没有版本号就无法在格式变化时给出可读的拒绝理由，只能报一堆形状错误。
  if (input.version !== CURRENT_VERSION) {
    problems.push(`版本号不受支持：${input.version}`);
  }

  const { start, lastSettlement } = rules.timeline;
  const inTimeline = (date) => isDate(date) && date >= start && date <= lastSettlement;
  // 周锚点是自然周的周日，可能是**已玩到前一天或更早**（从周二开始规划时，
  // 那一周的锚点就在已玩到之前）。社团切换同理，只发生在周锚点上。
  const firstAnchor = weekStartOf(start);
  const inWeekAnchors = (date) => isDate(date) && date >= firstAnchor && date <= lastSettlement;

  // 起点恒为已玩到：一个日期，既是"玩到哪了"，也是规划区间从这里开始。
  if (!isDate(input.playedUpTo)) {
    problems.push(`playedUpTo 格式错误：${input.playedUpTo}`);
  } else if (!inTimeline(input.playedUpTo)) {
    problems.push(`playedUpTo 超出时间轴：${input.playedUpTo}`);
  }

  checkAttributes(input, rules, problems);
  checkClubExperience(input, rules, problems, clubIds);

  const goalContext = {
    attributeIds: attributeIdSet,
    clubExperienceId: ceId,
    allowClubExperience: false,
  };
  problems.push(...goalProblems(input.globalConstraints, 'globalConstraints', goalContext));
  problems.push(...goalProblems(input.endingGoals, 'endingGoals', goalContext));
  problems.push(
    ...miniGoalProblems(input.miniGoals, 'miniGoals', { ...goalContext, allowClubExperience: true }),
  );

  checkClub(input, clubIds, inWeekAnchors, problems);
  checkWeekCommands(input.weekCommands, commandIds, inWeekAnchors, problems);
  checkDayCommands(input.dayCommands, commandIds, inTimeline, problems);
  checkDayList('restDays', input.restDays, inTimeline, problems);
  checkDayList('skippedDays', input.skippedDays, inTimeline, problems);

  return problems;
}

function checkAttributes(input, rules, problems) {
  const attributes = input.attributes;
  if (!attributes || typeof attributes !== 'object') {
    problems.push('缺少 attributes');
    return;
  }
  for (const a of rules.attributes) {
    const value = attributes[a.id];
    if (value === undefined) {
      problems.push(`输入缺少属性 ${a.id}`);
    } else if (!Number.isInteger(value)) {
      problems.push(`属性 ${a.id} 的值必须是整数`);
    } else if (value < a.min || value > a.max) {
      problems.push(`属性 ${a.id} 的值 ${value} 超出 [${a.min}, ${a.max}]`);
    }
  }
  for (const key of Object.keys(attributes)) {
    if (!rules.attributes.some((a) => a.id === key)) problems.push(`输入含未知属性 ${key}`);
  }
}

function isClubExperienceMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 起点各社团已经攒下的经验：`{ clubId: 值 }`，缺席的社团按 0。 */
function checkClubExperience(input, rules, problems, clubIds) {
  const ce = rules.clubExperience;
  if (input.clubExperience === undefined || input.clubExperience === null) {
    // 老存档没有这个字段：当作"哪个社团都还没攒过"。
    input.clubExperience = {};
    return;
  }
  if (!isClubExperienceMap(input.clubExperience)) {
    problems.push('clubExperience 必须是以社团 id 为键的对象');
    return;
  }
  for (const [clubId, value] of Object.entries(input.clubExperience)) {
    if (!clubIds.has(clubId)) {
      problems.push(`clubExperience 引用了未知社团 ${clubId}`);
    } else if (!Number.isInteger(value)) {
      problems.push(`clubExperience 的 ${clubId} 必须是整数：${value}`);
    } else if (value < ce.min || value > ce.max) {
      problems.push(`clubExperience 的 ${clubId} 超出 [${ce.min}, ${ce.max}]`);
    }
  }
}

function checkClub(input, clubIds, inTimeline, problems) {
  if (input.initialClub !== null && !clubIds.has(input.initialClub)) {
    problems.push(`initialClub 引用了未知社团 ${input.initialClub}`);
  }
  if (!Array.isArray(input.clubChanges)) {
    problems.push('clubChanges 必须是数组');
    return;
  }
  for (const change of input.clubChanges) {
    if (!isDate(change?.date)) {
      problems.push(`clubChanges 的日期格式错误：${change?.date}`);
    } else if (!inTimeline(change.date)) {
      problems.push(`clubChanges 的日期超出可切换范围：${change.date}`);
    } else if (weekdayOf(change.date) !== 0) {
      problems.push(`clubChanges 只能在周日切换社团：${change.date}`);
    }
    if (change?.clubId !== null && !clubIds.has(change?.clubId)) {
      problems.push(`clubChanges 引用了未知社团 ${change?.clubId}`);
    }
  }
}

function checkWeekCommands(map, commandIds, inTimeline, problems) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    problems.push('缺少 weekCommands');
    return;
  }
  for (const [date, commandId] of Object.entries(map)) {
    if (!isDate(date)) {
      problems.push(`weekCommands 的键不是日期：${date}`);
    } else if (!inTimeline(date)) {
      problems.push(`weekCommands 的日期超出可指定范围：${date}`);
    } else if (weekdayOf(date) !== 0) {
      problems.push(`weekCommands 的键必须是周日（周锚点）：${date}`);
    }
    if (commandId === null) continue;
    if (!commandIds.has(commandId)) problems.push(`weekCommands 引用了未知指令 ${commandId}`);
  }
}

function checkDayCommands(map, commandIds, inTimeline, problems) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    problems.push('缺少 dayCommands');
    return;
  }
  for (const [date, commandId] of Object.entries(map)) {
    if (!isDate(date)) problems.push(`dayCommands 的键不是日期：${date}`);
    else if (!inTimeline(date)) problems.push(`dayCommands 的日期超出时间轴：${date}`);
    if (commandId === null) continue;
    if (!commandIds.has(commandId)) problems.push(`dayCommands 引用了未知指令 ${commandId}`);
  }
}

function checkDayList(label, list, inTimeline, problems) {
  if (!Array.isArray(list)) {
    problems.push(`${label} 必须是数组`);
    return;
  }
  for (const date of list) {
    if (!isDate(date)) problems.push(`${label} 含非法日期：${date}`);
    else if (!inTimeline(date)) problems.push(`${label} 的日期超出时间轴：${date}`);
  }
}
