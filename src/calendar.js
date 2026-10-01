// 日历与决策点结构。
//
// 决策单位是周，结算单位是天。一个自然周 = 周日（第 1 天）+ 平日（周一至周六）。
// 纯函数：只吃规则与输入，不碰 DOM，因此同一份代码既能在内联 Worker 里跑，
// 也能在 Node 测试里通过 plan(input) 直接断言。

import { addDays, weekStartOf, weekdayOf } from './dates.js';

export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 空过的三个来源，任一成立该日即为空过：
 *   1. 该日在 input.skippedDays 里（指定某一天空过）
 *   2. 该日是平日，且其周锚点的周指令被显式置空（指定某一周空过）
 *   3. 该日是休息日，且它的日指令被显式置空
 */
export function buildCalendar(rules, input) {
  const { start: timelineStart, end, lastSettlement } = rules.timeline;
  const restDays = new Set(input.restDays);
  const skippedDays = new Set(input.skippedDays);

  const startDayIsGameOpening = input.startDate === timelineStart;
  const days = [];

  for (let date = input.startDate; date <= end; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    const weekStart = weekStartOf(date);
    const isRestDay = weekday === 0 || restDays.has(date);

    const skippedByDay = skippedDays.has(date);
    const skippedByWeek = !isRestDay && input.weekCommands[weekStart] === null;
    const skippedByDayCommand = isRestDay && input.dayCommands[date] === null;
    const isSkipped = skippedByDay || skippedByWeek || skippedByDayCommand;

    const isGameOpening = startDayIsGameOpening && date === input.startDate;
    const isTimelineEnd = date === end;
    const isSettled = !isSkipped && !isGameOpening && !isTimelineEnd;

    const declared = isRestDay ? input.dayCommands[date] : input.weekCommands[weekStart];

    days.push({
      date,
      weekday,
      weekdayName: WEEKDAY_NAMES[weekday],
      weekStart,
      isRestDay,
      isSkipped,
      isSettled,
      commandId: isSkipped ? null : (declared ?? null),
    });
  }

  return {
    days,
    weeks: groupWeeks(days, input),
    decisionPoints: buildDecisionPoints(days, input.startDate),
    summary: {
      totalDays: days.length,
      settledDays: days.filter((d) => d.isSettled).length,
      skippedDays: days.filter((d) => d.isSkipped).length,
      restDays: days.filter((d) => d.isRestDay).length,
      weeks: new Set(days.map((d) => d.weekStart)).size,
    },
    lastSettlement,
  };
}

function groupWeeks(days, input) {
  const weeks = [];
  let current = null;

  for (const day of days) {
    if (!current || current.start !== day.weekStart) {
      current = {
        start: day.weekStart,
        end: addDays(day.weekStart, 6),
        isSkipped: input.weekCommands[day.weekStart] === null,
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

function buildDecisionPoints(days, startDate) {
  const weekHasSettledWeekday = new Map();
  for (const day of days) {
    if (day.weekday !== 0 && day.isSettled) {
      weekHasSettledWeekday.set(day.weekStart, true);
    }
  }

  const points = [];
  const handledWeek = new Set();

  for (const day of days) {
    const pushing = (kind) => points.push({ date: day.date, kind });

    if (!handledWeek.has(day.weekStart)) {
      handledWeek.add(day.weekStart);

      if (day.date === day.weekStart) {
        // 完整周：周日日指令 → 周日结算 → 本周周指令
        if (day.isSettled) pushing('day-command');
        if (weekHasSettledWeekday.get(day.weekStart)) pushing('week-command');
      } else {
        // 首周没有周日落在时间轴内：周指令决策落在首周第一次结算之前
        if (weekHasSettledWeekday.get(day.weekStart)) pushing('week-command');
        if (day.isRestDay && day.isSettled) pushing('day-command');
      }
      continue;
    }

    // 本周内被标记为休息日的日子，在该日结算之前插入它的日指令决策
    if (day.isRestDay && day.isSettled) pushing('day-command');
  }

  return points.map((point, index) => ({ ...point, order: index }));
}
