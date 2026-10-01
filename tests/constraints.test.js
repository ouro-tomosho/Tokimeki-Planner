// 票 05：约束判定与目标函数。
//
// 断言走预先商定的最高层接缝 `plan(input) → PlanResult`；三层比较本身是一个纯函数，
// 直接断言它（ADR-0002 的次序就是这条验收标准）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { comparePlans, meets, shortfallOf } from '../src/constraints.js';
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

function findGoal(list, attribute) {
  const goal = list.find((entry) => entry.attribute === attribute);
  assert.ok(goal, `结果里没有 ${attribute} 的目标`);
  return goal;
}

test('阈值比较按「小数部分直接舍去」', () => {
  assert.equal(meets(129.99, '>=', 130), false, '129.99 舍去小数是 129，达不到 130');
  assert.equal(meets(130.0, '>=', 130), true);
  assert.equal(meets(130.5, '>=', 130), true);
  assert.equal(meets(69.9, '<', 70), true, '69.9 舍去小数是 69，满足 < 70');
  assert.equal(meets(70.0, '<', 70), false);
});

test('差距按同一个口径算', () => {
  assert.equal(shortfallOf(40, '>=', 130), 90);
  assert.equal(shortfallOf(131, '>=', 130), 0);
  assert.ok(Math.abs(shortfallOf(70.2, '<', 70) - 1.2) < 1e-9);
  assert.equal(shortfallOf(69.9, '<', 70), 0);
});

test('起点已满足的全局约束，是往后每天都不得破的硬不变量', () => {
  const result = planOf();
  const stamina = findGoal(result.goals.globalConstraints, 'stamina');

  assert.equal(stamina.mode, 'invariant');
  assert.equal(stamina.state, 'met');
  assert.deepEqual(stamina.violatedOn, []);
});

test('起点未满足的全局约束，按「尽快满足」处理，不直接判无解', () => {
  const result = planOf();
  // 默认起点人缘 32 < 100，而所有指令都还没指定
  const popularity = findGoal(result.goals.globalConstraints, 'popularity');

  assert.equal(popularity.mode, 'asap');
  assert.equal(popularity.metOn, null);
  assert.equal(popularity.state, 'unmet');
  assert.equal(result.goals.ok, false);
});

test('硬不变量被破坏时，逐日报出违例的日期', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
    input.globalConstraints = [{ attribute: 'stamina', op: '>=', value: 99 }];
    fillWeeks(input, rules, 'cmd-exercise'); // 每天扣体力
  });

  const stamina = result.goals.globalConstraints[0];
  assert.equal(stamina.mode, 'invariant');
  assert.equal(stamina.state, 'unmet');
  assert.equal(stamina.violatedOn[0], '1998-02-23');
  assert.deepEqual(stamina.violatedOn, [
    '1998-02-23',
    '1998-02-24',
    '1998-02-25',
    '1998-02-26',
    '1998-02-27',
    '1998-02-28',
  ]);
});

test('空过的天不参与全局约束的判定', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
    input.globalConstraints = [{ attribute: 'stamina', op: '>=', value: 99 }];
    fillWeeks(input, rules, 'cmd-exercise');
    input.skippedDays = ['1998-02-24'];
  });

  const stamina = result.goals.globalConstraints[0];
  assert.equal(stamina.violatedOn.includes('1998-02-24'), false, '空过日不该出现在违例里');
  // 02-22 是周日且没给日指令，属性不动；剩下五个平日把体力压低，02-24 被跳过
  assert.deepEqual(stamina.violatedOn, [
    '1998-02-23',
    '1998-02-25',
    '1998-02-26',
    '1998-02-27',
    '1998-02-28',
  ]);
});

test('尽快满足：真正被抬上去时，报出首次达成的日期', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
    input.globalConstraints = [{ attribute: 'stamina', op: '>=', value: 105 }];
    fillWeeks(input, rules, 'cmd-rest');
  });

  const stamina = result.goals.globalConstraints[0];
  assert.equal(stamina.mode, 'asap', '起点 100 达不到 105');
  assert.equal(stamina.metOn, '1998-02-24', '休息每天 +3.1，02-24 越过 105');
  assert.equal(stamina.state, 'met');
});

test('小目标：阈值作用于属性集合的求和', () => {
  const result = planOf((input) => {
    input.miniGoals = [
      { deadline: '1998-02-23', attributes: ['literature', 'science', 'art'], op: '>=', value: 200 },
    ];
  });

  const goal = result.goals.miniGoals[0];
  assert.equal(goal.evaluatedOn, '1998-02-23');
  assert.equal(goal.actual, 120, '40 + 40 + 40');
  assert.equal(goal.state, 'unmet');
  assert.equal(goal.shortfall, 80);
});

test('小目标达标时报出达成与评估日', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
    fillWeeks(input, rules, 'cmd-study-literature');
    input.miniGoals = [{ deadline: '1998-02-28', attributes: ['literature'], op: '>=', value: 42 }];
  });

  const goal = result.goals.miniGoals[0];
  assert.equal(goal.state, 'met');
  assert.ok(goal.actual > 42, `实际 ${goal.actual}`);
  assert.equal(goal.shortfall, 0);
});

test('小目标的属性集合可以包含社团经验，指向当前社团的那一份', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
    input.initialClub = 'science-club';
    fillWeeks(input, rules, 'cmd-club-science');
    input.miniGoals = [
      { deadline: '1998-02-28', attributes: [rules.clubExperience.id], op: '>=', value: 5 },
    ];
  });

  const goal = result.goals.miniGoals[0];
  assert.ok(goal.actual >= 5, `实际 ${goal.actual}`);
  assert.equal(goal.state, 'met');
});

test('结局目标在终点评估，并报出差多少', () => {
  const result = planOf();
  const literature = findGoal(result.goals.endingGoals, 'literature');

  assert.equal(literature.actual, 40);
  assert.equal(literature.state, 'unmet');
  assert.equal(literature.shortfall, 90, '130 − 40');
  assert.equal(result.goals.ok, false);
});

test('全部硬约束达标时，整体判定为达标', () => {
  const result = planOf((input) => {
    input.globalConstraints = [];
    input.miniGoals = [];
    input.endingGoals = [];
  });

  assert.equal(result.goals.ok, true);
});

test('目标函数第一层：硬约束优先于属性总和', () => {
  const clearAll = (input) => {
    input.startDate = '1998-02-22';
    input.globalConstraints = [];
    input.miniGoals = [];
    input.endingGoals = [];
  };

  const hardMet = planOf((input) => {
    clearAll(input);
    fillWeeks(input, rules, 'cmd-rest');
  });
  const hardUnmet = planOf((input) => {
    clearAll(input);
    input.endingGoals = [{ attribute: 'literature', op: '>=', value: 999 }];
    fillWeeks(input, rules, 'cmd-study-literature');
  });

  assert.equal(hardMet.goals.ok, true);
  assert.equal(hardUnmet.goals.ok, false);
  assert.equal(comparePlans(hardMet, hardUnmet), -1, '达标的方案更优，哪怕它的属性总和更低');
});

test('目标函数第二层：都达标时，正向等权总和大的更优', () => {
  const prepare = (input) => {
    input.startDate = '1998-02-22';
    input.globalConstraints = [];
    input.miniGoals = [];
    input.endingGoals = [];
  };

  const exercise = planOf((input) => {
    prepare(input);
    fillWeeks(input, rules, 'cmd-exercise');
  });
  const study = planOf((input) => {
    prepare(input);
    fillWeeks(input, rules, 'cmd-study-literature');
  });

  assert.ok(exercise.goals.score.positiveSum > study.goals.score.positiveSum);
  assert.equal(comparePlans(exercise, study), -1);
});

test('目标函数第三层：正向总和打平时，负面指标小的更优', () => {
  const planWith = (positiveSum, negative) => ({
    goals: { ok: true, score: { positiveSum, negative } },
  });

  assert.equal(comparePlans(planWith(100, 10), planWith(100, 5)), 1, '压力更小的更优');
  assert.equal(comparePlans(planWith(100, 5), planWith(100, 5)), 0);
});
