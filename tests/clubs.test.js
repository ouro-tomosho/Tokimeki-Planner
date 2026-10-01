// 票 04：社团与社团经验。
//
// 断言走预先商定的最高层接缝 `plan(input) → PlanResult`。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanner } from '../src/plan.js';
import { defaultInput } from '../src/input.js';
import { fillRestDays, fillWeeks } from './support/fill.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();
const plan = createPlanner(rules);

function planOf(mutate) {
  const input = defaultInput(rules);
  if (mutate) mutate(input);
  const result = plan(input);
  assert.equal(result.ok, true, `规划失败：${result.problems}`);
  return result;
}

function dayAt(result, date) {
  const day = result.days.find((d) => d.date === date);
  assert.ok(day, `结果里没有 ${date}`);
  return day;
}

test('社团切换自该日起生效：切换之前不可用，当天起可用', () => {
  const result = planOf((input) => {
    input.startDate = '1995-04-09';
    input.initialClub = 'literature-club';
    input.clubChanges = [{ date: '1995-04-16', clubId: 'science-club' }];
    fillWeeks(input, rules, 'cmd-club-science');
  });

  // 04-09 那一周的社团还是文艺社
  assert.equal(dayAt(result, '1995-04-10').commandBlocked, 'club-mismatch');
  // 04-16 是切换当天，那一周起科学社指令可用
  assert.equal(dayAt(result, '1995-04-17').commandBlocked, null);
});

test('起点之前没有社团、之后加入：切换记录的顺序不影响结果', () => {
  const build = (changes) =>
    planOf((input) => {
      input.startDate = '1995-04-09';
      input.initialClub = null;
      input.clubChanges = changes;
      fillWeeks(input, rules, 'cmd-club-art');
      input.initialClub = null;
    });

  const forward = build([
    { date: '1995-04-16', clubId: 'science-club' },
    { date: '1995-04-30', clubId: 'art-club' },
  ]);
  const backward = build([
    { date: '1995-04-30', clubId: 'art-club' },
    { date: '1995-04-16', clubId: 'science-club' },
  ]);

  const blocking = (result) => result.days.map((day) => day.commandBlocked);
  assert.deepEqual(blocking(forward), blocking(backward));

  // 04-16 之前没有社团，04-16 起是科学社，04-30 起才是美术社
  assert.equal(dayAt(forward, '1995-04-10').commandBlocked, 'club-not-selected');
  assert.equal(dayAt(forward, '1995-04-17').commandBlocked, 'club-mismatch');
  assert.equal(dayAt(forward, '1995-05-01').commandBlocked, null);
});

test('没有加入社团时，社团指令不会被结算', () => {
  const result = planOf((input) => {
    input.initialClub = null;
    fillWeeks(input, rules, 'cmd-club-science');
  });

  // 1995-04-10 已经在解锁日之后，但没选社团
  const day = dayAt(result, '1995-04-10');
  assert.equal(day.commandBlocked, 'club-not-selected');
  assert.deepEqual(day.attributes, dayAt(result, '1995-04-09').attributes, '这天不该有任何变化');
});

test('解锁日之前，社团指令不会被结算', () => {
  const result = planOf((input) => {
    input.initialClub = 'science-club';
    fillWeeks(input, rules, 'cmd-club-science');
  });

  // 解锁日是 1995-04-09
  assert.equal(rules.clubUnlockDate, '1995-04-09');
  assert.equal(dayAt(result, '1995-04-05').commandBlocked, 'club-not-unlocked');
  assert.equal(dayAt(result, '1995-04-08').commandBlocked, 'club-not-unlocked');
  assert.equal(dayAt(result, '1995-04-10').commandBlocked, null, '解锁日之后照常');
});

test('加入的是别的社团时，这条社团指令不会被结算', () => {
  const result = planOf((input) => {
    input.initialClub = 'science-club';
    fillWeeks(input, rules, 'cmd-club-baseball');
  });

  assert.equal(dayAt(result, '1995-04-10').commandBlocked, 'club-mismatch');
});

test('选定社团后，该社的社团指令照常结算', () => {
  const result = planOf((input) => {
    input.initialClub = 'science-club';
    fillWeeks(input, rules, 'cmd-club-science');
  });

  const day = dayAt(result, '1995-04-10');
  assert.equal(day.commandBlocked, null);
  // 科学社 平日：理科成功 +0.9、失败 +0.45 → 期望 0.63×0.9 + 0.37×0.45 = 0.7335
  assert.ok(Math.abs(day.attributes.science - 40.7335) < 1e-5, `${day.attributes.science}`);
});

test('日常指令不受社团限制', () => {
  const result = planOf((input) => {
    input.initialClub = null;
    fillWeeks(input, rules, 'cmd-study-literature');
  });

  const day = dayAt(result, '1995-04-05');
  assert.equal(day.commandBlocked, null);
  assert.ok(day.attributes.literature > 40);
});

test('社团切换自该周日起生效，并能影响该周日的日指令', () => {
  const result = planOf((input) => {
    input.startDate = '1995-04-09';
    input.initialClub = null;
    input.clubChanges = [{ date: '1995-04-16', clubId: 'science-club' }];
    input.dayCommands = {
      '1995-04-09': 'cmd-club-science',
      '1995-04-16': 'cmd-club-science',
    };
  });

  const before = dayAt(result, '1995-04-09');
  assert.equal(before.commandBlocked, 'club-not-selected', '切换之前还没加入社团');

  const switched = dayAt(result, '1995-04-16');
  assert.equal(switched.commandBlocked, null, '切换当天就可以用新社团的指令');
  // 休息日的社团指令给社团经验 +6
  assert.equal(result.clubExperience['science-club'], 6);
});

test('社团经验各自独立；切换后旧社团保留、新社团从自己的值继续', () => {
  const result = planOf((input) => {
    input.startDate = '1995-04-09';
    input.initialClub = 'science-club';
    fillWeeks(input, rules, 'cmd-club-science');
    input.clubChanges = [{ date: '1995-04-23', clubId: 'baseball-club' }];
    input.weekCommands['1995-04-23'] = 'cmd-club-baseball';
  });

  assert.ok(result.clubExperience['science-club'] > 0, '旧社团的经验保留');
  assert.ok(result.clubExperience['baseball-club'] > 0, '新社团从自己的值继续');
  assert.equal(result.clubExperience['literature-club'], 0, '没加入过的社团始终为 0');
});

test('社团指令不可用时，该日不结算，属性原样带入下一天', () => {
  const result = planOf((input) => {
    input.startDate = '1995-04-09';
    input.initialClub = null;
    fillWeeks(input, rules, 'cmd-club-science');
  });

  assert.deepEqual(dayAt(result, '1995-04-10').attributes, dayAt(result, '1995-04-09').attributes);
});
