// 日历与决策点结构。
//
// 决策单位是周，结算单位是天。一个自然周 = 周日（第 1 天）+ 平日（周一至周六）。
// **决策轴**与**加成轴**是分开的：
//   - 日指令日（休息日 ∪ 活动日）读自己的日指令，即使落在平日；
//   - 只有休息日享受 ×4 加成。
// 纯函数：只吃规则与输入，不碰 DOM，因此同一份代码既能在内联 Worker 里跑，
// 也能在 Node 测试里通过 plan(input) 直接断言。

import { addDays, weekStartOf, weekdayOf } from './dates.js';
import { clubCommandId, createClubLookupBase } from './clubs.js';
import { commandIdOf, isSkip } from './commands.js';

export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 该周的周指令是否被显式置空——该周的**非日指令日**平日因此空过。 */
function isWeekCleared(weekCommands, weekStart) {
  return weekCommands[weekStart] === null;
}

/**
 * 非活动日的「空过」来源（`null` 表示照常结算）：
 *   'day'          该日在 input.skippedDays 里（指定某一天跳过）
 *   'day-command'  该日指令日的日指令被显式置空
 *   'week'         该日是平日（非日指令日），且其周锚点的周指令被显式置空
 *
 * 活动日不适用使用者空过：活动绑定指令为 `跳过` 时才是空过，见 `buildCalendar`。
 */
function resolveSkipSource(date, isDayCommandDay, weekStart, input) {
  if (isDayCommandDay && input.dayCommands[date] === null) return 'day-command';
  if (!isDayCommandDay && isWeekCleared(input.weekCommands, weekStart)) return 'week';
  return null;
}

/**
 * 某一天实际执行的指令，以及它是从哪来的。
 *
 * 这是**唯一**的解析口径：使用者显式指定（含显式 null = 空过）→ 求解器的填空 →
 * 都没有就留空（待定）。日历、求解器、界面全部走这里，免得各写一份、然后悄悄分叉。
 *
 * 求解器可以选「跳过」（`SKIP_DAY`），它是空过的等价物，因此 `commandId` 解析为 `null`，
 * 但 `skip` 标记为 `true`，让界面能把"求解器跳过的"与"使用者显式空过的"分开显示。
 *
 * 活动日不走这里：活动绑定指令是硬强制，由 `buildCalendar` 直接写入 `commandId`。
 */
export function resolveCommand(input, assignments, slot) {
  const { isDayCommandDay, date, weekStart } = slot;
  const pinned = isDayCommandDay ? input.dayCommands[date] : input.weekCommands[weekStart];
  if (pinned !== undefined) {
    return { commandId: commandIdOf(pinned), source: 'pinned', skip: false };
  }

  const assigned = isDayCommandDay
    ? assignments?.dayCommands?.[date]
    : assignments?.weekCommands?.[weekStart];
  if (assigned !== undefined) {
    return { commandId: commandIdOf(assigned), source: 'assigned', skip: isSkip(assigned) };
  }

  return { commandId: null, source: 'none', skip: false };
}

/**
 * 活动条件是否命中当天社团。
 *
 * `when` 支持的字段：`clubId` / `clubCategory` / `excludeClubId` /
 * `excludeClubCategory`。没有 `when` 表示无条件命中。
 */
function matchesWhen(when, club, rules) {
  const definition = club ? rules.clubs.find((entry) => entry.id === club) : null;
  const category = definition?.category ?? null;
  if (when.clubId !== undefined && club !== when.clubId) return false;
  if (when.clubCategory !== undefined && category !== when.clubCategory) return false;
  if (when.excludeClubId !== undefined && club === when.excludeClubId) return false;
  if (when.excludeClubCategory !== undefined && category === when.excludeClubCategory) return false;
  return true;
}

/**
 * 某一天命中的活动；按**当天所在社团**解析条件与变体，没有命中返回 `null`。
 *
 * 变体按顺序匹配，最后一个无 `when` 的变体作为默认。条件不匹配且没有默认时，
 * 活动不生效（当天按普通日处理）。
 */
export function resolveActivity(rules, clubAt, date) {
  for (const activity of rules.calendar?.activities ?? []) {
    if (date < activity.start || date > activity.end) continue;
    const club = clubAt(date);
    for (const variant of activity.variants ?? [activity]) {
      if (!variant.when || matchesWhen(variant.when, club, rules)) {
        return { name: variant.name, command: variant.command, activity };
      }
    }
    return null;
  }
  return null;
}

/**
 * 活动实际强制的指令；`null` 表示活动不强制（`跳过`，或 `club`/`clubCamp` 但当前是回家社）。
 */
function forcedActivityCommand(rules, clubAt, date, activity) {
  if (!activity) return null;
  if (activity.command === 'skip') return null;
  if (activity.command === 'club' || activity.command === 'clubCamp') {
    return clubCommandId(rules, clubAt(date));
  }
  return activity.command;
}

/**
 * 日历口径的社团查询：切换/加入日要跳过被活动占用的周日。
 */
export function createClubLookup(input, rules) {
  return createClubLookupBase(input, rules, (date, club) =>
    resolveActivity(rules, () => club, date) === null);
}

export function buildCalendar(rules, input, assignments = null, clubAt = createClubLookup(input, rules)) {
  const { end, lastSettlement } = rules.timeline;
  // **休息日是游戏固定事实**，来自 `rules.calendar`，不是使用者的输入：
  // 周日天然是休息日，另有一批游戏内确定的节假日（由所有者逐日核对并写入规则）。
  const restDays = new Set(rules.calendar?.restDays ?? []);
  // 时间轴首日就是已玩到，它是**状态快照**：那一天的结算已经发生在游戏里，所以不结算。
  const snapshotDay = input.playedUpTo;

  const days = [];
  for (let date = input.playedUpTo; date <= end; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    const weekStart = weekStartOf(date);
    const isRestDay = weekday === 0 || restDays.has(date);

    // 活动日：走日指令轴；`club`/`clubCamp` 在回家社时按普通日处理（不强制）。
    const activity = resolveActivity(rules, clubAt, date);
    const forcedCommand = forcedActivityCommand(rules, clubAt, date, activity);
    const isActivitySkip = activity !== null && activity.command === 'skip';
    const isActivity = activity !== null && (isActivitySkip || forcedCommand !== null);

    // 社团加入/切换：最近的周日（跳过被活动占用的周日）；活动日优先。
    const isJoin = clubAt.joinDate !== null && date === clubAt.joinDate;
    const isSwitch = clubAt.switchDate !== null && date === clubAt.switchDate;
    const switchTarget = isSwitch ? clubAt.target : null;
    const joinCommand = isJoin ? clubCommandId(rules, clubAt.oldClub) : null;
    const switchCommand = isSwitch && switchTarget !== null
      ? clubCommandId(rules, switchTarget)
      : null;

    // 体育类社团：每月第 3 个周日的日指令强制为当前社团指令（活动/加入/切换优先）。
    const club = clubAt(date);
    const clubDefinition = club ? rules.clubs.find((entry) => entry.id === club) : null;
    const dayOfMonth = Number(date.slice(8, 10));
    const isThirdSunday = weekday === 0 && dayOfMonth >= 15 && dayOfMonth <= 21;
    const sportsCommand = !isActivity && !isJoin && !isSwitch
      && isThirdSunday && clubDefinition?.category === 'sports'
      ? clubCommandId(rules, club)
      : null;
    const isSports = sportsCommand !== null;

    const forced = isActivity
      ? { commandId: forcedCommand, source: 'activity' }
      : isSwitch && switchCommand !== null
        ? { commandId: switchCommand, source: 'switch' }
        : isJoin && joinCommand !== null
          ? { commandId: joinCommand, source: 'join' }
          : isSports
            ? { commandId: sportsCommand, source: 'sports' }
            : null;
    const isForced = forced !== null;
    const isDayCommandDay = isRestDay || isForced;

    const skipSource = isForced
      ? null
      : resolveSkipSource(date, isDayCommandDay, weekStart, input);
    const isEmpty = isActivity ? isActivitySkip : skipSource !== null;
    const isSnapshot = date === snapshotDay;
    const isTimelineEnd = date === end;

    const resolved = forced
      ?? (isEmpty
        ? { commandId: null, source: 'none', skip: false }
        : resolveCommand(input, assignments, { isDayCommandDay, date, weekStart }));

    // `isSettled` 表达"这一天要不要结算"：空过/跳过（`isEmpty`）、起点快照、终点都是 false，
    // 所以它们不会进结算。指令缺失（`commandId === null`）另由 `plan()` 按 null 跳过。
    const isSettled = !isEmpty && !isSnapshot && !isTimelineEnd;

    days.push({
      date,
      weekday,
      weekdayName: WEEKDAY_NAMES[weekday],
      weekStart,
      isRestDay,
      isDayCommandDay,
      isActivity,
      isActivitySkip,
      isSports,
      isForced,
      isJoin,
      isSwitch,
      switchTarget,
      activity: activity ? { name: activity.name, command: activity.command } : null,
      isEmpty,
      skipSource,
      isSkipped: resolved.skip,
      isSettled,
      commandId: resolved.commandId,
      commandSource: resolved.source,
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
      activityDays: days.filter((d) => d.isActivity).length,
      forcedDays: days.filter((d) => d.isForced).length,
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
 * 时间轴上的有序事件。`kind` 取四种值：
 *   'activity'      活动日（事件槽：显示活动名称/绑定指令，只确认）
 *   'day-command'   选择某个**非活动**日指令日的日指令
 *   'settle'        该日结算
 *   'week-command'  选择该周的周指令
 *
 * 完整周的次序是「周日事件/日指令 → 周日结算 → 本周周指令 → 各平日结算」；
 * 活动日不产生日指令决策（指令是强制的）。首周没有周日落在时间轴内时，周指令决策
 * 落在首周第一次结算之前。空过或起止例外的日子不产生任何事件。
 */
function buildSequence(days) {
  // 只有存在「会结算、且不是日指令日的平日」时，这一周才真的需要一个周指令决策。
  const weekHasSettledWeekday = new Set();
  for (const day of days) {
    if (!day.isDayCommandDay && day.isSettled) weekHasSettledWeekday.add(day.weekStart);
  }

  const entries = [];
  const handledWeek = new Set();

  for (const day of days) {
    const push = (kind) => entries.push({ date: day.date, kind });
    const needsWeekCommand = weekHasSettledWeekday.has(day.weekStart);

    if (!handledWeek.has(day.weekStart)) {
      handledWeek.add(day.weekStart);

      if (day.date === day.weekStart) {
        if (day.isForced) push('activity');
        else if (day.isDayCommandDay && day.isSettled) push('day-command');
        if (day.isSettled) push('settle');
        if (needsWeekCommand) push('week-command');
      } else {
        // 首周没有周日落在时间轴内：周指令决策落在首周第一次结算之前
        if (needsWeekCommand) push('week-command');
        if (day.isForced) push('activity');
        if (day.isSettled) push('settle');
      }
      continue;
    }

    // 本周内的日子：活动/体育强制是事件；非强制的日指令日有日指令决策；再结算。
    if (day.isForced) push('activity');
    if (day.isDayCommandDay && !day.isForced && day.isSettled) push('day-command');
    if (day.isSettled) push('settle');
  }

  return entries.map((entry, order) => ({ ...entry, order }));
}
