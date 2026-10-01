// 切片 1：数据文件的完整性。
//
// 期望值一律写成字面量，直接来自所有者提供的数值表（见 docs/data-request.md），
// 不从数据文件自身重算——这样断言才有可能与实现不一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateRules, attributeById, commandById } from '../src/rules.js';

const RULES_URL = new URL('../data/rules.json', import.meta.url);

function loadRules() {
  return JSON.parse(readFileSync(fileURLToPath(RULES_URL), 'utf8'));
}

test('数据文件通过自校验', () => {
  assert.deepEqual(validateRules(loadRules()), []);
});

test('九项属性齐全，名称、方向、上下限正确', () => {
  const rules = loadRules();
  assert.deepEqual(
    rules.attributes.map((a) => [a.id, a.name, a.direction]),
    [
      ['tili', '体力', 'up'],
      ['wenke', '文科', 'up'],
      ['like', '理科', 'up'],
      ['yishu', '艺术', 'up'],
      ['yundong', '运动', 'up'],
      ['renyuan', '人缘', 'up'],
      ['rongzi', '容姿', 'up'],
      ['yili', '毅力', 'up'],
      ['yali', '压力', 'down'],
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
  const c = commandById(loadRules(), 'c-yandu-wenke');
  assert.equal(c.name, '研读文科');
  assert.equal(c.kind, 'daily');
  assert.deepEqual(c.effects, {
    tili: -0.8,
    wenke: 0.9,
    like: 0.1,
    yishu: 0.1,
    yundong: -0.4,
    renyuan: 0.3,
    rongzi: -0.3,
    yili: -0.1,
    yali: 0.8,
  });
});

test('指令「休息」的成功变动逐项等于数值表，并且是唯一不会失败的一条', () => {
  const rules = loadRules();
  const c = commandById(rules, 'c-xiuxi');
  assert.equal(c.name, '休息');
  assert.equal(c.isRestCommand, true);
  assert.equal(c.successRate, 1);
  assert.deepEqual(c.effects, {
    tili: 3.1,
    wenke: 0,
    like: 0,
    yishu: 0,
    yundong: 0,
    renyuan: -0.6,
    rongzi: -0.8,
    yili: -0.1,
    yali: -2.9,
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
    tili: 100,
    wenke: 40,
    like: 40,
    yishu: 40,
    yundong: 40,
    renyuan: 32,
    rongzi: 60,
    yili: 5,
    yali: 0,
  });
});

test('默认全局约束逐项一致', () => {
  const rules = loadRules();
  assert.deepEqual(rules.defaultGlobalConstraints, [
    { attribute: 'tili', op: '>=', value: 20 },
    { attribute: 'renyuan', op: '>=', value: 100 },
    { attribute: 'rongzi', op: '>=', value: 35 },
    { attribute: 'yali', op: '<', value: 70 },
  ]);
});

test('默认结局目标逐项一致，体力为 50', () => {
  const rules = loadRules();
  assert.deepEqual(rules.defaultEndingGoals, [
    { attribute: 'tili', op: '>=', value: 50 },
    { attribute: 'wenke', op: '>=', value: 130 },
    { attribute: 'like', op: '>=', value: 130 },
    { attribute: 'yishu', op: '>=', value: 130 },
    { attribute: 'yundong', op: '>=', value: 130 },
    { attribute: 'renyuan', op: '>=', value: 120 },
    { attribute: 'rongzi', op: '>=', value: 100 },
    { attribute: 'yili', op: '>=', value: 100 },
    { attribute: 'yali', op: '<', value: 50 },
  ]);
});

test('默认小目标：一条是三项求和，一条是社团经验', () => {
  const rules = loadRules();
  assert.deepEqual(rules.defaultMiniGoals, [
    { deadline: '1998-02-23', attributes: ['wenke', 'like', 'yishu'], op: '>=', value: 561 },
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
  assert.equal(attributeById(rules, 'yali').name, '压力');
  assert.throws(() => attributeById(rules, 'nope'), /nope/);
});
