// 目标与约束的形状校验。规则文件的默认目标与使用者输入的目标，
// 判定规则完全相同，因此共用同一套实现。

import { isDate } from './dates.js';

const OPS = new Set(['>=', '<']);

function isKnownTarget(id, context) {
  if (context.attributeIds.has(id)) return true;
  return context.allowClubExperience && id === context.clubExperienceId;
}

/** 逐项的 `(属性, 方向, 阈值)` 目标：用于全局约束与结局目标。 */
export function goalProblems(list, label, context) {
  if (!Array.isArray(list)) return [`${label} 必须是数组`];

  const problems = [];
  for (const goal of list) {
    if (!isKnownTarget(goal?.attribute, context)) {
      problems.push(`${label} 引用了未知属性 ${goal?.attribute}`);
    }
    if (!OPS.has(goal?.op)) problems.push(`${label} 的 op 非法：${goal?.op}`);
    if (!Number.isInteger(goal?.value)) problems.push(`${label} 的 value 必须是整数`);
  }
  return problems;
}

/** 带截止日期、阈值作用于属性集合求和的小目标。 */
export function miniGoalProblems(list, label, context) {
  if (!Array.isArray(list)) return [`${label} 必须是数组`];

  const problems = [];
  for (const goal of list) {
    if (!isDate(goal?.deadline)) problems.push(`${label} 的截止日期格式错误：${goal?.deadline}`);

    if (!Array.isArray(goal?.attributes) || goal.attributes.length === 0) {
      problems.push(`${label} 的属性集合不能为空`);
    } else {
      for (const id of goal.attributes) {
        if (!isKnownTarget(id, context)) problems.push(`${label} 引用了未知属性 ${id}`);
      }
    }

    if (!OPS.has(goal?.op)) problems.push(`${label} 的 op 非法：${goal?.op}`);
    if (!Number.isInteger(goal?.value)) problems.push(`${label} 的 value 必须是整数`);
  }
  return problems;
}
