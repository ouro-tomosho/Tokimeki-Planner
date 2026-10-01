// 主线程：表单、日历表、JSON 导入导出，以及一次 Worker 往返。
//
// 页面是从 file:// 双击打开的，而有些浏览器在 file:// 下拒绝构造 blob Worker。
// 因此这里对 Worker 做降级：能建就用 Worker，建不了或中途报错就回退到主线程，
// 保证"双击即用"这件事在任何浏览器里都成立。

import rules from '../data/rules.json';
import { attributeById, attributeIds } from '../src/lookup.js';
import { defaultInput, fromJson, toJson } from '../src/input.js';
import { createPlanner } from '../src/plan.js';

const state = { input: defaultInput(rules), requestId: 0, daysByDate: new Map() };
const pending = new Map();
const inlinePlan = createPlanner(rules);
const commandNames = new Map(rules.commands.map((c) => [c.id, c.name]));
let worker = null;
let workerUnavailable = false;

let dayRows = new Map();
let weekRows = new Map();
let renderedSignature = '';

const COLUMNS = ['日期', '星期', '当天顺序', '结算', '指令', '休息日', '跳过'];
const SEQUENCE_LABELS = { 'day-command': '日指令', settle: '结算', 'week-command': '周指令' };
const EMPTY_LABELS = {
  day: '空过（指定本日）',
  'day-command': '空过（日指令置空）',
  week: '空过（本周空过）',
};

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
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = week.isCleared;
  box.dataset.action = 'week-skip';
  box.dataset.week = week.start;
  flag.append(box, document.createTextNode(' 本周平日全部空过'));

  cell.append(anchor, flag);
  row.append(cell);
  weekRows.set(week.start, row);
  return row;
}

function buildDayRow(day) {
  const row = document.createElement('tr');
  row.className = 'day-row';
  row.dataset.date = day.date;

  const cells = {};
  for (const name of ['date', 'weekday', 'sequence', 'state', 'command']) {
    const cell = document.createElement('td');
    cells[name] = cell;
    if (name === 'date') cell.textContent = day.date;
    if (name === 'weekday') cell.textContent = day.weekdayName;
    if (name === 'state' || name === 'sequence') cell.className = name === 'state' ? 'state' : '';
    row.append(cell);
  }

  const restCell = document.createElement('td');
  const restBox = document.createElement('input');
  restBox.type = 'checkbox';
  restBox.dataset.action = 'rest';
  restBox.dataset.date = day.date;
  restBox.disabled = day.weekday === 0;
  restCell.append(restBox);

  const skipCell = document.createElement('td');
  const skipBox = document.createElement('input');
  skipBox.type = 'checkbox';
  skipBox.dataset.action = 'skip';
  skipBox.dataset.date = day.date;
  skipCell.append(skipBox);

  row.append(restCell, skipCell);
  dayRows.set(day.date, row);
  return row;
}

/** 结果形状没变时只更新既有行，不重建 DOM——否则每次勾选都要重画一千多行。 */
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

    row.children[2].textContent = (sequenceByDate.get(day.date) ?? []).join(' → ');
    row.children[3].textContent = day.isEmpty
      ? EMPTY_LABELS[day.skipSource]
      : day.isSettled
        ? '结算'
        : '不结算';
    row.children[4].textContent = day.commandId
      ? (commandNames.get(day.commandId) ?? day.commandId)
      : '—';

    const restBox = row.querySelector('input[data-action="rest"]');
    restBox.checked = day.isRestDay;
    restBox.disabled = day.weekday === 0;

    // 「本周空过」由周表头那个勾选框负责，日级的跳过勾选框对它不作声。
    const skipBox = row.querySelector('input[data-action="skip"]');
    skipBox.checked = day.isEmpty && day.skipSource !== 'week';
    skipBox.disabled = day.skipSource === 'week';
  }

  for (const week of result.weeks) {
    const box = weekRows.get(week.start)?.querySelector('input[data-action="week-skip"]');
    if (box) box.checked = week.isCleared;
  }

  state.daysByDate = new Map(result.days.map((d) => [d.date, d]));
}

function renderSummary(result) {
  const s = result.summary;
  $('summary').textContent =
    `共 ${s.totalDays} 天 · 结算 ${s.settledDays} · 空过 ${s.emptyDays} · ` +
    `休息日 ${s.restDays} · 自然周 ${s.weeks}`;
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
  renderSummary(result);
  applyCalendar(result);

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

/**
 * 空过在 JSON 里有三种表示，"跳过"按当天类型写入**该类型的规范形式**：
 * 休息日写 `dayCommands[date] = null`，平日与周日之外的普通日写 `skippedDays`。
 * 两种写法都写一遍会留下取消勾选也清不掉的残留，所以每次先清干净再写一种。
 */
function setDayEmpty(date, empty) {
  const day = state.daysByDate.get(date);
  const isRestDay = Boolean(day && day.isRestDay);

  state.input.skippedDays = state.input.skippedDays.filter((d) => d !== date);
  delete state.input.dayCommands[date];
  if (!empty) return;

  if (isRestDay) state.input.dayCommands[date] = null;
  else state.input.skippedDays = [...state.input.skippedDays, date].sort();
}

function setWeekCleared(weekStart, cleared) {
  if (cleared) state.input.weekCommands[weekStart] = null;
  else delete state.input.weekCommands[weekStart];
}

function toggleInList(list, value, present) {
  const next = new Set(list);
  if (present) next.add(value);
  else next.delete(value);
  return [...next].sort();
}

$('calendar').addEventListener('change', (event) => {
  const box = event.target;
  const action = box.dataset && box.dataset.action;

  if (action === 'rest') {
    state.input.restDays = toggleInList(state.input.restDays, box.dataset.date, box.checked);
  } else if (action === 'skip') {
    setDayEmpty(box.dataset.date, box.checked);
  } else if (action === 'week-skip') {
    setWeekCleared(box.dataset.week, box.checked);
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
