// 测试用的日程填充工具。
//
// 「全局默认指令」已删除（它不在所有者给的规则里，且求解器会填满所有槽位，等于空转）。
// 测试要"把整条时间轴铺成同一条指令"时，直接写出**指定**，走的是使用者本来就走的那条路。

import { addDays, weekdayOf, weekStartOf } from '../../src/dates.js';

/** 把时间轴上的**平日**都指定成同一条指令（写进 weekCommands 的周锚点）。 */
export function fillWeeks(input, rules, commandId) {
  for (let date = input.startDate; date <= rules.timeline.lastSettlement; date = addDays(date, 1)) {
    if (weekdayOf(date) !== 0) input.weekCommands[weekStartOf(date)] = commandId;
  }
}

/** 把时间轴上的**休息日**都指定成同一条指令（写进 dayCommands）。 */
export function fillRestDays(input, rules, commandId) {
  for (let date = input.startDate; date <= rules.timeline.lastSettlement; date = addDays(date, 1)) {
    if (weekdayOf(date) === 0) input.dayCommands[date] = commandId;
  }
}
