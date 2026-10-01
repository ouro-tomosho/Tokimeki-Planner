// 使用者输入的形状与校验。JSON 只承载输入，不承载结果。
//
// weekCommands / dayCommands 用「显式的 null」表示空过，用「键不存在」表示
// 尚未指定（交由求解器决定）。这两种状态必须能穿过 JSON 往返而不被混淆。

import { attributeIds } from './rules.js';
import { isDate } from './dates.js';

export const CURRENT_VERSION = 1;

export function defaultInput(rules) {
  return {
    version: CURRENT_VERSION,
    startDate: rules.timeline.start,
    attributes: { ...rules.defaultStart },
    globalConstraints: structuredClone(rules.defaultGlobalConstraints),
    endingGoals: structuredClone(rules.defaultEndingGoals),
    miniGoals: structuredClone(rules.defaultMiniGoals),
    initialClub: null,
    clubChanges: [],
    weekCommands: {},
    dayCommands: {},
    restDays: [],
    skippedDays: [],
  };
}

export function toJson(input) {
  return JSON.stringify(input, null, 2);
}

/** 解析并校验；不合法时抛出带原因的错误。 */
export function fromJson(text, rules) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`不是合法的 JSON：${error.message}`);
  }
  const problems = validateInput(parsed, rules);
  if (problems.length > 0) throw new Error(`输入不合法：${problems[0]}`);
  return parsed;
}

/** @returns {string[]} 问题列表，空数组表示通过 */
export function validateInput(input, rules) {
  if (!input || typeof input !== 'object') return ['输入不是对象'];

  const problems = [];
  const attributeIdSet = new Set(attributeIds(rules));
  const commandIds = new Set(rules.commands.map((c) => c.id));
  const clubIds = new Set(rules.clubs.map((c) => c.id));
  const ceId = rules.clubExperience.id;

  if (input.version !== CURRENT_VERSION) {
    problems.push(`版本号不受支持：${input.version}`);
  }

  if (!isDate(input.startDate)) {
    problems.push(`startDate 格式错误：${input.startDate}`);
  } else if (input.startDate < rules.timeline.start || input.startDate > rules.timeline.lastSettlement) {
    problems.push(`startDate 超出时间轴：${input.startDate}`);
  }

  checkAttributes(input, rules, problems);
  checkGoals(input.globalConstraints, 'globalConstraints', attributeIdSet, false, ceId, problems);
  checkGoals(input.endingGoals, 'endingGoals', attributeIdSet, false, ceId, problems);
  checkMiniGoals(input.miniGoals, attributeIdSet, ceId, problems);
  checkClub(input, clubIds, problems);
  checkCommandMap('weekCommands', input.weekCommands, commandIds, problems);
  checkCommandMap('dayCommands', input.dayCommands, commandIds, problems);
  checkDates('restDays', input.restDays, problems);
  checkDates('skippedDays', input.skippedDays, problems);

  return problems;
}

function checkAttributes(input, rules, problems) {
  const attributes = input.attributes;
  if (!attributes || typeof attributes !== 'object') {
    problems.push('缺少 attributes');
    return;
  }
  for (const a of rules.attributes) {
    const value = attributes[a.id];
    if (value === undefined) {
      problems.push(`输入缺少属性 ${a.id}`);
    } else if (!Number.isInteger(value)) {
      problems.push(`属性 ${a.id} 的值必须是整数`);
    } else if (value < a.min || value > a.max) {
      problems.push(`属性 ${a.id} 的值 ${value} 超出 [${a.min}, ${a.max}]`);
    }
  }
  for (const key of Object.keys(attributes)) {
    if (!rules.attributes.some((a) => a.id === key)) problems.push(`输入含未知属性 ${key}`);
  }
}

function checkGoals(list, label, attributeIdSet, allowClubExperience, ceId, problems) {
  if (!Array.isArray(list)) {
    problems.push(`${label} 必须是数组`);
    return;
  }
  for (const goal of list) {
    if (!attributeIdSet.has(goal?.attribute) && !(allowClubExperience && goal?.attribute === ceId)) {
      problems.push(`${label} 引用了未知属性 ${goal?.attribute}`);
    }
    if (goal?.op !== '>=' && goal?.op !== '<') problems.push(`${label} 的 op 非法：${goal?.op}`);
    if (!Number.isInteger(goal?.value)) problems.push(`${label} 的 value 必须是整数`);
  }
}

function checkMiniGoals(list, attributeIdSet, ceId, problems) {
  if (!Array.isArray(list)) {
    problems.push('miniGoals 必须是数组');
    return;
  }
  for (const goal of list) {
    if (!isDate(goal?.deadline)) problems.push(`miniGoals 的截止日期格式错误：${goal?.deadline}`);
    if (!Array.isArray(goal?.attributes) || goal.attributes.length === 0) {
      problems.push('miniGoals 的属性集合不能为空');
    } else {
      for (const id of goal.attributes) {
        if (!attributeIdSet.has(id) && id !== ceId) problems.push(`miniGoals 引用了未知属性 ${id}`);
      }
    }
    if (goal?.op !== '>=' && goal?.op !== '<') problems.push(`miniGoals 的 op 非法：${goal?.op}`);
    if (!Number.isInteger(goal?.value)) problems.push('miniGoals 的 value 必须是整数');
  }
}

function checkClub(input, clubIds, problems) {
  if (input.initialClub !== null && !clubIds.has(input.initialClub)) {
    problems.push(`initialClub 引用了未知社团 ${input.initialClub}`);
  }
  if (!Array.isArray(input.clubChanges)) {
    problems.push('clubChanges 必须是数组');
    return;
  }
  for (const change of input.clubChanges) {
    if (!isDate(change?.date)) problems.push(`clubChanges 的日期格式错误：${change?.date}`);
    if (change?.clubId !== null && !clubIds.has(change?.clubId)) {
      problems.push(`clubChanges 引用了未知社团 ${change?.clubId}`);
    }
  }
}

function checkCommandMap(label, map, commandIds, problems) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    problems.push(`缺少 ${label}`);
    return;
  }
  for (const [date, commandId] of Object.entries(map)) {
    if (!isDate(date)) problems.push(`${label} 的键不是日期：${date}`);
    if (commandId === null) continue;
    if (!commandIds.has(commandId)) problems.push(`${label} 引用了未知指令 ${commandId}`);
  }
}

function checkDates(label, list, problems) {
  if (!Array.isArray(list)) {
    problems.push(`${label} 必须是数组`);
    return;
  }
  for (const date of list) {
    if (!isDate(date)) problems.push(`${label} 含非法日期：${date}`);
  }
}
