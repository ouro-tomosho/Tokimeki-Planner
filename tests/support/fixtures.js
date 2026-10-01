// 求解器相关测试共用的夹具。

import { defaultInput } from '../../src/input.js';

/** 起点、属性、目标都取默认，只是先加入一个社团——否则社团经验那条永远不可达。 */
export function clubInput(rules) {
  const input = defaultInput(rules);
  input.initialClub = 'science-club';
  return input;
}

/** 按日期索引结果里的每一天。 */
export function dayMap(result) {
  return new Map(result.days.map((day) => [day.date, day]));
}
