// 编辑动作：把界面上的操作写进 `input`，并登记"待计算"。
//
// 一条硬规则：**这里从不改求解器给出的 assignments**。使用者显式指定的内容进 input，
// 求解器的填空只是填空（见 src/calendar.js 的 resolveCommand）。
//
// 「平日的指令就是周指令」这条领域规则在这里落地：给平日指定指令＝给它的周锚点写周指令。
//
// 目标统一成**检查点**之后，这里只有三个动作：加一条、改一条、删一条（结局行不可删）。

import { canTakeSnapshot, rollForward } from '../src/frontier.js';
import { clampToLimits } from '../src/input.js';
import { isDate, weekStartOf, weekdayOf } from '../src/dates.js';
import {
  ATTRIBUTES,
  CHOICE_EMPTY,
  CHOICE_NO_CLUB,
  RULES,
  TIMELINE,
  UNSET,
  clampDate,
  clearResult,
  defaultCheckpoint,
  focusDate,
  hooks,
  inTimeline,
  isRestOn,
  markDirty,
  state,
} from './ui.js';
import { flashWeek } from './dom.js';

/** 三态选择串 ↔ 输入值：未指定＝键不存在，空过＝显式 null。 */
export function choiceToCommandId(choice) {
  if (choice === UNSET) return undefined;
  if (choice === CHOICE_EMPTY) return null;
  return choice;
}

export function commandIdToChoice(commandId) {
  if (commandId === undefined) return UNSET;
  if (commandId === null) return CHOICE_EMPTY;
  return commandId;
}

function applyChoice(map, key, commandId) {
  if (commandId === undefined) delete map[key];
  else map[key] = commandId;
}

function toggleInList(list, value, present) {
  const next = new Set(list);
  if (present) next.add(value);
  else next.delete(value);
  return [...next].sort();
}

// ---------------------------------------------------------------- 日历上的标记

/** 跳过 / 取消跳过（空过）。 */
export function setSkipped(dates, isSkipped) {
  let touched = 0;
  for (const date of dates) {
    if (!inTimeline(date)) continue;
    if (isSkipped === state.input.skippedDays.includes(date)) continue;
    state.input.skippedDays = toggleInList(state.input.skippedDays, date, isSkipped);
    touched += 1;
  }
  if (touched > 0) markDirty(touched);
}

/**
 * 指定指令（含"空过"与"清除指定"）。
 *
 * 周日与休息日写自己的日指令。**周一至周六的格子**——包括固定日历里是休息日的那天——
 * 还要把**它所在那一周的周指令**一起改掉，所以只要选区碰到某周的任何一天平日，
 * 那一周的周指令就会被改，即使选区外的平日会跟着变。所有者明确要这个语义。
 *
 * 周日不牵动周指令：周日有自己的决策点，改它不该连坐整周。
 */
export function setCommands(dates, choice) {
  const commandId = choiceToCommandId(choice);
  const weeks = new Set();
  let touched = 0;

  for (const date of dates) {
    if (!inTimeline(date)) continue;
    const isSunday = weekdayOf(date) === 0;
    if (isSunday || isRestOn(date)) {
      applyChoice(state.input.dayCommands, date, commandId);
    }
    if (!isSunday) {
      const weekStart = weekStartOf(date);
      applyChoice(state.input.weekCommands, weekStart, commandId);
      weeks.add(weekStart);
    }
    touched += 1;
  }

  // 先登记改动（它会同步重绘日历，把格子换成新的），再亮特效——反过来的话
  // 刚加上去的亮色会连同旧格子一起被丢掉。
  if (touched > 0) markDirty(touched);

  // 改完周指令，本周全部平日亮一下：这一改连坐六天，要看得见。
  for (const weekStart of weeks) flashWeek(weekStart);
}

/**
 * 「已玩到」：时间轴的起点。它既是"玩到哪了"，也是规划区间从这里开始——
 * 起点与已玩到已经合并成同一个日期（见 ADR-0004），所以只此一处入口。
 *
 * 往前推且有求解结果时，把那一天的**结算后状态**接过来（10 项属性 + 起始社团），
 * 旧排程随之作废。没有结果、或者往回退时，只能挪日期、状态保持原样：
 * 历史概念已经作废，往回退没有东西可以重放，"那一天的状态"无从谈起，所以如实说清楚。
 */
export function setPlayedUpTo(date) {
  // 清空日期框会送出空串：那不是一次移动，忽略即可（否则会被当成"早于时间轴起点"）。
  if (!isDate(date)) return;

  const lower = date < TIMELINE.start ? TIMELINE.start : date;
  const next = lower > TIMELINE.lastSettlement ? TIMELINE.lastSettlement : lower;
  if (state.input.playedUpTo === next) return;

  const movedBack = next < state.input.playedUpTo;
  const takeSnapshot = canTakeSnapshot(state.input, state.result, next);

  if (takeSnapshot) {
    state.input = rollForward(RULES, state.input, state.result, next);
    clearResult();
  } else {
    state.input.playedUpTo = next;
    // 回退之后旧排程的起点在新起点之后，留着就对不上了。
    if (movedBack && state.result) clearResult();
  }

  // 起点变了，视图与选区都跟到那一天——否则日历会停在已经没有格子的旧位置。
  focusDate(next);
  markDirty(takeSnapshot && !movedBack ? 0 : 1);

  hooks.notice(
    takeSnapshot
      ? `起点已前移到 ${next}：当前属性与社团取自那一天的结算结果，点「计算」重排。`
      : movedBack
        ? `起点已回退到 ${next}：没有历史可以重放，当前属性与社团保持原样，请按当时的实际状态核对。`
        : `还没有计算结果：只把起点移到 ${next}，当前属性与社团保持原样。`,
  );
}

// ---------------------------------------------------------------- 左栏输入

export function setAttributeValue(attributeId, value) {
  const attribute = ATTRIBUTES.find((entry) => entry.id === attributeId);
  state.input.attributes[attributeId] = clampToLimits(value, attribute);
  markDirty();
}

export function setInitialClub(clubId) {
  state.input.initialClub = clubId === UNSET ? null : clubId;
  markDirty();
}

// ---------------------------------------------------------------- 检查点

/** 阈值只认整数（见 validateInput），而 `type=number` 允许手输小数——落库前先取整。 */
function withIntegerThreshold(checkpoint) {
  if (!Number.isFinite(checkpoint?.value)) return checkpoint;
  return { ...checkpoint, value: Math.round(checkpoint.value) };
}

const ID_PREFIX = { global: 'gc', mini: 'mg', ending: 'eg' };

/** 给新检查点一个唯一 id；前缀按来源，编号接在已有最大编号之后。 */
function nextCheckpointId(source) {
  const prefix = ID_PREFIX[source] ?? 'cp';
  let max = 0;
  for (const checkpoint of state.input.checkpoints) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(checkpoint.id ?? '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  let candidate = `${prefix}-${max + 1}`;
  const taken = new Set(state.input.checkpoints.map((checkpoint) => checkpoint.id));
  while (taken.has(candidate)) {
    max += 1;
    candidate = `${prefix}-${max + 1}`;
  }
  return candidate;
}

/** 来源决定落点与属性形状：全局没有日期、结局恒在终点、小目标可以有多属性。 */
function normalizeCheckpoint(draft, previous = null) {
  const source = draft.source ?? previous?.source ?? 'mini';
  const checkpoint = { ...(previous ?? {}), ...draft, source };

  if (source === 'global') {
    checkpoint.date = null;
    delete checkpoint.attributes;
    checkpoint.attribute = checkpoint.attribute ?? ATTRIBUTES[0].id;
  } else {
    checkpoint.date = source === 'ending' ? TIMELINE.end : clampDate(checkpoint.date ?? TIMELINE.lastSettlement);
    if (source === 'ending') {
      delete checkpoint.attributes;
      checkpoint.attribute = checkpoint.attribute ?? ATTRIBUTES[0].id;
    } else {
      // 小目标既可以是单属性，也可以是集合；编辑弹窗统一给集合。
      const names = checkpoint.attributes ?? (checkpoint.attribute ? [checkpoint.attribute] : [ATTRIBUTES[0].id]);
      checkpoint.attributes = [...names];
      delete checkpoint.attribute;
    }
  }

  checkpoint.op = checkpoint.op === '<' ? '<' : '>=';
  checkpoint.id = checkpoint.id || nextCheckpointId(source);
  return withIntegerThreshold(checkpoint);
}

/** 加一条检查点；`draft.source` 决定落点语义，id 由这里补。 */
export function addCheckpoint(draft) {
  state.input.checkpoints.push(normalizeCheckpoint(draft));
  markDirty();
}

/** 改一条检查点；id 不变，来源变了会连带把落点/属性形状规范化。 */
export function updateCheckpoint(index, patch) {
  const previous = state.input.checkpoints[index];
  if (!previous) return;
  state.input.checkpoints[index] = normalizeCheckpoint({ ...previous, ...patch }, previous);
  markDirty();
}

/**
 * 删一条检查点。**结局行不可删**——它覆盖除社团经验以外的每一项属性，
 * 少了它终值无从判定（见 src/rules.js 的结局覆盖校验）。
 */
export function removeCheckpoint(index) {
  const checkpoint = state.input.checkpoints[index];
  if (!checkpoint || checkpoint.source === 'ending') return false;
  state.input.checkpoints.splice(index, 1);
  markDirty();
  return true;
}

/** 新建检查点的形状（供弹窗预填）。 */
export function draftCheckpoint(source, date) {
  return defaultCheckpoint(source, date);
}

/**
 * 在某个周日加入 / 更换 / 退出社团。自该周日起生效，并影响该周日的日指令。
 * 工具**绝不自行**选择或切换社团——这条只由使用者的右键操作触发（原规格故事 23）。
 */
export function setClubChange(date, choice) {
  const others = state.input.clubChanges.filter((entry) => entry.date !== date);
  if (choice === UNSET) {
    state.input.clubChanges = others;
  } else {
    const clubId = choice === CHOICE_NO_CLUB ? null : choice;
    state.input.clubChanges = [...others, { date, clubId }].sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  markDirty();
}
