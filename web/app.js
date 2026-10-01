// 主线程：表单、指令选择、日历表与曲线、JSON 导入导出，以及一次 Worker 往返。
//
// 页面是从 file:// 双击打开的，而有些浏览器在 file:// 下拒绝构造 blob Worker。
// 因此这里对 Worker 做降级：能建就用 Worker，建不了或中途报错就回退到主线程，
// 保证"双击即用"这件事在任何浏览器里都成立。

import rules from '../data/rules.json';
import { attributeById, attributeIds } from '../src/lookup.js';
import { defaultInput, fromJson, toJson } from '../src/input.js';
import { createPlanner } from '../src/plan.js';

const UNSET = '';
const EMPTY = '__empty__';

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

const BASE_COLUMNS = ['日期', '星期', '当天顺序', '结算', '指令', '休息日', '跳过'];
const COLUMNS = [...BASE_COLUMNS, ...attributeLabels.map((a) => a.name)];

const SEQUENCE_LABELS = { 'day-command': '日指令', settle: '结算', 'week-command': '周指令' };
const EMPTY_LABELS = {
  day: '空过（指定本日）',
  'day-command': '空过（日指令置空）',
  week: '空过（本周空过）',
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

/**
 * 全局默认指令只有两态：未指定 / 某条指令。
 * 「空过」是**逐周、逐日**的选择，不做全局默认——否则默认值一填下去整条时间轴都没了。
 */
function fillDefaultCommandSelect(select, commandId) {
  select.textContent = '';
  const entries = [[UNSET, '未指定']];
  for (const command of rules.commands) entries.push([command.id, command.name]);

  for (const [value, label] of entries) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = commandId ?? UNSET;
}

/** 逐周／逐日的指令选择是三态：未指定（键不存在）／空过（显式 null）／具体指令。 */
/** 逐周／逐日的三态：未指定（键不存在）／空过（显式 null）／具体指令。 */
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

/** 全局默认指令只有两态：未指定 / 某条指令。 */
function commandIdFromDefaultChoice(choice) {
  return choice === UNSET ? null : choice;
}

function fillCommandSelect(select, commandId) {
  select.textContent = '';
  const entries = [[UNSET, '未指定'], [EMPTY, '空过']];
  for (const command of rules.commands) entries.push([command.id, command.name]);

  for (const [value, label] of entries) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = choiceFromCommandId(commandId);
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
    fillCommandSelect(select, state.input.dayCommands[day.date]);
    cell.append(select);
    return;
  }
  cell.textContent = day.commandId
    ? (commandNames.get(day.commandId) ?? day.commandId)
    : day.skipSource === 'week'
      ? '空过'
      : '—';
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

  fillDefaultCommandSelect($('default-week-command'), state.input.defaultWeekCommand);
  fillDefaultCommandSelect($('default-day-command'), state.input.defaultDayCommand);
}

// ---------------------------------------------------------------- 日历表

function calendarSignature(result) {
  const last = result.days[result.days.length - 1];
  return `${result.startDate}|${result.days.length}|${last ? last.date : ''}`;
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

  const flag = document.createElement('label');
  flag.className = 'week-flag';
  const select = document.createElement('select');
  select.dataset.action = 'week-command';
  select.dataset.week = week.start;
  fillCommandSelect(select, state.input.weekCommands[week.start]);
  flag.append(document.createTextNode(' 周指令 '), select);

  cell.append(anchor, flag);
  row.append(cell);
  weekRows.set(week.start, row);
  return row;
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
        : day.commandId
          ? '结算'
          : '待定（未指定指令）';

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

    row.querySelector('input[data-action="skip"]').checked = state.input.skippedDays.includes(
      day.date,
    );

    let column = BASE_COLUMNS.length;
    for (const attribute of attributeLabels) {
      cells[column].textContent = day.attributes[attribute.id].toFixed(1);
      column += 1;
    }
  }

  for (const week of result.weeks) {
    const select = weekRows.get(week.start)?.querySelector('select[data-action="week-command"]');
    if (select) select.value = choiceFromCommandId(state.input.weekCommands[week.start]);
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
      const color = CURVE_COLORS[index % CURVE_COLORS.length];
      return `<path d="${points}" fill="none" stroke="${color}" stroke-width="1.4" />`;
    })
    .join('');

  const legend = attributeLabels
    .map(
      (attribute, index) =>
        `<span><i style="background:${CURVE_COLORS[index % CURVE_COLORS.length]}"></i>${escapeText(attribute.name)}</span>`,
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
