// 规划入口。
//
// 这是预先商定的最高层接缝：plan(input) → PlanResult。
// 本票只交付骨架，求解器在后续票中接入；因此这里诚实返回 status: 'skeleton'，
// 而不是伪造一份日程。

import { validateRules } from './rules.js';

export function plan(input, rules) {
  const problems = validateRules(rules);
  if (problems.length > 0) {
    return { ok: false, status: 'invalid-rules', problems };
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
      fixedPointScale: rules.fixedPointScale,
    },
  };
}
