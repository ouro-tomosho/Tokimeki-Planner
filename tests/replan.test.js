// 重规划与用户指定。
//
// 合并起点与已玩到之后，**每次求解都是整份重排**：不再有"冻结前缀 / 重算起点"
// 这套机器（见 ADR-0004）。这个文件因此只断言两件事：
//   1. 使用者显式指定的东西，工具一律不改写；
//   2. 达不到就如实报告，不偷偷改掉使用者的指定。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanner } from '../src/plan.js';
import { createSolver } from '../src/solver.js';
import { validateInput } from '../src/input.js';
import { clubInput, dayMap } from './support/fixtures.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();
const plan = createPlanner(rules);
const solve = createSolver(rules);

const baseInput = () => clubInput(rules);

test('指定的周指令、日指令、休息日与跳过都原样保留，工具不改写', () => {
  const input = baseInput();
  const weeks = plan(input, { assignments: solve(input) }).weeks;
  const anchors = weeks.map((week) => week.start);
  const sunday = weeks[10].days[0];

  input.weekCommands[anchors[3]] = 'cmd-rest';
  input.dayCommands[sunday] = 'cmd-groom';
  input.restDays = ['1996-05-15'];
  input.skippedDays = ['1996-05-16'];

  const result = plan(input, { assignments: solve(input) });
  const days = dayMap(result);

  assert.equal(days.get(weeks[3].days[1]).commandId, 'cmd-rest', '指定的周指令必须原样保留');
  assert.equal(days.get(sunday).commandId, 'cmd-groom', '指定的日指令必须原样保留');
  assert.equal(days.get('1996-05-15').isRestDay, true, '指定的休息日必须原样保留');
  assert.equal(days.get('1996-05-16').isEmpty, true, '指定的跳过必须原样保留');
});

test('同一输入连续求解两次，结果完全相同', () => {
  const input = baseInput();
  assert.deepEqual(solve(input), solve(structuredClone(input)));
});

test('改一处输入会让整份日程重排，而不是只补后面一段', () => {
  const input = baseInput();
  const before = plan(input, { assignments: solve(input) });

  const edited = structuredClone(input);
  edited.attributes.literature = 55;
  const after = plan(edited, { assignments: solve(edited) });

  const changed = after.days.some(
    (day, index) => day.attributes.literature !== before.days[index].attributes.literature,
  );
  assert.equal(changed, true, '换了前提，整份日程要跟着重排');
});

test('「已玩到」超出时间轴时被拒绝', () => {
  const input = clubInput(rules);
  input.playedUpTo = '1999-01-01';
  assert.deepEqual(validateInput(input, rules), ['playedUpTo 超出时间轴：1999-01-01']);
});

test('硬边界与目标无法同时满足时报告无解，而不是偷偷改掉使用者的指定', () => {
  const input = baseInput();
  input.endingGoals = [{ attribute: 'literature', op: '>=', value: 1000 }]; // 上限 999
  const emptyWeek = plan(input, { assignments: solve(input) }).weeks[5].start;
  input.weekCommands[emptyWeek] = null;

  const result = plan(input, { assignments: solve(input) });

  assert.equal(result.goals.ok, false, '达不到就要如实说达不到');
  const weekday = result.days.find((day) => day.date > emptyWeek && !day.isRestDay);
  assert.equal(weekday.isEmpty, true, '使用者指定的空过不能被偷偷改掉');
});
