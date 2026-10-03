// 「设为已玩到」的领域语义：把时间轴起点推到那一天（见 ADR-0004）。
//
// 断言走 `rollForward(input, planResult, date) → input` 这条纯函数接缝。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canTakeSnapshot, rollForward } from '../src/frontier.js';
import { createPlanner } from '../src/plan.js';
import { createSolver } from '../src/solver.js';
import { clubInput, dayMap } from './support/fixtures.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();
const plan = createPlanner(rules);
const solve = createSolver(rules);

const DATE = '1996-05-01'; // 周三

function rolled(input = clubInput(rules)) {
  const result = plan(input, { assignments: solve(input) });
  return { input, result, day: dayMap(result).get(DATE), next: rollForward(rules, input, result, DATE) };
}

test('起点前移到那一天', () => {
  const { next } = rolled();
  assert.equal(next.playedUpTo, DATE);
});

test('当前属性取自那一天结算后的值，并按游戏口径向下取整', () => {
  const { day, next } = rolled();
  for (const [id, value] of Object.entries(day.attributes)) {
    assert.equal(next.attributes[id], Math.floor(value), `${id} 没接过来`);
    assert.equal(Number.isInteger(next.attributes[id]), true, `${id} 不是整数`);
  }
});

test('起始社团与社团经验一并接过来', () => {
  const { day, next, input } = rolled();
  assert.equal(next.initialClub, input.initialClub);
  assert.equal(next.clubExperience[input.initialClub], Math.floor(day.clubExperience));
});

test('社团经验按社团各自保留：只更新当前社团那一格', () => {
  const input = clubInput(rules);
  input.clubExperience = { 'art-club': 77, 'science-club': 12 };

  const result = plan(input, { assignments: solve(input) });
  const next = rollForward(rules, input, result, DATE);

  assert.equal(next.clubExperience['art-club'], 77, '别的社团的计数不该被抹掉');
  assert.equal(
    next.clubExperience['science-club'],
    Math.floor(dayMap(result).get(DATE).clubExperience),
  );
});

test('拿前移后的输入重排：新区间里那一天不结算、不执行指令，属性就是起点状态', () => {
  const { next } = rolled();
  const replanned = plan(next, { assignments: solve(next) });
  assert.equal(replanned.ok, true, `${replanned.problems}`);

  const day = dayMap(replanned).get(DATE);
  assert.ok(day, '新区间必须从已玩到那一天开始');
  assert.equal(day.isSettled, false, '起点当天是状态快照，不结算');
  assert.equal(day.isEmpty, false, '它是快照，不是空过');
  assert.deepEqual(day.attributes, next.attributes, '起点当天的属性必须等于自动填入的起点状态');
  // "不执行指令"的可观测形态：那一天**不结算**。跨过起点的那一周仍需要周指令决策，
  // 而它的周锚点在时间轴之外，所以那个决策事件会落在区间内的第一天——这不是结算。
  assert.deepEqual(
    replanned.sequence.filter((entry) => entry.date === DATE && entry.kind === 'settle'),
    [],
    '起点当天不该有结算事件',
  );

  // 次日才回到正常结算
  assert.equal(dayMap(replanned).get('1996-05-02').isSettled, true);
});

test('能取到快照的条件：往后推，且有覆盖那一天的求解结果', () => {
  const input = clubInput(rules);
  input.playedUpTo = DATE; // 起点已经是 DATE，用来测"往回退"
  const result = plan(input, { assignments: solve(input) });

  assert.equal(canTakeSnapshot(input, result, '1996-06-01'), true, '往后推且有结果');
  assert.equal(canTakeSnapshot(input, result, '1996-04-01'), false, '往回退没有历史可重放');
  assert.equal(canTakeSnapshot(input, result, DATE), false, '原地不动不算移动');
  assert.equal(canTakeSnapshot(input, null, '1996-06-01'), false, '没有结果就没有快照');
});

test('期间换过社团时，先前那个社团攒下的经验不会丢', () => {
  const input = clubInput(rules); // 起点在科学社
  input.clubExperience = { 'science-club': 40 };
  input.clubChanges = [{ date: '1995-06-04', clubId: 'art-club' }]; // 周日

  const result = plan(input, { assignments: solve(input) });
  const next = rollForward(rules, input, result, DATE);

  assert.equal(next.initialClub, 'art-club');
  assert.ok(
    next.clubExperience['science-club'] > 40,
    `换社团之前攒下的经验没有补上：${next.clubExperience['science-club']}`,
  );
  // 当前社团那一格必须与求解结果对上——重放与规划不能各算一套。
  assert.equal(
    next.clubExperience['art-club'],
    Math.floor(dayMap(result).get(DATE).clubExperience),
  );
});

test('该日之前的显式指定被清掉，该日及之后的保留', () => {
  const input = clubInput(rules);
  input.restDays = ['1996-04-10', DATE, '1996-06-01'];
  input.skippedDays = ['1996-04-11', '1996-06-02'];
  input.dayCommands = { '1996-04-14': 'cmd-rest', [DATE]: 'cmd-groom' };
  input.weekCommands = {
    '1996-04-14': 'cmd-rest', // 那一周 04-20 就结束了，在起点之前
    '1996-04-28': 'cmd-chat', // 跨过起点的一周，还剩几天在区间内
    '1996-05-12': 'cmd-study-literature',
  };
  input.clubChanges = [
    { date: '1996-04-14', clubId: 'art-club' },
    { date: '1996-05-12', clubId: 'tennis-club' },
  ];

  const result = plan(input, { assignments: solve(input) });
  const next = rollForward(rules, input, result, DATE);

  assert.deepEqual(next.restDays, [DATE, '1996-06-01']);
  assert.deepEqual(next.skippedDays, ['1996-06-02']);
  assert.deepEqual(next.dayCommands, { [DATE]: 'cmd-groom' });
  assert.deepEqual(next.weekCommands, {
    '1996-04-28': 'cmd-chat',
    '1996-05-12': 'cmd-study-literature',
  });
  assert.deepEqual(next.clubChanges, [{ date: '1996-05-12', clubId: 'tennis-club' }]);
});

test('没有计算结果时只能移动日期，其余输入原样不动', () => {
  const input = clubInput(rules);
  const next = rollForward(rules, input, null, DATE);

  assert.equal(next.playedUpTo, DATE);
  assert.deepEqual(next.attributes, input.attributes);
  assert.equal(next.initialClub, input.initialClub);
  assert.deepEqual(next.clubExperience, input.clubExperience);
});
