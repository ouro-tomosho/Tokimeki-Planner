// 切片 2：输入模型与 JSON 往返。
//
// JSON 只承载使用者的输入，不承载结果——结果永远由输入重新算出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defaultInput, toJson, fromJson, validateInput } from '../src/input.js';

const rules = JSON.parse(
  readFileSync(fileURLToPath(new URL('../data/rules.json', import.meta.url)), 'utf8'),
);

test('默认输入取自规则文件里的默认值', () => {
  const input = defaultInput(rules);
  assert.equal(input.version, 1);
  assert.equal(input.startDate, '1995-04-04');
  assert.deepEqual(input.attributes, rules.defaultStart);
  assert.deepEqual(input.endingGoals, rules.defaultEndingGoals);
  assert.deepEqual(input.miniGoals, rules.defaultMiniGoals);
  assert.deepEqual(input.globalConstraints, rules.defaultGlobalConstraints);
  assert.equal(input.initialClub, null);
  assert.deepEqual(input.clubChanges, []);
  assert.deepEqual(input.weekCommands, {});
  assert.deepEqual(input.dayCommands, {});
  assert.deepEqual(input.restDays, []);
  assert.deepEqual(input.skippedDays, []);
});

test('默认输入通过校验', () => {
  assert.deepEqual(validateInput(defaultInput(rules), rules), []);
});

test('JSON 往返后输入完全相等', () => {
  const input = defaultInput(rules);
  input.startDate = '1996-05-07';
  input.attributes.tili = 250;
  input.initialClub = 'kexueshe';
  input.clubChanges = [{ date: '1997-01-05', clubId: 'lanqiushe' }, { date: '1997-06-01', clubId: null }];
  input.weekCommands = { '1996-05-12': 'c-yandu-wenke' };
  input.dayCommands = { '1996-05-12': 'c-xiuxi' };
  input.restDays = ['1996-05-08'];
  input.skippedDays = ['1996-05-09'];
  input.miniGoals = [];

  assert.deepEqual(fromJson(toJson(input), rules), input);
});

test('往返保留“空过”这一显式选择，不会退化成“未指定”', () => {
  const input = defaultInput(rules);
  input.weekCommands = { '1996-05-12': null };
  input.dayCommands = { '1996-05-12': null };

  const back = fromJson(toJson(input), rules);
  assert.ok('1996-05-12' in back.weekCommands, '空过的周必须留在键里');
  assert.equal(back.weekCommands['1996-05-12'], null);
  assert.ok('1996-05-12' in back.dayCommands, '空过的日必须留在键里');
  assert.equal(back.dayCommands['1996-05-12'], null);
});

test('无法解析的文本抛出可读错误', () => {
  assert.throws(() => fromJson('{ not json', rules), /JSON/);
});

test('未知版本被拒绝', () => {
  const input = defaultInput(rules);
  input.version = 99;
  assert.throws(() => fromJson(JSON.stringify(input), rules), /版本/);
});

test('属性越界的输入被拒绝', () => {
  const input = defaultInput(rules);
  input.attributes.tili = 1000;
  assert.deepEqual(validateInput(input, rules), ['属性 tili 的值 1000 超出 [0, 999]']);
  assert.throws(() => fromJson(JSON.stringify(input), rules), /超出/);
});

test('引用未知指令的输入被拒绝', () => {
  const input = defaultInput(rules);
  input.weekCommands = { '1996-05-12': 'c-buzhicunzai' };
  assert.deepEqual(validateInput(input, rules), ['weekCommands 引用了未知指令 c-buzhicunzai']);
});

test('引用未知社团的输入被拒绝', () => {
  const input = defaultInput(rules);
  input.initialClub = 'buzhicunzai';
  assert.deepEqual(validateInput(input, rules), ['initialClub 引用了未知社团 buzhicunzai']);
});

test('缺少属性的输入被拒绝', () => {
  const input = defaultInput(rules);
  delete input.attributes.yali;
  assert.deepEqual(validateInput(input, rules), ['输入缺少属性 yali']);
});
