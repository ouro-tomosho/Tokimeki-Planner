// 规划入口。
//
// 预先商定的接缝是 `plan(input) → PlanResult`：规则在**构造时**注入，所以调用方
// 只传 input。本票把日历、社团状态与单日结算接起来：每一天按它实际执行的指令结算，
// 不可用的社团指令不会被结算。指令还没有被"求解"——没有指定时就是待定。

import { buildCalendar } from './calendar.js';
import { clubBlockReason, createClubLookup, seededClubExperience } from './clubs.js';
import { evaluateGoals } from './constraints.js';
import { validateInput } from './input.js';
import { validateRules } from './rules.js';
import { REST_DAY, WEEKDAY, createSettlement } from './settlement.js';

export function createPlanner(rules) {
  const ruleProblems = validateRules(rules);
  const settleDay = createSettlement(rules);
  const commandsById = new Map(rules.commands.map((command) => [command.id, command]));
  const scale = rules.fixedPointScale;

  const toScaled = (values) =>
    Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value * scale]));
  const toReal = (values) =>
    Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value / scale]));

  return function plan(input, { assignments = null } = {}) {
    if (ruleProblems.length > 0) {
      return { ok: false, status: 'invalid-rules', problems: ruleProblems };
    }

    const inputProblems = validateInput(input, rules);
    if (inputProblems.length > 0) {
      return { ok: false, status: 'invalid-input', problems: inputProblems };
    }

    const calendar = buildCalendar(rules, input, assignments);
    const clubAt = createClubLookup(input);

    // 起点社团已经攒下的经验由输入直接给出（合并起点与已玩到之后没有历史可重放）。
    let state = {
      attributes: toScaled(input.attributes),
      clubExperience: seededClubExperience(rules, input, scale),
    };

    const days = calendar.days.map((day) => {
      const command = day.commandId ? commandsById.get(day.commandId) : null;
      // 社团指令受解锁日与「当前社团」限制；使用者写进来的指令若不可用，就不执行。
      const commandBlocked = command
        ? clubBlockReason(rules, command, clubAt(day.date), day.date)
        : null;

      if (day.isSettled && command && commandBlocked === null) {
        state = settleDay(state, command.id, day.isRestDay ? REST_DAY : WEEKDAY);
      }
      // 不结算的日子（空过、开局日、终点、指令不可用）属性原样带入下一天。
      const club = clubAt(day.date);
      return {
        ...day,
        commandBlocked,
        attributes: toReal(state.attributes),
        clubExperience: club ? (state.clubExperience[club] ?? 0) / scale : 0,
      };
    });

    return {
      ok: true,
      status: 'planned',
      playedUpTo: input.playedUpTo,
      endDate: rules.timeline.end,
      lastSettlement: rules.timeline.lastSettlement,
      days,
      weeks: calendar.weeks,
      sequence: calendar.sequence,
      summary: calendar.summary,
      goals: evaluateGoals(rules, input, days),
      finalAttributes: toReal(state.attributes),
      clubExperience: toReal(state.clubExperience),
      ruleSummary: {
        attributes: rules.attributes.length,
        commands: rules.commands.length,
        clubs: rules.clubs.length,
      },
    };
  };
}
