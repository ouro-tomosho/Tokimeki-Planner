// 切片 2：输入模型与 JSON 往返。
//
// JSON 只承载使用者的输入，不承载结果——结果永远由输入重新算出。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampToLimits,
  defaultInput,
  exportFileName,
  fromJson,
  toJson,
  validateInput,
} from '../src/input.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();

test('默认输入取自规则文件里的默认值', () => {
  const input = defaultInput(rules);
  assert.equal(input.version, 2);
  assert.equal(input.playedUpTo, '1995-04-04');
  assert.deepEqual(input.attributes, rules.defaultStart);
  assert.deepEqual(input.endingGoals, rules.defaultEndingGoals);
  assert.deepEqual(input.miniGoals, rules.defaultMiniGoals);
  assert.deepEqual(input.globalConstraints, rules.defaultGlobalConstraints);
  assert.equal(input.initialClub, null);
  assert.deepEqual(input.clubExperience, {});
  assert.deepEqual(input.clubChanges, []);
  assert.deepEqual(input.weekCommands, {});
  assert.deepEqual(input.dayCommands, {});
  assert.deepEqual(input.restDays, []);
  assert.deepEqual(input.skippedDays, []);
});

test('默认输入通过校验', () => {
  assert.deepEqual(validateInput(defaultInput(rules), rules), []);
});

test('导出文件名就是已玩到日期的裸日期', () => {
  const input = defaultInput(rules);
  input.playedUpTo = '1996-05-01';
  assert.equal(exportFileName(input), '1996-05-01.json');
});

test('手输的属性值落库前被夹进上下限并取整', () => {
  const limits = { min: 0, max: 999 };
  assert.equal(clampToLimits(1000, limits), 999, '越上界夹到上界');
  assert.equal(clampToLimits(-5, limits), 0, '越下界夹到下界');
  assert.equal(clampToLimits(12.6, limits), 13, '小数取整');
  assert.equal(clampToLimits(Number.NaN, limits), 0, '非数字退回下界');
});

test('JSON 往返后输入完全相等', () => {
  const input = defaultInput(rules);
  input.playedUpTo = '1996-05-07';
  input.attributes.stamina = 250;
  input.initialClub = 'science-club';
  input.clubChanges = [
    { date: '1997-01-05', clubId: 'basketball-club' },
    { date: '1997-06-01', clubId: null },
  ];
  input.weekCommands = { '1996-05-12': 'cmd-study-literature' };
  input.dayCommands = { '1996-05-12': 'cmd-rest' };
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

test('同一个周日既是周锚点又拥有自己的日指令，是合法输入', () => {
  const input = defaultInput(rules);
  input.weekCommands['1996-05-12'] = 'cmd-study-literature';
  input.dayCommands['1996-05-12'] = 'cmd-rest';

  assert.deepEqual(validateInput(input, rules), []);
});

test('无法解析的文本抛出可读错误', () => {
  assert.throws(() => fromJson('{ not json', rules), /JSON/);
});

test('未知版本被拒绝', () => {
  const input = defaultInput(rules);
  input.version = 99;
  assert.throws(() => fromJson(JSON.stringify(input), rules), /版本/);
});

test('v1 的 JSON 导入时把两个日期合并成一个，取较晚者', () => {
  const legacy = {
    ...defaultInput(rules),
    version: 1,
    startDate: '1995-06-01',
    playedUpTo: '1996-05-01',
  };

  const migrated = fromJson(JSON.stringify(legacy), rules);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.playedUpTo, '1996-05-01');
  assert.equal('startDate' in migrated, false, 'v1 的 startDate 不该留在输入里');
});

test('v1 里起点晚于已玩到时，取起点', () => {
  const legacy = {
    ...defaultInput(rules),
    version: 1,
    startDate: '1996-05-01',
    playedUpTo: '1995-06-01',
  };

  const migrated = fromJson(JSON.stringify(legacy), rules);
  assert.equal(migrated.playedUpTo, '1996-05-01');
});

test('属性越界的输入被拒绝', () => {
  const input = defaultInput(rules);
  input.attributes.stamina = 1000;
  assert.deepEqual(validateInput(input, rules), ['属性 stamina 的值 1000 超出 [0, 999]']);
  assert.throws(() => fromJson(JSON.stringify(input), rules), /超出/);
});

test('引用未知指令的输入被拒绝', () => {
  const input = defaultInput(rules);
  input.weekCommands = { '1996-05-12': 'cmd-does-not-exist' };
  assert.deepEqual(validateInput(input, rules), [
    'weekCommands 引用了未知指令 cmd-does-not-exist',
  ]);
});

test('引用未知社团的输入被拒绝', () => {
  const input = defaultInput(rules);
  input.initialClub = 'no-such-club';
  assert.deepEqual(validateInput(input, rules), ['initialClub 引用了未知社团 no-such-club']);
});

test('缺少属性的输入被拒绝', () => {
  const input = defaultInput(rules);
  delete input.attributes.stress;
  assert.deepEqual(validateInput(input, rules), ['输入缺少属性 stress']);
});

test('起点社团经验越界被拒绝；缺失时按空映射补上', () => {
  const over = defaultInput(rules);
  over.clubExperience = { 'science-club': 1000 };
  assert.deepEqual(validateInput(over, rules), [
    'clubExperience 的 science-club 超出 [0, 999]',
  ]);

  const unknown = defaultInput(rules);
  unknown.clubExperience = { 'no-such-club': 10 };
  assert.deepEqual(validateInput(unknown, rules), [
    'clubExperience 引用了未知社团 no-such-club',
  ]);

  const legacy = defaultInput(rules);
  delete legacy.clubExperience;
  assert.deepEqual(validateInput(legacy, rules), []);
  assert.deepEqual(legacy.clubExperience, {}, '缺字段的老输入当作哪个社团都没攒过');
});

test('周锚点必须是周日', () => {
  const input = defaultInput(rules);
  input.weekCommands = { '1996-05-13': 'cmd-rest' };
  assert.deepEqual(validateInput(input, rules), [
    'weekCommands 的键必须是周日（周锚点）：1996-05-13',
  ]);
});

test('休息日与跳过日必须落在时间轴内', () => {
  const input = defaultInput(rules);
  input.restDays = ['1999-01-01'];
  input.skippedDays = ['1994-01-01'];
  assert.deepEqual(validateInput(input, rules), [
    'restDays 的日期超出时间轴：1999-01-01',
    'skippedDays 的日期超出时间轴：1994-01-01',
  ]);
});

test('形状合法但不是真实日历的日期被拒绝', () => {
  const input = defaultInput(rules);
  input.skippedDays = ['1996-13-45'];
  assert.deepEqual(validateInput(input, rules), ['skippedDays 含非法日期：1996-13-45']);
});

test('「键为 null」表示空过，与「键不存在」（待定）区分得开', () => {
  const input = defaultInput(rules);
  input.weekCommands['1996-05-12'] = null;
  input.dayCommands['1996-05-19'] = null;
  assert.deepEqual(validateInput(input, rules), []);
});

test('旧存档里多出来的字段不会导致导入失败', () => {
  // 「全局默认指令」已删除；带这两个字段的旧导出仍须能导入，只是它们不再起作用。
  const input = defaultInput(rules);
  input.defaultWeekCommand = 'cmd-rest';
  input.defaultDayCommand = 'cmd-rest';

  assert.deepEqual(validateInput(input, rules), []);
  assert.doesNotThrow(() => fromJson(JSON.stringify(input), rules));
});
