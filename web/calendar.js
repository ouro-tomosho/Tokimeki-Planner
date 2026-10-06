// 双月日历与当日详情条。
//
// 两件事在这里落地：
//   1. 日历**从周日起排**，所以每一行恰好等于一个自然周（周日 + 周一至周六）——
//      该周的周指令一眼是一个整体。
//   2. 格子里写的是**当天实际执行的指令**：平日显示本周周指令，周日与休息日显示各自的日指令。
//      休息日来自游戏固定日历（`rules.calendar.restDays`），界面上没有标注它的操作。

import { addDays, weekStartOf, weekdayOf } from '../src/dates.js';
import { $ } from './dom.js';
import {
  BLOCK_LABELS,
  CLUBS,
  SKIP_LABELS,
  SOURCE_LABELS,
  TIMELINE,
  VALUE_FIELDS,
  clubAt,
  commandName,
  fmt1,
  inTimeline,
  isRestOn,
  isStale,
  isRangeSelection,
  monthCells,
  monthLabel,
  monthOf,
  landingMet,
  rebuildCheckpointIndex,
  resolveDayCommand,
  selectedDates,
  shiftMonth,
  state,
  valueOf,
} from './ui.js';

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
/** 小目标标记最多画几面旗；超出的收进 `⚑N` 徽标。 */
const MAX_FLAGS = 4;

/** 与 src/calendar.js 的 resolveSkipSource 同口径：界面在未计算时也要能画出"空过"。 */
function skipSourceOn(date, rest) {
  if (state.input.skippedDays.includes(date)) return 'day';
  if (rest && state.input.dayCommands[date] === null) return 'day-command';
  if (!rest && state.input.weekCommands[weekStartOf(date)] === null) return 'week';
  return null;
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

  if (weekday === 0) cell.classList.add('is-sun');
  else cell.classList.add('is-wd');
  if (rest && weekday !== 0) cell.classList.add('is-rest');

  // 终点不是决策日：它不结算，所以"空过/跳过"对它没有意义。
  // 在源头就把这件事定下来——否则存档里若有终点的空过标记，格子会显示「空过」，
  // 与「终点没有指令可执行」这件事矛盾（格子与详情条必须说同一句话）。
  const skipSource = inRange && date !== TIMELINE.end ? skipSourceOn(date, rest) : null;
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
  } else if (date === state.input.playedUpTo) {
    // 状态快照：按 ADR-0004，起点当天不结算，写"要执行的指令"会骗人。
    command.textContent = '起点';
  } else if (date === TIMELINE.end) {
    // 终点当天不结算、也没有指令可执行（它不是休息日，只是时间轴的边界）。
    // 写「待定」会让人以为还得给它下一条指令——那是错的；这里与起点格用**同一种表达**：
    // 朴素的一行文案，不加专属底边、不加角标。
    command.textContent = '终点';
  } else if (inRange) {
    const resolved = resolveDayCommand(date);
    if (resolved.commandId) command.textContent = commandName(resolved.commandId);
    else command.textContent = resolved.skip ? '跳过' : '待定';
  } else {
    command.textContent = '—';
  }

  cell.append(number);

  const landings = inRange ? state.landingByDate.get(date) ?? [] : [];
  // 日历格上**只标小目标**（所有者 2026-10-07 裁决）：全局约束与结局目标不再占格子。
  const minis = landings.filter((landing) => landing.source === 'mini');
  if (minis.length > 0) {
    const flags = document.createElement('span');
    flags.className = 'flags';
    const shown = minis.length > MAX_FLAGS ? MAX_FLAGS - 1 : minis.length;
    for (let i = 0; i < shown; i += 1) {
      flags.append(buildFlag(minis[i]));
    }
    if (minis.length > MAX_FLAGS) {
      const badge = document.createElement('span');
      badge.className = 'flag-count';
      badge.textContent = `⚑${minis.length}`;
      flags.append(badge);
    }
    cell.append(flags);
  }

  cell.append(command);

  return cell;
}

/** 一面旗 = 一个小目标落点：红旗达标、白旗未达标；没算过一律白旗。 */
function buildFlag(landing) {
  const flag = document.createElement('span');
  const met = landingMet(landing);
  flag.className = 'flag';
  flag.classList.add(met === true ? 'met' : 'unmet');
  const label = flagTitleOf(landing);
  flag.title = met === null ? `${label}（尚未计算）` : met ? `${label}：达标` : `${label}：未达标`;
  return flag;
}

function flagTitleOf(landing) {
  return `${landing.date} ${flagLabelOf(landing)}`;
}

function flagLabelOf(landing) {
  const names = (landing.attributes ?? (landing.attribute ? [landing.attribute] : []))
    .map((id) => fieldNameOf(id))
    .join('+');
  return `${names} ${landing.op === '>=' ? '≥' : '<'} ${landing.value}`;
}

function fieldNameOf(id) {
  return VALUE_FIELDS.find((field) => field.id === id)?.name ?? id;
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
      cell.classList.remove('is-empty', 'is-rest', 'is-end', 'is-played');
      cell.querySelector('.dcmd').textContent = '—';
      const flags = cell.querySelector('.flags');
      if (flags) flags.remove();
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
  // 检查点落点索引（619 个落点）在这里重建：日历上的旗按落点画，与编辑表的"一行"不同。
  rebuildCheckpointIndex();

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
        Date.parse(`${weekStartOf(state.input.playedUpTo)}T00:00:00Z`)) /
        604800000,
    ) + 1;
  const weekText = document.createElement('span');
  weekText.textContent = ` · 第 ${Number.isFinite(weekNo) ? weekNo : '—'} 周`;
  line.append(strong, weekText);
  when.append(line);

  const commandLine = document.createElement('p');
  if (date === TIMELINE.end) {
    // 终点不是决策日：与日历格上写同一句话（格子写「终点」）。
    commandLine.textContent = '当日指令：终点（时间轴边界，不下指令、不结算）';
  } else if (date === state.input.playedUpTo) {
    // 起点同样不是决策日：它的结果已经发生在游戏里（格子写「起点」）。
    commandLine.textContent = '当日指令：起点（状态快照，不结算）';
  } else if (skipSource) {
    commandLine.textContent = `当日指令：${SKIP_LABELS[skipSource]}`;
  } else if (resolved.skip) {
    commandLine.textContent = '当日指令：跳过（求解器选择，当天不执行、不结算）';
  } else if (resolved.commandId) {
    commandLine.textContent = `当日指令：${commandName(resolved.commandId)}（${SOURCE_LABELS[resolved.source]}）`;
  } else {
    commandLine.textContent = '当日指令：待定';
  }
  when.append(commandLine);

  const settleLine = document.createElement('p');
  if (!day) {
    // 没有结算记录有两种情况，说法不能混：还没算过，与真的在时间轴之外。
    settleLine.textContent = inTimeline(date)
      ? '尚未计算：点右上角「计算」后这里会显示这一天的属性与判定。'
      : '时间轴之外：没有这一天的结算记录。';
  } else if (!day.isSettled) {
    // 如实说明为什么不结算，不编数值：下面的属性是**当天状态**（起点快照，或沿用上一日）。
    const blockText = day.commandBlocked
      ? BLOCK_LABELS[day.commandBlocked].replace(/^不结算（/, '').replace(/）$/, '')
      : null;
    const reason = blockText
      ?? (day.isEmpty
        ? '空过'
        : date === TIMELINE.end
          ? '时间轴终点'
          : date === state.input.playedUpTo
            ? '时间轴起点（状态快照）'
            : '没有可执行的指令');
    settleLine.textContent = `不结算（${reason}）：下面的属性是当天状态。`;
  } else if (!state.result) {
    settleLine.textContent = '尚未计算——点上方「计算」得到属性与达标判定。';
  } else {
    settleLine.textContent = '已结算';
  }
  when.append(settleLine);

  if (rest && weekday !== 0) {
    const restLine = document.createElement('p');
    // 休息日是**游戏固定日历**（节假日），不是使用者标的，所以措辞不能写"被标记为"。
    restLine.textContent = '这一天是游戏固定日历里的休息日：执行自己的日指令，不执行本周周指令。';
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
  // 当日详情只报**当天结算后的属性值**（所有者 2026-10-07 裁决）：不再显示当日 Δ 与目标轨迹值。
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

