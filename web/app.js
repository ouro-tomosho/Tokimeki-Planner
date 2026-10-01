// 主线程：表单、指令选择、日历表与曲线、JSON 导入导出，以及一次 Worker 往返。
//
// 页面是从 file:// 双击打开的，而有些浏览器在 file:// 下拒绝构造 blob Worker。
// 因此这里对 Worker 做降级：能建就用 Worker，建不了或中途报错就回退到主线程，
// 保证"双击即用"这件事在任何浏览器里都成立。

import rules from '../data/rules.json';
import { resolveCommand } from '../src/calendar.js';
import { availableCommandIds, createClubLookup } from '../src/clubs.js';
import { attributeById, attributeIds } from '../src/lookup.js';
import { defaultInput, fromJson, toJson } from '../src/input.js';
import { createPlanner } from '../src/plan.js';
import { createSolver } from '../src/solver.js';

const UNSET = '';
const EMPTY = '__empty__';
const NO_CLUB = '__no_club__';

const state = { input: defaultInput(rules), requestId: 0, daysByDate: new Map(), assignments: null, solving: false };
const pending = new Map();
const inlinePlan = createPlanner(rules);
const inlineSolve = createSolver(rules);
const commandNames = new Map(rules.commands.map((c) => [c.id, c.name]));
const attributeLabels = rules.attributes.map((a) => ({ id: a.id, name: a.name }));

let worker = null;
let workerUnavailable = false;

let dayRows = new Map();
let weekRows = new Map();
let renderedKey = '';

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
    return { ok: true, result: inlinePlan(input, { assignments: state.assignments }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function requestPlan(input) {
  if (workerUnavailable || !worker) return Promise.resolve(runOnMainThread(input));

  const id = ++state.requestId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, type: 'plan', input, assignments: state.assignments });
  }).then((reply) => {
    if (!reply.fallback) return reply;
    setStatus('当前浏览器不允许内联 Worker，已回退到主线程计算。');
    return runOnMainThread(input);
  });
}

function runSolveOnMainThread(input) {
  try {
    return { ok: true, assignments: inlineSolve(input) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function requestSolve(input) {
  if (workerUnavailable || !worker) return Promise.resolve(runSolveOnMainThread(input));

  const id = ++state.requestId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, type: 'solve', input });
  }).then((reply) => {
    if (!reply.fallback) return reply;
    return runSolveOnMainThread(input);
  });
}

/** 取消：直接把 worker 掐掉重建——求解是同步循环，没有协作式中断点。 */
function cancelSolve() {
  if (!state.solving) return;
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

/** 三个下拉框共用的建 option 循环。 */
function fillSelect(select, entries, value) {
  select.textContent = '';
  for (const [optionValue, label] of entries) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
}

/**
 * 指令下拉框。`choice` 是已经归一化过的选择串。
 * `commands` 用来把不可用的社团指令挡在候选之外。
 */
function fillCommandSelect(select, choice, { commands = rules.commands } = {}) {
  const entries = [[UNSET, '未指定'], [EMPTY, '空过']];
  for (const command of commands) entries.push([command.id, command.name]);

  // 已经写进输入、但当前**不可用**的指令也要留在选项里——否则下拉框会显示成"未指定"，
  // 与输入里那条真实存在的指定对不上。至于为什么没执行，由结算列说明。
  if (choice && !entries.some(([value]) => value === choice)) {
    entries.push([choice, `${commandNames.get(choice) ?? choice}（不可用）`]);
  }
  fillSelect(select, entries, choice);
}

/** 这一天能选的指令——社团指令受解锁日与当前社团限制。 */
function commandsAvailableAt(clubAt, date) {
  const allowed = new Set(availableCommandIds(rules, clubAt(date), date));
  return rules.commands.filter((command) => allowed.has(command.id));
}

function fillClubSelect(select, value) {
  const clubs = rules.clubs.map((club) => [club.id, club.name]);
  fillSelect(select, [[UNSET, '未加入'], ...clubs], value ?? UNSET);
}

/** 每周表头里的社团下拉框：三态——不切换 / 退出社团 / 某个社团。 */
function fillWeekClubSelect(select, value) {
  const clubs = rules.clubs.map((club) => [club.id, club.name]);
  const entries = [[UNSET, '不切换'], [NO_CLUB, '退出社团'], ...clubs];
  fillSelect(select, entries, value === undefined ? UNSET : value === null ? NO_CLUB : value);
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
/**
 * 下拉框该显示什么：使用者指定的优先，其次是求解器排的（**改它就等于指定**），
 * 再次是全局默认指令。
 */
/** 下拉框要显示的选择串。解析口径与日历、求解器完全一致（见 resolveCommand）。 */
function selectionChoice(day) {
  const { commandId, source } = resolveCommand(state.input, state.assignments, {
    isRestDay: day.isRestDay,
    date: day.date,
    weekStart: day.weekStart,
  });
  return source === 'pinned' || source === 'assigned'
    ? choiceFromCommandId(commandId)
    : (commandId ?? UNSET);
}

/** 周指令下拉框的选择串。 */
function weekSelectionChoice(week) {
  const { commandId, source } = resolveCommand(state.input, state.assignments, {
    isRestDay: false,
    date: week.firstDay,
    weekStart: week.start,
  });
  return source === 'pinned' || source === 'assigned'
    ? choiceFromCommandId(commandId)
    : (commandId ?? UNSET);
}

function fillCommandCell(cell, day, clubAt) {
  cell.textContent = '';
  if (day.isRestDay) {
    const select = document.createElement('select');
    select.dataset.action = 'day-command';
    select.dataset.date = day.date;
    fillCommandSelect(select, selectionChoice(day), {
      commands: commandsAvailableAt(clubAt, day.date),
    });
    cell.append(select);
    return;
  }
  // 平日不单独决策：显示本周实际执行的周指令（可能来自使用者的指定，也可能来自求解器）。
  if (day.skipSource === 'week') {
    cell.textContent = '空过';
    return;
  }
  cell.textContent = day.commandId ? (commandNames.get(day.commandId) ?? day.commandId) : '—';
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
  renderGoalEditors();
}

// ---------------------------------------------------------------- 日历表

/**
 * 结果表的渲染缓存键：只要它没变，就只更新既有行、不重建 DOM。
 * 社团会改变每个时点能选的指令（下拉框候选），所以它也在键里。
 */
function renderKey(result) {
  const last = result.days[result.days.length - 1];
  const clubs = `${state.input.initialClub}|${JSON.stringify(state.input.clubChanges)}`;
  return `${result.startDate}|${result.days.length}|${last ? last.date : ''}|${clubs}`;
}

function renderCalendar(result, clubAt) {
  const host = $('calendar');
  host.textContent = '';
  dayRows = new Map();
  weekRows = new Map();
  renderedKey = renderKey(result);

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
    fragment.append(buildWeekRow(week, clubAt));
    for (const date of week.days) {
      fragment.append(buildDayRow(dayByDate.get(date), clubAt));
    }
  }

  body.append(fragment);
  table.append(body);
  host.append(table);
}

function buildWeekRow(week, clubAt) {
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
  fillCommandSelect(commandSelect, weekSelectionChoice(week), {
    commands: commandsAvailableAt(clubAt, week.firstDay),
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

function buildDayRow(day, clubAt) {
  const row = document.createElement('tr');
  row.className = 'day-row';
  row.dataset.date = day.date;

  for (const name of BASE_COLUMNS) {
    const cell = document.createElement('td');
    if (name === '日期') cell.textContent = day.date;
    if (name === '星期') cell.textContent = day.weekdayName;
    if (name === '结算') cell.className = 'state';
    if (name === '指令') fillCommandCell(cell, day, clubAt);
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
  const clubAt = createClubLookup(state.input);

  if (renderedKey !== renderKey(result)) {
    renderCalendar(result, clubAt);
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

    const restFlag = day.isRestDay ? '1' : '0';
    if (row.dataset.rest !== restFlag) {
      row.dataset.rest = restFlag;
      fillCommandCell(cells[4], day, clubAt);
    }
    const select = cells[4].querySelector('select');
    if (select) {
      select.value = selectionChoice(day);
    } else {
      fillCommandCell(cells[4], day, clubAt);
    }

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
    if (commandSelect) commandSelect.value = weekSelectionChoice(week);
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

// ---------------------------------------------------------------- 约束与目标编辑

const OPS = [
  ['>=', '≥'],
  ['<', '<'],
];

function nameOf(attributeId) {
  if (attributeId === rules.clubExperience.id) return rules.clubExperience.name;
  return attributeLabels.find((attribute) => attribute.id === attributeId)?.name ?? attributeId;
}

function goalAttributes(allowClubExperience) {
  if (!allowClubExperience) return attributeLabels;
  return [...attributeLabels, { id: rules.clubExperience.id, name: rules.clubExperience.name }];
}

function option(value, label, selected) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  element.selected = Boolean(selected);
  return element;
}

function buildGoalRow(goal, { withDeadline = false, allowClubExperience = false } = {}) {
  const row = document.createElement('div');
  row.className = 'goal-row';

  if (withDeadline) {
    const deadline = document.createElement('input');
    deadline.type = 'date';
    deadline.className = 'date';
    deadline.dataset.role = 'deadline';
    deadline.min = rules.timeline.start;
    deadline.max = rules.timeline.lastSettlement;
    deadline.value = goal.deadline;
    row.append(deadline);

    // 小目标的属性集合可以含社团经验（指当前社团那一份）
    const attributes = document.createElement('select');
    attributes.multiple = true;
    attributes.className = 'attrs';
    attributes.dataset.role = 'attributes';
    for (const attribute of goalAttributes(true)) {
      attributes.append(option(attribute.id, attribute.name, goal.attributes.includes(attribute.id)));
    }
    row.append(attributes);
  } else {
    const attribute = document.createElement('select');
    attribute.className = 'attr';
    attribute.dataset.role = 'attribute';
    for (const entry of goalAttributes(allowClubExperience)) {
      attribute.append(option(entry.id, entry.name, false));
    }
    attribute.value = goal.attribute;
    row.append(attribute);
  }

  const op = document.createElement('select');
  op.dataset.role = 'op';
  for (const [value, label] of OPS) op.append(option(value, label, false));
  op.value = goal.op;
  row.append(op);

  const threshold = document.createElement('input');
  threshold.type = 'number';
  threshold.className = 'num';
  threshold.dataset.role = 'value';
  threshold.value = String(goal.value);
  row.append(threshold);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.dataset.role = 'remove';
  remove.textContent = '×';
  row.append(remove);

  return row;
}

const GOAL_LISTS = [
  { hostId: 'global-constraints', listKey: 'globalConstraints', options: {} },
  { hostId: 'ending-goals', listKey: 'endingGoals', options: {} },
  {
    hostId: 'mini-goals',
    listKey: 'miniGoals',
    options: { withDeadline: true, allowClubExperience: true },
  },
];

function renderGoalEditors() {
  for (const { hostId, listKey, options } of GOAL_LISTS) {
    const host = $(hostId);
    host.textContent = '';
    state.input[listKey].forEach((goal, index) => {
      const row = buildGoalRow(goal, options);
      row.dataset.index = String(index);
      host.append(row);
    });
  }
}

function goalFromRow(row, options) {
  const value = Number(row.querySelector('[data-role="value"]').value);
  const op = row.querySelector('[data-role="op"]').value;

  if (options.withDeadline) {
    const selected = row.querySelector('[data-role="attributes"]').selectedOptions;
    return {
      deadline: row.querySelector('[data-role="deadline"]').value,
      attributes: [...selected].map((element) => element.value),
      op,
      value,
    };
  }
  return { attribute: row.querySelector('[data-role="attribute"]').value, op, value };
}

function wireGoalList({ hostId, listKey, options }) {
  const host = $(hostId);
  host.addEventListener('change', (event) => {
    const row = event.target.closest('.goal-row');
    if (!row) return;
    state.input[listKey][Number(row.dataset.index)] = goalFromRow(row, options);
    generate();
  });
  host.addEventListener('click', (event) => {
    if (event.target.dataset.role !== 'remove') return;
    const row = event.target.closest('.goal-row');
    state.input[listKey].splice(Number(row.dataset.index), 1);
    renderGoalEditors();
    generate();
  });
}

// ---------------------------------------------------------------- 达标状态

function goalLine(tag, text, met) {
  const item = document.createElement('li');
  item.className = met ? 'met' : 'unmet';
  const label = document.createElement('span');
  label.className = 'tag';
  label.textContent = tag;
  item.append(label, document.createTextNode(text));
  return item;
}

function describeGlobalConstraint(goal) {
  const name = nameOf(goal.attribute);
  const relation = `${name} ${goal.op === '>=' ? '≥' : '<'} ${goal.value}`;
  if (goal.state === 'met') {
    return goal.mode === 'invariant'
      ? `${relation} —— 硬不变量，全程成立`
      : `${relation} —— 尽快满足，${goal.metOn} 达成`;
  }
  if (goal.mode === 'invariant') {
    return `${relation} —— 破了 ${goal.violatedOn.length} 天，首次 ${goal.violatedOn[0]}`;
  }
  return `${relation} —— 一直到终点都没有满足`;
}

function describeMiniGoal(goal) {
  const relation = `${goal.deadline} ${goalRelation(goal)}`;
  return goal.state === 'met'
    ? `${relation} —— 实际 ${goal.actual.toFixed(1)}`
    : `${relation} —— 实际 ${goal.actual.toFixed(1)}，还差 ${goal.shortfall.toFixed(1)}`;
}

function describeEndingGoal(goal) {
  const relation = goalRelation(goal);
  return goal.state === 'met'
    ? `${relation} —— 实际 ${goal.actual.toFixed(1)}`
    : `${relation} —— 实际 ${goal.actual.toFixed(1)}，还差 ${goal.shortfall.toFixed(1)}`;
}

/** 「文科 + 理科 ≥ 561」这种关系串，三种描述共用。 */
function goalRelation(goal) {
  const names = goal.attributes ? goal.attributes.map(nameOf).join(' + ') : nameOf(goal.attribute);
  return `${names} ${goal.op === '>=' ? '≥' : '<'} ${goal.value}`;
}

/** 诊断里的目标是输入原件，没有实际值，只拼关系串（外加截止日期）。 */
function describeGoalBriefly(goal) {
  return `${goal.deadline ? `${goal.deadline} ` : ''}${goalRelation(goal)}`;
}

/**
 * 不可达诊断：**三项并列**，不是只报第一个命中的原因。
 * 只报一项会让使用者误以为是唯一原因，从而去改错地方。
 */
function buildDiagnosis(diagnosis) {
  const wrap = document.createElement('div');
  wrap.className = 'diagnosis';

  const title = document.createElement('div');
  title.className = 'headline';
  title.textContent = '不可达诊断（三项并列）';
  wrap.append(title);

  const list = document.createElement('ul');
  list.append(
    goalLine(
      '小目标',
      diagnosis.miniGoalsBlocking
        ? `是它在挡路——取消「${describeGoalBriefly(diagnosis.reachableAfterCancelling)}」之后即可达标`
        : '不是小目标在挡路',
      !diagnosis.miniGoalsBlocking,
    ),
  );
  list.append(
    goalLine(
      '结局 vs 全局',
      diagnosis.endingAndGlobalConflict
        ? '两者冲突——把小目标全删了也达不到'
        : '彼此不冲突',
      !diagnosis.endingAndGlobalConflict,
    ),
  );
  list.append(
    goalLine(
      '结局目标本身',
      diagnosis.endingGoalsAloneUnreachable
        ? '不可达——连全局约束一起拿掉也达不到'
        : '可达',
      !diagnosis.endingGoalsAloneUnreachable,
    ),
  );

  wrap.append(list);
  return wrap;
}

function renderGoalsStatus(result) {
  const host = $('goals-status');
  host.textContent = '';

  const { goals } = result;
  const unmet =
    goals.globalConstraints.filter((g) => g.state !== 'met').length +
    goals.miniGoals.filter((g) => g.state !== 'met').length +
    goals.endingGoals.filter((g) => g.state !== 'met').length;

  const headline = document.createElement('div');
  headline.className = `headline ${goals.ok ? 'ok' : 'bad'}`;
  headline.textContent = goals.ok ? '硬约束全部达标' : `硬约束未全部达标（${unmet} 项）`;
  host.append(headline);

  const list = document.createElement('ul');
  for (const goal of goals.globalConstraints) {
    list.append(goalLine('全局', describeGlobalConstraint(goal), goal.state === 'met'));
  }
  for (const goal of goals.miniGoals) {
    list.append(goalLine('小目标', describeMiniGoal(goal), goal.state === 'met'));
  }
  for (const goal of goals.endingGoals) {
    list.append(goalLine('结局', describeEndingGoal(goal), goal.state === 'met'));
  }
  list.append(
    goalLine(
      '目标函数',
      `正向等权总和 ${goals.score.positiveSum.toFixed(1)} · 压力 ${goals.score.negative.toFixed(1)}`,
      true,
    ),
  );
  host.append(list);

  // 可达时不显示任何不可达诊断（见票 08 的验收标准）。
  const diagnosis = state.assignments?.diagnosis;
  if (!goals.ok && diagnosis) host.append(buildDiagnosis(diagnosis));
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
    renderGoalsStatus(result);
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
  setStatus(state.assignments ? '计算中…' : '尚未生成日程——点「生成」让工具排出一份。');
  const reply = await requestPlan(state.input);
  if (reply.cancelled) return;
  if (!reply.ok) {
    setStatus(`计算失败：${reply.error}`, true);
    return;
  }
  renderResult(reply.result);
}

/** 「生成」：先求解出完整日程，再按这份日程规划。 */
async function generate() {
  // 求解期间又来的改动不能丢：记下来，这一轮结束后再排一次。
  if (state.solving) {
    state.resolveQueued = true;
    return;
  }
  state.solving = true;
  $('btn-cancel').hidden = false;
  $('btn-plan').disabled = true;
  setStatus('求解中…');

  try {
    const reply = await requestSolve(state.input);
    if (reply.cancelled) {
      setStatus('已取消计算。');
      return;
    }
    if (!reply.ok) {
      setStatus(`求解失败：${reply.error}`, true);
      return;
    }
    state.assignments = reply.assignments;
    await runPlan();
  } finally {
    state.solving = false;
    $('btn-cancel').hidden = true;
    $('btn-plan').disabled = false;
    if (state.resolveQueued) {
      state.resolveQueued = false;
      generate();
    }
  }
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
  await generate();
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
  generate();
});

startWorker();
renderForm();

for (const list of GOAL_LISTS) wireGoalList(list);

$('btn-add-global').addEventListener('click', () => {
  state.input.globalConstraints.push({ attribute: attributeLabels[0].id, op: '>=', value: 50 });
  renderGoalEditors();
  generate();
});

$('btn-add-ending').addEventListener('click', () => {
  state.input.endingGoals.push({ attribute: attributeLabels[0].id, op: '>=', value: 50 });
  renderGoalEditors();
  generate();
});

$('btn-add-mini').addEventListener('click', () => {
  state.input.miniGoals.push({
    deadline: rules.timeline.lastSettlement,
    attributes: [attributeLabels[0].id],
    op: '>=',
    value: 50,
  });
  renderGoalEditors();
  generate();
});

$('start-date').addEventListener('change', (event) => {
  state.input.startDate = event.target.value;
  generate();
});

$('initial-club').addEventListener('change', (event) => {
  state.input.initialClub = event.target.value === UNSET ? null : event.target.value;
  generate();
});

$('btn-plan').addEventListener('click', () => {
  generate();
});

$('btn-cancel').addEventListener('click', () => {
  cancelSolve();
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

// 打开就先排一份，使用者不必先点一次「生成」才看得到东西。
generate();
