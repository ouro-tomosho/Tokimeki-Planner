// 票 06：求解器。
//
// 断言走 `plan(input, { assignments })` 这条最高层接缝：求解器产出的是**数据**，
// 它的行为通过"这份数据被规划重放后会怎样"来观察。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanner } from '../src/plan.js';
import { createSolver } from '../src/solver.js';
import { createSettlement } from '../src/settlement.js';
import { defaultInput } from '../src/input.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();
const plan = createPlanner(rules);
const solve = createSolver(rules);

/** 一套确实有解的输入：加入科学社，沿用数据文件里的默认目标。 */
function feasibleInput() {
  const input = defaultInput(rules);
  input.initialClub = 'science-club';
  return input;
}

function solveAndPlan(input) {
  const assignments = solve(input);
  const result = plan(input, { assignments });
  assert.equal(result.ok, true, `规划失败：${result.problems}`);
  return { assignments, result };
}

test('产出的日程覆盖整条时间轴：每周有周指令，每个休息日有日指令', () => {
  const input = feasibleInput();
  const { assignments, result } = solveAndPlan(input);
  const byDate = new Map(result.days.map((day) => [day.date, day]));

  for (const week of result.weeks) {
    const days = week.days.map((date) => byDate.get(date));

    if (days.some((day) => !day.isRestDay && day.isSettled)) {
      assert.ok(
        typeof assignments.weekCommands[week.start] === 'string',
        `${week.start} 这一周没有周指令`,
      );
    }
    for (const day of days) {
      if (day.isRestDay && day.isSettled) {
        assert.ok(
          typeof assignments.dayCommands[day.date] === 'string',
          `${day.date} 这个休息日没有日指令`,
        );
      }
    }
  }
});

test('求解的结果全是可执行的指令，绝不出现「空过」', () => {
  const input = feasibleInput();
  const { assignments } = solveAndPlan(input);

  const ids = new Set(rules.commands.map((command) => command.id));
  for (const id of Object.values(assignments.weekCommands)) assert.ok(ids.has(id), id);
  for (const id of Object.values(assignments.dayCommands)) assert.ok(ids.has(id), id);
});

test('存在可行解时，产出的日程满足全部硬约束', () => {
  const input = feasibleInput();
  const { result } = solveAndPlan(input);

  const unmet = [
    ...result.goals.globalConstraints.filter((goal) => goal.state !== 'met'),
    ...result.goals.miniGoals.filter((goal) => goal.state !== 'met'),
    ...result.goals.endingGoals.filter((goal) => goal.state !== 'met'),
  ];
  assert.deepEqual(
    unmet.map((goal) => `${goal.attribute ?? goal.attributes?.join('+')} ${goal.op} ${goal.value}`),
    [],
    '有解的场景必须全部达标',
  );
  assert.equal(result.goals.ok, true);
});

test('结果表的逐日属性与日程重放逐格一致', () => {
  const input = feasibleInput();
  const { result } = solveAndPlan(input);
  const settleDay = createSettlement(rules);
  const scale = rules.fixedPointScale;

  let replayed = {
    attributes: Object.fromEntries(
      Object.entries(input.attributes).map(([id, value]) => [id, value * scale]),
    ),
    clubExperience: Object.fromEntries(rules.clubs.map((club) => [club.id, 0])),
  };

  for (const day of result.days) {
    if (day.isSettled && day.commandId && !day.commandBlocked) {
      replayed = settleDay(replayed, day.commandId, day.isRestDay ? 'restDay' : 'weekday');
    }
    for (const [id, value] of Object.entries(replayed.attributes)) {
      assert.ok(
        Math.abs(day.attributes[id] - value / scale) < 1e-9,
        `${day.date} 的 ${id}：表里 ${day.attributes[id]}，重放 ${value / scale}`,
      );
    }
  }
});

test('同一输入连续求解两次，结果完全相同（不掷骰子）', () => {
  const input = feasibleInput();
  assert.deepEqual(solve(input), solve(input));
});

test('使用者显式指定的指令不会被求解器覆盖', () => {
  const input = feasibleInput();
  input.weekCommands = { '1996-05-12': 'cmd-rest' };
  input.dayCommands = { '1996-05-19': 'cmd-groom' };
  input.skippedDays = ['1996-05-15'];

  const { result } = solveAndPlan(input);

  const week = result.days.find((day) => day.date === '1996-05-13');
  assert.equal(week.commandId, 'cmd-rest', '指定的周指令必须原样保留');

  const sunday = result.days.find((day) => day.date === '1996-05-19');
  assert.equal(sunday.commandId, 'cmd-groom', '指定的日指令必须原样保留');

  const skipped = result.days.find((day) => day.date === '1996-05-15');
  assert.equal(skipped.isEmpty, true, '跳过的那天仍然是空过');
});

test('求解器绝不自行选择或切换社团', () => {
  const input = defaultInput(rules); // 未加入任何社团
  const before = structuredClone(input.clubChanges);
  const { result } = solveAndPlan(input);

  assert.deepEqual(input.clubChanges, before, '求解不得改写社团切换记录');
  assert.equal(input.initialClub, null);
  for (const day of result.days) {
    if (!day.commandId) continue;
    const command = rules.commands.find((entry) => entry.id === day.commandId);
    assert.notEqual(command.kind, 'club', `${day.date} 在没有社团时执行了社团指令`);
  }
});

test('贪心没排好时，终局修补能把收尾的硬约束补上', () => {
  // Spec 轴审查给的反例：把结局「容姿 ≥ 100」放松到 55（纯放松），
  // 滚动时域贪心会差一点点，修补阶段从终点往回扫应当收平。
  const input = defaultInput(rules);
  input.initialClub = 'science-club';
  input.endingGoals = input.endingGoals.map((goal) =>
    goal.attribute === 'appearance' ? { ...goal, value: 55 } : goal,
  );

  const { result } = solveAndPlan(input);
  assert.equal(result.goals.ok, true);
});

test('未加入社团而小目标要求社团经验时，如实报为未达成', () => {
  const input = defaultInput(rules); // 未加入社团
  const { result } = solveAndPlan(input);

  assert.equal(result.clubExperience['science-club'], 0);
  assert.equal(result.goals.ok, false, '没有社团就不可能攒出社团经验，不能假装达标');
  const goal = result.goals.miniGoals.find((entry) => entry.attributes.includes('clubExperience'));
  assert.equal(goal.state, 'unmet');
});

test('默认数据下一次求解在秒级完成', () => {
  const input = feasibleInput();
  solve(input); // 预热
  const started = performance.now();
  solve(input);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `求解耗时 ${elapsed.toFixed(0)} ms，超出秒级`);
});
