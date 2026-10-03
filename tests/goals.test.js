// 达标清单的显示顺序（见 `goalDisplayOrder`）。
//
// 断言走纯函数接缝：给定目标数组，返回**显示用的下标序列**。
// 排序只影响显示，所以这里同时锁住"输入数组原样不动"。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { goalDisplayOrder } from '../src/goals.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();

test('结局目标与全局约束按属性次序排，不看录入顺序', () => {
  const goals = [
    { attribute: 'stress', op: '<', value: 50 },
    { attribute: 'stamina', op: '>=', value: 50 },
    { attribute: 'literature', op: '>=', value: 130 },
    { attribute: 'popularity', op: '>=', value: 120 },
  ];

  assert.deepEqual(goalDisplayOrder(rules, goals, 'attribute'), [1, 2, 3, 0]);
});

test('同一属性的多条按录入顺序稳定排列', () => {
  const goals = [
    { attribute: 'stress', op: '<', value: 70 },
    { attribute: 'stamina', op: '>=', value: 20 },
    { attribute: 'stress', op: '<', value: 50 },
    { attribute: 'stamina', op: '>=', value: 60 },
  ];

  assert.deepEqual(goalDisplayOrder(rules, goals, 'attribute'), [1, 3, 0, 2]);
});

test('未知属性排在最后，不会打断已知属性的次序', () => {
  const goals = [
    { attribute: 'nope', op: '>=', value: 1 },
    { attribute: 'grit', op: '>=', value: 100 },
    { attribute: 'appearance', op: '>=', value: 100 },
  ];

  assert.deepEqual(goalDisplayOrder(rules, goals, 'attribute'), [2, 1, 0]);
});

test('小目标按截止日期从早到晚，同日按录入顺序', () => {
  const goals = [
    { deadline: '1998-02-23', attributes: ['literature'], op: '>=', value: 1 },
    { deadline: '1998-01-02', attributes: ['clubExperience'], op: '>=', value: 380 },
    { deadline: '1998-01-02', attributes: ['science'], op: '>=', value: 1 },
  ];

  assert.deepEqual(goalDisplayOrder(rules, goals, 'deadline'), [1, 2, 0]);
});

test('排序不改写输入数组', () => {
  const goals = [
    { attribute: 'stress', op: '<', value: 50 },
    { attribute: 'stamina', op: '>=', value: 50 },
  ];
  const before = structuredClone(goals);

  goalDisplayOrder(rules, goals, 'attribute');
  assert.deepEqual(goals, before);
});
