// 编辑动作：把界面上的操作写进 `input`，并登记"待计算"。
//
// 一条硬规则：**这里从不改求解器给出的 assignments**。使用者显式指定的内容进 input，
// 求解器的填空只是填空（见 src/calendar.js 的 resolveCommand）。
//
// 「平日的指令就是周指令」这条领域规则在这里落地：给平日指定指令＝给它的周锚点写周指令。

import { canTakeSnapshot, rollForward } from '../src/frontier.js';
import { clampToLimits } from '../src/input.js';
import { isDate, weekStartOf, weekdayOf } from '../src/dates.js';
import {
  ATTRIBUTES,
  CHOICE_EMPTY,
  CHOICE_NO_CLUB,
  CLUB_EXPERIENCE,
  RULES,
  TIMELINE,
  UNSET,
  clampDeadline,
  clearResult,
  defaultGoal,
  flashWeek,
  focusDate,
  hooks,
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

/**
 * 「已玩到」：时间轴的起点。它既是"玩到哪了"，也是规划区间从这里开始——
 * 起点与已玩到已经合并成同一个日期（见 ADR-0004），所以只此一处入口。
 *
 * 往前推且有求解结果时，把那一天的**结算后状态**接过来（属性 / 起始社团 / 各社团经验），
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
      ? `起点已前移到 ${next}：当前属性、社团与社团经验取自那一天的结算结果，点「计算」重排。`
      : movedBack
        ? `起点已回退到 ${next}：没有历史可以重放，当前属性、社团与社团经验保持原样，请按当时的实际状态核对。`
        : `还没有计算结果：只把起点移到 ${next}，当前属性、社团与社团经验保持原样。`,
  );
}

// ---------------------------------------------------------------- 左栏输入

export function setAttributeValue(attributeId, value) {
  const attribute = ATTRIBUTES.find((entry) => entry.id === attributeId);
  state.input.attributes[attributeId] = clampToLimits(value, attribute);
  markDirty();
}

/** 某个社团已经攒下的经验——每个社团各自一份，是当前状态的一部分。 */
export function setClubExperience(clubId, value) {
  state.input.clubExperience = {
    ...state.input.clubExperience,
    [clubId]: clampToLimits(value, CLUB_EXPERIENCE),
  };
  markDirty();
}

export function setInitialClub(clubId) {
  state.input.initialClub = clubId === UNSET ? null : clubId;
  markDirty();
}

// ---------------------------------------------------------------- 目标

/** 阈值只认整数（见 validateInput），而 `type=number` 允许手输小数——落库前先取整。 */
function withIntegerThreshold(goal) {
  if (!Number.isFinite(goal?.value)) return goal;
  return { ...goal, value: Math.round(goal.value) };
}

export function addGlobalConstraint(goal) {
  state.input.globalConstraints.push(withIntegerThreshold(goal ?? defaultGoal()));
  markDirty();
}

export function updateGlobalConstraint(index, patch) {
  state.input.globalConstraints[index] = withIntegerThreshold({
    ...state.input.globalConstraints[index],
    ...patch,
  });
  markDirty();
}

export function removeGlobalConstraint(index) {
  state.input.globalConstraints.splice(index, 1);
  markDirty();
}

export function addEndingGoal(goal) {
  state.input.endingGoals.push(withIntegerThreshold(goal ?? defaultGoal()));
  markDirty();
}

export function updateEndingGoal(index, patch) {
  state.input.endingGoals[index] = withIntegerThreshold({
    ...state.input.endingGoals[index],
    ...patch,
  });
  markDirty();
}

export function removeEndingGoal(index) {
  state.input.endingGoals.splice(index, 1);
  markDirty();
}

export function addMiniGoal(goal) {
  state.input.miniGoals.push(withIntegerThreshold(goal));
  markDirty();
}

export function updateMiniGoal(index, goal) {
  state.input.miniGoals[index] = withIntegerThreshold(goal);
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
