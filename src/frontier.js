// 「设为已玩到」的领域语义：把时间轴起点推到那一天（见 ADR-0004）。
//
// 合并起点与已玩到之后，这一个动作同时是三件事：
//   1. 起点前移到 date；
//   2. 当前属性、起始社团、社团经验换成**求解结果在那一天的结算后状态**——
//      那一天在新区间里是起点快照（不结算，见 src/calendar.js），所以接过来不会重复计入；
//   3. 该日之前的显式指定清掉：它们在新区间之外，留着只会让人以为还生效。
//
// 属性按游戏口径**向下取整**（与约束判定 meets 的取整一致），因为输入里的属性必须是整数。

import { createClubLookup } from './clubs.js';
import { addDays } from './dates.js';
import { REST_DAY, WEEKDAY, clubExperienceGain } from './settlement.js';

/** 只保留键满足 `keep` 的那些项。 */
function keepEntries(map, keep) {
  return Object.fromEntries(Object.entries(map).filter(([key]) => keep(key)));
}

/**
 * date 那一刻**各社团**的经验：从旧起点往后重放求解结果里社团指令的执行。
 *
 * 求解结果每天只暴露"当前社团"那一份计数，所以光看那一天答不出"我离开 A 时 A 攒到了几"——
 * 而输入里的映射只有上一次快照的值。社团经验是每个社团各自一份，漏掉哪一份，
 * "设为已玩到"拿到的就不是完整的状态快照（见 ADR-0004 与规格 D5）。
 */
function clubExperienceAt(rules, input, planResult, date) {
  const experience = { ...input.clubExperience };
  const commands = new Map(rules.commands.map((command) => [command.id, command]));
  const limits = rules.clubExperience;

  for (const day of planResult.days) {
    // 只重放"旧起点之后、date 之前（含）"这一段：旧起点当天的状态已经在映射里。
    if (day.date <= input.playedUpTo || day.date > date) continue;
    if (!day.isSettled || !day.commandId || day.commandBlocked) continue;

    const earned = clubExperienceGain(
      rules,
      commands.get(day.commandId),
      day.isRestDay ? REST_DAY : WEEKDAY,
    );
    if (earned === 0) continue;
    const clubId = commands.get(day.commandId).clubId;
    experience[clubId] = Math.min(limits.max, Math.max(limits.min, (experience[clubId] ?? 0) + earned));
  }
  return experience;
}

/**
 * 能不能从那一天取到状态快照？只有**往后推**、并且求解结果覆盖那一天时才行。
 * 往回退没有历史可以重放，只能把日期挪回去、状态保持原样（调用方负责说清楚）。
 */
export function canTakeSnapshot(input, planResult, date) {
  return date > input.playedUpTo && Boolean(planResult?.days?.some((entry) => entry.date === date));
}

/**
 * @param rules      规则（社团经验的增速与上限从这里取）
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
    clubExperience: clubExperienceAt(rules, input, planResult, date),
    initialClub: club ?? null,
    // 起点当天已经折算进 initialClub，所以保留下来的切换都严格晚于它。
    clubChanges: input.clubChanges.filter((change) => change.date > date),
    restDays: input.restDays.filter((entry) => entry >= date),
    skippedDays: input.skippedDays.filter((entry) => entry >= date),
    dayCommands: keepEntries(input.dayCommands, (key) => key >= date),
    // 周指令以周锚点为键：跨过起点的那个自然周还剩几天，那一周的周指令就还有效。
    weekCommands: keepEntries(input.weekCommands, (key) => addDays(key, 6) >= date),
  };
}
