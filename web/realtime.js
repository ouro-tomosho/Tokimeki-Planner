// 实时规划的纯数据层：给定「已玩到」与求解结果，回答
//   · 下一个要确认的槽位是什么（活动 / 日指令 / 周指令 / 自动结算）
//   · 这个槽位的推荐指令（自动档）
//   · 确认后记录怎么写、回到某天怎么裁
// 不含 DOM，方便用 Node 直接断言；界面只负责把这几个答案渲染出来。

import { addDays, weekStartOf, weekdayOf } from '../src/dates.js';
import { createClubLookup } from '../src/calendar.js';

/** 只有这三类槽位需要使用者确认；`settle` 是自动结算，不进当前槽位。 */
const DECISION_KINDS = new Set(['activity', 'day-command', 'week-command']);

/**
 * 下一个需要确认的槽位。
 *
 * `plan.sequence` 是整条时间轴上的有序事件（见 src/calendar.js 的 buildSequence）。
 * 当前日期当天快照已经发生，所以从**严格晚于** `playedUpTo` 的第一条决策事件起算；
 * 只剩自动结算时返回 null（时间轴走到头了）。
 *
 * @returns {{date: string, kind: string, isRestDay: boolean} | null}
 */
export function currentSlot(plan, playedUpTo, after = null) {
  const entries = plan?.sequence ?? [];
  let start = 0;
  if (after) {
    const idx = entries.findIndex((entry) => entry.date === after.date && entry.kind === after.kind);
    if (idx >= 0) start = idx + 1;
  }
  for (let i = start; i < entries.length; i += 1) {
    const entry = entries[i];
    if (after ? entry.date < playedUpTo : entry.date <= playedUpTo) continue;
    if (!DECISION_KINDS.has(entry.kind)) continue;
    const day = plan.days?.find((item) => item.date === entry.date);
    return {
      date: entry.date,
      kind: entry.kind,
      isRestDay: Boolean(day?.isRestDay),
    };
  }
  return null;
}

/**
 * 这个槽位的推荐指令（自动档）。
 *
 * 先看使用者是否已经钉住（`weekCommands` / `dayCommands`），再看求解器排定的指令，
 * 最后退回 `plan` 的实际生效指令。活动槽位没有"选择"，返回它的强制指令或空过。
 */
export function recommendedCommand(plan, input, slot, assignments = null) {
  if (!slot) return null;
  const day = plan?.days?.find((item) => item.date === slot.date);
  if (slot.kind === 'activity') {
    return day?.effectiveCommandId ?? null;
  }
  if (slot.kind === 'week-command') {
    const weekStart = slot.date;
    const pinned = input?.weekCommands?.[weekStart];
    if (pinned !== undefined) return pinned;
    return assignments?.weeks?.[weekStart] ?? null;
  }
  const pinned = input?.dayCommands?.[slot.date];
  if (pinned !== undefined) return pinned;
  return assignments?.days?.[slot.date] ?? day?.effectiveCommandId ?? null;
}

/** 活动/加入/切换/体育强制这类槽位只允许"确认"，不允许改指令。 */
export function isConfirmOnly(slot) {
  return slot?.kind === 'activity';
}

/**
 * 「自动确认」与「手动确认」的区别只在这里表达：
 *   auto   沿用推荐（求解器排定的）指令
 *   manual 使用者手选的指令；空过用 null
 * 两者都要写进输入，才能让 `plan()` 与之后的推进看到同一份事实。
 */
export function slotAssignment(slot, input, plan, assignments, { mode, manualCommand = null } = {}) {
  if (!slot) return null;
  if (mode === 'manual') return { commandId: manualCommand };
  return { commandId: recommendedCommand(plan, input, slot, assignments) };
}

/**
 * 确认一个槽位后，把这一天追加进记录。
 *
 * 记录只存**最终值**：日期、实际执行的指令、结算后的属性；不存任何中间计算，
 * 也不存整份日程（ADR-0011：完整日程不暴露给使用者）。
 */
export function appendRecord(record, day) {
  if (!day) return record;
  const entry = {
    date: day.date,
    commandId: day.effectiveCommandId ?? null,
    isEmpty: Boolean(day.isEmpty),
    isActivity: Boolean(day.isActivity),
    isRestDay: Boolean(day.isRestDay),
    attributes: Object.fromEntries(
      Object.entries(day.attributes ?? {}).map(([id, value]) => [id, Math.floor(value)]),
    ),
  };
  const rest = (record ?? []).filter((item) => item.date !== day.date);
  return [...rest, entry].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 回到某一天：裁掉记录里严格晚于这一天的条目，并返回该天的最终属性快照。
 * 找不到快照时返回 `attributes: null`，调用方应保留当前属性、只移动日期。
 */
export function rewindRecord(record, date) {
  const history = (record ?? []).filter((item) => item.date <= date);
  const snapshot = history.find((item) => item.date === date) ?? null;
  return { record: history, attributes: snapshot?.attributes ?? null, day: snapshot };
}

/**
 * 小目标/结局目标的跳转按钮数据：未过期且未达成的才给按钮。
 * 过期目标的 `state === 'expired'`，界面显示「已跳过」而不是跳转。
 */
export function goalJumps(goals) {
  const items = goals?.items ?? [];
  return items
    .filter((item) => item.source === 'mini' || item.source === 'ending')
    .map((item) => ({
      id: item.id,
      label: item.label,
      date: item.date,
      state: item.state,
      expired: item.state === 'expired',
      achieved: item.state === 'met',
      shortfall: item.shortfall,
      op: item.op,
      value: item.value,
      actual: item.actual,
    }));
}

/**
 * 当前周/下一个休息日的两个快捷槽位（界面的「本周」「休息日」卡片）。
 * 周指令的键是周锚点；休息日只取严格晚于当前日期、且不是活动/加入/切换强制的休息日。
 */
export function weekAndRestSlots(plan, playedUpTo) {
  const days = (plan?.days ?? []).filter((day) => day.date > playedUpTo);
  const weekStart = weekStartOf(addDays(playedUpTo, 1));
  const restDay = days.find((day) => day.isRestDay && !day.isForced && !day.isActivity) ?? null;
  return {
    weekStart,
    week: { kind: 'week-command', date: weekStart },
    rest: restDay ? { kind: 'day-command', date: restDay.date, isRestDay: true } : null,
  };
}

/** 某一天的星期名，界面用。 */
export function weekdayLabel(date) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekdayOf(date)];
}

/** 这个日期是否在时间轴内、且严格晚于当前日期。 */
export function isFutureDate(rules, playedUpTo, date) {
  return date > playedUpTo && date >= rules.timeline.start && date <= rules.timeline.end;
}

/** 当前社团（切换后已生效的那个）。 */
export function clubOn(input, rules, date) {
  return createClubLookup(input, rules)(date) ?? null;
}
