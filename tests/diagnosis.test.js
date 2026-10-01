// 票 08：不可达诊断。
//
// 断言走 `solve(input)` 与 `plan(input, { assignments })` 这两条口子：
// 诊断是求解器在排不出达标日程时一并给出的结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanner } from '../src/plan.js';
import { createSolver } from '../src/solver.js';
import { defaultInput } from '../src/input.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();
const plan = createPlanner(rules);
const solve = createSolver(rules);

function solveAndPlan(input) {
  const assignments = solve(input);
  const result = plan(input, { assignments });
  assert.equal(result.ok, true, `规划失败：${result.problems}`);
  return { assignments, result };
}

/** 未加入社团：社团经验那条小目标永远不可达，其余都可达。 */
function noClubInput() {
  return defaultInput(rules);
}

/** 全局约束要文科**始终**低于 50，而结局目标要文科 ≥ 200——这两个直接打架。 */
function conflictingInput() {
  const input = defaultInput(rules);
  input.globalConstraints = [{ attribute: 'literature', op: '<', value: 50 }];
  input.endingGoals = [{ attribute: 'literature', op: '>=', value: 200 }];
  input.miniGoals = [];
  return input;
}

/** 结局目标本身就不可能：属性上限是 999。 */
function impossibleEndingInput() {
  const input = defaultInput(rules);
  input.endingGoals = [{ attribute: 'stamina', op: '>=', value: 1000 }];
  input.miniGoals = [];
  return input;
}

test('可达时不给出任何诊断', () => {
  const input = defaultInput(rules);
  input.initialClub = 'science-club';

  const { result } = solveAndPlan(input);
  assert.equal(result.goals.ok, true);
  assert.equal(solve(input).diagnosis, undefined, '达标就不该谈不可达');
});

test('不可达时，三项结论同时给出', () => {
  const { assignments, result } = solveAndPlan(noClubInput());
  assert.equal(result.goals.ok, false);

  const { diagnosis } = assignments;
  assert.ok(diagnosis, '不可达必须有诊断');
  assert.deepEqual(
    Object.keys(diagnosis).sort(),
    ['endingAndGlobalConflict', 'endingGoalsUnreachable', 'miniGoalsBlocking', 'mustCancel'],
    '四项结论一并给出，而不是只报第一个命中的原因',
  );
});

test('未加入社团时：小目标被指认，结局目标与全局约束不冲突', () => {
  const { assignments } = solveAndPlan(noClubInput());
  const { diagnosis } = assignments;

  assert.equal(diagnosis.miniGoalsBlocking, true);
  assert.equal(diagnosis.endingAndGlobalConflict, false);
  assert.equal(diagnosis.endingGoalsUnreachable, false);
});

test('只有一条病根时，取消它确实可达、只取消另一条确实不行', () => {
  const input = noClubInput();
  const { assignments } = solveAndPlan(input);
  const { mustCancel } = assignments.diagnosis;

  assert.equal(mustCancel.length, 1, '只有一个病根，取消一条就够');
  assert.deepEqual(mustCancel[0].attributes, ['clubExperience']);

  // 按**序号**取消：诊断给的是副本里的对象，拿它做 indexOf / includes 对不上。
  const blamedIndex = input.miniGoals.findIndex((entry) => entry.deadline === mustCancel[0].deadline);
  assert.ok(blamedIndex >= 0, '指认的必须是使用者确实设过的那一条');

  const reachableAfterCancelling = (indexes) => {
    const copy = structuredClone(input);
    copy.miniGoals = copy.miniGoals.filter((_, position) => !indexes.includes(position));
    return plan(copy, { assignments: solve(copy) }).goals.ok;
  };

  assert.equal(reachableAfterCancelling([blamedIndex]), true, '取消它之后确实可达');
  for (let index = 0; index < input.miniGoals.length; index += 1) {
    if (index === blamedIndex) continue;
    assert.equal(reachableAfterCancelling([index]), false, `只取消第 ${index} 条并不够`);
  }
});

test('两条小目标各自独立地不可达时，报的是**取消到哪一条为止**，不是单条就够', () => {
  // 两条都不可达：没有社团就攒不出社团经验；属性上限是 999，体力 ≥ 1000 永远达不到。
  const input = defaultInput(rules);
  input.miniGoals = [
    { deadline: '1998-01-02', attributes: ['clubExperience'], op: '>=', value: 380 },
    { deadline: '1998-02-27', attributes: ['stamina'], op: '>=', value: 1000 },
  ];

  const { assignments } = solveAndPlan(input);
  const { mustCancel, miniGoalsBlocking } = assignments.diagnosis;

  assert.equal(miniGoalsBlocking, true);
  assert.equal(mustCancel.length, 2, '必须两条都取消才可达');

  const reachableAfterCancelling = (count) => {
    const copy = structuredClone(input);
    copy.miniGoals = copy.miniGoals.sort((a, b) => (a.deadline < b.deadline ? -1 : 1)).slice(count);
    return plan(copy, { assignments: solve(copy) }).goals.ok;
  };

  assert.equal(reachableAfterCancelling(1), false, '只取消最近的那一条不够');
  assert.equal(reachableAfterCancelling(2), true, '取消到第二条才可达');
});

test('三条小目标时也能报全——循环上界不能被比较器的参数个数带跑', () => {
  const input = defaultInput(rules);
  input.miniGoals = [
    { deadline: '1998-01-02', attributes: ['clubExperience'], op: '>=', value: 380 },
    { deadline: '1998-02-01', attributes: ['grit'], op: '>=', value: 999 },
    { deadline: '1998-02-27', attributes: ['stamina'], op: '>=', value: 1000 },
  ];

  const { assignments } = solveAndPlan(input);
  const { mustCancel, miniGoalsBlocking } = assignments.diagnosis;

  assert.equal(miniGoalsBlocking, true);
  assert.equal(mustCancel.length, 3, '三条都要取消');
  assert.deepEqual(
    mustCancel.map((goal) => goal.deadline),
    ['1998-01-02', '1998-02-01', '1998-02-27'],
    '按截止日期由近至远',
  );
});

test('由近至远逐个取消：指认的是**最早也能解决**的那一条', () => {
  const input = noClubInput();
  // 社团经验那条截止 1998-01-02，比另一条 1998-02-23 更近；可它就是病根
  const deadlines = input.miniGoals.map((goal) => goal.deadline).sort();
  assert.deepEqual(deadlines, ['1998-01-02', '1998-02-23']);

  const { assignments } = solveAndPlan(input);
  assert.deepEqual(
    assignments.diagnosis.mustCancel.map((goal) => goal.deadline),
    ['1998-01-02'],
    '病根是最近的那一条',
  );
});

test('结局目标与全局约束冲突时，明确报告冲突', () => {
  const { result, assignments } = solveAndPlan(conflictingInput());
  assert.equal(result.goals.ok, false);

  const { diagnosis } = assignments;
  assert.equal(diagnosis.endingAndGlobalConflict, true, '全局约束与结局目标彼此冲突');
  assert.equal(diagnosis.miniGoalsBlocking, false, '与小目标无关');
  assert.deepEqual(diagnosis.mustCancel, [], '取消小目标救不了');
  // 验收标准 4 问的是"全部小目标取消后是否仍不可达"，这里正是
  assert.equal(diagnosis.endingGoalsUnreachable, true);
});

test('结局目标本身不可达时，明确报告是它，而不是让小目标背锅', () => {
  const input = impossibleEndingInput();
  input.miniGoals = [{ deadline: '1998-02-23', attributes: ['literature'], op: '>=', value: 50 }];

  const { result, assignments } = solveAndPlan(input);
  assert.equal(result.goals.ok, false);

  const { diagnosis } = assignments;
  assert.equal(diagnosis.endingGoalsUnreachable, true);
  assert.equal(diagnosis.endingAndGlobalConflict, false, '不是冲突——把全局约束全删了它也达不到');
  assert.equal(diagnosis.miniGoalsBlocking, false);
  assert.deepEqual(diagnosis.mustCancel, [], '取消小目标救不了它');
});

test('诊断全程不修改使用者设定的任何目标或约束', () => {
  const input = noClubInput();
  const before = structuredClone(input);

  solve(input);

  assert.deepEqual(input, before, '诊断必须在副本上做');
});
