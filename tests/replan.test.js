// 票 07：重规划与用户指定。
//
// 断言走 `solve(input, { previous, fromDate })` 与 `plan(input, { assignments })`：
// 冻结前缀是求解器的一等能力，它的效果通过"重算前后的日程逐格比对"来观察。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanner } from '../src/plan.js';
import { createSolver } from '../src/solver.js';
import { defaultInput } from '../src/input.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();
const plan = createPlanner(rules);
const solve = createSolver(rules);

/** 起点、属性、目标都取默认，只是先加入一个社团——否则社团经验那条永远不可达。 */
function baseInput() {
  const input = defaultInput(rules);
  input.initialClub = 'science-club';
  return input;
}

function dayMap(result) {
  return new Map(result.days.map((day) => [day.date, day]));
}

function assertIdenticalBefore(before, after, cut) {
  const left = dayMap(before);
  const right = dayMap(after);
  for (const [date, day] of left) {
    if (date >= cut) break;
    const other = right.get(date);
    assert.equal(other.commandId, day.commandId, `${date} 的指令被改写了`);
    assert.equal(other.isEmpty, day.isEmpty, `${date} 的空过状态被改写了`);
    assert.equal(other.isRestDay, day.isRestDay, `${date} 的休息日标记被改写了`);
    assert.deepEqual(other.attributes, day.attributes, `${date} 的属性变了`);
  }
}

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

test('改动一处之后，重算起点之前的安排逐格不变', () => {
  const input = baseInput();
  const before = plan(input, { assignments: solve(input) });
  const cut = before.weeks[60].start;

  const edited = structuredClone(input);
  edited.weekCommands[cut] = 'cmd-rest';

  const after = plan(edited, { assignments: solve(edited, { previous: solve(input), fromDate: cut }) });

  assertIdenticalBefore(before, after, cut);
  assert.equal(dayMap(after).get(before.weeks[61].days[1]).commandId !== undefined, true);
});

test('从重算起点起的部分，与"把前缀当成显式指定后整份重排"一致', () => {
  const input = baseInput();
  const previous = solve(input);
  const cut = plan(input, { assignments: previous }).weeks[60].start;

  const edited = structuredClone(input);
  edited.weekCommands[cut] = 'cmd-rest';
  const incremental = plan(edited, { assignments: solve(edited, { previous, fromDate: cut }) });

  // 把前缀原样写成显式指定，再不带冻结地完整算一遍——这就是"从该决策点起重新完整计算"
  const explicit = structuredClone(edited);
  for (const [anchor, id] of Object.entries(previous.weekCommands)) {
    if (anchor < cut) explicit.weekCommands[anchor] ??= id;
  }
  for (const [date, id] of Object.entries(previous.dayCommands)) {
    if (date < cut) explicit.dayCommands[date] ??= id;
  }
  const full = plan(explicit, { assignments: solve(explicit) });

  const left = dayMap(incremental);
  const right = dayMap(full);
  for (const [date, day] of left) {
    if (date < cut) continue;
    assert.equal(right.get(date).commandId, day.commandId, `${date} 的指令对不上`);
    assert.deepEqual(right.get(date).attributes, day.attributes, `${date} 的属性对不上`);
  }
});

test('在某个周日切换社团，重算自该周日起，且该周日起不再出现旧社团的指令', () => {
  const input = baseInput();
  const previous = solve(input);
  const before = plan(input, { assignments: previous });
  const sunday = before.weeks[20].start;

  const edited = structuredClone(input);
  edited.clubChanges = [{ date: sunday, clubId: 'art-club' }];
  const after = plan(edited, {
    assignments: solve(edited, { previous, fromDate: sunday }),
  });

  assertIdenticalBefore(before, after, sunday);

  const clubOf = new Map(rules.commands.map((command) => [command.id, command.clubId]));
  for (const day of after.days) {
    if (day.date < sunday || !day.commandId) continue;
    const club = clubOf.get(day.commandId);
    if (club == null) continue; // 日常指令的 clubId 是 null，不受社团限制
    assert.equal(club, 'art-club', `${day.date} 还在用旧社团的指令`);
  }
});

test('已有结果上再改一处，之前已经排好的历史仍然逐格不变', () => {
  const input = baseInput();
  const first = solve(input);
  const cutOne = plan(input, { assignments: first }).weeks[40].start;

  const second = structuredClone(input);
  second.weekCommands[cutOne] = 'cmd-chat';
  const secondAssignments = solve(second, { previous: first, fromDate: cutOne });

  const cutTwo = plan(second, { assignments: secondAssignments }).weeks[80].start;
  const third = structuredClone(second);
  third.restDays = ['1997-01-15'];
  const thirdAssignments = solve(third, { previous: secondAssignments, fromDate: cutTwo });

  const before = plan(second, { assignments: secondAssignments });
  const after = plan(third, { assignments: thirdAssignments });
  assertIdenticalBefore(before, after, cutTwo);

  // 第一次改动定下的那一周，在第二次改动之后仍然是它
  const pinnedWeekday = after.days.find((day) => day.date > cutOne && !day.isRestDay);
  assert.equal(pinnedWeekday.commandId, 'cmd-chat', '第一次改动定下的安排被第二次改动改写了');
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
