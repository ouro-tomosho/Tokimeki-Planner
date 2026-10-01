// 主线程入口：接线、计算流程、左栏输入与 JSON 导入导出。
//
// 页面从 file:// 双击打开，而有些浏览器在 file:// 下拒绝构造 blob Worker，
// 所以 Worker 有降级路径：建不了或中途报错就回退到主线程，保证"双击即用"成立。
//
// 计算是**显式**的：改任何输入只登记"待计算"，点「计算」才跑求解器。

import rules from '../data/rules.json';
import { createPlanner } from '../src/plan.js';
import { createSolver } from '../src/solver.js';
import { fromJson, toJson } from '../src/input.js';
import {
  $,
  ATTRIBUTES,
  CLUBS,
  TIMELINE,
  UNSET,
  hooks,
  isStale,
  monthOf,
  setResult,
  state,
} from './ui.js';
import { renderCalendar, renderDetail, wireCalendar } from './calendar.js';
import { renderDiagnosis, renderGoals, wirePanels } from './panels.js';
import { setAttributeValue, setInitialClub, setPlayedUpTo, setStartDate } from './edits.js';

const inlinePlan = createPlanner(rules);
const inlineSolve = createSolver(rules);

let worker = null;
let workerUnavailable = false;
let requestId = 0;
const pending = new Map();

let elapsedTimer = null;
let startedAt = 0;
let notice = null;

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

function runPlanOnMainThread(input) {
  try {
    return { ok: true, result: inlinePlan(input, { assignments: state.assignments }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function requestPlan(input) {
  if (workerUnavailable || !worker) return Promise.resolve(runPlanOnMainThread(input));

  const id = ++requestId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, type: 'plan', input, assignments: state.assignments });
  }).then((reply) => {
    if (!reply.fallback) return reply;
    return runPlanOnMainThread(input);
  });
}

function runSolveOnMainThread(input, options) {
  try {
    return { ok: true, assignments: inlineSolve(input, options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function requestSolve(input, options) {
  if (workerUnavailable || !worker) return Promise.resolve(runSolveOnMainThread(input, options));

  const id = ++requestId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, type: 'solve', input, ...options });
  }).then((reply) => {
    if (!reply.fallback) return reply;
    return runSolveOnMainThread(input, options);
  });
}

/** 取消：求解是同步循环，没有协作式中断点，只能把 worker 掐掉重建。 */
function cancelSolve() {
  if (!state.computing) return;
  const inflight = [...pending.values()];
  pending.clear();
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerUnavailable = false;
  startWorker();
  for (const settle of inflight) settle({ cancelled: true });
}

// ---------------------------------------------------------------- 计算流程

function startProgress() {
  startedAt = Date.now();
  $('progress').hidden = false;
  $('btn-cancel').hidden = false;
  $('btn-compute').disabled = true;
  const tick = () => {
    $('progress-elapsed').textContent = `已用 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  };
  tick();
  elapsedTimer = setInterval(tick, 100);
}

function stopProgress() {
  if (elapsedTimer !== null) clearInterval(elapsedTimer);
  elapsedTimer = null;
  $('progress').hidden = true;
  $('btn-cancel').hidden = true;
  $('btn-compute').disabled = false;
  $('progress-elapsed').textContent = '';
}

async function compute() {
  if (state.computing) return;
  state.computing = true;
  notice = null;
  startProgress();
  renderComputeRow();

  try {
    const solved = await requestSolve(state.input, {
      previous: state.assignments,
      fromDate: null,
    });
    if (solved.cancelled) {
      notice = { text: '已取消计算。' };
      return;
    }
    if (!solved.ok) {
      notice = { text: `求解失败：${solved.error}`, error: true };
      return;
    }

    const previous = state.assignments;
    state.assignments = solved.assignments;
    const planned = await requestPlan(state.input);

    if (!planned.ok) {
      state.assignments = previous;
      notice = { text: `规划失败：${(planned.problems ?? [planned.error]).join('；')}`, error: true };
      return;
    }

    setResult(planned.result);
    state.diagnosis = solved.assignments.diagnosis ?? null;
  } finally {
    state.computing = false;
    stopProgress();
    renderAll();
  }
}

// ---------------------------------------------------------------- 左栏

const attributeInputs = new Map();

function buildRail() {
  $('rail-start-date').min = TIMELINE.start;
  $('rail-start-date').max = TIMELINE.lastSettlement;
  $('rail-played-up-to').min = TIMELINE.start;
  $('rail-played-up-to').max = TIMELINE.lastSettlement;
  $('jump-date').min = TIMELINE.start;
  $('jump-date').max = TIMELINE.end;

  const clubSelect = $('rail-initial-club');
  clubSelect.textContent = '';
  const none = document.createElement('option');
  none.value = UNSET;
  none.textContent = '未加入';
  clubSelect.append(none);
  for (const club of CLUBS) {
    const option = document.createElement('option');
    option.value = club.id;
    option.textContent = club.name;
    clubSelect.append(option);
  }

  const host = $('attributes');
  host.textContent = '';
  for (const attribute of ATTRIBUTES) {
    const label = document.createElement('label');
    label.className = `attr-cell ${attribute.direction === 'down' ? 'down' : ''}`;

    const caption = document.createElement('span');
    caption.textContent = attribute.name;

    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(attribute.min);
    input.max = String(attribute.max);
    input.addEventListener('change', () => {
      setAttributeValue(attribute.id, Number(input.value));
    });

    label.append(caption, input);
    host.append(label);
    attributeInputs.set(attribute.id, input);
  }
}

function syncRail() {
  $('rail-start-date').value = state.input.startDate;
  $('rail-played-up-to').value = state.input.playedUpTo;
  $('rail-initial-club').value = state.input.initialClub ?? UNSET;
  for (const attribute of ATTRIBUTES) {
    const input = attributeInputs.get(attribute.id);
    if (input && document.activeElement !== input) {
      input.value = String(state.input.attributes[attribute.id]);
    }
  }
}

// ---------------------------------------------------------------- 渲染

function renderComputeRow() {
  const row = $('compute-row');
  const note = $('pending-note');
  const stale = isStale();
  const dirty = state.pending > 0;

  row.classList.toggle('is-dirty', dirty && !state.computing);

  if (state.computing) {
    note.textContent = '求解中…';
  } else if (notice) {
    note.textContent = notice.text;
  } else if (state.result === null) {
    note.textContent =
      state.pending > 0
        ? `尚未计算——已有 ${state.pending} 处改动，点右上角「计算」排出日程`
        : '尚未计算——点右上角「计算」排出日程';
  } else if (dirty) {
    note.textContent = `${state.pending} 处改动待计算`;
  } else {
    note.textContent = '已计算';
  }
  note.classList.toggle('error', Boolean(notice?.error));

  if (state.result && stale) {
    $('stale-note').textContent = '以下数值基于上次计算结果';
  } else if (state.result) {
    $('stale-note').textContent = `上次计算 ${state.computedAt.toLocaleTimeString()}`;
  } else {
    $('stale-note').textContent = '';
  }

  const chip = $('status-chip');
  const goals = state.result?.goals;
  if (!goals) {
    chip.textContent = '尚未计算';
    chip.className = 'chip';
  } else if (goals.ok) {
    chip.textContent = '全部达标';
    chip.className = 'chip met';
  } else {
    chip.textContent = '未达标';
    chip.className = 'chip unmet';
  }
}

function renderAll() {
  syncRail();
  renderCalendar();
  renderDetail();
  renderGoals();
  renderDiagnosis();
  renderComputeRow();
}

hooks.render = renderAll;

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
    notice = { text: `导入失败：${error.message}`, error: true };
    renderComputeRow();
    return;
  }
  // 导入换了整套输入：结果作废，回到"尚未计算"。
  state.assignments = null;
  state.result = null;
  state.diagnosis = null;
  state.dayByDate = new Map();
  state.pending = 0;
  state.computedAt = null;
  state.viewMonth = monthOf(state.input.startDate);
  state.selection = { from: state.input.startDate, to: state.input.startDate };
  notice = null;
  renderAll();
}

// ---------------------------------------------------------------- 接线

function wireTopbar() {
  $('btn-compute').addEventListener('click', () => compute());
  $('btn-cancel').addEventListener('click', () => cancelSolve());
  $('btn-export').addEventListener('click', exportJson);
  $('btn-export-foot').addEventListener('click', exportJson);

  for (const id of ['file-import', 'file-import-foot']) {
    $(id).addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) importJson(file);
    });
  }

  $('btn-collapse').addEventListener('click', () => {
    const shell = $('shell');
    shell.classList.toggle('collapsed');
    $('btn-collapse').innerHTML = shell.classList.contains('collapsed')
      ? '▶'
      : '◀<span> 收起左栏</span>';
  });
}

function wireRail() {
  $('rail-start-date').addEventListener('change', (event) => setStartDate(event.target.value));
  $('rail-played-up-to').addEventListener('change', (event) => setPlayedUpTo(event.target.value));
  $('rail-initial-club').addEventListener('change', (event) => setInitialClub(event.target.value));
}

// ---------------------------------------------------------------- 启动

startWorker();
buildRail();
wireTopbar();
wireRail();
wireCalendar();
wirePanels();

state.selection = { from: state.input.startDate, to: state.input.startDate };
state.viewMonth = monthOf(state.input.startDate);
$('jump-date').value = state.input.startDate;

renderAll();
