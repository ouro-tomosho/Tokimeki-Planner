// 票 02：日历与决策点结构。
//
// 断言一律走预先商定的最高层接缝 `plan(input) → PlanResult`，不直接够到
// calendar 模块内部。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlanner } from '../src/plan.js';
import { defaultInput } from '../src/input.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();
const plan = createPlanner(rules);

/** 用默认输入做一份规划，可选地先改一改输入。 */
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

test('终点恒为 1998-03-01：在表中，但不结算', () => {
  const result = planOf();
  assert.equal(result.endDate, '1998-03-01');

  const last = dayAt(result, '1998-03-01');
  assert.equal(last.weekdayName, '周日');
  assert.equal(last.isSettled, false);
});

test('最后结算日是 1998-02-28', () => {
  const result = planOf();
  assert.equal(result.lastSettlement, '1998-02-28');
  assert.equal(dayAt(result, '1998-02-28').isSettled, true);

  const laterSettled = result.days.filter((d) => d.date > '1998-02-28' && d.isSettled);
  assert.deepEqual(laterSettled, []);
});

test('起点为 1995-04-04 时，该日留在表里但不结算', () => {
  const result = planOf();
  const opening = dayAt(result, '1995-04-04');
  assert.equal(opening.isSettled, false);
  assert.equal(opening.isSkipped, false);

  // 次日照常结算
  assert.equal(dayAt(result, '1995-04-05').isSettled, true);
});

test('起点不是游戏开局日时，起点当天照常结算', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
  });
  assert.equal(dayAt(result, '1998-02-20').isSettled, true);
});

test('每一天都带有星期与所属自然周的周锚点', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
  });
  for (const day of result.days) {
    assert.match(day.weekdayName, /^周[日一二三四五六]$/, day.date);
    assert.ok(day.weekStart <= day.date, `${day.date} 的周锚点晚于它自己`);
  }
});

test('周日恒为休息日，且它就是所在自然周的第一天', () => {
  const result = planOf((input) => {
    input.startDate = '1996-01-01';
  });
  const sundays = result.days.filter((d) => d.weekday === 0);
  assert.ok(sundays.length > 100, '时间轴里应当有很多个周日');
  for (const sunday of sundays) {
    assert.equal(sunday.isRestDay, true, `${sunday.date} 是周日却不是休息日`);
    assert.equal(sunday.weekStart, sunday.date, `${sunday.date} 不是它自己那一周的锚点`);
  }
});

test('首周不完整时，只包含从起点到该周周六的实际天数', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20'; // 周五
  });
  const firstWeek = result.weeks[0];
  assert.equal(firstWeek.start, '1998-02-15'); // 周日
  assert.deepEqual(firstWeek.days, ['1998-02-20', '1998-02-21']);
  assert.equal(firstWeek.lastDay, '1998-02-21');
});

test('起始日是周日时，首周是完整的一周', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
  });
  assert.deepEqual(result.weeks[0].days, [
    '1998-02-22',
    '1998-02-23',
    '1998-02-24',
    '1998-02-25',
    '1998-02-26',
    '1998-02-27',
    '1998-02-28',
  ]);
});

test('标记某一天为休息日，只有那一天改变', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
    input.restDays = ['1998-02-24'];
  });

  assert.equal(dayAt(result, '1998-02-24').isRestDay, true);
  assert.equal(dayAt(result, '1998-02-23').isRestDay, false);
  assert.equal(dayAt(result, '1998-02-25').isRestDay, false);
});

test('跳过某一周，只影响该周的平日，周日不受影响', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
    input.weekCommands = { '1998-02-15': null };
  });

  assert.equal(dayAt(result, '1998-02-20').isSkipped, true);
  assert.equal(dayAt(result, '1998-02-21').isSkipped, true);
  assert.equal(dayAt(result, '1998-02-20').isSettled, false);

  // 下一周的周日照常休息、照常结算
  assert.equal(dayAt(result, '1998-02-22').isSkipped, false);
  assert.equal(dayAt(result, '1998-02-22').isSettled, true);
});

test('跳过某一天，不影响同一周的其它天', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
    input.skippedDays = ['1998-02-24'];
  });

  assert.equal(dayAt(result, '1998-02-24').isSkipped, true);
  assert.equal(dayAt(result, '1998-02-24').isSettled, false);
  assert.equal(dayAt(result, '1998-02-23').isSkipped, false);
  assert.equal(dayAt(result, '1998-02-25').isSkipped, false);
});

test('把某个休息日的日指令显式置空，等价于跳过该日', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
    input.restDays = ['1998-02-24'];
    input.dayCommands = { '1998-02-24': null };
  });

  assert.equal(dayAt(result, '1998-02-24').isSkipped, true);
  assert.equal(dayAt(result, '1998-02-24').isSettled, false);
});

test('决策点顺序：首周周指令 → 周日日指令 → 本周周指令', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20'; // 周五，首周没有周日落在时间轴内
  });

  assert.deepEqual(result.decisionPoints, [
    { date: '1998-02-20', kind: 'week-command', order: 0 },
    { date: '1998-02-22', kind: 'day-command', order: 1 },
    { date: '1998-02-22', kind: 'week-command', order: 2 },
  ]);
});

test('起点是周日时，顺序为 周日日指令 → 周日结算 → 本周周指令', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
  });

  assert.deepEqual(result.decisionPoints.slice(0, 2), [
    { date: '1998-02-22', kind: 'day-command', order: 0 },
    { date: '1998-02-22', kind: 'week-command', order: 1 },
  ]);
});

test('被标记为休息日的平日，其日指令决策出现在该日结算之前', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
    input.restDays = ['1998-02-25'];
  });

  const points = result.decisionPoints.map((p) => `${p.order}:${p.date}:${p.kind}`);
  assert.deepEqual(points, [
    '0:1998-02-22:day-command',
    '1:1998-02-22:week-command',
    '2:1998-02-25:day-command',
  ]);
});

test('首周没有周日时，周指令决策落在首周第一次结算之前', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
  });

  const weekCommand = result.decisionPoints.find((p) => p.kind === 'week-command');
  assert.equal(weekCommand.date, '1998-02-20');

  const firstSettled = result.days.find((d) => d.isSettled);
  assert.equal(firstSettled.date, '1998-02-20');
  assert.ok(weekCommand.order <= result.decisionPoints[0].order);
});

test('终点所在的最后一周末尾没有可结算的平日，因此不产生周指令决策', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
  });
  const lastWeek = result.weeks.at(-1);
  assert.equal(lastWeek.start, '1998-03-01');

  const pointsAtEnd = result.decisionPoints.filter((p) => p.date === '1998-03-01');
  assert.deepEqual(pointsAtEnd, []);
});

test('汇总数字与表一致（短时间轴）', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
  });
  assert.deepEqual(result.summary, {
    totalDays: 10,
    settledDays: 9,
    skippedDays: 0,
    restDays: 2,
    weeks: 3,
  });
});

test('默认规划覆盖整条时间轴：首尾都在表里，共 1063 天', () => {
  // 时间轴 1995-04-04 → 1998-03-01 的跨度是 1062 天；表把**首尾两天都列出来**，
  // 所以行数是 1063。
  const result = planOf();
  assert.equal(result.summary.totalDays, 1063);
  assert.equal(result.days[0].date, '1995-04-04');
  assert.equal(result.days.at(-1).date, '1998-03-01');
});
