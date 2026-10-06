// 使用者输入的形状与校验。JSON 只承载输入，不承载结果。
//
// 约定：`weekCommands` 的键是**周锚点**，即该自然周的周日；`dayCommands` 的键是
// 某个休息日的日期。同一个周日可以既是一个周锚点、又拥有自己的日指令——这两者
// 并存是正确模型，不是冲突。
//
// 用「显式的 null」表示空过，用「键不存在」表示尚未指定（交由求解器决定）。
// 这两种状态必须能穿过 JSON 往返而不被混淆。

import { isDate, weekdayOf, weekStartOf } from './dates.js';
import { CLUB_COMMAND, isClubSlot, isSkip } from './commands.js';
import { attributeIds } from './lookup.js';
import { createClubLookup } from './clubs.js';
import { commonSuccessRate } from './rules.js';
// 集训周是硬约束，校验要在输入层就拦住违规日程（见 checkClubWeekMandate）。
// 复用语义定义，避免"校验层"与"引擎层"各自实现一遍规则。
import { clubWeekMandate } from './checkpoints.js';

export const CURRENT_VERSION = 3;

/**
 * 出厂成功率。
 *
 * 所有者 2026-10-06 裁决：**直接定为 70%**。理由是实测的阶梯——
 * 出厂数据里每条指令的成功率常量是 35%，在那个期望值下，本工具的最好成绩是
 * 9/11 达标且全局硬约束违反 1161 天；而 **70% 是能同时满足全部三类需求
 * （4 条全局约束 + 2 条小目标 + 9 条结局目标）的最低档位**。
 *
 * 这是**求解口径**，不是改动所有者提供的数值表：`data/rules.json` 里每条指令的
 * `successRate` 仍是 0.35（权威副本不动），覆盖走 `rules.js` 的 `withSuccessRate`，
 * 默认值由这里给出，并随输入保存/导出，所以"用 70% 算出来的解"可以在存档里重现。
 */
export const DEFAULT_SUCCESS_RATE = 0.7;

export function defaultInput(rules) {
  // 优先级：规则里非恒成功指令的**共同值**（出厂数据 0.35）会被上面的裁决覆盖成 70%。
  // 若规则里各指令成功率不一致（`commonSuccessRate` 返回 null），仍然给 70%——
  // 因为那是"能不能解出全部三类需求"的关键档位，而不是数据表里的一个统计量。
  const common = commonSuccessRate(rules);
  const successRate = DEFAULT_SUCCESS_RATE ?? common;
  return {
    version: CURRENT_VERSION,
    ...(successRate === null ? {} : { successRate }),
    // 「已玩到」：使用者已经在游戏里玩到的那一天，同时也是**时间轴的起点**。
    // 它是状态快照——当天不结算，规划从次日开始（见 ADR-0004）。
    // 默认等于时间轴起点，也就是"还没玩过"。
    playedUpTo: rules.timeline.start,
    attributes: Object.fromEntries(rules.attributes.map((a) => [a.id, a.default])),
    checkpoints: structuredClone(rules.checkpoints),
    // 默认加入管乐社（由 data/rules.json 的 defaultClub 给出）。
    initialClub: rules.defaultClub ?? null,
    clubChanges: [],
    weekCommands: {},
    dayCommands: {},
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
  const migrated = migrate(parsed, rules);
  const problems = validateInput(migrated, rules);
  if (problems.length > 0) throw new Error(`输入不合法：${problems[0]}`);
  return migrated;
}

/** 属性值是整数：游戏里的数值是整数，小数只出现在结算过程里。 */
const integerValue = (v) => Number.isInteger(v);

/**
 * 旧版本迁移。
 *
 * v1 → v2：两个日期合成一个。v1 允许「起点」早于「已玩到」，于是需要冻结前缀那套
 *          机器；v2 里起点恒为已玩到，取两者的**较晚者**（宁可少算一段，也不能把
 *          已玩过的那天再结算一遍）。
 * v2 → v3：三套目标数组（globalConstraints / endingGoals / miniGoals）合并成统一的
 *          `checkpoints`；社团经验升为第 10 个属性，输入里不再有 `clubExperience` 映射。
 */
function migrate(input, rules) {
  if (!input || typeof input !== 'object') return input;

  if (input.version === 1) {
    const dates = [input.startDate, input.playedUpTo].filter(isDate).sort();
    const { startDate, ...rest } = input;
    input = {
      ...rest,
      playedUpTo: dates.length > 0 ? dates[dates.length - 1] : input.playedUpTo,
    };
  }

  if (input.version === 1 || input.version === 2) {
    input = { ...input, version: CURRENT_VERSION, checkpoints: checkpointsFromLegacy(input, rules) };
    delete input.globalConstraints;
    delete input.endingGoals;
    delete input.miniGoals;

    // v2 之前社团经验是一张 `{ clubId: 值 }` 映射，且它不在 attributes 里。
    // 升为属性之后只保留**当前社团**的那一份。
    const legacyMap = input.clubExperience;
    if (legacyMap && typeof legacyMap === 'object' && !Array.isArray(legacyMap)) {
      const club = input.initialClub;
      const seeded = club ? legacyMap[club] : undefined;
      if (Number.isFinite(seeded)) {
        input.attributes = { ...input.attributes, clubExperience: seeded };
      }
    }
    delete input.clubExperience;
  }

  return input;
}

/** 把 v2 的三套目标数组搬进统一检查点。 */
function checkpointsFromLegacy(input, rules) {
  const out = [];
  const endingDate = rules.timeline.end;
  for (const g of input.globalConstraints ?? []) {
    out.push({ id: `gc-${g.attribute}`, date: null, attribute: g.attribute, op: g.op, value: g.value, source: 'global' });
  }
  for (const g of input.miniGoals ?? []) {
    out.push({
      id: `mg-${g.attributes.join('-')}`,
      date: g.deadline,
      attributes: [...g.attributes],
      op: g.op,
      value: g.value,
      source: 'mini',
    });
  }
  for (const g of input.endingGoals ?? []) {
    out.push({ id: `eg-${g.attribute}`, date: endingDate, attribute: g.attribute, op: g.op, value: g.value, source: 'ending' });
  }
  return out.length > 0 ? out : structuredClone(rules.checkpoints);
}

/** @returns {string[]} 问题列表，空数组表示通过 */
export function validateInput(input, rules) {
  if (!input || typeof input !== 'object') return ['输入不是对象'];

  const problems = [];
  const clubIds = new Set(rules.clubs.map((c) => c.id));

  // version 是刻意加的：这份 JSON 会随后续票继续长大，
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

  checkAttributeValues(input, rules, problems);
  checkSuccessRate(input, problems);
  checkCheckpoints(input.checkpoints, rules, problems);

  checkClub(input, clubIds, inWeekAnchors, problems);
  const commandIds = new Set(rules.commands.map((c) => c.id));
  // 社团占位符要校验"那一天确实有社团指令可用"，所以需要一个按日期取社团的查询。
  const clubAtForCheck = createClubLookup(input);
  checkWeekCommands(input.weekCommands, commandIds, inWeekAnchors, clubAtForCheck, problems, rules);
  checkDayCommands(input.dayCommands, commandIds, inTimeline, clubAtForCheck, problems);
  checkDayList('skippedDays', input.skippedDays, inTimeline, problems);

  return problems;
}

/**
 * 成功率覆盖的范围校验：缺省 = 不覆盖（沿用规则常量），给了就必须是 (0,1] 内的有限数。
 *
 * 为什么上限是 1 而不是 0.95：休息指令恒成功（`successRate === 1`）不参与覆盖，
 * 但使用者把普通指令调到 1 只是"假设必成"，不是非法——那仍然是一次合法的放宽实验。
 */
function checkSuccessRate(input, problems) {
  if (input.successRate === undefined) return;
  const rate = input.successRate;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1) {
    problems.push(`成功率必须是 (0,1] 内的数：${rate}`);
  }
}

function checkAttributeValues(input, rules, problems) {
  const attributes = input.attributes;
  if (!attributes || typeof attributes !== 'object') {
    problems.push('缺少 attributes');
    return;
  }
  for (const a of rules.attributes) {
    const value = attributes[a.id];
    if (value === undefined) {
      problems.push(`输入缺少属性 ${a.id}`);
    } else if (!integerValue(value)) {
      problems.push(`属性 ${a.id} 的值必须是整数`);
    } else if (value < a.min || value > a.max) {
      problems.push(`属性 ${a.id} 的值 ${value} 超出 [${a.min}, ${a.max}]`);
    }
  }
  for (const key of Object.keys(attributes)) {
    if (!rules.attributes.some((a) => a.id === key)) problems.push(`输入含未知属性 ${key}`);
  }
  if (!rules.attributes.some((a) => a.id === 'clubExperience')) {
    // 社团经验必须是属性之一；这条由 rules.js 保证，这里只在缺失时给出可读原因。
    problems.push('规则里缺少社团经验属性');
  }
}

function checkCheckpoints(checkpoints, rules, problems) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    problems.push('缺少 checkpoints');
    return;
  }
  const attributeIdSet = new Set(attributeIds(rules));
  const { start, end } = rules.timeline;
  const ids = new Set();

  for (const cp of checkpoints) {
    if (typeof cp?.id !== 'string' || cp.id === '') problems.push('检查点缺少 id');
    else if (ids.has(cp.id)) problems.push(`检查点 id 重复：${cp.id}`);
    else ids.add(cp.id);

    if (!['global', 'mini', 'ending'].includes(cp?.source)) {
      problems.push(`检查点 ${cp?.id} 的 source 非法：${cp?.source}`);
    }
    if (!['>=', '<'].includes(cp?.op)) {
      problems.push(`检查点 ${cp?.id} 的比较符非法：${cp?.op}`);
    }
    if (!Number.isFinite(cp?.value)) problems.push(`检查点 ${cp?.id} 的阈值不是数字`);

    const names = cp?.attributes ?? (typeof cp?.attribute === 'string' ? [cp.attribute] : []);
    if (names.length === 0) problems.push(`检查点 ${cp?.id} 没有指定属性`);
    for (const id of names) {
      if (!attributeIdSet.has(id)) problems.push(`检查点 ${cp?.id} 引用了未知属性 ${id}`);
    }

    if (cp?.source === 'global') {
      if (cp.date != null) problems.push(`全局检查点 ${cp.id} 的日期必须为空（表示每周）`);
    } else if (!isDate(cp?.date)) {
      problems.push(`检查点 ${cp?.id} 的日期格式错误：${cp?.date}`);
    } else if (cp.date < start || cp.date > end) {
      problems.push(`检查点 ${cp.id} 的日期超出时间轴：${cp.date}`);
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

/**
 * 指令槽位里除真实指令 id 外，还允许两个占位符：
 *   `'club'` 当前社团指令——具体哪一条取决于当时的社团（见 `commands.js`）
 *   `'skip'` 只有**日指令**允许（空过）
 */
function checkCommandValue(commandId, commandIds, date, clubAt, problems, where) {
  if (commandId === null) return;
  if (isClubSlot(commandId)) {
    if (!clubAt(date)) problems.push(`${where} 在 ${date} 用了当前社团指令，但那天没有加入任何社团`);
    return;
  }
  if (isSkip(commandId)) return;
  if (!commandIds.has(commandId)) problems.push(`${where} 引用了未知指令 ${commandId}`);
}

function checkWeekCommands(map, commandIds, inTimeline, clubAt, problems, rules) {
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
    checkCommandValue(commandId, commandIds, date, clubAt, problems, 'weekCommands');
    checkClubWeekMandate(rules, clubAt, date, commandId, problems);
  }
}

/**
 * 社团集训周是**硬约束**：该周全部平日必须执行当前社团的社团指令（ADR-0007 第三节）。
 *
 * 校验必须在**输入层**就报出来：此前 `validateInput` 不查这一条，于是一份 6 个集训周里
 * 5 个没执行社团指令的日程照样被 `plan()` 报成 `goals.ok = true`——"11/11 达标"随时可能
 * 被违规日程污染（solver 2026-10-06 实测踩到）。
 *
 * 回家社（`initialClub = null`）不受此约束；空过（`null`）与占位符按"违规"处理，
 * 因为它们在集训周里同样意味着"没有执行社团指令"。
 */
function checkClubWeekMandate(rules, clubAt, date, commandId, problems) {
  if (!isDate(date)) return;
  const mandate = clubWeekMandate(rules, clubAt(date), date);
  if (mandate === null) return;
  if (commandId !== mandate) {
    problems.push(
      `集训周 ${date} 的周指令必须是当前社团的指令 ${mandate}（实际 ${commandId ?? '空过'}）：`
      + '该周的平日被游戏强制为社团活动，见 ADR-0007。',
    );
  }
}

function checkDayCommands(map, commandIds, inTimeline, clubAt, problems) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    problems.push('缺少 dayCommands');
    return;
  }
  for (const [date, commandId] of Object.entries(map)) {
    if (!isDate(date)) problems.push(`dayCommands 的键不是日期：${date}`);
    else if (!inTimeline(date)) problems.push(`dayCommands 的日期超出时间轴：${date}`);
    checkCommandValue(commandId, commandIds, date, clubAt, problems, 'dayCommands');
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
