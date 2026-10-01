// 主线程：表单、日历表、JSON 导入导出，以及一次 Worker 往返。
//
// 页面是从 file:// 双击打开的，而有些浏览器在 file:// 下拒绝构造 blob Worker。
// 因此这里对 Worker 做降级：能建就用 Worker，建不了或中途报错就回退到主线程，
// 保证"双击即用"这件事在任何浏览器里都成立。

import rules from '../data/rules.json';
import { attributeById, attributeIds } from '../src/lookup.js';
import { defaultInput, fromJson, toJson } from '../src/input.js';
import { createPlanner } from '../src/plan.js';

const state = { input: defaultInput(rules), requestId: 0 };
const pending = new Map();
const inlinePlan = createPlanner(rules);
const commandNames = new Map(rules.commands.map((c) => [c.id, c.name]));
let worker = null;
let workerUnavailable = false;

let dayRows = new Map();
let weekRows = new Map();
let renderedSignature = '';

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
  return `${result.startDate}|${result.days.length}|${result.days[result.days.length - 1].date}`;
}

const COLUMNS = ['日期', '星期', '结算', '指令', '休息日', '跳过'];

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
  box.checked = week.isSkipped;
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

  const dateCell = document.createElement('td');
  dateCell.textContent = day.date;

  const weekdayCell = document.createElement('td');
  weekdayCell.textContent = day.weekdayName;

  const stateCell = document.createElement('td');
  stateCell.className = 'state';

  const commandCell = document.createElement('td');
  commandCell.className = 'command';

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

  row.append(dateCell, weekdayCell, stateCell, commandCell, restCell, skipCell);
  dayRows.set(day.date, row);
  return row;
}

/** 结果形状没变时只更新既有行，不重建 DOM——否则每次勾选都要重画一千多行。 */
function applyCalendar(result) {
  if (renderedSignature !== calendarSignature(result)) {
    renderCalendar(result);
  }

  for (const day of result.days) {
    const row = dayRows.get(day.date);
    if (!row) continue;
    row.classList.toggle('is-rest', day.isRestDay);
    row.classList.toggle('is-skipped', day.isSkipped);
    row.classList.toggle('is-unsettled', !day.isSettled && !day.isSkipped);

    row.querySelector('td.state').textContent = day.isSkipped
      ? '空过'
      : day.isSettled
        ? '结算'
        : '不结算';

    row.querySelector('td.command').textContent = day.commandId
      ? (commandNames.get(day.commandId) ?? day.commandId)
      : '—';

    const restBox = row.querySelector('input[data-action="rest"]');
    restBox.checked = day.isRestDay;
    restBox.disabled = day.weekday === 0;

    row.querySelector('input[data-action="skip"]').checked = day.isSkipped;
  }

  for (const week of result.weeks) {
    const box = weekRows.get(week.start)?.querySelector('input[data-action="week-skip"]');
    if (box) box.checked = week.isSkipped;
  }
}

function renderSummary(result) {
  const s = result.summary;
  $('summary').innerHTML =
    `共 <b>${s.totalDays}</b> 天 · 结算 <b>${s.settledDays}</b> · 空过 <b>${s.skippedDays}</b> · ` +
    `休息日 <b>${s.restDays}</b> · 自然周 <b>${s.weeks}</b>`;
}

function scrollToDate(date) {
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
    setStatus(`规则数据有问题：\n${result.problems.join('\n')}`, true);
    return;
  }
  setStatus(`${result.note}\n${result.startDate} → ${result.endDate}（最后结算日 ${result.lastSettlement}）`);
  renderSummary(result);
  applyCalendar(result);
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

function setWeekSkipped(weekStart, skipped) {
  if (skipped) state.input.weekCommands[weekStart] = null;
  else delete state.input.weekCommands[weekStart];
}

$('calendar').addEventListener('change', (event) => {
  const box = event.target;
  const action = box.dataset && box.dataset.action;
  if (!action) return;

  if (action === 'rest') {
    state.input.restDays = toggleInList(state.input.restDays, box.dataset.date, box.checked);
  } else if (action === 'skip') {
    state.input.skippedDays = toggleInList(state.input.skippedDays, box.dataset.date, box.checked);
  } else if (action === 'week-skip') {
    setWeekSkipped(box.dataset.week, box.checked);
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
