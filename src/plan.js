// 规划入口。
//
// 预先商定的接缝是 `plan(input) → PlanResult`：规则在**构造时**注入，所以调用方
// 只传 input。本票交付日历与决策点结构——指令仍全部空过，属性不动；求解器与
// 单日结算在后续票接入。

import { buildCalendar } from './calendar.js';
import { validateRules } from './rules.js';

export function createPlanner(rules) {
  const ruleProblems = validateRules(rules);

  return function plan(input) {
    if (ruleProblems.length > 0) {
      return { ok: false, status: 'invalid-rules', problems: ruleProblems };
    }

    const calendar = buildCalendar(rules, input);

    return {
      ok: true,
      status: 'calendar',
      note: '日历与决策点已就绪。指令仍然是空的，属性不动——求解器将在后续票接入。',
      startDate: input.startDate,
      endDate: rules.timeline.end,
      lastSettlement: rules.timeline.lastSettlement,
      days: calendar.days,
      weeks: calendar.weeks,
      decisionPoints: calendar.decisionPoints,
      summary: calendar.summary,
      ruleSummary: {
        attributes: rules.attributes.length,
        commands: rules.commands.length,
        clubs: rules.clubs.length,
      },
    };
  };
}
