// 共享状态、标签、日期工具与弹窗骨架。
//
// 依赖方向是单向的：ui.js ← edits.js ← panels.js ← app.js，且 ui.js ← calendar.js ← panels.js。
// （panels.js 同时用到 edits.js 与 calendar.js；没有任何一条边反向指回 ui.js。）
// 打包器拒绝循环依赖，所以渲染入口由 app.js 通过 hooks 注入，而不是让 ui.js 反向 import app.js。

import rules from '../data/rules.json';
import { addDays, weekStartOf, weekdayOf } from '../src/dates.js';
import { availableCommandIds, createClubLookup } from '../src/clubs.js';
import { defaultInput } from '../src/input.js';
import { resolveCommand } from '../src/calendar.js';

export const UNSET = '';
export const CHOICE_EMPTY = '__empty__';
export const CHOICE_NO_CLUB = '__no_club__';

export const $ = (id) => document.getElementById(id);

export const TIMELINE = rules.timeline;

export const ATTRIBUTES = rules.attributes.map((attribute) => ({
  id: attribute.id,
  name: attribute.name,
  direction: attribute.direction,
  min: attribute.min,
  max: attribute.max,
}));

/** 「社团经验」在详情里与 9 项属性并列显示，但它不是属性表里的一项。 */
export const CLUB_EXPERIENCE = {
  id: rules.clubExperience.id,
  name: rules.clubExperience.name,
};

/** 详情条里的 10 项数值：9 项属性 + 当前社团的社团经验。 */
export const VALUE_FIELDS = [
  ...ATTRIBUTES.map((attribute) => ({ id: attribute.id, name: attribute.name })),
  CLUB_EXPERIENCE,
];

export const CLUBS = rules.clubs.map((club) => ({ id: club.id, name: club.name }));
export const COMMANDS = rules.commands.map((command) => ({ id: command.id, name: command.name }));

const COMMAND_NAMES = new Map(COMMANDS.map((command) => [command.id, command.name]));
const ATTRIBUTE_NAMES = new Map(ATTRIBUTES.map((attribute) => [attribute.id, attribute.name]));

export const SOURCE_LABELS = {
  pinned: '使用者指定',
  assigned: '求解器排定',
  none: '待定',
};

export const SKIP_LABELS = {
  day: '空过（指定本日）',
  'day-command': '空过（日指令置空）',
  week: '空过（本周周指令置空）',
};

export const BLOCK_LABELS = {
  'club-not-unlocked': '不结算（社团未解锁）',
  'club-not-selected': '不结算（未加入社团）',
  'club-mismatch': '不结算（社团不符）',
};

export const state = {
  input: defaultInput(rules),
  /** 求解器排出的日程；`null` 表示还没算过。 */
  assignments: null,
  /** `plan()` 的结果；`null` 表示还没算过。 */
  result: null,
  /** 求解器给的不可达诊断（排不出达标日程时才存在）。 */
  diagnosis: null,
  /** 尚未计算的改动数。 */
  pending: 0,
  computing: false,
  computedAt: null,
  /** 选区。`from` 恒不晚于 `to`；单日选中时两者相等。 */
  selection: { from: TIMELINE.start, to: TIMELINE.start },
  /** 双月日历左侧那个月，`YYYY-MM`。 */
  viewMonth: TIMELINE.start.slice(0, 7),
  dayByDate: new Map(),
  miniGoalByDate: new Map(),
};

/** app.js 注入的渲染入口；界面模块只管改状态，不互相直接调用渲染。 */
export const hooks = {
  render() {},
};

export function commandName(id) {
  return COMMAND_NAMES.get(id) ?? id;
}

export function attributeName(id) {
  if (id === CLUB_EXPERIENCE.id) return CLUB_EXPERIENCE.name;
  return ATTRIBUTE_NAMES.get(id) ?? id;
}

export function opText(op) {
  return op === '>=' ? '≥' : '<';
}

export function fmt1(value) {
  return Number(value ?? 0).toFixed(1);
}

export function isStale() {
  return state.pending > 0 || state.result === null;
}

/** 一个「空目标」：属性 + 方向 + 阈值。默认值只有这一处，免得三处各写一份。 */
export function defaultGoal() {
  return { attribute: ATTRIBUTES[0].id, op: '>=', value: 50 };
}

/** 目标与小目标的日期都夹在时间轴内：越界的截止日会让画旗与评估走偏。 */
export function clampDeadline(date) {
  if (date > TIMELINE.lastSettlement) return TIMELINE.lastSettlement;
  if (date < TIMELINE.start) return TIMELINE.start;
  return date;
}

/** 某一天所属的社团（`null` = 未加入）。社团只能在一个个周日内切换。 */
export function clubAt(date) {
  return createClubLookup(state.input)(date);
}

export function selectedDates() {
  const { from, to } = state.selection;
  if (!from || !to) return [];
  const dates = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function isRangeSelection() {
  return state.selection.from !== state.selection.to;
}

// ---------------------------------------------------------------- 日期

export function inTimeline(date) {
  return date >= TIMELINE.start && date <= TIMELINE.end;
}

export function monthOf(date) {
  return date.slice(0, 7);
}

export function monthLabel(key) {
  const [year, month] = key.split('-');
  return `${year}年${Number(month)}月`;
}

export function shiftMonth(key, delta) {
  const [year, month] = key.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

/** 一个月的日期格：补齐前后溢出日，行数按实际需要（5 或 6 行）。 */
export function monthCells(key) {
  const first = `${key}-01`;
  const [year, month] = key.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = Math.ceil((weekdayOf(first) + daysInMonth) / 7);
  const start = weekStartOf(first);
  return Array.from({ length: rows * 7 }, (_, index) => addDays(start, index));
}

// ---------------------------------------------------------------- 指令候选

export function commandsAvailableAt(date) {
  const clubAt = createClubLookup(state.input);
  const allowed = new Set(availableCommandIds(rules, clubAt(date), date));
  return COMMANDS.filter((command) => allowed.has(command.id));
}

export function isRestOn(date) {
  return weekdayOf(date) === 0 || state.input.restDays.includes(date);
}

/** 与日历、求解器完全一致的指令解析口径（见 src/calendar.js 的 resolveCommand）。 */
export function resolveDayCommand(date) {
  const rest = isRestOn(date);
  const weekStart = weekStartOf(date);
  return resolveCommand(state.input, state.assignments, {
    isRestDay: rest,
    date,
    weekStart,
  });
}

export function setResult(result) {
  state.result = result;
  state.dayByDate = new Map(result.days.map((day) => [day.date, day]));
  state.diagnosis = null;
  state.computedAt = new Date();
  state.pending = 0;
}

export function dayOf(date) {
  return state.dayByDate.get(date) ?? null;
}

/** 值：优先取计算结果，没有就退回起始属性（未计算时详情条仍要能显示起点）。 */
export function valueOf(date, id) {
  const day = dayOf(date);
  if (!day) return null;
  return id === CLUB_EXPERIENCE.id ? day.clubExperience : day.attributes[id];
}

/** 当日增量：与前一天结算后的值比较；时间轴第一天与起始属性比较。 */
export function deltaOf(date, id) {
  const day = dayOf(date);
  if (!day) return null;
  if (date === state.input.startDate) {
    const base = id === CLUB_EXPERIENCE.id ? 0 : state.input.attributes[id];
    const current = id === CLUB_EXPERIENCE.id ? day.clubExperience : day.attributes[id];
    return current - base;
  }
  const previous = dayOf(addDays(date, -1));
  if (!previous) return null;
  const before = id === CLUB_EXPERIENCE.id ? previous.clubExperience : previous.attributes[id];
  const after = id === CLUB_EXPERIENCE.id ? day.clubExperience : day.attributes[id];
  return after - before;
}

// ---------------------------------------------------------------- 改动登记

export function markDirty(count = 1) {
  state.pending += count;
  hooks.render();
}

/** 改完周指令后，把本周全部平日亮一下——"这一改连坐六天"要看得见。 */
export function flashWeek(weekStart) {
  const cells = document.querySelectorAll(`.cell[data-week="${weekStart}"].is-wd`);
  for (const cell of cells) {
    cell.classList.remove('is-flash');
    void cell.offsetWidth;
    cell.classList.add('is-flash');
    setTimeout(() => cell.classList.remove('is-flash'), 1400);
  }
}

// ---------------------------------------------------------------- 弹窗

export function openModal({ title, body, actions = [] }) {
  $('modal-title').textContent = title;
  const bodyHost = $('modal-body');
  bodyHost.textContent = '';
  if (body) bodyHost.append(body);

  const actionHost = $('modal-actions');
  actionHost.textContent = '';
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.primary ? 'btn btn-primary' : 'btn';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    actionHost.append(button);
  }
  $('modal').hidden = false;
}

export function closeModal() {
  $('modal').hidden = true;
}

export function modalIsOpen() {
  return !$('modal').hidden;
}

export function field(label, control) {
  const row = document.createElement('label');
  row.className = 'form-row';
  const caption = document.createElement('span');
  caption.textContent = label;
  row.append(caption, control);
  return row;
}

export function numberInput(value, { min = 0, max = 999, step = 1 } = {}) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  return input;
}

export function selectOf(entries, value) {
  const select = document.createElement('select');
  for (const [optionValue, label] of entries) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
  return select;
}

export function attributePicker(selected) {
  const host = document.createElement('div');
  host.className = 'attr-picker';
  const chosen = new Set(selected);
  for (const field2 of VALUE_FIELDS) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = field2.id;
    box.checked = chosen.has(field2.id);
    const caption = document.createElement('span');
    caption.textContent = field2.name;
    label.append(box, caption);
    host.append(label);
  }
  return host;
}

export function pickedAttributes(host) {
  return [...host.querySelectorAll('input[type="checkbox"]')]
    .filter((box) => box.checked)
    .map((box) => box.value);
}
