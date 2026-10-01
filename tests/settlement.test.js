// 票 03：单日结算内核。
//
// 断言走到预先商定的接缝 `settleDay(状态, 当日指令, 当日类型) → 新状态`。
// 期望值一律用**手算字面量**（来自所有者给的规则），不从实现重算。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSettlement } from '../src/settlement.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();
const settleDay = createSettlement(rules);
const SCALE = rules.fixedPointScale;
const TOLERANCE = 1e-5;

const NAMES = Object.fromEntries(rules.attributes.map((a) => [a.id, a.name]));
const EMPTY_CLUB_EXPERIENCE = Object.fromEntries(rules.clubs.map((c) => [c.id, 0]));

function scaled(values) {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v * SCALE]));
}

function makeState(attributes, clubExperience = {}) {
  return {
    attributes: scaled({ ...rules.defaultStart, ...attributes }),
    clubExperience: scaled({ ...EMPTY_CLUB_EXPERIENCE, ...clubExperience }),
  };
}

function deltaOf(before, after) {
  return Object.fromEntries(
    Object.keys(before.attributes).map((id) => [
      id,
      (after.attributes[id] - before.attributes[id]) / SCALE,
    ]),
  );
}

/** 逐项比对，失败信息带上属性名，方便对着数值表读。 */
function assertDelta(actual, expected) {
  for (const [id, want] of Object.entries(expected)) {
    assert.ok(
      Math.abs(actual[id] - want) < TOLERANCE,
      `${NAMES[id]}：期望 ${want}，实际 ${actual[id]}`,
    );
  }
}

function settle(commandId, dayKind = 'weekday', attributes = {}, clubExperience = {}) {
  const before = makeState(attributes, clubExperience);
  const after = settleDay(before, commandId, dayKind);
  return { before, after, delta: deltaOf(before, after) };
}

test('空过：不执行、不判定、不结算，状态原样返回', () => {
  const before = makeState({ tili: 100 });
  assert.deepEqual(settleDay(before, null, 'weekday'), before);
  assert.deepEqual(settleDay(before, null, 'restDay'), before);
});

test('研读文科・平日：期望值 = 0.63×成功 + 0.37×失败', () => {
  const { delta } = settle('cmd-study-literature');
  assertDelta(delta, {
    stamina: -0.8,
    literature: 0.7335,
    science: 0.0815,
    art: 0.0815,
    sports: -0.4,
    popularity: 0.2445,
    appearance: -0.3,
    grit: -0.1,
    stress: 1.17,
  });
});

test('失败时上升减半、下降照常；压力不减半，按原值再 +1', () => {
  // 研读文科成功：文科 +0.9（升）、运动 -0.4（降）、压力 +0.8
  // 失败：文科 +0.45、运动 -0.4、压力 +0.8+1=+1.8
  // 合起来就是对上面那组期望值的解释——这里单独把它写成一组断言。
  const { delta } = settle('cmd-study-literature');
  const success = 0.63;
  const failure = 1 - success;
  assert.ok(
    Math.abs(delta.literature - (success * 0.9 + failure * 0.45)) < TOLERANCE,
    '上升属性失败时应减半',
  );
  assert.ok(
    Math.abs(delta.sports - (success * -0.4 + failure * -0.4)) < TOLERANCE,
    '下降属性失败时应照常',
  );
  assert.ok(
    Math.abs(delta.stress - (success * 0.8 + failure * 1.8)) < TOLERANCE,
    '压力失败时不减半，且额外 +1',
  );
});

test('休息日加成：日常指令上升 ×4、社团指令上升 ×6，下降不受加成', () => {
  // 研读文科在休息日：文科 0.9→3.6，理科 0.1→0.4，艺术 0.1→0.4，人缘 0.3→1.2
  // 下降的体力/运动/容姿/毅力不变；压力不吃加成
  const { delta } = settle('cmd-study-literature', 'restDay');
  assertDelta(delta, {
    stamina: -0.8,
    literature: 0.63 * 3.6 + 0.37 * 1.8, // 2.934
    science: 0.63 * 0.4 + 0.37 * 0.2, // 0.326
    art: 0.63 * 0.4 + 0.37 * 0.2,
    sports: -0.4,
    popularity: 0.63 * 1.2 + 0.37 * 0.6, // 0.978
    appearance: -0.3,
    grit: -0.1,
    stress: 1.17, // 与平日相同：压力不受 ×4 影响
  });
});

test('社团指令在休息日的上升 ×6', () => {
  // 科学社：理科 0.9→5.4，文科 0.1→0.6，艺术 0.3→1.8，毅力 0.3→1.8，人缘 0.1→0.6
  // 压力 +1.4 不加成、失败时 +1；体力/容姿是下降，不变
  const { delta } = settle('cmd-club-science', 'restDay');
  assertDelta(delta, {
    stamina: -0.8,
    literature: 0.63 * 0.6 + 0.37 * 0.3,
    science: 0.63 * 5.4 + 0.37 * 2.7, // 4.401
    art: 0.63 * 1.8 + 0.37 * 0.9,
    sports: 0,
    popularity: 0.63 * 0.6 + 0.37 * 0.3,
    appearance: -0.3,
    grit: 0.63 * 1.8 + 0.37 * 0.9,
    stress: 0.63 * 1.4 + 0.37 * 2.4, // 1.77
  });
});

test('「休息」永远成功：期望值就等于成功变动', () => {
  // 压力要从够高的地方起步，否则 -2.9 会被夹到 0，测到的就不是规则而是夹取
  const { delta } = settle('cmd-rest', 'weekday', { stress: 50 });
  assertDelta(delta, {
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
});

test('「休息」在休息日：压力下降 ×4，上升效果也 ×4', () => {
  const { delta } = settle('cmd-rest', 'restDay', { stress: 50 });
  assertDelta(delta, {
    stamina: 12.4, // 3.1 × 4
    popularity: -0.6, // 下降不受加成
    appearance: -0.8,
    grit: -0.1,
    stress: -11.6, // -2.9 × 4，唯一一条享受该翻倍的指令
  });
});

test('非「休息」指令的压力下降在休息日不翻倍', () => {
  const weekday = settle('cmd-practice-art').delta;
  const restDay = settle('cmd-practice-art', 'restDay').delta;
  assert.ok(
    Math.abs(weekday.stress - restDay.stress) < TOLERANCE,
    `培养艺术气质的压力：平日 ${weekday.stress}，休息日 ${restDay.stress}`,
  );
});

test('社团经验：平日 +1、休息日 +6，不受成败与加成影响', () => {
  const weekday = settle('cmd-club-science');
  assert.ok(Math.abs(weekday.after.clubExperience['science-club'] / SCALE - 1) < TOLERANCE);

  const restDay = settle('cmd-club-science', 'restDay');
  assert.ok(Math.abs(restDay.after.clubExperience['science-club'] / SCALE - 6) < TOLERANCE);

  const daily = settle('cmd-study-literature');
  for (const clubId of rules.clubs.map((c) => c.id)) {
    assert.equal(daily.after.clubExperience[clubId], daily.before.clubExperience[clubId]);
  }
});

test('社团经验各自独立累积，互不影响', () => {
  const { after } = settle('cmd-club-science', 'weekday', {}, { 'science-club': 37 });
  assert.equal(after.clubExperience['science-club'] / SCALE, 38);
  assert.equal(after.clubExperience['literature-club'], 0);
});

test('属性被夹在 [0, 999]：上溢截到 999', () => {
  // 力量训练给运动 +3.3，起点贴到上限
  const { after } = settle('cmd-exercise', 'weekday', { sports: 998 });
  assert.equal(after.attributes.sports, 999 * SCALE);
});

test('属性被夹在 [0, 999]：下溢截到 0', () => {
  // 研读文科要扣体力
  const { after } = settle('cmd-study-literature', 'weekday', { stamina: 0 });
  assert.equal(after.attributes.stamina, 0);
});

test('结算结果只落在 1e-6 的整数倍上（定点表示）', () => {
  const { after } = settle('cmd-study-literature');
  for (const value of Object.values(after.attributes)) {
    assert.equal(Number.isInteger(value), true, `${value} 不是定点整数`);
  }
});

test('同一状态连续结算两次，结果与逐次结算一致（确定性）', () => {
  const start = makeState({});
  const once = settleDay(settleDay(start, 'cmd-study-literature', 'weekday'), 'cmd-rest', 'restDay');
  const twice = settleDay(
    settleDay(makeState({}), 'cmd-study-literature', 'weekday'),
    'cmd-rest',
    'restDay',
  );
  assert.deepEqual(once, twice);
  assert.notDeepEqual(once, start);
});
