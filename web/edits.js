// 编辑动作：把界面上的操作写进 `input`，并登记"待计算"。
//
// 一条硬规则：**这里从不改求解器给出的 assignments**。使用者显式指定的内容进 input，
// 求解器的填空只是填空（见 src/calendar.js 的 resolveCommand）。
//
// 「平日的指令就是周指令」这条领域规则在这里落地：给平日指定指令＝给它的周锚点写周指令。

import { weekStartOf, weekdayOf } from '../src/dates.js';
import {
  ATTRIBUTES,
  CHOICE_EMPTY,
  CHOICE_NO_CLUB,
  TIMELINE,
  UNSET,
  clampDeadline,
  defaultGoal,
  flashWeek,
  inTimeline,
  isRestOn,
  markDirty,
  state,
} from './ui.js';

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

/** 标记/取消休息日。周日恒为休息日，不受影响。 */
export function setRestDays(dates, isRest) {
  let touched = 0;
  for (const date of dates) {
    if (weekdayOf(date) === 0) continue;
    if (!inTimeline(date)) continue;
    // 只登记**真的变了**的那些：取消一个本来就不是休息日的日子不该让"待计算"计数上涨。
    if (isRest === state.input.restDays.includes(date)) continue;
    state.input.restDays = toggleInList(state.input.restDays, date, isRest);
    touched += 1;
  }
  if (touched > 0) markDirty(touched);
}

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
 * 周日与休息日写自己的日指令。**周一至周六的格子**——包括其中被标记为休息日的那天——
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

/** 「已玩到」：历史是前缀，取到这一天（含）。 */
export function setPlayedUpTo(date) {
  const clamped = date < state.input.startDate ? state.input.startDate : date;
  const next = clamped > TIMELINE.lastSettlement ? TIMELINE.lastSettlement : clamped;
  if (state.input.playedUpTo === next) return;
  state.input.playedUpTo = next;
  markDirty();
}

// ---------------------------------------------------------------- 左栏输入

export function setStartDate(date) {
  state.input.startDate = date;
  if (state.input.playedUpTo < date) state.input.playedUpTo = date;
  markDirty();
}

export function setAttributeValue(attributeId, value) {
  state.input.attributes[attributeId] = value;
  markDirty();
}

export function setInitialClub(clubId) {
  state.input.initialClub = clubId === UNSET ? null : clubId;
  markDirty();
}

// ---------------------------------------------------------------- 目标

export function addGlobalConstraint(goal) {
  state.input.globalConstraints.push(goal ?? defaultGoal());
  markDirty();
}

export function updateGlobalConstraint(index, patch) {
  state.input.globalConstraints[index] = { ...state.input.globalConstraints[index], ...patch };
  markDirty();
}

export function removeGlobalConstraint(index) {
  state.input.globalConstraints.splice(index, 1);
  markDirty();
}

export function addEndingGoal(goal) {
  state.input.endingGoals.push(goal ?? defaultGoal());
  markDirty();
}

export function updateEndingGoal(index, patch) {
  state.input.endingGoals[index] = { ...state.input.endingGoals[index], ...patch };
  markDirty();
}

export function removeEndingGoal(index) {
  state.input.endingGoals.splice(index, 1);
  markDirty();
}

export function addMiniGoal(goal) {
  state.input.miniGoals.push(goal);
  markDirty();
}

export function updateMiniGoal(index, goal) {
  state.input.miniGoals[index] = goal;
  markDirty();
}

export function removeMiniGoal(index) {
  state.input.miniGoals.splice(index, 1);
  markDirty();
}

/** 新小目标的形状：截止日 + 属性集合 + 求和阈值 + 方向。日期一律夹在时间轴内。 */
export function draftMiniGoal(deadline) {
  return {
    deadline: clampDeadline(deadline),
    attributes: [ATTRIBUTES[0].id],
    op: '>=',
    value: 50,
  };
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
