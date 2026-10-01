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

/** 把有序事件压成 "日期:种类" 便于逐条比对。 */
function sequenceOf(result) {
  return result.sequence.map((entry) => `${entry.date}:${entry.kind}`);
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
  assert.equal(opening.isEmpty, false);

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
  assert.equal(firstWeek.start, '1998-02-15'); // 周日，落在起点之前
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

  const skipped = dayAt(result, '1998-02-20');
  assert.equal(skipped.isEmpty, true);
  assert.equal(skipped.skipSource, 'week');
  assert.equal(skipped.isSettled, false);
  assert.equal(dayAt(result, '1998-02-21').isEmpty, true);

  // 下一周的周日照常休息、照常结算
  assert.equal(dayAt(result, '1998-02-22').isEmpty, false);
  assert.equal(dayAt(result, '1998-02-22').isSettled, true);
});

test('跳过某一天，不影响同一周的其它天', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
    input.skippedDays = ['1998-02-24'];
  });

  const skipped = dayAt(result, '1998-02-24');
  assert.equal(skipped.isEmpty, true);
  assert.equal(skipped.skipSource, 'day');
  assert.equal(skipped.isSettled, false);
  assert.equal(dayAt(result, '1998-02-23').isEmpty, false);
  assert.equal(dayAt(result, '1998-02-25').isEmpty, false);
});

test('把某个休息日的日指令显式置空，该日空过', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
    input.restDays = ['1998-02-24'];
    input.dayCommands = { '1998-02-24': null };
  });

  const day = dayAt(result, '1998-02-24');
  assert.equal(day.isEmpty, true);
  assert.equal(day.skipSource, 'day-command');
  assert.equal(day.isSettled, false);
});

test('严格按验收标准：周日日指令 → 周日结算 → 本周周指令 → 各平日结算', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22'; // 周日起步，首周完整
  });

  assert.deepEqual(sequenceOf(result), [
    '1998-02-22:day-command',
    '1998-02-22:settle',
    '1998-02-22:week-command',
    '1998-02-23:settle',
    '1998-02-24:settle',
    '1998-02-25:settle',
    '1998-02-26:settle',
    '1998-02-27:settle',
    '1998-02-28:settle',
  ]);
});

test('首周没有周日时，周指令决策落在首周第一次结算之前', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20'; // 周五，首周没有周日落在时间轴内
  });

  assert.deepEqual(sequenceOf(result), [
    '1998-02-20:week-command',
    '1998-02-20:settle',
    '1998-02-21:settle',
    '1998-02-22:day-command',
    '1998-02-22:settle',
    '1998-02-22:week-command',
    '1998-02-23:settle',
    '1998-02-24:settle',
    '1998-02-25:settle',
    '1998-02-26:settle',
    '1998-02-27:settle',
    '1998-02-28:settle',
  ]);
});

test('被标记为休息日的平日，其日指令决策出现在该日结算之前', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
    input.restDays = ['1998-02-25'];
  });

  assert.deepEqual(sequenceOf(result), [
    '1998-02-22:day-command',
    '1998-02-22:settle',
    '1998-02-22:week-command',
    '1998-02-23:settle',
    '1998-02-24:settle',
    '1998-02-25:day-command',
    '1998-02-25:settle',
    '1998-02-26:settle',
    '1998-02-27:settle',
    '1998-02-28:settle',
  ]);
});

test('空过的日子不产生任何事件', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
    input.skippedDays = ['1998-02-24'];
  });

  const forSkipped = result.sequence.filter((entry) => entry.date === '1998-02-24');
  assert.deepEqual(forSkipped, []);
});

test('终点所在的最后一周期 1998-03-01 是周日，当天不结算也不产生事件', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
  });
  assert.equal(result.weeks.at(-1).start, '1998-03-01');
  assert.deepEqual(
    result.sequence.filter((entry) => entry.date === '1998-03-01'),
    [],
  );
});

test('汇总数字与表一致（短时间轴）', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-20';
  });
  assert.deepEqual(result.summary, {
    totalDays: 10,
    settledDays: 9,
    emptyDays: 0,
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

test('非法输入不会让 plan 抛错，而是回报问题列表', () => {
  const input = defaultInput(rules);
  input.startDate = '1999-01-01'; // 超出时间轴
  const result = plan(input);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid-input');
  assert.ok(result.problems.some((p) => p.includes('startDate')));
});

test('全局默认指令能铺满整条时间轴，逐日属性按期望值演变', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
    input.attributes.stress = 50;
    input.defaultWeekCommand = 'cmd-rest';
    input.defaultDayCommand = 'cmd-rest';
  });

  // 02-22 是周日（休息日）：休息指令的体力 +3.1×4、压力 -2.9×4
  const sunday = dayAt(result, '1998-02-22');
  assert.equal(sunday.commandId, 'cmd-rest');
  assert.ok(Math.abs(sunday.attributes.stamina - 112.4) < 1e-5, `${sunday.attributes.stamina}`);
  assert.ok(Math.abs(sunday.attributes.stress - 38.4) < 1e-5, `${sunday.attributes.stress}`);

  // 02-23 是平日：体力 +3.1、压力 -2.9
  const monday = dayAt(result, '1998-02-23');
  assert.ok(Math.abs(monday.attributes.stamina - 115.5) < 1e-5, `${monday.attributes.stamina}`);
  assert.ok(Math.abs(monday.attributes.stress - 35.5) < 1e-5, `${monday.attributes.stress}`);

  // 终点当天不结算，属性停在前一天
  assert.deepEqual(dayAt(result, '1998-03-01').attributes, dayAt(result, '1998-02-28').attributes);
});

test('空过日不结算，属性原样带入下一天', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
    input.defaultWeekCommand = 'cmd-rest';
    input.skippedDays = ['1998-02-24'];
  });

  assert.deepEqual(dayAt(result, '1998-02-24').attributes, dayAt(result, '1998-02-23').attributes);
  assert.notDeepEqual(
    dayAt(result, '1998-02-25').attributes,
    dayAt(result, '1998-02-24').attributes,
  );
});

test('显式指定的周指令优先于全局默认', () => {
  const result = planOf((input) => {
    input.startDate = '1998-02-22';
    input.defaultWeekCommand = 'cmd-rest';
    input.weekCommands['1998-02-22'] = 'cmd-exercise';
  });

  const monday = dayAt(result, '1998-02-23');
  assert.equal(monday.commandId, 'cmd-exercise');
  // 运动的运动 +3.3（成功）→ 期望 0.63×3.3 + 0.37×1.65 = 2.6895
  assert.ok(Math.abs(monday.attributes.sports - 42.6895) < 1e-5, `${monday.attributes.sports}`);
});

test('同一输入两次规划，逐日属性完全一致', () => {
  const build = () => {
    const input = defaultInput(rules);
    input.startDate = '1998-02-22';
    input.defaultWeekCommand = 'cmd-study-literature';
    return plan(input);
  };
  assert.deepEqual(build().days, build().days);
});
