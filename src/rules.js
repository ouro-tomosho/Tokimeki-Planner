// 领域规则的纯函数视图：校验与查询。
//
// 数据只存在于 data/rules.json 一处权威来源；本模块不加载数据，只接收它，
// 因此同一份代码既能在内联 Worker 中运行，也能在 Node 测试里直接 import。

import { isDate } from './dates.js';

const DIRECTIONS = new Set(['up', 'down']);
const KINDS = new Set(['daily', 'club']);
const OPS = new Set(['>=', '<']);

/** @returns {string[]} 问题列表，空数组表示通过 */
export function validateRules(rules) {
  const problems = [];
  const note = (msg) => problems.push(msg);

  if (!rules || typeof rules !== 'object') return ['规则不是对象'];

  checkAttributes(rules, note);
  checkClubs(rules, note);
  checkCommands(rules, note);
  checkGoals(rules, note);
  checkTimeline(rules, note);
  checkConstants(rules, note);

  return problems;
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
    if (Number.isFinite(a.default) && (a.default < a.min || a.default > a.max)) {
      note(`属性 ${a.id} 的默认值越界`);
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

  const start = rules.defaultStart;
  if (!start || typeof start !== 'object') {
    note('defaultStart 缺失');
    return;
  }
  for (const a of attributes) {
    const v = start[a.id];
    if (!Number.isFinite(v)) note(`defaultStart 缺少属性 ${a.id}`);
    else if (v < a.min || v > a.max) note(`defaultStart 的 ${a.id} 越界`);
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

    if (c.isRestCommand) {
      restCommands += 1;
      if (c.successRate !== 1) note(`休息指令 ${c.id} 的成功率必须为 1`);
    } else if (!(c.successRate > 0 && c.successRate < 1)) {
      note(`指令 ${c.id} 的成功率必须在 (0,1) 之间：${c.successRate}`);
    }

    if (!Number.isInteger(c.clubExperienceGain) || c.clubExperienceGain < 0) {
      note(`指令 ${c.id} 的社团经验增量非法`);
    } else if ((c.kind === 'club') !== (c.clubExperienceGain > 0)) {
      note(`指令 ${c.id} 的社团经验增量与指令类型不符`);
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

function checkGoals(rules, note) {
  const attributeIds = new Set((rules.attributes ?? []).map((a) => a.id));
  const ceId = rules.clubExperience?.id;

  const checkList = (list, label, allowClubExperience) => {
    if (!Array.isArray(list)) {
      note(`${label} 必须是数组`);
      return;
    }
    for (const g of list) {
      if (!attributeIds.has(g.attribute) && !(allowClubExperience && g.attribute === ceId)) {
        note(`${label} 引用了未知属性 ${g.attribute}`);
      }
      if (!OPS.has(g.op)) note(`${label} 的 op 非法：${g.op}`);
      if (!Number.isFinite(g.value)) note(`${label} 的 value 不是数字`);
    }
  };

  checkList(rules.defaultGlobalConstraints, 'defaultGlobalConstraints', false);
  checkList(rules.defaultEndingGoals, 'defaultEndingGoals', false);

  if (!Array.isArray(rules.defaultMiniGoals)) {
    note('defaultMiniGoals 必须是数组');
    return;
  }
  for (const g of rules.defaultMiniGoals) {
    if (!isDate(g.deadline)) note(`小目标截止日期格式错误：${g.deadline}`);
    if (!Array.isArray(g.attributes) || g.attributes.length === 0) {
      note(`小目标 ${g.deadline} 的属性集合为空`);
      continue;
    }
    for (const id of g.attributes) {
      if (!attributeIds.has(id) && id !== ceId) note(`小目标含未知属性 ${id}`);
    }
    if (!OPS.has(g.op)) note(`小目标的 op 非法：${g.op}`);
    if (!Number.isFinite(g.value)) note('小目标的 value 不是数字');
  }
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

function findOrThrow(list, id, label) {
  const hit = list?.find((x) => x.id === id);
  if (!hit) throw new Error(`未知${label}：${id}`);
  return hit;
}

export function attributeById(rules, id) {
  return findOrThrow(rules.attributes, id, '属性');
}

export function commandById(rules, id) {
  return findOrThrow(rules.commands, id, '指令');
}

export function clubById(rules, id) {
  return findOrThrow(rules.clubs, id, '社团');
}

export function attributeIds(rules) {
  return rules.attributes.map((a) => a.id);
}

export function allTrackedIds(rules) {
  return [...attributeIds(rules), rules.clubExperience.id];
}

export function commandsByKind(rules, kind) {
  return rules.commands.filter((c) => c.kind === kind);
}
