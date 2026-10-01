// 达标清单、不可达诊断、右键菜单、小目标弹窗与目标编辑器。
//
// 「编辑」与「查看状态」在这里合到一处：每一行既是"达没达到"，也是改它的入口。

import { weekdayOf, weekStartOf } from '../src/dates.js';
import {
  $,
  ATTRIBUTES,
  CHOICE_EMPTY,
  CHOICE_NO_CLUB,
  CLUBS,
  TIMELINE,
  UNSET,
  attributeName,
  attributePicker,
  clampDeadline,
  closeModal,
  clubAt,
  commandsAvailableAt,
  defaultGoal,
  field,
  fmt1,
  isRestOn,
  isStale,
  modalIsOpen,
  numberInput,
  opText,
  openModal,
  pickedAttributes,
  selectOf,
  selectedDates,
  isRangeSelection,
  state,
} from './ui.js';
import {
  addEndingGoal,
  addGlobalConstraint,
  addMiniGoal,
  commandIdToChoice,
  draftMiniGoal,
  removeEndingGoal,
  removeGlobalConstraint,
  removeMiniGoal,
  setClubChange,
  setCommands,
  setPlayedUpTo,
  setRestDays,
  setSkipped,
  updateEndingGoal,
  updateGlobalConstraint,
  updateMiniGoal,
} from './edits.js';
import { jumpToDate, selectDate } from './calendar.js';

// ---------------------------------------------------------------- 达标清单

function goalRow({ name, threshold, actual, gap, met, actions, subtitle }) {
  const row = document.createElement('div');
  row.className = `goal-row ${met === null ? '' : met ? 'met' : 'unmet'}`;

  const nameCell = document.createElement('span');
  nameCell.className = 'name';
  nameCell.textContent = name;
  if (subtitle) nameCell.title = subtitle;

  const thresholdCell = document.createElement('span');
  thresholdCell.className = 'v';
  thresholdCell.textContent = threshold;

  const actualCell = document.createElement('span');
  actualCell.className = 'v';
  actualCell.textContent = actual;

  const gapCell = document.createElement('span');
  gapCell.className = 'gap';
  gapCell.textContent = gap;

  const stateCell = document.createElement('span');
  stateCell.className = 'state';
  if (met !== null) {
    const dot = document.createElement('i');
    dot.className = `dot ${met ? 'met' : 'unmet'}`;
    stateCell.append(dot);
    const text = document.createElement('span');
    text.textContent = met ? '达标' : '未达标';
    stateCell.append(text);
  } else {
    stateCell.textContent = '未计算';
  }

  const actionCell = document.createElement('span');
  actionCell.className = 'row-actions';
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = action.label;
    if (action.title) button.title = action.title;
    button.addEventListener('click', action.onClick);
    actionCell.append(button);
  }

  row.append(nameCell, thresholdCell, actualCell, gapCell, stateCell, actionCell);
  return row;
}

function groupHeader(title, countText, onAdd) {
  const header = document.createElement('header');
  const label = document.createElement('span');
  label.textContent = title;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = countText;
  header.append(label, count);
  if (onAdd) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn';
    add.textContent = '+ 加一条';
    add.addEventListener('click', onAdd);
    header.append(add);
  }
  return header;
}

/** 组标题右边的"N 条 · 全部达标/有未达标"。没有结果时不加后半句。 */
function groupCount(total, evaluated, allMet, someMet) {
  const suffix = evaluated ? (evaluated.every((entry) => entry.state === 'met') ? allMet : someMet) : '';
  return `${total} 条${suffix}`;
}

function columnsRow() {
  const row = document.createElement('div');
  row.className = 'goal-cols';
  for (const label of ['名称', '阈值', '实际值', '差距', '状态', '']) {
    const span = document.createElement('span');
    span.textContent = label;
    row.append(span);
  }
  return row;
}

/**
 * 「未达标的条目排在前」（规格 R14）。排序是稳定的：同一档内保持输入顺序，
 * 因为行的编辑/删除动作靠的是**输入数组里的下标**，不是显示位置。
 */
function orderedRows(goals, evaluated) {
  const rank = (entry) => {
    if (!entry) return 1;
    return entry.state === 'met' ? 2 : 0;
  };
  return goals
    .map((goal, index) => ({ goal, index, ev: evaluated[index] ?? null }))
    .sort((a, b) => rank(a.ev) - rank(b.ev) || a.index - b.index);
}

function group() {
  const host = document.createElement('div');
  host.className = 'goal-group';
  return host;
}

export function renderGoals() {
  const host = $('goals');
  host.textContent = '';
  host.classList.toggle('stale', isStale());

  const evaluated = state.result?.goals ?? null;
  const head = document.createElement('div');
  head.className = 'goals-head';
  const title = document.createElement('span');
  title.textContent = '达标';
  const count = document.createElement('span');
  count.className = 'count';
  if (evaluated) {
    const met = (list) => list.filter((entry) => entry.state === 'met').length;
    count.textContent = `结局 ${met(evaluated.endingGoals)}/${evaluated.endingGoals.length} · 小目标 ${met(
      evaluated.miniGoals,
    )}/${evaluated.miniGoals.length} · 全局 ${met(evaluated.globalConstraints)}/${
      evaluated.globalConstraints.length
    }`;
  } else {
    count.textContent = '尚未计算——下面的状态列显示「未计算」';
  }
  head.append(title, count);
  host.append(head);

  // 结局目标
  const ending = group();
  const endingEval = evaluated?.endingGoals ?? [];
  ending.append(
    groupHeader(
      '结局目标',
      groupCount(state.input.endingGoals.length, endingEval, ' · 全部达标', ' · 有未达标'),
      () => openEndingEditor(null),
    ),
  );
  if (state.input.endingGoals.length > 0) ending.append(columnsRow());
  for (const { goal, index, ev } of orderedRows(state.input.endingGoals, endingEval)) {
    ending.append(
      goalRow({
        name: attributeName(goal.attribute),
        threshold: `${opText(goal.op)} ${goal.value}`,
        actual: ev ? fmt1(ev.actual) : '—',
        gap: ev && ev.state === 'unmet' ? `还差 ${fmt1(ev.shortfall)}` : ev ? '—' : '—',
        met: ev ? ev.state === 'met' : null,
        subtitle: '在 1998-03-01 评估',
        actions: [
          { label: '✎', title: '编辑', onClick: () => openEndingEditor(index) },
          { label: '×', title: '删除', onClick: () => removeEndingGoal(index) },
        ],
      }),
    );
  }
  host.append(ending);

  // 小目标
  const mini = group();
  const miniEval = evaluated?.miniGoals ?? [];
  mini.append(
    groupHeader(
      '小目标',
      groupCount(state.input.miniGoals.length, miniEval, ' · 全部达标', ' · 有未达标'),
      () => openMiniGoalPopup(state.selection.to, null),
    ),
  );
  if (state.input.miniGoals.length > 0) mini.append(columnsRow());
  for (const { goal, index, ev } of orderedRows(state.input.miniGoals, miniEval)) {
    mini.append(
      goalRow({
        name: `${goal.deadline} ${miniGoalSummary(goal)}`,
        threshold: `${opText(goal.op)} ${goal.value}`,
        actual: ev ? fmt1(ev.actual) : '—',
        gap: ev && ev.state === 'unmet' ? `还差 ${fmt1(ev.shortfall)}` : '—',
        met: ev ? ev.state === 'met' : null,
        subtitle: ev ? `在 ${ev.evaluatedOn} 结算后评估` : '阈值作用于所选属性的求和',
        actions: [
          {
            label: '↗',
            title: '跳到该日',
            onClick: () => jumpToDate(goal.deadline),
          },
          { label: '✎', title: '编辑', onClick: () => openMiniGoalPopup(goal.deadline, index) },
          { label: '×', title: '删除', onClick: () => removeMiniGoal(index) },
        ],
      }),
    );
  }
  if (state.input.miniGoals.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent =
      '还没有小目标。在日历上右键某一天选「添加小目标…」，或者用上面的「+ 加一条」。';
    mini.append(empty);
  }
  host.append(mini);

  // 全局约束
  const global = group();
  const globalEval = evaluated?.globalConstraints ?? [];
  global.append(
    groupHeader(
      '全局约束',
      groupCount(state.input.globalConstraints.length, globalEval, ' · 全部成立', ' · 有被破的'),
      () => openGlobalEditor(null),
    ),
  );
  if (state.input.globalConstraints.length > 0) global.append(columnsRow());
  for (const { goal, index, ev } of orderedRows(state.input.globalConstraints, globalEval)) {
    let actual = '—';
    if (ev) {
      if (ev.state === 'met') actual = ev.metOn ? `${ev.metOn} 达成` : '成立';
      else actual = `破了 ${ev.violatedOn.length} 天`;
    }
    global.append(
      goalRow({
        name: attributeName(goal.attribute),
        threshold: `${opText(goal.op)} ${goal.value}`,
        actual,
        gap: ev && ev.mode ? (ev.mode === 'invariant' ? '硬不变量' : '尽快满足') : '—',
        met: ev ? ev.state === 'met' : null,
        subtitle: '每一次每日结算之后判定',
        actions: [
          { label: '✎', title: '编辑', onClick: () => openGlobalEditor(index) },
          { label: '×', title: '删除', onClick: () => removeGlobalConstraint(index) },
        ],
      }),
    );
  }
  host.append(global);
}

// ---------------------------------------------------------------- 诊断

export function renderDiagnosis() {
  const host = $('diagnosis');
  host.textContent = '';
  host.classList.toggle('stale', isStale());

  const diagnosis = state.diagnosis;
  if (!diagnosis) return;

  const head = document.createElement('div');
  head.className = 'goals-head';
  const title = document.createElement('span');
  title.textContent = '不可达诊断（三项并列）';
  head.append(title);
  host.append(head);

  const cards = [];
  if (diagnosis.miniGoalsBlocking) {
    const cancelled = diagnosis.mustCancel ?? [];
    const last = cancelled.length > 0 ? cancelled[cancelled.length - 1] : null;
    cards.push({
      title: '小目标 是它在挡路',
      text: last
        ? `由近至远取消 ${cancelled.length} 条（到「${last.deadline} ${
            last.attributes.map((id) => attributeName(id)).join('+')
          } ${opText(last.op)} ${last.value}」为止）即可达标。`
        : '取消全部小目标即可达标。',
    });
  } else {
    cards.push({ title: '小目标 不是（唯一的）障碍', text: '只取消小目标不足以达标。' });
  }

  cards.push({
    title: '结局 vs 全局',
    text: diagnosis.endingAndGlobalConflict
      ? '两者彼此冲突：必须连全局约束也拿掉，结局目标才可达。'
      : '两者彼此不冲突。',
  });

  cards.push({
    title: diagnosis.endingGoalsUnreachable ? '结局目标本身不可达' : '小目标之外',
    text: diagnosis.endingGoalsUnreachable
      ? '把小目标全部取消后仍不可达——问题出在结局目标本身。'
      : '把小目标全部取消即可达标。',
  });

  for (const card of cards) {
    const node = document.createElement('div');
    node.className = 'diag-card';
    const heading = document.createElement('b');
    heading.textContent = card.title;
    const text = document.createElement('p');
    text.textContent = card.text;
    node.append(heading, text);
    host.append(node);
  }
}

// ---------------------------------------------------------------- 右键菜单

function closeMenu() {
  $('menu').hidden = true;
}

function menuItem(label, onClick, { disabled = false, title } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'menu-item';
  button.textContent = label;
  if (title) button.title = title;
  button.disabled = disabled;
  if (!disabled) {
    button.addEventListener('click', () => {
      closeMenu();
      onClick();
    });
  }
  return button;
}

function separator() {
  const node = document.createElement('div');
  node.className = 'menu-sep';
  return node;
}

function openMenu(clientX, clientY, date) {
  const host = $('menu');
  host.textContent = '';

  const dates = selectedDates();
  const range = isRangeSelection();
  const restTargets = dates.filter((entry) => weekdayOf(entry) !== 0);
  const canSetRest = restTargets.some((entry) => !isRestOn(entry));
  const canUnsetRest = restTargets.some((entry) => isRestOn(entry));
  const skipped = dates.filter((entry) => state.input.skippedDays.includes(entry));
  const goalsOnDate = state.input.miniGoals.filter((goal) => goal.deadline === date).length;

  host.append(menuItem('指定指令…', () => openCommandPicker()));
  host.append(
    menuItem('切换社团…', () => openClubPicker(state.selection.to), {
      disabled: weekdayOf(date) !== 0,
      title: weekdayOf(date) === 0 ? undefined : '社团只能在周日加入、更换或退出',
    }),
  );
  host.append(separator());
  host.append(menuItem('设为休息日', () => setRestDays(dates, true), { disabled: !canSetRest }));
  host.append(menuItem('取消休息日', () => setRestDays(dates, false), { disabled: !canUnsetRest }));
  host.append(
    menuItem(range ? `跳过这 ${dates.length} 天` : '跳过这一天', () => setSkipped(dates, true), {
      disabled: dates.length === 0,
    }),
  );
  host.append(
    menuItem(
      skipped.length > 0 ? `取消跳过（${skipped.length}）` : '取消跳过',
      () => setSkipped(dates, false),
      { disabled: skipped.length === 0 },
    ),
  );
  host.append(separator());
  host.append(
    menuItem('添加小目标…', () => openMiniGoalPopup(date, null), {
      disabled: range,
      title: range ? '小目标挂在具体某一天，请先只选一天' : undefined,
    }),
  );
  host.append(
    menuItem(
      goalsOnDate > 0 ? `管理这一天的小目标（${goalsOnDate}）` : '管理这一天的小目标',
      () => openMiniGoalPopup(date, null),
      { disabled: range || goalsOnDate === 0 },
    ),
  );
  host.append(separator());
  host.append(
    menuItem(`设为已玩到（${state.selection.to}）`, () => setPlayedUpTo(state.selection.to), {
      title: '历史是前缀，取选区的最后一天',
    }),
  );

  host.hidden = false;
  const box = host.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - box.width - 6);
  const top = Math.min(clientY, window.innerHeight - box.height - 6);
  host.style.left = `${Math.max(4, left)}px`;
  host.style.top = `${Math.max(4, top)}px`;
}

// ---------------------------------------------------------------- 指定指令

function currentChoiceOf(dates) {
  const anchor = dates[dates.length - 1];
  const isSunday = weekdayOf(anchor) === 0;
  const value =
    isSunday || isRestOn(anchor)
      ? state.input.dayCommands[anchor]
      : state.input.weekCommands[weekStartOf(anchor)];
  return commandIdToChoice(value);
}

/** 社团切换：只在周日可行，且工具绝不自行选择或切换（原规格故事 23）。 */
function openClubPicker(date) {
  const existing = state.input.clubChanges.find((entry) => entry.date === date);
  const value =
    existing === undefined ? UNSET : existing.clubId === null ? CHOICE_NO_CLUB : existing.clubId;
  const select = selectOf(
    [
      [UNSET, '不切换（沿用之前的社团）'],
      [CHOICE_NO_CLUB, '退出社团'],
      ...CLUBS.map((club) => [club.id, club.name]),
    ],
    value,
  );

  const currentClub = clubAt(date);
  const body = document.createElement('div');
  body.append(field('社团', select));
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = `自 ${date}（周日）起生效，并影响该周日的日指令。当天生效的社团：${
    currentClub ? CLUBS.find((entry) => entry.id === currentClub)?.name ?? currentClub : '未加入'
  }。`;
  body.append(hint);

  openModal({
    title: `切换社团（${date}）`,
    body,
    actions: [
      { label: '取消', onClick: closeModal },
      {
        label: '确定',
        primary: true,
        onClick: () => {
          setClubChange(date, select.value);
          closeModal();
        },
      },
    ],
  });
}

function openCommandPicker() {
  const dates = selectedDates();
  if (dates.length === 0) return;
  const anchor = state.selection.to;
  const entries = [
    [UNSET, '清除指定'],
    [CHOICE_EMPTY, '空过'],
    ...commandsAvailableAt(anchor).map((command) => [command.id, command.name]),
  ];
  const select = selectOf(entries, currentChoiceOf(dates));

  const dayCount = dates.filter((entry) => isRestOn(entry)).length;
  const weekdayDates = dates.filter((entry) => weekdayOf(entry) !== 0);
  const weeks = new Set(weekdayDates.map((entry) => weekStartOf(entry)));
  const spill = Math.max(0, weeks.size * 6 - weekdayDates.length);

  const scope = document.createElement('p');
  scope.className = 'hint';
  scope.textContent =
    dayCount > 0 || weeks.size > 0
      ? `将写入 ${dayCount} 天的日指令、${weeks.size} 周的周指令。周一至周六执行的是整周周指令，所以这些周里最多还有 ${spill} 个未被选中的平日会跟着改。`
      : '没有可写入的日期。';

  const body = document.createElement('div');
  body.append(field('指令', select), scope);

  openModal({
    title: `指定指令（${dates.length} 天）`,
    body,
    actions: [
      { label: '取消', onClick: closeModal },
      {
        label: '确定',
        primary: true,
        onClick: () => {
          setCommands(dates, select.value);
          closeModal();
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- 小目标弹窗

function miniGoalSummary(goal) {
  const attributes = goal.attributes.map((id) => attributeName(id)).join('+');
  return `${attributes} ${opText(goal.op)} ${goal.value}`;
}

export function openMiniGoalPopup(date, editIndex) {
  let editing = editIndex;

  const render = () => {
    const isNew = editing === null;
    const goal = isNew ? draftMiniGoal(date) : state.input.miniGoals[editing];

    const deadline = document.createElement('input');
    deadline.type = 'date';
    deadline.min = TIMELINE.start;
    deadline.max = TIMELINE.lastSettlement;
    deadline.value = goal.deadline;

    const picker = attributePicker(goal.attributes);
    const op = selectOf(OP_ENTRIES, goal.op);
    const value = numberInput(goal.value, { min: 0, max: 9999, step: 1 });

    const body = document.createElement('div');
    body.append(
      field('截止日期', deadline),
      field('属性集合', picker),
      field('方向', op),
      field('阈值', value),
    );
    const sum = document.createElement('p');
    sum.className = 'hint';
    sum.textContent = '阈值作用于所选属性的**求和**；集合里可以包含「社团经验」，指当前所选社团的那一份。';
    body.append(sum);

    const list = document.createElement('div');
    list.className = 'modal-list';
    const heading = document.createElement('h4');
    heading.textContent =
      state.input.miniGoals.filter((entry) => entry.deadline === date).length > 0
        ? `${date} 这一天的小目标`
        : `${date} 这一天还没有小目标`;
    list.append(heading);

    state.input.miniGoals.forEach((entry, index) => {
      if (entry.deadline !== date) return;
      const row = document.createElement('div');
      row.className = 'mini-row';
      const name = document.createElement('span');
      name.textContent = miniGoalSummary(entry);
      if (index === editing) name.textContent += '（正在编辑）';
      const evaluated = state.result?.goals?.miniGoals?.[index];
      const stateCell = document.createElement('span');
      stateCell.className = 'v';
      stateCell.textContent = evaluated ? (evaluated.state === 'met' ? '达标' : '未达标') : '未计算';
      const actions = document.createElement('span');
      actions.className = 'row-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn';
      edit.textContent = '✎';
      edit.title = '编辑';
      edit.addEventListener('click', () => {
        editing = index;
        render();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn';
      remove.textContent = '×';
      remove.title = '删除';
      remove.addEventListener('click', () => {
        removeMiniGoal(index);
        editing = null;
        render();
      });
      actions.append(edit, remove);
      row.append(name, stateCell, actions);
      list.append(row);
    });
    body.append(list);

    openModal({
      title: isNew ? `添加小目标（${date}）` : `编辑小目标（${date}）`,
      body,
      actions: [
        { label: '取消', onClick: closeModal },
        {
          label: isNew ? '添加' : '保存',
          primary: true,
          onClick: () => {
            const attributes = pickedAttributes(picker);
            if (attributes.length === 0) {
              sum.textContent = '至少要选一个属性。';
              return;
            }
            const next = {
              deadline: clampDeadline(deadline.value),
              attributes,
              op: op.value,
              value: Number(value.value),
            };
            if (isNew) addMiniGoal(next);
            else updateMiniGoal(editing, next);
            closeModal();
          },
        },
      ],
    });
  };

  render();
}

// ---------------------------------------------------------------- 目标编辑器

const OP_ENTRIES = [
  ['>=', '≥ 至少达到'],
  ['<', '< 低于（越低越好）'],
];

/** 结局目标与全局约束的形状相同（属性 + 方向 + 阈值），只有标题与说明不同。 */
function openSimpleGoalEditor({ isNew, goal, what, hint, onSave }) {
  const attribute = selectOf(ATTRIBUTES.map((entry) => [entry.id, entry.name]), goal.attribute);
  const op = selectOf(OP_ENTRIES, goal.op);
  const value = numberInput(goal.value, { min: 0, max: 9999 });

  const body = document.createElement('div');
  body.append(field('属性', attribute), field('方向', op), field('阈值', value));
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = hint;
  body.append(note);

  openModal({
    title: `${isNew ? '添加' : '编辑'}${what}`,
    body,
    actions: [
      { label: '取消', onClick: closeModal },
      {
        label: isNew ? '添加' : '保存',
        primary: true,
        onClick: () => {
          onSave({ attribute: attribute.value, op: op.value, value: Number(value.value) });
          closeModal();
        },
      },
    ],
  });
}

function openEndingEditor(index) {
  const isNew = index === null;
  openSimpleGoalEditor({
    isNew,
    goal: isNew ? defaultGoal() : state.input.endingGoals[index],
    what: '结局目标',
    hint: '结局目标在时间轴终点 1998-03-01 逐项评估。',
    onSave: (patch) => (isNew ? addEndingGoal(patch) : updateEndingGoal(index, patch)),
  });
}

function openGlobalEditor(index) {
  const isNew = index === null;
  openSimpleGoalEditor({
    isNew,
    goal: isNew ? defaultGoal() : state.input.globalConstraints[index],
    what: '全局约束',
    hint: '全局约束在每一次每日结算之后判定：起点已满足的就是硬不变量，未满足的尽快满足。',
    onSave: (patch) => (isNew ? addGlobalConstraint(patch) : updateGlobalConstraint(index, patch)),
  });
}

// ---------------------------------------------------------------- 接线

export function wirePanels() {
  $('calendar').addEventListener('contextmenu', (event) => {
    // Shift+右键放行浏览器原生菜单：不能因为做了右键菜单就吞掉"另存为/检查元素"。
    if (event.shiftKey) return;
    const cell = event.target.closest('.cell');
    if (!cell || cell.classList.contains('is-ovf')) return;
    event.preventDefault();
    const date = cell.dataset.date;
    const { from, to } = state.selection;
    if (date < from || date > to) selectDate(date);
    openMenu(event.clientX, event.clientY, date);
  });

  $('btn-more').addEventListener('click', (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    openMenu(box.left, box.bottom + 4, state.selection.to);
  });

  document.addEventListener('mousedown', (event) => {
    if ($('menu').hidden) return;
    // target 不一定是元素（点在滚动条或空白处时是 document），所以先判类型再 closest，
    // 否则这里抛异常、菜单就永远关不上。
    const target = event.target;
    if (target instanceof Element && target.closest('#menu')) return;
    closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('menu').hidden) closeMenu();
    else if (modalIsOpen()) closeModal();
  });

  $('btn-modal-close').addEventListener('click', closeModal);
  $('modal').addEventListener('mousedown', (event) => {
    if (event.target === $('modal')) closeModal();
  });
}
