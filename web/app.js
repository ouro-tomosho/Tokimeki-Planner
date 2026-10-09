// 主线程入口：接线、计算流程、左栏输入与 JSON 导入导出。
//
// 页面从 file:// 双击打开，而有些浏览器在 file:// 下拒绝构造 blob Worker，
// 所以 Worker 有降级路径：建不了或中途报错就回退到主线程，保证"双击即用"成立。
//
// 计算是**显式**的：改任何输入只登记"待计算"，点「计算」才跑求解器。

import rules from '../data/rules.json';
import { createPlanner } from '../src/plan.js';
import { MAIN_THREAD_BUDGET_MS, createSolver } from '../src/solve.js';
import { exportFileName, fromJson, toJson } from '../src/input.js';
import {
  CLUBS,
  TIMELINE,
  UNSET,
  VALUE_FIELDS,
  clearResult,
  focusDate,
  hooks,
  isStale,
  rebuildCheckpointIndex,
  setResult,
  state,
} from './ui.js';
import { $ } from './dom.js';
import { renderCalendar, renderDetail, wireCalendar } from './calendar.js';
import { renderGoals, wirePanels } from './panels.js';
import { loadInput, saveInput } from './session.js';
import { setAttributeValue, setInitialClub, setPlayedUpTo } from './edits.js';

const inlinePlan = createPlanner(rules);
const inlineSolve = createSolver(rules, { budgetMs: MAIN_THREAD_BUDGET_MS });

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

async function runSolveOnMainThread(input) {
  try {
    // 主线程降级路径：预算是硬的 5 秒，且带协作式取消，否则界面会被同步循环卡死。
    const { assignments, metrics } = await inlineSolve(input, {
      budgetMs: MAIN_THREAD_BUDGET_MS,
      shouldStop: () => state.cancelRequested === true,
    });
    return { ok: true, assignments, metrics };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function requestSolve(input) {
  if (workerUnavailable || !worker) return Promise.resolve(runSolveOnMainThread(input));

  const id = ++requestId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, type: 'solve', input });
  }).then((reply) => {
    if (!reply.fallback) return reply;
    return runSolveOnMainThread(input);
  });
}

/** 取消：先请求解器在检查点停下；worker 路径另加 terminate 兜底。 */
function cancelSolve() {
  if (!state.computing) return;
  state.cancelRequested = true;
  const inflight = [...pending.values()];
  pending.clear();
  if (worker) worker.postMessage({ id: ++requestId, type: 'cancel', targetId: requestId - 1 });
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
  state.cancelRequested = false;
  notice = null;
  startProgress();
  renderComputeRow();

  try {
    const solved = await requestSolve(state.input);
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

    setResult(planned.result, solved.metrics ?? null);
  } finally {
    state.computing = false;
    stopProgress();
    renderAll();
  }
}

// ---------------------------------------------------------------- 左栏

const attributeInputs = new Map();

function buildRail() {
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
  // 10 格：10 项属性，含「当前社团经验」——它现在是普通属性，不再是特例。
  for (const field of VALUE_FIELDS) {
    const label = document.createElement('label');
    label.className = `attr-cell ${field.direction === 'down' ? 'down' : ''}`;

    const caption = document.createElement('span');
    caption.textContent = field.name;

    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(field.min);
    input.max = String(field.max);
    input.addEventListener('change', () => {
      setAttributeValue(field.id, Number(input.value));
    });

    label.append(caption, input);
    host.append(label);
    attributeInputs.set(field.id, input);
  }
}

/** 左栏 10 项数值一律读 `input.attributes`。 */
function railValue(id) {
  return state.input.attributes[id];
}

function syncRail() {
  $('rail-played-up-to').value = state.input.playedUpTo;
  $('rail-initial-club').value = state.input.initialClub ?? UNSET;
  for (const field of VALUE_FIELDS) {
    const input = attributeInputs.get(field.id);
    if (!input || document.activeElement === input) continue;
    input.value = String(railValue(field.id));
  }
}

// ---------------------------------------------------------------- 渲染

/**
 * 求解指标：如实报告这次计算的状态。
 *
 * 所有者 2026-10-07 裁决：顶栏与状态行**只报"是否达标"**；硬约束读数（硬违反 / 集训周违反）
 * 不在界面上展示——它们仍在 `plan()` 的返回里，也仍在检查点区域的全局约束一段里逐行体现
 * （「已破线」）。这里只留目标条数、耗时，以及"有没有跑完"。
 */
function metricsText() {
  const metrics = state.metrics;
  if (!metrics) return '';
  const parts = [];
  if (metrics.gatesTotal !== undefined) {
    parts.push(`目标 ${metrics.gatesMet ?? '?'}/${metrics.gatesTotal}`);
  }
  if (metrics.elapsedMs !== undefined) parts.push(`耗时 ${(metrics.elapsedMs / 1000).toFixed(1)}s`);
  if (metrics.cancelled) parts.push('已取消');
  else if (metrics.incomplete) parts.push('预算内未跑完');
  return ` · ${parts.join(' · ')}`;
}

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
    // 求解用的是"已玩到"那一刻的属性快照，真实游玩中随机事件会让实际属性与推算值逐渐分叉，
    // 所以提醒每三个月回来校正一次（所有者 2026-10-09 要求写在状态行，措辞按同日要求润色）。
    note.textContent = '已计算｜每三个月用“已玩到”与左侧属性栏校正一次';
  }
  note.classList.toggle('error', Boolean(notice?.error));

  if (state.result && stale) {
    $('stale-note').textContent = `以下数值基于上次计算结果${metricsText()}`;
  } else if (state.result) {
    $('stale-note').textContent = `上次计算 ${state.computedAt.toLocaleTimeString()}${metricsText()}`;
  } else {
    $('stale-note').textContent = '';
  }

  // 顶栏只有一个结论：**是否达标**（`goals.ok`）。硬违反/集训周这些硬约束读数仍在算、
  // 仍在检查点区域的全局约束一段里如实体现（见 panels.js），这里不重复。
  const chip = $('status-chip');
  const goals = state.result?.goals;
  if (!goals) {
    chip.textContent = '尚未计算';
    chip.className = 'chip';
    chip.title = '';
  } else {
    chip.textContent = goals.ok ? '达标' : '未达标';
    chip.className = `chip ${goals.ok ? 'met' : 'unmet'}`;
    chip.title = goals.ok ? '参与判定的检查点全部达标' : '参与判定的检查点尚未全部达标';
  }
}

function renderAll() {
  syncRail();
  renderCalendar();
  renderDetail();
  renderGoals();
  renderComputeRow();
}

hooks.render = renderAll;
hooks.persist = () => saveInput(state.input);
hooks.notice = (text, error = false) => {
  notice = text === null ? null : { text, error };
  renderComputeRow();
};

// ---------------------------------------------------------------- JSON

function exportJson() {
  const blob = new Blob([toJson(state.input)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName(state.input);
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
  // 导入换了整套输入：结果作废，回到"尚未计算"，视图跟到新的起点。
  clearResult();
  focusDate(state.input.playedUpTo);
  notice = null;
  // 导入的输入立刻成为"上次的输入"，刷新后要能接着用。
  saveInput(state.input);
  renderAll();
}

// ---------------------------------------------------------------- 接线

function wireTopbar() {
  $('btn-compute').addEventListener('click', () => compute());
  $('btn-cancel').addEventListener('click', () => cancelSolve());
  $('btn-export').addEventListener('click', exportJson);

  $('file-import').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) importJson(file);
  });

  $('btn-collapse').addEventListener('click', () => {
    const shell = $('shell');
    shell.classList.toggle('collapsed');
    $('btn-collapse').innerHTML = shell.classList.contains('collapsed')
      ? '▶'
      : '◀<span> 收起左栏</span>';
  });
}

function wireRail() {
  $('rail-played-up-to').addEventListener('change', (event) => setPlayedUpTo(event.target.value));
  $('rail-initial-club').addEventListener('change', (event) => setInitialClub(event.target.value));
}

// ---------------------------------------------------------------- 启动

// 先尝试恢复上次的输入；没有就沿用出厂默认。结果一律不恢复：刷新后是「尚未计算」。
const restored = loadInput(rules);
if (restored) state.input = restored;

startWorker();
buildRail();
wireTopbar();
wireRail();
wireCalendar();
wirePanels();

focusDate(state.input.playedUpTo);
$('jump-date').value = state.input.playedUpTo;

renderAll();
