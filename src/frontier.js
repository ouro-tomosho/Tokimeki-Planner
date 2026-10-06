// 「设为已玩到」的领域语义：把时间轴起点推到那一天（见 ADR-0004）。
//
// 合并起点与已玩到之后，这一个动作同时是三件事：
//   1. 起点前移到 date；
//   2. 当前属性、起始社团、社团经验换成**求解结果在那一天的结算后状态**——
//      那一天在新区间里是起点快照（不结算，见 src/calendar.js），所以接过来不会重复计入；
//   3. 该日之前的显式指定清掉：它们在新区间之外，留着只会让人以为还生效。
//
// 属性按游戏口径**向下取整**，因为输入里的属性必须是整数。

import { addDays } from './dates.js';
import { createClubLookup } from './clubs.js';

/** 只保留键满足 `keep` 的那些项。 */
function keepEntries(map, keep) {
  return Object.fromEntries(Object.entries(map).filter(([key]) => keep(key)));
}

/**
 * 能不能从那一天取到状态快照？只有**往后推**、并且求解结果覆盖那一天时才行。
 * 往回退没有历史可以重放，只能把日期挪回去、状态保持原样（调用方负责说清楚）。
 */
export function canTakeSnapshot(input, planResult, date) {
  return date > input.playedUpTo && Boolean(planResult?.days?.some((entry) => entry.date === date));
}

/**
 * @param rules      规则
 * @param input      当前输入
 * @param planResult `plan()` 的结果；没有它就只能移动日期（调用方负责判断）
 * @param date       新的已玩到日期
 */
export function rollForward(rules, input, planResult, date) {
  const day = planResult?.days?.find((entry) => entry.date === date);
  if (!day) return { ...input, playedUpTo: date };

  const club = createClubLookup(input)(date);
  return {
    ...input,
    playedUpTo: date,
    attributes: Object.fromEntries(
      Object.entries(day.attributes).map(([id, value]) => [id, Math.floor(value)]),
    ),
    initialClub: club ?? null,
    // 起点当天已经折算进 initialClub，所以保留下来的切换都严格晚于它。
    clubChanges: input.clubChanges.filter((change) => change.date > date),
    // 休息日**不是输入**（它是 rules.calendar 上的固定日历），所以这里没有可裁剪的副本。
    skippedDays: input.skippedDays.filter((entry) => entry >= date),
    dayCommands: keepEntries(input.dayCommands, (key) => key >= date),
    // 周指令以周锚点为键：跨过起点的那个自然周还剩几天，那一周的周指令就还有效。
    weekCommands: keepEntries(input.weekCommands, (key) => addDays(key, 6) >= date),
  };
}
