// 日历与决策点结构。
//
// 决策单位是周，结算单位是天。一个自然周 = 周日（第 1 天）+ 平日（周一至周六）。
// 纯函数：只吃规则与输入，不碰 DOM，因此同一份代码既能在内联 Worker 里跑，
// 也能在 Node 测试里通过 plan(input) 直接断言。

import { addDays, weekStartOf, weekdayOf } from './dates.js';

export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 该周的周指令是否被显式置空——该周的平日因此空过。 */
function isWeekCleared(weekCommands, weekStart) {
  return weekCommands[weekStart] === null;
}

/**
 * 一天的「空过」有三个来源，返回是哪一个（`null` 表示照常结算）：
 *   'day'          该日在 input.skippedDays 里（指定某一天跳过）
 *   'day-command'  该休息日的日指令被显式置空
 *   'week'         该日是平日，且其周锚点的周指令被显式置空
 */
function resolveSkipSource(date, isRestDay, weekStart, input, skippedDaySet) {
  if (skippedDaySet.has(date)) return 'day';
  if (isRestDay && input.dayCommands[date] === null) return 'day-command';
  if (!isRestDay && isWeekCleared(input.weekCommands, weekStart)) return 'week';
  return null;
}

export function buildCalendar(rules, input) {
  const { start: timelineStart, end, lastSettlement } = rules.timeline;
  const restDays = new Set(input.restDays);
  const skippedDaySet = new Set(input.skippedDays);
  const startDayIsGameOpening = input.startDate === timelineStart;

  const days = [];
  for (let date = input.startDate; date <= end; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    const weekStart = weekStartOf(date);
    const isRestDay = weekday === 0 || restDays.has(date);

    const skipSource = resolveSkipSource(date, isRestDay, weekStart, input, skippedDaySet);
    const isEmpty = skipSource !== null;
    const isGameOpening = startDayIsGameOpening && date === input.startDate;
    const isTimelineEnd = date === end;
    const isSettled = !isEmpty && !isGameOpening && !isTimelineEnd;

    const declared = isRestDay ? input.dayCommands[date] : input.weekCommands[weekStart];

    days.push({
      date,
      weekday,
      weekdayName: WEEKDAY_NAMES[weekday],
      weekStart,
      isRestDay,
      isEmpty,
      skipSource,
      isSettled,
      commandId: isEmpty ? null : (declared ?? null),
    });
  }

  const clearedWeeks = new Set(
    Object.keys(input.weekCommands).filter((weekStart) =>
      isWeekCleared(input.weekCommands, weekStart),
    ),
  );

  return {
    days,
    weeks: groupWeeks(days, clearedWeeks),
    sequence: buildSequence(days),
    summary: {
      totalDays: days.length,
      settledDays: days.filter((d) => d.isSettled).length,
      emptyDays: days.filter((d) => d.isEmpty).length,
      restDays: days.filter((d) => d.isRestDay).length,
      weeks: new Set(days.map((d) => d.weekStart)).size,
    },
    lastSettlement,
  };
}

function groupWeeks(days, clearedWeeks) {
  const weeks = [];
  let current = null;

  for (const day of days) {
    if (!current || current.start !== day.weekStart) {
      current = {
        start: day.weekStart,
        end: addDays(day.weekStart, 6),
        isCleared: clearedWeeks.has(day.weekStart),
        firstDay: day.date,
        lastDay: day.date,
        days: [],
      };
      weeks.push(current);
    }
    current.lastDay = day.date;
    current.days.push(day.date);
  }
  return weeks;
}

/**
 * 时间轴上的有序事件。`kind` 取三种值：
 *   'day-command'   选择某一天的日指令
 *   'settle'        该日结算
 *   'week-command'  选择该周的周指令
 *
 * 完整周的次序是「周日日指令 → 周日结算 → 本周周指令 → 各平日结算」；被标记为
 * 休息日的平日，其日指令决策插在该日结算之前；首周没有周日落在时间轴内时，
 * 周指令决策落在首周第一次结算之前。空过或起止例外的日子不产生任何事件。
 */
function buildSequence(days) {
  // 只有存在「会结算的平日」时，这一周才真的需要一个周指令决策。
  const weekHasSettledWeekday = new Set();
  for (const day of days) {
    if (day.weekday !== 0 && day.isSettled) weekHasSettledWeekday.add(day.weekStart);
  }

  const entries = [];
  const handledWeek = new Set();

  for (const day of days) {
    const push = (kind) => entries.push({ date: day.date, kind });
    const needsWeekCommand = weekHasSettledWeekday.has(day.weekStart);

    if (!handledWeek.has(day.weekStart)) {
      handledWeek.add(day.weekStart);

      if (day.date === day.weekStart) {
        if (day.isSettled) push('day-command');
        if (day.isSettled) push('settle');
        if (needsWeekCommand) push('week-command');
      } else {
        // 首周没有周日落在时间轴内：周指令决策落在首周第一次结算之前
        if (needsWeekCommand) push('week-command');
        if (day.isRestDay && day.isSettled) push('day-command');
        if (day.isSettled) push('settle');
      }
      continue;
    }

    // 本周内被标记为休息日的日子，在该日结算之前插入它的日指令决策
    if (day.isRestDay && day.isSettled) push('day-command');
    if (day.isSettled) push('settle');
  }

  return entries.map((entry, order) => ({ ...entry, order }));
}
