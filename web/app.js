// 主线程：表单、指令选择、日历表与曲线、JSON 导入导出，以及一次 Worker 往返。
//
// 页面是从 file:// 双击打开的，而有些浏览器在 file:// 下拒绝构造 blob Worker。
// 因此这里对 Worker 做降级：能建就用 Worker，建不了或中途报错就回退到主线程，
// 保证"双击即用"这件事在任何浏览器里都成立。

import rules from '../data/rules.json';
import { availableCommandIds, createClubLookup } from '../src/clubs.js';
import { attributeById, attributeIds } from '../src/lookup.js';
import { defaultInput, fromJson, toJson } from '../src/input.js';
import { createPlanner } from '../src/plan.js';

const UNSET = '';
const EMPTY = '__empty__';
const NO_CLUB = '__no_club__';

const state = { input: defaultInput(rules), requestId: 0, daysByDate: new Map() };
const pending = new Map();
const inlinePlan = createPlanner(rules);
const commandNames = new Map(rules.commands.map((c) => [c.id, c.name]));
const attributeLabels = rules.attributes.map((a) => ({ id: a.id, name: a.name }));

let worker = null;
let workerUnavailable = false;

let dayRows = new Map();
let weekRows = new Map();
let renderedSignature = '';
let clubAtNow = () => null;

const BASE_COLUMNS = ['日期', '星期', '当天顺序', '结算', '指令', '休息日', '跳过'];
const COLUMNS = [...BASE_COLUMNS, ...attributeLabels.map((a) => a.name)];

const SEQUENCE_LABELS = { 'day-command': '日指令', settle: '结算', 'week-command': '周指令' };
const EMPTY_LABELS = {
  day: '空过（指定本日）',
  'day-command': '空过（日指令置空）',
  week: '空过（本周空过）',
};
const BLOCK_LABELS = {
  'club-not-unlocked': '不结算（社团未解锁）',
  'club-not-selected': '不结算（未加入社团）',
  'club-mismatch': '不结算（社团不符）',
};
const CURVE_COLORS = [
  '#2f6fed',
  '#e05252',
  '#2f9e6f',
  '#c98a1b',
  '#8b5cf6',
  '#0e9aa7',
  '#d9578a',
  '#6b7280',
  '#a3541c',
];
const curveColorAt = (index) => CURVE_COLORS[index % CURVE_COLORS.length];

const $ = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error', isError);
}

// ---------------------------------------------------------------- Worker

function startWorker() {
  try {
    const source = $('worker-source').textContent;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = (event) => {
      const reply = event.data;
      const settle = pending.get(reply && reply.id);
      if (!settle) return;
      pending.delete(reply.id);
      settle(reply);
    };
    worker.onerror = () => {
      workerUnavailable = true;
      const inflight = [...pending.values()];
      pending.clear();
      for (const settle of inflight) settle({ fallback: true });
    };
  } catch (error) {
    worker = null;
    workerUnavailable = true;
  }
}

function runOnMainThread(input) {
  try {
    return { ok: true, result: inlinePlan(input) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function requestPlan(input) {
  if (workerUnavailable || !worker) return Promise.resolve(runOnMainThread(input));

  const id = ++state.requestId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, type: 'plan', input });
  }).then((reply) => {
    if (!reply.fallback) return reply;
    setStatus('当前浏览器不允许内联 Worker，已回退到主线程计算。');
    return runOnMainThread(input);
  });
}

// ---------------------------------------------------------------- 指令选择器

/** 三态选择串与输入值之间的互转：未指定 ↔ 键不存在，空过 ↔ 显式 null。 */
function commandIdFromChoice(choice) {
  if (choice === EMPTY) return null;
  if (choice === UNSET) return undefined;
  return choice;
}

function choiceFromCommandId(commandId) {
  if (commandId === undefined) return UNSET;
  if (commandId === null) return EMPTY;
  return commandId;
}

/** 全局默认指令只有两态：未指定 / 某条指令——「空过」是逐周逐日的选择，不做全局默认。 */
function commandIdFromDefaultChoice(choice) {
  return choice === UNSET ? null : choice;
}

/**
 * 填一个指令下拉框。`choice` 是已经归一化过的选择串。
 * `allowEmpty` 为假时不给「空过」选项——那就是全局默认指令。
 * `commands` 用来把不可用的社团指令挡在候选之外。
 */
function fillCommandSelect(select, choice, { allowEmpty = true, commands = rules.commands } = {}) {
  select.textContent = '';
  const entries = [[UNSET, '未指定']];
  if (allowEmpty) entries.push([EMPTY, '空过']);
  for (const command of commands) entries.push([command.id, command.name]);

  for (const [value, label] of entries) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }

  // 已经写进输入、但当前**不可用**的指令也要留在选项里——否则下拉框会显示成"未指定"，
  // 与输入里那条真实存在的指定对不上。至于为什么没执行，由结算列说明。
  if (choice && !entries.some(([value]) => value === choice)) {
    const option = document.createElement('option');
    option.value = choice;
    option.textContent = `${commandNames.get(choice) ?? choice}（不可用）`;
    select.append(option);
  }

  select.value = choice;
}

/** 这一天能选的指令——社团指令受解锁日与当前社团限制。 */
function commandsAvailableAt(date) {
  const allowed = new Set(availableCommandIds(rules, clubAtNow(date), date));
  return rules.commands.filter((command) => allowed.has(command.id));
}

function fillClubSelect(select, value) {
  select.textContent = '';
  const entries = [[UNSET, '未加入'], ...rules.clubs.map((club) => [club.id, club.name])];
  for (const [optionValue, label] of entries) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  }
  select.value = value ?? UNSET;
}

/** 每周表头里的社团下拉框：三态——不切换 / 退出社团 / 某个社团。 */
function fillWeekClubSelect(select, value) {
  select.textContent = '';
  const entries = [[UNSET, '不切换'], [NO_CLUB, '退出社团'], ...rules.clubs.map((club) => [club.id, club.name])];
  for (const [optionValue, label] of entries) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  }
  select.value = value === undefined ? UNSET : value === null ? NO_CLUB : value;
}

function setMapEntry(map, key, choice) {
  const commandId = commandIdFromChoice(choice);
  if (commandId === undefined) delete map[key];
  else map[key] = commandId;
}

/**
 * 一天的「指令」单元格：休息日给可改的下拉框，平日只显示本周周指令（不可单独决策）。
 * 休息日只在**真正需要**时才建下拉框——一千多行每行都塞一个二十项的下拉框太重。
 */
function fillCommandCell(cell, day) {
  cell.textContent = '';
  if (day.isRestDay) {
    const select = document.createElement('select');
    select.dataset.action = 'day-command';
    select.dataset.date = day.date;
    fillCommandSelect(select, choiceFromCommandId(state.input.dayCommands[day.date]), {
      commands: commandsAvailableAt(day.date),
    });
    cell.append(select);
    return;
  }
  // 平日不单独决策：这里显示的是本周周指令，由输入推导（空过日的 commandId 本来就是空）
  if (day.skipSource === 'week') {
    cell.textContent = '空过';
    return;
  }
  const pinned = state.input.weekCommands[day.weekStart];
  const effective = pinned === undefined ? state.input.defaultWeekCommand : pinned;
  cell.textContent = effective ? (commandNames.get(effective) ?? effective) : '—';
}

// ---------------------------------------------------------------- 输入区

function renderForm() {
  const startDate = $('start-date');
  startDate.min = rules.timeline.start;
  startDate.max = rules.timeline.lastSettlement;
  startDate.value = state.input.startDate;

  const container = $('attributes');
  container.textContent = '';
  for (const id of attributeIds(rules)) {
    const attribute = attributeById(rules, id);

    const label = document.createElement('label');
    label.className = 'field';

    const caption = document.createElement('span');
    caption.textContent = attribute.name;

    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(attribute.min);
    input.max = String(attribute.max);
    input.value = String(state.input.attributes[id]);
    input.addEventListener('change', () => {
      state.input.attributes[id] = Number(input.value);
    });

    label.append(caption, input);
    container.append(label);
  }

  fillClubSelect($('initial-club'), state.input.initialClub);
  fillCommandSelect($('default-week-command'), state.input.defaultWeekCommand ?? UNSET, {
    allowEmpty: false,
  });
  fillCommandSelect($('default-day-command'), state.input.defaultDayCommand ?? UNSET, {
    allowEmpty: false,
  });
}

// ---------------------------------------------------------------- 日历表

function calendarSignature(result) {
  const last = result.days[result.days.length - 1];
  // 社团决定了每个时点能选哪些指令，所以它一变就得重建下拉框里的候选。
  const clubs = `${state.input.initialClub}|${JSON.stringify(state.input.clubChanges)}`;
  return `${result.startDate}|${result.days.length}|${last ? last.date : ''}|${clubs}`;
}

function renderCalendar(result) {
  const host = $('calendar');
  host.textContent = '';
  dayRows = new Map();
  weekRows = new Map();
  renderedSignature = calendarSignature(result);

  const table = document.createElement('table');
  table.className = 'calendar';

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const name of COLUMNS) {
    const th = document.createElement('th');
    th.textContent = name;
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement('tbody');
  const fragment = document.createDocumentFragment();
  const dayByDate = new Map(result.days.map((d) => [d.date, d]));

  for (const week of result.weeks) {
    fragment.append(buildWeekRow(week));
    for (const date of week.days) {
      fragment.append(buildDayRow(dayByDate.get(date)));
    }
  }

  body.append(fragment);
  table.append(body);
  host.append(table);
}

function buildWeekRow(week) {
  const row = document.createElement('tr');
  row.className = 'week-row';

  const cell = document.createElement('th');
  cell.colSpan = COLUMNS.length;

  const anchor = document.createElement('span');
  anchor.textContent = `周锚点 ${week.start}（${week.firstDay} 起）`;

  const commandFlag = document.createElement('label');
  commandFlag.className = 'week-flag';
  const commandSelect = document.createElement('select');
  commandSelect.dataset.action = 'week-command';
  commandSelect.dataset.week = week.start;
  fillCommandSelect(commandSelect, choiceFromCommandId(state.input.weekCommands[week.start]), {
    commands: commandsAvailableAt(week.firstDay),
  });
  commandFlag.append(document.createTextNode(' 周指令 '), commandSelect);

  // 社团只能在周日切换，而每周表头正是那个周日。
  const clubFlag = document.createElement('label');
  clubFlag.className = 'week-flag';
  const clubSelect = document.createElement('select');
  clubSelect.dataset.action = 'club-change';
  clubSelect.dataset.week = week.start;
  fillWeekClubSelect(clubSelect, clubChangeValueAt(week.start));
  clubFlag.append(document.createTextNode(' 社团 '), clubSelect);

  cell.append(anchor, commandFlag, clubFlag);
  row.append(cell);
  weekRows.set(week.start, row);
  return row;
}

/** 该周锚点上是否有一条「切换社团」记录；undefined 表示不切换。 */
function clubChangeValueAt(date) {
  const change = state.input.clubChanges.find((entry) => entry.date === date);
  return change ? change.clubId : undefined;
}

function buildDayRow(day) {
  const row = document.createElement('tr');
  row.className = 'day-row';
  row.dataset.date = day.date;

  for (const name of BASE_COLUMNS) {
    const cell = document.createElement('td');
    if (name === '日期') cell.textContent = day.date;
    if (name === '星期') cell.textContent = day.weekdayName;
    if (name === '结算') cell.className = 'state';
    if (name === '指令') fillCommandCell(cell, day);
    if (name === '休息日' || name === '跳过') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.action = name === '休息日' ? 'rest' : 'skip';
      box.dataset.date = day.date;
      cell.append(box);
    }
    row.append(cell);
  }

  for (let i = 0; i < attributeLabels.length; i += 1) {
    const cell = document.createElement('td');
    cell.className = 'num';
    row.append(cell);
  }

  dayRows.set(day.date, row);
  return row;
}

/** 结果形状没变时只更新既有行，不重建 DOM——否则改一个下拉就要重画一千多行。 */
function applyCalendar(result) {
  clubAtNow = createClubLookup(state.input);

  if (renderedSignature !== calendarSignature(result)) {
    renderCalendar(result);
  }

  const sequenceByDate = new Map();
  for (const entry of result.sequence) {
    if (!sequenceByDate.has(entry.date)) sequenceByDate.set(entry.date, []);
    sequenceByDate.get(entry.date).push(SEQUENCE_LABELS[entry.kind] ?? entry.kind);
  }

  for (const day of result.days) {
    const row = dayRows.get(day.date);
    if (!row) continue;
    row.classList.toggle('is-rest', day.isRestDay);
    row.classList.toggle('is-empty', day.isEmpty);
    row.classList.toggle('is-unsettled', !day.isSettled && !day.isEmpty);

    const cells = row.children;
    cells[2].textContent = (sequenceByDate.get(day.date) ?? []).join(' → ');
    cells[3].textContent = day.isEmpty
      ? EMPTY_LABELS[day.skipSource]
      : !day.isSettled
        ? '不结算'
        : day.commandBlocked
          ? BLOCK_LABELS[day.commandBlocked]
          : day.commandId
            ? '结算'
            : '待定';

    // 指令单元格只在「是否休息日」改变时才重建
    const restFlag = day.isRestDay ? '1' : '0';
    if (row.dataset.rest !== restFlag) {
      row.dataset.rest = restFlag;
      fillCommandCell(cells[4], day);
    }
    const select = cells[4].querySelector('select');
    if (select) select.value = choiceFromCommandId(state.input.dayCommands[day.date]);
    else fillCommandCell(cells[4], day);

    const restBox = row.querySelector('input[data-action="rest"]');
    restBox.checked = day.isRestDay;
    restBox.disabled = day.weekday === 0;

    // 「跳过」勾选框只代表**逐日跳过**这一个来源；周空过由周表头负责，
    // 休息日置空由它自己的指令下拉框负责。三者互不冒充。
    row.querySelector('input[data-action="skip"]').checked = day.skipSource === 'day';

    let column = BASE_COLUMNS.length;
    for (const attribute of attributeLabels) {
      cells[column].textContent = day.attributes[attribute.id].toFixed(1);
      column += 1;
    }
  }

  for (const week of result.weeks) {
    const row = weekRows.get(week.start);
    if (!row) continue;
    const commandSelect = row.querySelector('select[data-action="week-command"]');
    if (commandSelect) commandSelect.value = choiceFromCommandId(state.input.weekCommands[week.start]);
    const clubSelect = row.querySelector('select[data-action="club-change"]');
    if (clubSelect) {
      const value = clubChangeValueAt(week.start);
      clubSelect.value = value === undefined ? UNSET : value === null ? NO_CLUB : value;
    }
  }

  state.daysByDate = new Map(result.days.map((d) => [d.date, d]));
}

function renderSummary(result) {
  const s = result.summary;
  $('summary').textContent =
    `共 ${s.totalDays} 天 · 结算 ${s.settledDays} · 空过 ${s.emptyDays} · ` +
    `休息日 ${s.restDays} · 自然周 ${s.weeks}`;
}

/** 九条属性随时间的曲线。没有引入任何图表库——一张内联 SVG 就够。 */
function renderCurve(result) {
  const host = $('curve');
  host.textContent = '';
  const days = result.days;
  if (days.length < 2) return;

  const width = 1000;
  const height = 170;
  const padding = 24;

  let min = Infinity;
  let max = -Infinity;
  for (const day of days) {
    for (const attribute of attributeLabels) {
      const value = day.attributes[attribute.id];
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min)) return;
  if (max - min < 1) max = min + 1;

  const x = (index) => padding + (index / (days.length - 1)) * (width - padding * 2);
  const y = (value) => height - padding - ((value - min) / (max - min)) * (height - padding * 2);

  const paths = attributeLabels
    .map((attribute, index) => {
      const points = days
        .map(
          (day, i) =>
            `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(day.attributes[attribute.id]).toFixed(1)}`,
        )
        .join(' ');
      const color = curveColorAt(index);
      return `<path d="${points}" fill="none" stroke="${color}" stroke-width="1.4" />`;
    })
    .join('');

  const legend = attributeLabels
    .map(
      (attribute, index) =>
        `<span><i style="background:${curveColorAt(index)}"></i>${escapeText(attribute.name)}</span>`,
    )
    .join('');

  // 用 HTML 字符串整体写入：浏览器会把内层 <svg> 按 SVG 命名空间解析，
  // 因此源码里不需要出现那个命名空间常量（产物必须零外部引用）。
  host.innerHTML =
    `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
    `<line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#d0d5dd" />` +
    `<text x="${padding + 4}" y="15" font-size="13" fill="#5b6472">最高 ${max.toFixed(1)}</text>` +
    `<text x="${padding + 4}" y="${height - padding - 6}" font-size="13" fill="#5b6472">最低 ${min.toFixed(1)}</text>` +
    paths +
    '</svg>' +
    `<div class="legend">${legend}</div>`;
}

function escapeText(value) {
  return String(value).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function scrollToDate(date) {
  if (!date) {
    setStatus('请先在「跳到日期」里选一个完整日期。', true);
    return;
  }
  const row = dayRows.get(date);
  if (!row) {
    setStatus(`日历里没有 ${date}。`, true);
    return;
  }
  row.scrollIntoView({ block: 'center' });
  row.classList.add('is-highlight');
  setTimeout(() => row.classList.remove('is-highlight'), 1200);
}

// ---------------------------------------------------------------- 结果

function renderResult(result) {
  if (!result.ok) {
    const label = result.status === 'invalid-input' ? '输入有问题' : '规则数据有问题';
    setStatus(`${label}：\n${result.problems.join('\n')}`, true);
    return;
  }

  setStatus(`时间轴 ${result.startDate} → ${result.endDate}（最后结算日 ${result.lastSettlement}）`);

  // 渲染出错时留下半张表比抛出去更难看：抓起来，把原因摆到状态栏。
  try {
    renderSummary(result);
    applyCalendar(result);
    renderCurve(result);
  } catch (error) {
    setStatus(`界面渲染出错：${error.message}`, true);
    throw error;
  }

  const jump = $('jump-date');
  jump.min = result.startDate;
  jump.max = result.endDate;
}

async function runPlan() {
  setStatus('计算中…');
  const reply = await requestPlan(state.input);
  if (!reply.ok) {
    setStatus(`计算失败：${reply.error}`, true);
    return;
  }
  renderResult(reply.result);
}

// ---------------------------------------------------------------- JSON

function exportJson() {
  const blob = new Blob([toJson(state.input)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'tokimeki-planner-input.json';
  // 必须真的进 DOM，且撤销要等到下载启动之后，否则部分浏览器下载会失败。
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importJson(file) {
  try {
    state.input = fromJson(await file.text(), rules);
  } catch (error) {
    setStatus(`导入失败：${error.message}`, true);
    return;
  }
  renderForm();
  await runPlan();
}

// ---------------------------------------------------------------- 交互

function toggleInList(list, value, present) {
  const next = new Set(list);
  if (present) next.add(value);
  else next.delete(value);
  return [...next].sort();
}

/** 在一个周锚点上写入/清除社团切换。不切换 = 没有这条记录。 */
function setClubChange(weekStart, choice) {
  const others = state.input.clubChanges.filter((entry) => entry.date !== weekStart);
  if (choice === UNSET) {
    state.input.clubChanges = others;
    return;
  }
  const clubId = choice === NO_CLUB ? null : choice;
  state.input.clubChanges = [...others, { date: weekStart, clubId }].sort((a, b) =>
    a.date < b.date ? -1 : 1,
  );
}

$('calendar').addEventListener('change', (event) => {
  const control = event.target;
  const action = control.dataset && control.dataset.action;

  if (action === 'rest') {
    state.input.restDays = toggleInList(state.input.restDays, control.dataset.date, control.checked);
  } else if (action === 'skip') {
    state.input.skippedDays = toggleInList(
      state.input.skippedDays,
      control.dataset.date,
      control.checked,
    );
  } else if (action === 'week-command') {
    setMapEntry(state.input.weekCommands, control.dataset.week, control.value);
  } else if (action === 'day-command') {
    setMapEntry(state.input.dayCommands, control.dataset.date, control.value);
  } else if (action === 'club-change') {
    setClubChange(control.dataset.week, control.value);
  } else {
    return;
  }
  runPlan();
});

startWorker();
renderForm();

$('start-date').addEventListener('change', (event) => {
  state.input.startDate = event.target.value;
  runPlan();
});

$('initial-club').addEventListener('change', (event) => {
  state.input.initialClub = event.target.value === UNSET ? null : event.target.value;
  runPlan();
});

$('default-week-command').addEventListener('change', (event) => {
  state.input.defaultWeekCommand = commandIdFromDefaultChoice(event.target.value);
  runPlan();
});

$('default-day-command').addEventListener('change', (event) => {
  state.input.defaultDayCommand = commandIdFromDefaultChoice(event.target.value);
  runPlan();
});

$('btn-plan').addEventListener('click', () => {
  runPlan();
});

$('btn-export').addEventListener('click', () => {
  exportJson();
});

$('btn-jump').addEventListener('click', () => {
  scrollToDate($('jump-date').value);
});

$('file-import').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) importJson(file);
});

runPlan();
