// 领域查询与共享状态（不含 DOM 原语——那些在 web/dom.js，见票 10）。
//
// 依赖方向是单向的：ui.js ← edits.js ← panels.js ← app.js，且 ui.js ← calendar.js ← panels.js。
// （panels.js 同时用到 edits.js 与 calendar.js；没有任何一条边反向指回 ui.js。）
// 打包器拒绝循环依赖，所以渲染入口由 app.js 通过 hooks 注入，而不是让 ui.js 反向 import app.js。

import rules from '../data/rules.json';
import { addDays, weekStartOf, weekdayOf } from '../src/dates.js';
import { availableCommandIds, clubCommandId } from '../src/clubs.js';
import { defaultInput } from '../src/input.js';
import { createClubLookup, resolveActivity, resolveCommand } from '../src/calendar.js';
import { buildCheckpointSchedule, findConflictingMiniGoals, isExpiredGoal, meets } from '../src/checkpoints.js';

export const UNSET = '';
export const CHOICE_EMPTY = '__empty__';
export const CHOICE_NO_CLUB = '__no_club__';

export const TIMELINE = rules.timeline;

/** 规则文件本身：需要用到「属性次序」这类原始顺序的地方（例如检查点表的行序）。 */
export const RULES = rules;

/** 10 项属性——`clubExperience` 现在是其中之一，不再是旁挂的伪属性。 */
export const ATTRIBUTES = rules.attributes.map((attribute) => ({
  id: attribute.id,
  name: attribute.name,
  direction: attribute.direction,
  min: attribute.min,
  max: attribute.max,
}));

/** 详情条与左栏共用的 10 项数值。形状一致（都带 `min`/`max`），渲染侧不需要按 id 分支。 */
export const VALUE_FIELDS = ATTRIBUTES;

export const CLUBS = rules.clubs.map((club) => ({ id: club.id, name: club.name }));
export const COMMANDS = rules.commands.map((command) => ({ id: command.id, name: command.name }));

/**
 * 左栏「快速添加小目标」的预设。
 *
 * 预设本身是**领域数值**（日期 + 阈值），所以只存在 `data/rules.json` 里一份；
 * 界面只负责渲染与落地，不写死第二份阈值。
 */
export const QUICK_MINI_GOALS = rules.quickMiniGoals ?? [];

/** 只在休息日可用的指令（电话/约会）：进「指定指令」，但不进求解器候选。 */
const REST_ONLY_COMMAND_IDS = new Set(
  rules.commands.filter((command) => command.restOnly).map((command) => command.id),
);

const COMMAND_NAMES = new Map(COMMANDS.map((command) => [command.id, command.name]));
const ATTRIBUTE_NAMES = new Map(ATTRIBUTES.map((attribute) => [attribute.id, attribute.name]));

export const SOURCE_LABELS = {
  pinned: '使用者指定',
  assigned: '求解器排定',
  activity: '活动强制',
  sports: '体育社团强制',
  join: '社团加入',
  switch: '社团切换',
  none: '待定',
};

/** 「跳过」只有活动日才有；使用者已经不能再手工标空过或跳过。 */
export const SKIP_LABELS = {
  day: '跳过（指定本日）',
  'day-command': '跳过（日指令置空）',
  week: '跳过（周指令置空）',
};

export const BLOCK_LABELS = {
  'club-not-unlocked': '不结算（社团未解锁）',
  'club-not-selected': '不结算（未加入社团）',
  'club-mismatch': '不结算（社团不符）',
  'rest-only': '不结算（休息日专属指令）',
};

/** 检查点来源的显示名。落点语义各不相同，见 `checkpointLandingText`。 */
export const CHECKPOINT_SOURCE_LABELS = {
  global: '全局约束',
  mini: '小目标',
  ending: '结局目标',
};

export const state = {
  input: defaultInput(rules),
  /** 求解器排出的日程；`null` 表示还没算过。 */
  assignments: null,
  /** `plan()` 的结果；`null` 表示还没算过。 */
  result: null,
  /** 最近一次求解的指标（束宽/层数/扩展/剪枝/耗时/取消/未完成）；没算过是 null。 */
  metrics: null,
  /** 尚未计算的改动数。 */
  pending: 0,
  computing: false,
  /** 使用者点过「取消」；求解器在检查点读它。 */
  cancelRequested: false,
  computedAt: null,
  /** 选区。`from` 恒不晚于 `to`；单日选中时两者相等。 */
  selection: { from: TIMELINE.start, to: TIMELINE.start },
  /** 双月日历左侧那个月，`YYYY-MM`。 */
  viewMonth: TIMELINE.start.slice(0, 7),
  dayByDate: new Map(),
  /** `Map<日期, 检查点落点[]>`：日历上的小目标标记按**具体落点**画。 */
  landingByDate: new Map(),
};

/** app.js 注入的渲染入口；界面模块只管改状态，不互相直接调用渲染。 */
export const hooks = {
  render() {},
  /** 输入变了之后要落盘；由 app.js 注入（见 web/session.js）。 */
  persist() {},
  /** 给使用者的一句提示（起点已前移、求解失败等）；由 app.js 注入。`null` 表示清空。 */
  notice() {},
};

export function commandName(id) {
  return COMMAND_NAMES.get(id) ?? id;
}

const ACTIVITY_COMMAND_LABELS = {
  skip: '跳过',
  club: '执行当前社团指令',
  clubCamp: '社团集训指令',
};

/** 活动绑定指令的显示名（含 club / clubCamp 占位符）。 */
export function activityCommandName(commandId) {
  return ACTIVITY_COMMAND_LABELS[commandId] ?? commandName(commandId);
}

export function attributeName(id) {
  return ATTRIBUTE_NAMES.get(id) ?? id;
}

export function opText(op) {
  return op === '>=' ? '≥' : '<';
}

export function fmt1(value) {
  return Number(value ?? 0).toFixed(1);
}

export function isStale() {
  return state.pending > 0 || state.result === null;
}

/** 一个检查点的属性集合（单属性与集合两种形状统一成数组）。 */
export function checkpointAttributeIds(checkpoint) {
  return checkpoint.attributes ?? (checkpoint.attribute ? [checkpoint.attribute] : []);
}

/** 属性的显示文本：单属性给名字，集合给 `文+理+艺`。 */
export function checkpointAttributesText(checkpoint) {
  return checkpointAttributeIds(checkpoint).map(attributeName).join('+');
}

/** 落点的显示文本：全局约束是"每个结算日"，其余是具体日期。 */
export function checkpointLandingText(checkpoint) {
  return checkpoint.source === 'global' || checkpoint.date == null
    ? '每个结算日'
    : checkpoint.date;
}

/** 一行检查点的摘要：`文+理+艺 ≥ 561`。 */
export function checkpointSummary(checkpoint) {
  return `${checkpointAttributesText(checkpoint)} ${opText(checkpoint.op)} ${checkpoint.value}`;
}

/** 新检查点的形状；落点按来源定：全局为 null（表示"每个结算日"），结局恒为终点，小目标给日期。 */
export function defaultCheckpoint(source, date = TIMELINE.lastSettlement) {
  const attribute = ATTRIBUTES[0].id;
  if (source === 'global') {
    return { id: '', date: null, attribute, op: '>=', value: 20, source: 'global' };
  }
  if (source === 'ending') {
    return { id: '', date: TIMELINE.end, attribute, op: '>=', value: 50, source: 'ending' };
  }
  return { id: '', date: clampDate(date), attributes: [attribute], op: '>=', value: 50, source: 'mini' };
}

/** 日期夹在可落点的范围内：越界的截止日会让画旗与评估走偏。 */
export function clampDate(date) {
  if (date > TIMELINE.lastSettlement) return TIMELINE.lastSettlement;
  if (date < TIMELINE.start) return TIMELINE.start;
  return date;
}

/** 某一天所属的社团（`null` = 未加入）。社团只能在一个个周日内切换。 */
export function clubAt(date) {
  return createClubLookup(state.input, rules)(date);
}

export function selectedDates() {
  const { from, to } = state.selection;
  if (!from || !to) return [];
  const dates = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function isRangeSelection() {
  return state.selection.from !== state.selection.to;
}

// ---------------------------------------------------------------- 日期

export function inTimeline(date) {
  return date >= TIMELINE.start && date <= TIMELINE.end;
}

export function monthOf(date) {
  return date.slice(0, 7);
}

export function monthLabel(key) {
  const [year, month] = key.split('-');
  return `${year}年${Number(month)}月`;
}

export function shiftMonth(key, delta) {
  const [year, month] = key.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

/** 一个月的日期格：补齐前后溢出日，行数按实际需要（5 或 6 行）。 */
export function monthCells(key) {
  const first = `${key}-01`;
  const [year, month] = key.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = Math.ceil((weekdayOf(first) + daysInMonth) / 7);
  const start = weekStartOf(first);
  return Array.from({ length: rows * 7 }, (_, index) => addDays(start, index));
}

// ---------------------------------------------------------------- 指令候选

export function commandsAvailableAt(date) {
  const club = createClubLookup(state.input, rules)(date);
  const allowed = new Set(availableCommandIds(rules, club, date));
  return COMMANDS.filter((command) => allowed.has(command.id));
}

/**
 * 「指定指令」里可选的指令：求解器候选 + **只在休息日可用**的指令（目前只有电话/约会）。
 *
 * 电话/约会效果全 0，所以不进候选序列（求解器不替使用者选，见 ADR-0014）；
 * 但它是使用者的记录手段，必须能手动填进去——这就是它与候选集的唯一区别。
 */
export function commandsSelectableAt(date) {
  const rest = isRestOn(date);
  const club = createClubLookup(state.input, rules)(date);
  const available = new Set(availableCommandIds(rules, club, date));
  return COMMANDS.filter(
    (command) => available.has(command.id) || (rest && REST_ONLY_COMMAND_IDS.has(command.id)),
  );
}

/**
 * 这一天是不是休息日。**休息日是游戏固定事实**（周日 + `rules.calendar.restDays` 里的
 * 节假日），不是使用者可标注的输入——界面上不再有"设为休息日"这个操作。
 */
export function isRestOn(date) {
  return weekdayOf(date) === 0 || (rules.calendar?.restDays ?? []).includes(date);
}

/** 与日历、求解器完全一致的指令解析口径（见 src/calendar.js 的 resolveCommand）。 */
export function resolveDayCommand(date) {
  // 活动日优先：活动绑定指令是硬强制，`club`/`clubCamp` 按当天社团展开。
  const activity = activityOn(date);
  if (activity) {
    if (activity.command === 'skip') {
      return { commandId: null, source: 'activity', skip: false, empty: true };
    }
    if (activity.command === 'club' || activity.command === 'clubCamp') {
      const commandId = clubCommandId(rules, createClubLookup(state.input, rules)(date));
      // 回家社时活动按普通日处理，落回自由指令。
      if (commandId) return { commandId, source: 'activity', skip: false };
    } else {
      return { commandId: activity.command, source: 'activity', skip: false };
    }
  }

  // 社团加入/切换：最近的周日；活动日优先。
  const lookup = createClubLookup(state.input, rules);
  const isJoin = lookup.joinDate !== null && date === lookup.joinDate;
  const isSwitch = lookup.switchDate !== null && date === lookup.switchDate;
  if (isSwitch && lookup.target !== null) {
    const commandId = clubCommandId(rules, lookup.target);
    if (commandId) return { commandId, source: 'switch', skip: false };
  }
  if (isJoin && !isSwitch) {
    const commandId = clubCommandId(rules, lookup.oldClub);
    if (commandId) return { commandId, source: 'join', skip: false };
  }

  const rest = isRestOn(date);
  const club = clubAt(date);
  const clubDefinition = club ? rules.clubs.find((entry) => entry.id === club) : null;
  const dayOfMonth = Number(date.slice(8, 10));
  const isThirdSunday = weekdayOf(date) === 0 && dayOfMonth >= 15 && dayOfMonth <= 21;
  if (isThirdSunday && clubDefinition?.category === 'sports') {
    const commandId = clubCommandId(rules, club);
    if (commandId) return { commandId, source: 'sports', skip: false };
  }
  const weekStart = weekStartOf(date);
  return resolveCommand(state.input, state.assignments, {
    isDayCommandDay: rest,
    date,
    weekStart,
  });
}

/**
 * 这一天的指令是不是被**硬规则**占着（活动 / 社团加入 / 社团切换 / 体育第 3 周日）。
 *
 * 这些天指令由日历与社团规则决定，使用者的指定会被引擎忽略（见 `resolveDayCommand` 的
 * 短路顺序），所以「指定指令」应当禁用——否则界面会收下一个永远不会生效的选择。
 */
export function forcedCommandSource(date) {
  const { source } = resolveDayCommand(date);
  return source === 'activity' || source === 'join' || source === 'switch' || source === 'sports'
    ? source
    : null;
}

/** 某一天命中的活动（按当天社团解析条件与变体）；没有返回 null。 */
export function activityOn(date) {
  return resolveActivity(rules, createClubLookup(state.input, rules), date);
}

// ---------------------------------------------------------------- 检查点

/**
 * **求解前**就能判定的状态：`expired`（结算日早于「已玩到」）与 `conflict`（同日同属性上下界无交集）。
 *
 * 这两条只依赖输入，不依赖求解结果，所以不需要先点「计算」——新加的目标如果注定不可满足，
 * 表格里当场就标出来（所有者 2026-11-06 要求）。
 * 其余状态（met / unmet / violated）仍然只能由 `plan()` 给出。
 */
export function staticStatesOf() {
  const conflicts = findConflictingMiniGoals(state.input.checkpoints);
  const map = new Map();
  for (const checkpoint of state.input.checkpoints) {
    if (checkpoint.source === 'global') continue;
    if (isExpiredGoal(checkpoint, state.input.playedUpTo)) map.set(checkpoint.id, 'expired');
    else if (conflicts.has(checkpoint.id)) map.set(checkpoint.id, 'conflict');
  }
  return map;
}

/** 某条规则的达标读数（`evaluateCheckpoints` 按规则聚合后的一行）；没算过是 null。 */
export function evaluationOf(checkpointId) {
  return state.result?.goals?.items?.find((item) => item.id === checkpointId) ?? null;
}

/** 全部规则一行一条的读数（兜底条目也在内）。 */
export function goalItems() {
  return state.result?.goals?.items ?? [];
}

/**
 * 结果的**两个独立结论**；没算过是 null。
 *
 *   - `ok`    目标（参与判定的检查点）是否全部达标——`goals.ok`；
 *   - `valid` 日程是否合格——`goals.valid`，看硬约束有没有被违反。
 *
 * 所有者明确要求两者**分开报告**：目标全达标而日程不合格是真实存在的情况
 * （例如"往 0 压再拉起"的夹逼套利日程）。界面不得把它们合并成一个成功/失败。
 */
export function goalsVerdict() {
  const goals = state.result?.goals;
  if (!goals) return null;
  const gated = goals.gated ?? [];
  return {
    ok: goals.ok === true,
    metGates: gated.filter((item) => item.state === 'met').length,
    gatedCount: gated.length,
    valid: goals.valid === true,
    hardViolations: goals.hardViolations ?? 0,
    clubWeekViolations: goals.clubWeekViolations ?? 0,
  };
}

/** 每条规则一行：结果里有它就用结果的读数，没有就退回输入（未计算时也看得到规则）。 */
export function checkpointRows() {
  return state.input.checkpoints.map((checkpoint) => ({
    checkpoint,
    evaluation: evaluationOf(checkpoint.id),
  }));
}

/**
 * 日历上的旗按**小目标落点**画（全局约束与结局目标不再标记，所有者 2026-10-07 裁决）。
 * 每次渲染重建一张日期索引——四千多个落点，成本可以忽略。
 */
export function rebuildCheckpointIndex() {
  const schedule = buildCheckpointSchedule(RULES, state.input);
  const byDate = new Map();
  for (const landing of schedule) {
    if (!byDate.has(landing.date)) byDate.set(landing.date, []);
    byDate.get(landing.date).push(landing);
  }
  state.landingByDate = byDate;
}

/** 某个落点达标了吗；没有计算结果时返回 null（界面画白旗）。 */
export function landingMet(landing) {
  if (!state.result) return null;
  // 判定基准：小目标与结局目标取**落点前一天的结算值**（所有者 2026-10-07 裁决，见 ADR-0007）。
  // 不能直接读 `day.attributes`——那是**当天结算后**的值，比引擎的判定基准晚一天；
  // 也不能依赖 `day.attributesBefore`：重放沿用计算结果里的 days，那个字段只在首次计算时存在。
  const actual = checkpointAttributeIds(landing).reduce(
    (sum, id) => sum + (valueBefore(landing.date, id) ?? 0),
    0,
  );
  return meets(actual, landing.op, landing.value);
}

/**
 * `date` 当天结算**之前**的属性值，也就是前一天的结算结果。
 *
 * 属性只在结算日变动，所以"当天结算前"等于"上一个结算日结算后"——往回找最近一个有结算
 * 记录的日子即可。落点当天不结算时（终点 / 空过 / 起点快照），当天值与之前的值相同。
 */
function valueBefore(date, attributeId) {
  const day = state.dayByDate.get(date);
  if (day && !day.isSettled) return day.attributes?.[attributeId] ?? null;
  let cursor = previousDate(date);
  while (cursor !== null) {
    const previous = state.dayByDate.get(cursor);
    if (!previous) break;
    if (previous.isSettled) return previous.attributes?.[attributeId] ?? null;
    cursor = previousDate(cursor);
  }
  // 落点之前没有任何结算（起点快照就是第一天）：用输入里的起始值。
  return state.input.attributes?.[attributeId] ?? null;
}

function previousDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function setResult(result, metrics = null) {
  state.result = result;
  state.dayByDate = new Map(result.days.map((day) => [day.date, day]));
  state.metrics = metrics;
  state.computedAt = new Date();
  state.pending = 0;
  state.cancelRequested = false;
  rebuildCheckpointIndex();
}

/**
 * 排程与结果整个作废，回到「尚未计算」。
 * 三处会用到：导入换了整套输入、起点前移（旧排程只覆盖旧区间）、以及将来任何"前提换了"的动作。
 */
export function clearResult() {
  state.assignments = null;
  state.result = null;
  state.metrics = null;
  state.dayByDate = new Map();
  state.computedAt = null;
  state.pending = 0;
  state.cancelRequested = false;
  rebuildCheckpointIndex();
}

/** 把视图与选区都挪到某一天：起点前移、导入换了输入、首次挂载，日历都该跟过去。 */
export function focusDate(date) {
  state.selection = { from: date, to: date };
  state.viewMonth = monthOf(date);
}

export function dayOf(date) {
  return state.dayByDate.get(date) ?? null;
}

/**
 * 当天的属性值：有结算结果就取那一天的；还没算过就退回输入的起始属性；
 * 算过却没有这一天（时间轴之外）如实给 `null`，不编数值。
 */
export function valueOf(date, id) {
  const day = dayOf(date);
  if (day) return day.attributes[id];
  if (state.result === null) return state.input.attributes[id] ?? null;
  return null;
}

// ---------------------------------------------------------------- 改动登记

export function markDirty(count = 1) {
  state.pending += count;
  rebuildCheckpointIndex();
  hooks.render();
  // 输入变了就落盘：刷新不丢，是本地保存承诺的全部。
  hooks.persist();
}
