// 主线程：表单、JSON 导入导出，以及一次 Worker 往返。
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
let worker = null;
let workerUnavailable = false;

const $ = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error', isError);
}

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

function renderResult(result) {
  const body = $('result-body');
  body.textContent = '';

  if (!result.ok) {
    setStatus(`规则数据有问题：\n${result.problems.join('\n')}`, true);
    return;
  }

  setStatus(result.note);

  const rows = [
    ['起点', result.startDate],
    ['终点', result.endDate],
    ['最后结算日', result.lastSettlement],
    ['属性', `${result.ruleSummary.attributes} 项`],
    ['指令', `${result.ruleSummary.commands} 条`],
    ['社团', `${result.ruleSummary.clubs} 个`],
  ];

  const list = document.createElement('dl');
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  body.append(list);
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

startWorker();
renderForm();

$('start-date').addEventListener('change', (event) => {
  state.input.startDate = event.target.value;
});

$('btn-plan').addEventListener('click', () => {
  runPlan();
});

$('btn-export').addEventListener('click', () => {
  exportJson();
});

$('file-import').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) importJson(file);
});

runPlan();
