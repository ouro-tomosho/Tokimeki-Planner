// 规划入口。
//
// 预先商定的接缝是 `plan(input) → PlanResult`：规则在**构造时**注入，所以调用方
// 只传 input。本票把日历与单日结算接起来：每一天按它实际执行的指令结算，结果表
// 因此带上逐日属性。指令还没有被"求解"——没有指定时就是空过。

import { buildCalendar } from './calendar.js';
import { validateInput } from './input.js';
import { validateRules } from './rules.js';
import { REST_DAY, WEEKDAY, createSettlement } from './settlement.js';

export function createPlanner(rules) {
  const ruleProblems = validateRules(rules);
  const settleDay = createSettlement(rules);
  const scale = rules.fixedPointScale;

  const toScaled = (values) =>
    Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value * scale]));
  const toReal = (values) =>
    Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value / scale]));

  return function plan(input) {
    if (ruleProblems.length > 0) {
      return { ok: false, status: 'invalid-rules', problems: ruleProblems };
    }

    const inputProblems = validateInput(input, rules);
    if (inputProblems.length > 0) {
      return { ok: false, status: 'invalid-input', problems: inputProblems };
    }

    const calendar = buildCalendar(rules, input);

    let state = {
      attributes: toScaled(input.attributes),
      clubExperience: Object.fromEntries(rules.clubs.map((club) => [club.id, 0])),
    };

    const days = calendar.days.map((day) => {
      if (day.isSettled) {
        state = settleDay(state, day.commandId, day.isRestDay ? REST_DAY : WEEKDAY);
      }
      // 不结算的日子（空过、开局日、终点）属性原样带入下一天。
      return { ...day, attributes: toReal(state.attributes) };
    });

    return {
      ok: true,
      status: 'planned',
      startDate: input.startDate,
      endDate: rules.timeline.end,
      lastSettlement: rules.timeline.lastSettlement,
      days,
      weeks: calendar.weeks,
      sequence: calendar.sequence,
      summary: calendar.summary,
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
