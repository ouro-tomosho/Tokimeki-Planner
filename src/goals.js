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

/**
 * 达标清单的**显示顺序**（只影响显示，输入数组原样不动）。
 *
 *   'attribute' 结局目标与全局约束：按属性在 `rules.attributes` 里的次序，
 *               也就是出厂默认目标书写的那套顺序（体力→…→压力）；
 *   'deadline'  小目标：按截止日期从早到晚。
 *
 * 同一键内保持**录入顺序**，因为行的编辑与删除动作靠的是输入数组的下标，
 * 不是显示位置。返回的是下标序列。
 */
export function goalDisplayOrder(rules, goals, kind) {
  // 每个 kind 一个取键函数：口味写在一张表里，校验与取键就不会各写一份、然后悄悄分叉。
  const keyOf = {
    attribute: () => {
      const rank = new Map(rules.attributes.map((attribute, index) => [attribute.id, index]));
      return (goal) => rank.get(goal.attribute) ?? rules.attributes.length;
    },
    deadline: () => (goal) => goal.deadline ?? '',
  }[kind];
  if (!keyOf) throw new Error(`未知的行序口径：${kind}`);

  const key = keyOf();
  return goals
    .map((goal, index) => ({ goal, index }))
    .sort((a, b) => {
      const left = key(a.goal);
      const right = key(b.goal);
      if (left < right) return -1;
      if (left > right) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.index);
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
