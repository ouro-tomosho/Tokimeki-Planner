// 双月日历与当日详情条。
//
// 两件事在这里落地：
//   1. 日历**从周日起排**，所以每一行恰好等于一个自然周（周日 + 周一至周六）——
//      该周的周指令一眼是一个整体。
//   2. 格子里写的是**当天实际执行的指令**：平日显示本周周指令，周日与休息日显示各自的日指令。

import { addDays, weekStartOf, weekdayOf } from '../src/dates.js';
import {
  $,
  BLOCK_LABELS,
  CLUBS,
  SKIP_LABELS,
  SOURCE_LABELS,
  TIMELINE,
  VALUE_FIELDS,
  clampDeadline,
  clubAt,
  commandName,
  deltaOf,
  fmt1,
  inTimeline,
  isRestOn,
  isStale,
  isRangeSelection,
  monthCells,
  monthLabel,
  monthOf,
  resolveDayCommand,
  selectedDates,
  shiftMonth,
  state,
  valueOf,
} from './ui.js';

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const MAX_FLAGS = 4;

/** 与 src/calendar.js 的 resolveSkipSource 同口径：界面在未计算时也要能画出"空过"。 */
function skipSourceOn(date, rest) {
  if (state.input.skippedDays.includes(date)) return 'day';
  if (rest && state.input.dayCommands[date] === null) return 'day-command';
  if (!rest && state.input.weekCommands[weekStartOf(date)] === null) return 'week';
  return null;
}

/** `date` 上挂着哪几条小目标（按 input.miniGoals 的下标，用来取达标状态）。 */
function miniGoalIndexesOn(date) {
  const indexes = [];
  state.input.miniGoals.forEach((goal, index) => {
    if (clampDeadline(goal.deadline) === date) indexes.push(index);
  });
  return indexes;
}

function buildCell(date) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.dataset.date = date;
  cell.dataset.week = weekStartOf(date);
  cell.tabIndex = 0;
  cell.setAttribute('role', 'gridcell');

  const weekday = weekdayOf(date);
  const inRange = inTimeline(date);
  const rest = isRestOn(date);
  const history = state.input.playedUpTo ? date < state.input.playedUpTo : false;

  if (weekday === 0) cell.classList.add('is-sun');
  else cell.classList.add('is-wd');
  if (rest && weekday !== 0) cell.classList.add('is-rest');
  if (history) cell.classList.add('is-history');

  const skipSource = inRange ? skipSourceOn(date, rest) : null;
  if (skipSource) cell.classList.add('is-empty');
  if (!inRange) {
    cell.classList.add('is-ovf');
    cell.setAttribute('aria-disabled', 'true');
    cell.tabIndex = -1;
  }
  if (state.input.playedUpTo === date) cell.classList.add('is-played');
  if (date === TIMELINE.end) cell.classList.add('is-end');

  const number = document.createElement('span');
  number.className = 'dn';
  number.textContent = String(Number(date.slice(8, 10)));

  const command = document.createElement('span');
  command.className = 'dcmd';
  if (skipSource) {
    command.textContent = '空过';
  } else if (inRange) {
    const resolved = resolveDayCommand(date);
    command.textContent = resolved.commandId ? commandName(resolved.commandId) : '待定';
  } else {
    command.textContent = '—';
  }

  cell.append(number);

  const indexes = inRange ? miniGoalIndexesOn(date) : [];
  if (indexes.length > 0) {
    const flags = document.createElement('span');
    flags.className = 'flags';
    const shown = indexes.length > MAX_FLAGS ? MAX_FLAGS - 1 : indexes.length;
    for (let i = 0; i < shown; i += 1) {
      flags.append(buildFlag(indexes[i]));
    }
    if (indexes.length > MAX_FLAGS) {
      const badge = document.createElement('span');
      badge.className = 'flag-count';
      badge.textContent = `⚑${indexes.length}`;
      flags.append(badge);
    }
    cell.append(flags);
  }

  cell.append(command);

  if (date === TIMELINE.end) {
    const tag = document.createElement('span');
    tag.className = 'tag-end';
    tag.textContent = '终点';
    cell.append(tag);
  }
  return cell;
}

function buildFlag(index) {
  const flag = document.createElement('span');
  const evaluated = state.result?.goals?.miniGoals?.[index];
  flag.className = 'flag';
  if (evaluated) {
    flag.classList.add(evaluated.state === 'met' ? 'met' : 'unmet');
    flag.title = evaluated.state === 'met' ? '小目标达标' : '小目标未达标';
  } else {
    flag.classList.add('unmet');
    flag.title = '小目标（尚未计算）';
  }
  return flag;
}

function buildMonth(key) {
  const month = document.createElement('div');
  month.className = 'month';

  const title = document.createElement('div');
  title.className = 'month-title';
  title.textContent = monthLabel(key);
  month.append(title);

  const dow = document.createElement('div');
  dow.className = 'dow';
  for (const name of DOW) {
    const head = document.createElement('span');
    head.textContent = name;
    dow.append(head);
  }
  month.append(dow);

  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const date of monthCells(key)) {
    const cell = buildCell(date);
    cell.dataset.month = key;
    // 溢出日：日期不属于本月，置灰不可选。
    if (monthOf(date) !== key) {
      cell.classList.add('is-ovf');
      cell.setAttribute('aria-disabled', 'true');
      cell.tabIndex = -1;
      // 溢出格是"另一个月的那一天"，不该携带本月的任何标记——包括终点的底边与「终点」标签。
      cell.classList.remove('is-empty', 'is-rest', 'is-history', 'is-end', 'is-played');
      cell.querySelector('.dcmd').textContent = '—';
      const flags = cell.querySelector('.flags');
      if (flags) flags.remove();
      const tag = cell.querySelector('.tag-end');
      if (tag) tag.remove();
    }
    grid.append(cell);
  }
  month.append(grid);
  return month;
}

function applySelectionClasses() {
  const { from, to } = state.selection;
  const range = from !== to;
  for (const cell of document.querySelectorAll('.cell')) {
    // 溢出格是"上/下个月的那一天"，不可选也不该显示选中态——否则同一日期会在
    // 两张月历里同时亮起，其中一张还是灰的。
    if (cell.classList.contains('is-ovf')) {
      cell.classList.remove('is-range', 'is-selected');
      cell.removeAttribute('aria-selected');
      continue;
    }
    const date = cell.dataset.date;
    const inside = range && date >= from && date <= to;
    const selected = date === from || date === to;
    cell.classList.toggle('is-range', inside && !selected);
    cell.classList.toggle('is-selected', selected);
    if (selected) cell.setAttribute('aria-selected', 'true');
    else cell.removeAttribute('aria-selected');
  }
}

export function renderCalendar() {
  const host = $('calendar');
  host.textContent = '';

  const stale = isStale();
  const months = document.createElement('div');
  months.className = 'cal-months';
  months.append(buildMonth(state.viewMonth), buildMonth(shiftMonth(state.viewMonth, 1)));
  host.append(months);

  host.classList.toggle('stale', stale);
  applySelectionClasses();

  $('month-label').textContent = `${monthLabel(state.viewMonth)} · ${monthLabel(
    shiftMonth(state.viewMonth, 1),
  )}`;
}

export function renderDetail() {
  const host = $('detail');
  host.textContent = '';
  host.classList.toggle('stale', isStale());

  const date = state.selection.to;
  const range = isRangeSelection();
  const weekday = weekdayOf(date);
  const weekStart = weekStartOf(date);
  const rest = isRestOn(date);
  const skipSource = skipSourceOn(date, rest);
  const resolved = resolveDayCommand(date);
  const day = state.dayByDate.get(date) ?? null;

  const when = document.createElement('div');
  when.className = 'when';

  const line = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = `${date} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday]}`;
  const weekNo =
    Math.round(
      (Date.parse(`${weekStart}T00:00:00Z`) -
        Date.parse(`${weekStartOf(state.input.startDate)}T00:00:00Z`)) /
        604800000,
    ) + 1;
  const weekText = document.createElement('span');
  weekText.textContent = ` · 第 ${Number.isFinite(weekNo) ? weekNo : '—'} 周`;
  line.append(strong, weekText);
  when.append(line);

  const commandLine = document.createElement('p');
  if (skipSource) {
    commandLine.textContent = `当日指令：${SKIP_LABELS[skipSource]}`;
  } else if (resolved.commandId) {
    commandLine.textContent = `当日指令：${commandName(resolved.commandId)}（${SOURCE_LABELS[resolved.source]}）`;
  } else {
    commandLine.textContent = '当日指令：待定';
  }
  when.append(commandLine);

  const settleLine = document.createElement('p');
  if (day && !day.isSettled) {
    settleLine.textContent = `不结算：${
      day.commandBlocked ? BLOCK_LABELS[day.commandBlocked] : date === TIMELINE.end ? '时间轴终点' : '时间轴起点'
    }`;
  } else if (!state.result) {
    settleLine.textContent = '尚未计算——点上方「计算」得到属性与达标判定。';
  } else {
    settleLine.textContent = '已结算';
  }
  when.append(settleLine);

  if (rest && weekday !== 0) {
    const restLine = document.createElement('p');
    restLine.textContent = '这一天被标记为休息日：执行自己的日指令，不执行本周周指令。';
    when.append(restLine);
  }

  const clubId = clubAt(date);
  const clubLine = document.createElement('p');
  clubLine.textContent = `社团：${
    clubId ? (CLUBS.find((entry) => entry.id === clubId)?.name ?? clubId) : '未加入'
  }`;
  when.append(clubLine);

  host.append(when);

  const attrs = document.createElement('div');
  attrs.className = 'attrs';
  for (const field of VALUE_FIELDS) {
    const row = document.createElement('div');
    row.className = 'attr';
    const name = document.createElement('span');
    name.textContent = field.name;
    row.append(name);

    const value = document.createElement('b');
    const current = valueOf(date, field.id);
    value.textContent = current === null ? '—' : fmt1(current);
    row.append(value);

    const delta = deltaOf(date, field.id);
    const deltaEl = document.createElement('em');
    if (delta === null) {
      deltaEl.textContent = 'Δ —';
    } else {
      const rounded = Math.abs(delta) < 0.05 ? 0 : delta;
      deltaEl.textContent = `Δ ${rounded > 0 ? '+' : ''}${fmt1(rounded)}`;
      if (rounded > 0) deltaEl.classList.add('up');
      if (rounded < 0) deltaEl.classList.add('down');
    }
    row.append(deltaEl);
    attrs.append(row);
  }
  host.append(attrs);

  if (range) {
    const note = document.createElement('div');
    note.className = 'range-note';
    const dates = selectedDates();
    const weeks = new Set(dates.map((entry) => weekStartOf(entry)));
    note.textContent = `已选 ${dates.length} 天（${state.selection.from} → ${state.selection.to}，跨 ${weeks.size} 周）：右键打开批量操作；在这段里改指令会写进它覆盖到的每一周的周指令。`;
    host.append(note);
  }
}

// ---------------------------------------------------------------- 选中与框选

export function setSelection(anchor, other) {
  const from = anchor <= other ? anchor : other;
  const to = anchor <= other ? other : anchor;
  state.selection = { from, to };
  applySelectionClasses();
  renderDetail();
}

export function selectDate(date) {
  setSelection(date, date);
}

export function goToMonth(key) {
  const lowest = monthOf(TIMELINE.start);
  const highest = monthOf(TIMELINE.end);
  if (key < lowest) key = lowest;
  if (key > highest) key = highest;
  state.viewMonth = key;
  renderCalendar();
}

/** 跳到某一天：把它所在的月份放到**左侧**，并选中它。 */
export function jumpToDate(date) {
  if (!date) return;
  goToMonth(monthOf(date));
  selectDate(date);
  const cell = cellFor(date);
  if (cell) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** 同一日期可能在两张月历里各有一格；永远挑可用（非溢出）的那一格。 */
export function cellFor(date) {
  return (
    document.querySelector(`.cell[data-date="${date}"]:not(.is-ovf)`) ??
    document.querySelector(`.cell[data-date="${date}"]`)
  );
}

let drag = null;

export function wireCalendar() {
  const host = $('calendar');

  host.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const cell = event.target.closest('.cell');
    if (!cell || cell.classList.contains('is-ovf')) return;
    event.preventDefault();
    drag = { anchor: cell.dataset.date, last: cell.dataset.date };
    selectDate(cell.dataset.date);
  });

  host.addEventListener('mousemove', (event) => {
    if (!drag) return;
    const cell = event.target.closest('.cell');
    if (!cell || cell.classList.contains('is-ovf')) return;
    const date = cell.dataset.date;
    if (date === drag.last) return;
    drag.last = date;
    setSelection(drag.anchor, date);
  });

  document.addEventListener('mouseup', () => {
    drag = null;
  });

  host.addEventListener('keydown', (event) => {
    const cell = event.target.closest('.cell');
    if (!cell) return;
    const date = cell.dataset.date;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = addDays(date, step);
    if (!inTimeline(next)) return;
    if (monthOf(next) !== monthOf(date)) goToMonth(monthOf(next));
    selectDate(next);
    const moved = cellFor(next);
    if (moved) moved.focus();
  });

  $('btn-prev-month').addEventListener('click', () => goToMonth(shiftMonth(state.viewMonth, -1)));
  $('btn-next-month').addEventListener('click', () => goToMonth(shiftMonth(state.viewMonth, 1)));
  $('btn-jump').addEventListener('click', () => jumpToDate($('jump-date').value));
  $('btn-jump-start').addEventListener('click', () => jumpToDate(TIMELINE.start));
  $('btn-jump-end').addEventListener('click', () => jumpToDate(TIMELINE.end));
}

