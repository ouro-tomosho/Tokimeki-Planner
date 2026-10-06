// 规则文件（data/rules.json）的自校验。
//
// 这是数据唯一权威来源的看门人：字段之间的一致性（社团指令必属某社团、
// 休息指令必不失手、每条指令的变动必覆盖全部 10 项属性、检查点引用已知属性）
// 都在这里兜住。

import { isDate } from './dates.js';

const DIRECTIONS = new Set(['up', 'down']);
const KINDS = new Set(['daily', 'club']);
const OPS = new Set(['>=', '<']);
const SOURCES = new Set(['global', 'mini', 'ending']);
/** 社团经验是唯一豁免"必须出现在结局检查点"的属性，见 checkCheckpoints。 */
const CLUB_EXPERIENCE_ID = 'clubExperience';

/** @returns {string[]} 问题列表，空数组表示通过 */
export function validateRules(rules) {
  if (!rules || typeof rules !== 'object') return ['规则不是对象'];

  const problems = [];
  const note = (msg) => problems.push(msg);

  checkAttributes(rules, note);
  checkClubs(rules, note);
  checkCommands(rules, note);
  checkCheckpoints(rules, note);
  checkTimeline(rules, note);
  checkConstants(rules, note);

  return problems;
}

function attributeIdsOf(rules) {
  return new Set((rules.attributes ?? []).map((a) => a.id));
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
    // 默认起点就存在属性表里，不再有第二处副本。
    if (!Number.isFinite(a.default)) note(`属性 ${a.id} 缺少 default 起点值`);
    else if (Number.isFinite(a.min) && (a.default < a.min || a.default > a.max)) {
      note(`属性 ${a.id} 的 default 越界`);
    }
  }

  if (attributes.filter((a) => a.direction === 'down').length !== 1) {
    note('必须恰好有一项负面指标');
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
  const attributeIds = attributeIdsOf(rules);
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

    // 休息指令的判据只有 successRate === 1 一条：不再用 isRestCommand 重复表达同一件事。
    if (c.successRate === 1) {
      restCommands += 1;
    } else if (!(c.successRate > 0 && c.successRate < 1)) {
      note(`指令 ${c.id} 的成功率必须在 (0,1) 之间或恒为 1：${c.successRate}`);
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

  if (restCommands !== 1) note(`必须恰好有一条永不失败的指令，实际 ${restCommands} 条`);
}

function checkCheckpoints(rules, note) {
  const checkpoints = rules.checkpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    note('checkpoints 必须是非空数组');
    return;
  }
  const attributeIds = attributeIdsOf(rules);
  const known = new Set();
  let ending = 0;

  for (const cp of checkpoints) {
    if (known.has(cp.id)) note(`检查点 id 重复：${cp.id}`);
    known.add(cp.id);
    if (!SOURCES.has(cp.source)) note(`检查点 ${cp.id} 的 source 非法：${cp.source}`);
    if (!OPS.has(cp.op)) note(`检查点 ${cp.id} 的 op 非法：${cp.op}`);
    if (!Number.isFinite(cp.value)) note(`检查点 ${cp.id} 的阈值不是数字`);

    const single = typeof cp.attribute === 'string';
    const set = Array.isArray(cp.attributes);
    if (!single && !set) note(`检查点 ${cp.id} 必须含 attribute 或 attributes`);
    if (single && set) note(`检查点 ${cp.id} 不能同时含 attribute 与 attributes`);
    for (const id of single ? [cp.attribute] : cp.attributes ?? []) {
      if (!attributeIds.has(id)) note(`检查点 ${cp.id} 引用未知属性：${id}`);
    }

    // global 的落点是"每周最后一天"，没有具体日期。
    if (cp.source === 'global') {
      if (cp.date != null) note(`全局检查点 ${cp.id} 的 date 必须为 null`);
    } else if (!isDate(cp.date)) {
      note(`检查点 ${cp.id} 的 date 格式错误：${cp.date}`);
    }

    if (cp.source === 'ending') {
      ending += 1;
      if (cp.date !== rules.timeline?.end) {
        note(`结局检查点 ${cp.id} 的 date 必须等于 timeline.end`);
      }
    }
  }

  if (ending === 0) note('至少要有 1 个结局检查点');
  // 结局检查点必须覆盖除**社团属性**以外的每一项属性，否则终值无从判定。
  // 社团经验是唯一豁免项：它是否增长取决于所有者加不加入社团，把它设为结局硬目标
  // 会在"未加入社团"时产生一条恒不可达的目标（那会把整个搜索的排序压平）。
  for (const id of attributeIds) {
    if (id === CLUB_EXPERIENCE_ID) continue;
    const covered = checkpoints.some(
      (cp) => cp.source === 'ending' && (cp.attribute === id || cp.attributes?.includes(id)),
    );
    if (!covered) note(`结局检查点未覆盖属性 ${id}`);
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
  const bonus = rules.restDayBonus;
  if (!bonus) {
    note('restDayBonus 缺失');
  } else {
    for (const key of ['daily', 'club', 'stressReduction']) {
      if (!Number.isFinite(bonus[key]) || bonus[key] < 1) note(`restDayBonus.${key} 非法`);
    }
  }
  const gain = rules.clubExperienceGain;
  if (!gain) note('clubExperienceGain 缺失');
  else {
    for (const key of ['weekday', 'restDay']) {
      if (!Number.isInteger(gain[key]) || gain[key] < 0) note(`clubExperienceGain.${key} 非法`);
    }
    // 8 月集训周加成（见 ADR-0007）：当前 6 个集训周里 8 月组有加成、10 月组没有。
    // 字段缺失视为"无加成"，不属于错误——数据可以不含这条规则。
    if (gain.augustWeekday !== undefined
      && (!Number.isInteger(gain.augustWeekday) || gain.augustWeekday < 0)) {
      note(`clubExperienceGain.augustWeekday 非法：${gain.augustWeekday}`);
    }
  }
}

// ---------------------------------------------------------------- 成功率覆盖
//
// 所有者的要求（2026-10-06）：**成功率允许放宽**，从 40% 往上调、上限 90%，
// 因为"目标在真实成功率下做不到"这件事必须能被使用者亲手验证一遍。
//
// 口径（三条，写死在这里，别在别处再实现一遍）：
//   1. 覆盖只作用于 `successRate !== 1` 的指令；`successRate === 1`（休息指令，永远成功）
//      **不参与覆盖**——把它从 1 改成 0.7 会让"休息也会失败"，那不是放宽，是改规则。
//   2. 覆盖是**规则级**变更：返回一份新 rules，不修改入参（引擎全程纯函数）。
//   3. 缺省/非法值一律退回原规则，绝不静默改成某个魔法数。

/** 规则里非恒成功指令的**共同**成功率；不一致或没有时返回 `null`。 */
export function commonSuccessRate(rules) {
  const rates = new Set();
  for (const command of rules?.commands ?? []) {
    if (command.successRate === 1) continue;
    rates.add(command.successRate);
  }
  return rates.size === 1 ? [...rates][0] : null;
}

/**
 * 把每条非恒成功指令的成功率换成 `rate`。
 *
 * @param {object} rules 规则
 * @param {number|null|undefined} rate (0,1] 内的数；`null`/`undefined` 原样返回
 * @returns {object} 新规则对象（入参不被修改）
 */
export function withSuccessRate(rules, rate) {
  if (rate === null || rate === undefined) return rules;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) return rules;
  return {
    ...rules,
    commands: (rules.commands ?? []).map((command) =>
      (command.successRate === 1 ? command : { ...command, successRate: rate }),
    ),
  };
}
