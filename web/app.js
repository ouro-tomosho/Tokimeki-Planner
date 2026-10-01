// 主线程：表单、JSON 导入导出，以及一次 Worker 往返。

import rules from '../data/rules.json';
import { attributeById, attributeIds } from '../src/rules.js';
import { defaultInput, fromJson, toJson } from '../src/input.js';

const state = { input: defaultInput(rules), requestId: 0 };
const pending = new Map();
let worker;

const $ = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function startWorker() {
  const source = $('worker-source').textContent;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  worker = new Worker(url);
  worker.onmessage = (event) => {
    const settle = pending.get(event.data && event.data.id);
    if (!settle) return;
    pending.delete(event.data.id);
    settle(event.data);
  };
  worker.onerror = (event) => {
    pending.clear();
    setStatus(`Worker 出错：${event.message || '未知错误'}`, true);
  };
}

function ask(type, payload) {
  const id = ++state.requestId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, type, ...payload });
  });
}

function renderForm() {
  const startDate = $('start-date');
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

  const list = document.createElement('dl');
  const rows = [
    ['起点', result.startDate],
    ['终点', result.endDate],
    ['最后结算日', result.lastSettlement],
    ['属性', `${result.ruleSummary.attributes} 项`],
    ['指令', `${result.ruleSummary.commands} 条`],
    ['社团', `${result.ruleSummary.clubs} 个`],
    ['定点缩放因子', String(result.ruleSummary.fixedPointScale)],
  ];
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
  const reply = await ask('plan', { input: state.input });
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
  link.click();
  URL.revokeObjectURL(url);
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
