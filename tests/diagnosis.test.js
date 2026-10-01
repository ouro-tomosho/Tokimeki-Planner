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
    [
      'endingAndGlobalConflict',
      'endingGoalsAloneUnreachable',
      'miniGoalsBlocking',
      'reachableAfterCancelling',
    ],
    '四项结论一并给出，而不是只报第一个命中的原因',
  );
});

test('未加入社团时：小目标被指认，结局目标与全局约束不冲突', () => {
  const { assignments } = solveAndPlan(noClubInput());
  const { diagnosis } = assignments;

  assert.equal(diagnosis.miniGoalsBlocking, true);
  assert.equal(diagnosis.endingAndGlobalConflict, false);
  assert.equal(diagnosis.endingGoalsAloneUnreachable, false);
});

test('诊断指认的那条小目标，取消它真的就可达；只取消另一条则不行', () => {
  const input = noClubInput();
  const { assignments } = solveAndPlan(input);
  const blamed = assignments.diagnosis.reachableAfterCancelling;

  assert.ok(blamed, '应当指认出一条小目标');
  assert.deepEqual(blamed.attributes, ['clubExperience'], '就是社团经验那条');

  // 按**序号**取消：诊断给的是副本里的对象，拿它做 indexOf / includes 对不上。
  const blamedIndex = input.miniGoals.findIndex(
    (entry) =>
      entry.deadline === blamed.deadline &&
      entry.op === blamed.op &&
      entry.value === blamed.value,
  );
  assert.ok(blamedIndex >= 0, '指认的必须是使用者确实设过的那一条');

  const reachableWithoutIndex = (index) => {
    const copy = structuredClone(input);
    copy.miniGoals = copy.miniGoals.filter((_, position) => position !== index);
    return plan(copy, { assignments: solve(copy) }).goals.ok;
  };

  assert.equal(reachableWithoutIndex(blamedIndex), true, '取消它之后确实可达');
  for (let index = 0; index < input.miniGoals.length; index += 1) {
    if (index === blamedIndex) continue;
    assert.equal(
      reachableWithoutIndex(index),
      false,
      `只取消 ${input.miniGoals[index].deadline} 那条并不够`,
    );
  }
});

test('由近至远逐个取消：指认的是**最早也能解决**的那一条', () => {
  const input = noClubInput();
  // 社团经验那条截止 1998-01-02，比另一条 1998-02-23 更近；可它就是病根
  const deadlines = input.miniGoals.map((goal) => goal.deadline).sort();
  assert.deepEqual(deadlines, ['1998-01-02', '1998-02-23']);

  const { assignments } = solveAndPlan(input);
  assert.equal(assignments.diagnosis.reachableAfterCancelling.deadline, '1998-01-02');
});

test('结局目标与全局约束冲突时，明确报告冲突', () => {
  const { result, assignments } = solveAndPlan(conflictingInput());
  assert.equal(result.goals.ok, false);

  const { diagnosis } = assignments;
  assert.equal(diagnosis.endingAndGlobalConflict, true, '全局约束与结局目标彼此冲突');
  assert.equal(diagnosis.endingGoalsAloneUnreachable, false, '结局目标单看是可达的，不该赖它');
  assert.equal(diagnosis.miniGoalsBlocking, false, '与小目标无关');
  assert.equal(diagnosis.reachableAfterCancelling, null);
});

test('结局目标本身不可达时，明确报告是它，而不是让小目标背锅', () => {
  const input = impossibleEndingInput();
  input.miniGoals = [{ deadline: '1998-02-23', attributes: ['literature'], op: '>=', value: 50 }];

  const { result, assignments } = solveAndPlan(input);
  assert.equal(result.goals.ok, false);

  const { diagnosis } = assignments;
  assert.equal(diagnosis.endingGoalsAloneUnreachable, true);
  assert.equal(diagnosis.endingAndGlobalConflict, false, '不是冲突——把全局约束全删了它也达不到');
  assert.equal(diagnosis.miniGoalsBlocking, false);
  assert.equal(diagnosis.reachableAfterCancelling, null, '取消小目标救不了它');
});

test('诊断全程不修改使用者设定的任何目标或约束', () => {
  const input = noClubInput();
  const before = structuredClone(input);

  solve(input);

  assert.deepEqual(input, before, '诊断必须在副本上做');
});
