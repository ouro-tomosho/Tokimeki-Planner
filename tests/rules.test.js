// 切片 1：数据文件的完整性。
//
// 期望值一律写成字面量，直接来自所有者提供的数值表（见 docs/data-request.md），
// 不从数据文件自身重算——这样断言才有可能与实现不一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateRules } from '../src/rules.js';
import { attributeById, commandById } from '../src/lookup.js';
import { loadRules } from './support/rules.js';

test('数据文件通过自校验', () => {
  assert.deepEqual(validateRules(loadRules()), []);
});

test('九项属性齐全，名称、方向、上下限正确', () => {
  const rules = loadRules();
  assert.deepEqual(
    rules.attributes.map((a) => [a.id, a.name, a.direction]),
    [
      ['stamina', '体力', 'up'],
      ['literature', '文科', 'up'],
      ['science', '理科', 'up'],
      ['art', '艺术', 'up'],
      ['sports', '运动', 'up'],
      ['popularity', '人缘', 'up'],
      ['appearance', '容姿', 'up'],
      ['grit', '毅力', 'up'],
      ['stress', '压力', 'down'],
    ],
  );
  for (const a of rules.attributes) {
    assert.equal(a.min, 0);
    assert.equal(a.max, 999);
  }
  assert.equal(rules.attributes.filter((a) => a.direction === 'down').length, 1);
});

test('十八条指令：七条日常 + 十一条社团', () => {
  const rules = loadRules();
  assert.equal(rules.commands.length, 18);
  assert.equal(rules.commands.filter((c) => c.kind === 'daily').length, 7);
  assert.equal(rules.commands.filter((c) => c.kind === 'club').length, 11);
});

test('每条指令的变动项恰好覆盖九项属性', () => {
  const rules = loadRules();
  const ids = rules.attributes.map((a) => a.id).sort();
  for (const c of rules.commands) {
    assert.deepEqual(Object.keys(c.effects).sort(), ids, `指令 ${c.name}`);
  }
});

test('指令「研读文科」的成功变动逐项等于数值表', () => {
  const c = commandById(loadRules(), 'cmd-study-literature');
  assert.equal(c.name, '研读文科');
  assert.equal(c.kind, 'daily');
  assert.deepEqual(c.effects, {
    stamina: -0.8,
    literature: 0.9,
    science: 0.1,
    art: 0.1,
    sports: -0.4,
    popularity: 0.3,
    appearance: -0.3,
    grit: -0.1,
    stress: 0.8,
  });
});

test('指令「休息」的成功变动逐项等于数值表，并且是唯一不会失败的一条', () => {
  const rules = loadRules();
  const c = commandById(rules, 'cmd-rest');
  assert.equal(c.name, '休息');
  assert.equal(c.isRestCommand, true);
  assert.equal(c.successRate, 1);
  assert.deepEqual(c.effects, {
    stamina: 3.1,
    literature: 0,
    science: 0,
    art: 0,
    sports: 0,
    popularity: -0.6,
    appearance: -0.8,
    grit: -0.1,
    stress: -2.9,
  });
  const rest = rules.commands.filter((x) => x.isRestCommand);
  assert.equal(rest.length, 1);
  for (const other of rules.commands) {
    if (other.id === c.id) continue;
    assert.equal(other.successRate, 0.63, `指令 ${other.name} 的成功率应为 0.63`);
  }
});

test('默认起点与数值表逐项一致', () => {
  const rules = loadRules();
  assert.deepEqual(rules.defaultStart, {
    stamina: 100,
    literature: 40,
    science: 40,
    art: 40,
    sports: 40,
    popularity: 32,
    appearance: 60,
    grit: 5,
    stress: 0,
  });
});

test('默认全局约束逐项一致', () => {
  const rules = loadRules();
  assert.deepEqual(rules.defaultGlobalConstraints, [
    { attribute: 'stamina', op: '>=', value: 20 },
    { attribute: 'popularity', op: '>=', value: 100 },
    { attribute: 'appearance', op: '>=', value: 35 },
    { attribute: 'stress', op: '<', value: 70 },
  ]);
});

test('默认结局目标逐项一致，体力为 50', () => {
  const rules = loadRules();
  assert.deepEqual(rules.defaultEndingGoals, [
    { attribute: 'stamina', op: '>=', value: 50 },
    { attribute: 'literature', op: '>=', value: 130 },
    { attribute: 'science', op: '>=', value: 130 },
    { attribute: 'art', op: '>=', value: 130 },
    { attribute: 'sports', op: '>=', value: 130 },
    { attribute: 'popularity', op: '>=', value: 120 },
    { attribute: 'appearance', op: '>=', value: 100 },
    { attribute: 'grit', op: '>=', value: 100 },
    { attribute: 'stress', op: '<', value: 50 },
  ]);
});

test('默认小目标：一条是三项求和，一条是社团经验', () => {
  const rules = loadRules();
  assert.deepEqual(rules.defaultMiniGoals, [
    { deadline: '1998-02-23', attributes: ['literature', 'science', 'art'], op: '>=', value: 561 },
    { deadline: '1998-01-02', attributes: ['clubExperience'], op: '>=', value: 380 },
  ]);
  assert.deepEqual(rules.clubExperience, { id: 'clubExperience', name: '社团经验', min: 0, max: 999 });
});

test('时间轴与其余所有者给定的常量正确', () => {
  const rules = loadRules();
  assert.equal(rules.timeline.start, '1995-04-04');
  assert.equal(rules.timeline.end, '1998-03-01');
  assert.equal(rules.timeline.lastSettlement, '1998-02-28');
  assert.equal(rules.clubUnlockDate, '1995-04-09');
  assert.equal(rules.fixedPointScale, 1000000);
  assert.deepEqual(rules.restDayBonus, { daily: 4, club: 6, restCommandNegative: 4 });
  assert.equal(rules.clubExperienceGain.weekday, 1);
  assert.equal(rules.clubExperienceGain.restDay, 6);
});

test('十一个社团各有 id 与名称，且每条社团指令绑定其中之一', () => {
  const rules = loadRules();
  assert.equal(rules.clubs.length, 11);
  const clubIds = new Set(rules.clubs.map((c) => c.id));
  const used = rules.commands.filter((c) => c.kind === 'club').map((c) => c.clubId);
  assert.equal(new Set(used).size, 11, '每条社团指令绑定一个不同的社团');
  for (const id of used) assert.ok(clubIds.has(id), `未知社团 ${id}`);
});

test('属性查询按 id 命中，未知 id 抛错', () => {
  const rules = loadRules();
  assert.equal(attributeById(rules, 'stress').name, '压力');
  assert.throws(() => attributeById(rules, 'nope'), /nope/);
});

// 所有者给的整张数值表，照抄一遍当作**独立**的真相来源。
// 它存在的唯一理由：数据文件里任何一个数字被抄错，这里就会红。
// 列序：体力 文科 理科 艺术 运动 人缘 容姿 毅力 压力
const VALUE_TABLE = [
  ['研读文科', [-0.8, 0.9, 0.1, 0.1, -0.4, 0.3, -0.3, -0.1, 0.8]],
  ['研读理科', [-0.8, 0.1, 0.9, 0.1, -0.8, 0.1, -0.4, 0.3, 0.3]],
  ['培养艺术气质', [-0.8, 0.1, 0.1, 0.9, -0.4, 0.1, -0.1, -0.1, -0.3]],
  ['运动', [-2.4, -0.1, -0.1, -0.1, 3.3, 0.1, -0.4, 1.4, 0.1]],
  ['和同学闲聊', [-1.2, -0.3, -0.3, -0.3, 0.2, 1.5, 0.8, -0.4, -0.9]],
  ['整理仪容', [-0.6, -0.1, -0.1, -0.1, -0.1, 0.5, 2.1, -0.6, 0.1]],
  ['休息', [3.1, 0, 0, 0, 0, -0.6, -0.8, -0.1, -2.9]],
  ['文艺社', [-0.8, 0.8, 0.3, 0.1, 0, 0.1, -0.3, -0.1, 1.1]],
  ['演剧社', [-0.9, 0.9, 0, 0.4, 0.1, 0.1, -0.1, 0.1, 1.1]],
  ['科学社', [-0.8, 0.1, 0.9, 0.3, 0, 0.1, -0.3, 0.3, 1.4]],
  ['电脑社', [-0.8, 0.1, 0.7, 0.3, 0, 0.2, -0.4, 0.2, 1.8]],
  ['美术社', [-0.9, 0.1, 0, 0.9, 0.1, 0.1, -0.1, -0.1, 0.9]],
  ['管乐社', [-0.9, 0.1, 0.1, 0.9, 0.2, 0.1, -0.2, 0.1, 0.9]],
  ['棒球社', [-1.9, -0.1, -0.1, -0.1, 0.9, 0.1, -0.3, 0.3, 0.2]],
  ['足球社', [-1.9, -0.1, -0.1, -0.1, 0.9, 0.1, -0.2, 0.7, 0.3]],
  ['网球社', [-1.6, -0.1, -0.1, 0, 0.8, 0.1, -0.1, 0.6, 0.5]],
  ['游泳社', [-1.9, -0.1, -0.1, 0, 0.9, 0, -0.1, 0.7, 0.2]],
  ['篮球社', [-1.8, -0.1, -0.1, -0.1, 0.9, -0.1, -0.2, 0.6, 0.4]],
];

const VALUE_COLUMNS = ['stamina', 'literature', 'science', 'art', 'sports', 'popularity', 'appearance', 'grit', 'stress'];

test('十八条指令 × 九项属性，逐格等于所有者给的数值表', () => {
  const rules = loadRules();
  assert.equal(VALUE_TABLE.length, rules.commands.length, '数值表应覆盖全部指令');

  for (const [name, expected] of VALUE_TABLE) {
    const command = rules.commands.find((c) => c.name === name);
    assert.ok(command, `数据文件里没有指令「${name}」`);
    assert.deepEqual(
      VALUE_COLUMNS.map((id) => command.effects[id]),
      expected,
      `指令「${name}」的变动与数值表不符`,
    );
  }
});
