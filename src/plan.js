// 规划入口。
//
// 预先商定的接缝是 `plan(input) → PlanResult`：规则在**构造时**注入，所以调用方
// 只传 input。本票只交付骨架——求解器在后续票中接入，因此现在诚实地返回
// status: 'skeleton'，而不是伪造一份日程。

import { validateRules } from './rules.js';

export function createPlanner(rules) {
  const ruleProblems = validateRules(rules);

  return function plan(input) {
    if (ruleProblems.length > 0) {
      return { ok: false, status: 'invalid-rules', problems: ruleProblems };
    }

    return {
      ok: true,
      status: 'skeleton',
      note: '骨架已就绪：数据、时间轴与内联 Worker 通道均已打通，求解器将在后续票中接入。',
      startDate: input.startDate,
      endDate: rules.timeline.end,
      lastSettlement: rules.timeline.lastSettlement,
      ruleSummary: {
        attributes: rules.attributes.length,
        commands: rules.commands.length,
        clubs: rules.clubs.length,
      },
    };
  };
}
