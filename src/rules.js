// 规则文件（data/rules.json）的自校验。
//
// 这是数据的唯一权威来源的看门人：字段之间的一致性（社团指令必属某社团、
// 休息指令必不失手、每条指令的变动必覆盖全部属性）都在这里兜住。

import { isDate } from './dates.js';
import { goalProblems, miniGoalProblems } from './goals.js';

const DIRECTIONS = new Set(['up', 'down']);
const KINDS = new Set(['daily', 'club']);

/** @returns {string[]} 问题列表，空数组表示通过 */
export function validateRules(rules) {
  if (!rules || typeof rules !== 'object') return ['规则不是对象'];

  const problems = [];
  const note = (msg) => problems.push(msg);

  checkAttributes(rules, note);
  checkClubs(rules, note);
  checkCommands(rules, note);
  checkGoals(rules, problems);
  checkTimeline(rules, note);
  checkConstants(rules, note);

  return problems;
}

function goalContext(rules, allowClubExperience) {
  return {
    attributeIds: new Set((rules.attributes ?? []).map((a) => a.id)),
    clubExperienceId: rules.clubExperience?.id,
    allowClubExperience,
  };
}

function checkAttributes(rules, note) {
  const attributes = rules.attributes;
  if (!Array.isArray(attributes) || attributes.length === 0) {
    note('attributes 必须是非空数组');
    return;
  }
  const seen = new Set();
  for (const a of attributes) {
    if (seen.has(a.id)) note(`属性 id 重复：${a.id}`);
    seen.add(a.id);
    if (typeof a.name !== 'string' || a.name === '') note(`属性 ${a.id} 缺少名称`);
    if (!DIRECTIONS.has(a.direction)) note(`属性 ${a.id} 的 direction 非法：${a.direction}`);
    if (!Number.isFinite(a.min) || !Number.isFinite(a.max) || a.min >= a.max) {
      note(`属性 ${a.id} 的上下限非法`);
    }
  }
  if (attributes.filter((a) => a.direction === 'down').length !== 1) {
    note('必须恰好有一项负面指标');
  }

  const ce = rules.clubExperience;
  if (!ce || typeof ce.id !== 'string') {
    note('clubExperience 元数据缺失');
  } else if (attributes.some((a) => a.id === ce.id)) {
    note(`社团经验 id 与属性 id 冲突：${ce.id}`);
  }

  // 默认起点是起始属性的唯一权威；属性表里不再重复存一份默认值。
  const start = rules.defaultStart;
  if (!start || typeof start !== 'object') {
    note('defaultStart 缺失');
    return;
  }
  for (const a of attributes) {
    const value = start[a.id];
    if (!Number.isFinite(value)) note(`defaultStart 缺少属性 ${a.id}`);
    else if (value < a.min || value > a.max) note(`defaultStart 的 ${a.id} 越界`);
  }
  for (const key of Object.keys(start)) {
    if (!attributes.some((a) => a.id === key)) note(`defaultStart 含未知属性 ${key}`);
  }
}

function checkClubs(rules, note) {
  if (!Array.isArray(rules.clubs) || rules.clubs.length === 0) {
    note('clubs 必须是非空数组');
    return;
  }
  const seen = new Set();
  for (const c of rules.clubs) {
    if (seen.has(c.id)) note(`社团 id 重复：${c.id}`);
    seen.add(c.id);
    if (typeof c.name !== 'string' || c.name === '') note(`社团 ${c.id} 缺少名称`);
  }
}

function checkCommands(rules, note) {
  const commands = rules.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    note('commands 必须是非空数组');
    return;
  }
  const attributeIds = new Set((rules.attributes ?? []).map((a) => a.id));
  const clubIds = new Set(rules.clubs.map((c) => c.id));
  const seen = new Set();
  let restCommands = 0;

  for (const c of commands) {
    if (seen.has(c.id)) note(`指令 id 重复：${c.id}`);
    seen.add(c.id);
    if (typeof c.name !== 'string' || c.name === '') note(`指令 ${c.id} 缺少名称`);
    if (!KINDS.has(c.kind)) note(`指令 ${c.id} 的 kind 非法：${c.kind}`);

    if (c.kind === 'club') {
      if (!clubIds.has(c.clubId)) note(`指令 ${c.id} 的社团未知：${c.clubId}`);
    } else if (c.clubId != null) {
      note(`日常指令 ${c.id} 不应绑定社团`);
    }

    // 社团经验的增量由 kind 与 clubExperienceGain 常量共同决定，指令表里不重复记录。
    //
    // isRestCommand 与 successRate 记录的是两件事——「这是那条特殊指令」与「它的
    // 成功率是多少」——两条都保留，由下面这行校验锁死一致性，不允许只留一条。
    if (c.isRestCommand) {
      restCommands += 1;
      if (c.successRate !== 1) note(`休息指令 ${c.id} 的成功率必须为 1`);
    } else if (!(c.successRate > 0 && c.successRate < 1)) {
      note(`指令 ${c.id} 的成功率必须在 (0,1) 之间：${c.successRate}`);
    }

    if (!c.effects || typeof c.effects !== 'object') {
      note(`指令 ${c.id} 缺少 effects`);
      continue;
    }
    for (const key of Object.keys(c.effects)) {
      if (!attributeIds.has(key)) note(`指令 ${c.id} 含未知属性 ${key}`);
      if (!Number.isFinite(c.effects[key])) note(`指令 ${c.id} 的 ${key} 变动不是数字`);
    }
    for (const id of attributeIds) {
      if (!(id in c.effects)) note(`指令 ${c.id} 缺少属性 ${id} 的变动`);
    }
  }

  if (restCommands !== 1) note(`必须恰好有一条休息指令，实际 ${restCommands} 条`);
}

function checkGoals(rules, problems) {
  const plain = goalContext(rules, false);
  problems.push(...goalProblems(rules.defaultGlobalConstraints, 'defaultGlobalConstraints', plain));
  problems.push(...goalProblems(rules.defaultEndingGoals, 'defaultEndingGoals', plain));
  problems.push(
    ...miniGoalProblems(rules.defaultMiniGoals, 'defaultMiniGoals', goalContext(rules, true)),
  );
}

function checkTimeline(rules, note) {
  const t = rules.timeline;
  if (!t) {
    note('timeline 缺失');
    return;
  }
  for (const key of ['start', 'end', 'lastSettlement']) {
    if (!isDate(t[key])) note(`timeline.${key} 格式错误：${t[key]}`);
  }
  if (isDate(t.start) && isDate(t.lastSettlement) && t.start >= t.lastSettlement) {
    note('timeline.start 必须早于 lastSettlement');
  }
  if (isDate(t.lastSettlement) && isDate(t.end) && t.lastSettlement >= t.end) {
    note('timeline.lastSettlement 必须早于 end');
  }
  if (!isDate(rules.clubUnlockDate)) {
    note(`clubUnlockDate 格式错误：${rules.clubUnlockDate}`);
  }
}

function checkConstants(rules, note) {
  if (!Number.isInteger(rules.fixedPointScale) || rules.fixedPointScale <= 0) {
    note('fixedPointScale 必须是正整数');
  }
  const bonus = rules.restDayBonus;
  if (!bonus) {
    note('restDayBonus 缺失');
  } else {
    for (const key of ['daily', 'club', 'restCommandNegative']) {
      if (!Number.isFinite(bonus[key]) || bonus[key] < 1) note(`restDayBonus.${key} 非法`);
    }
  }
  const gain = rules.clubExperienceGain;
  if (!gain) note('clubExperienceGain 缺失');
  else {
    for (const key of ['weekday', 'restDay']) {
      if (!Number.isInteger(gain[key]) || gain[key] < 0) note(`clubExperienceGain.${key} 非法`);
    }
  }
}
