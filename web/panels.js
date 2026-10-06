// 检查点表、右键菜单与检查点编辑器。
//
// 三类目标（全局约束 / 小目标 / 结局目标）统一成**一张检查点表**：每行 = 一个检查点，
// 既是"达没达到"，也是改它的入口。区别只在 `source`：
//   global  落点是**每个结算日**（每日检查），用的是当天结算后的数值；语义是「先达成者先硬化」——
//           没到过阈值时只是欠着（`state: 'unmet'`），到过之后再跌破就是「已破线」（`state: 'violated'`）；
//   mini    落点是各自的截止日，评估属性集合的**求和**；
//   ending  落点是时间轴终点，**不可删除**（它覆盖除社团经验以外的每一项属性）。
//
// 表头下面并排显示**两个独立结论**（所有者要求分开报告，不得合并）：
//   目标 = 参与判定的检查点是否全部达标（`goals.ok`）；
//   日程 = 硬约束是否全部满足（`goals.valid`）。

import { weekdayOf, weekStartOf } from '../src/dates.js';
import {
  ATTRIBUTES,
  CHOICE_EMPTY,
  CHOICE_NO_CLUB,
  CHECKPOINT_SOURCE_LABELS,
  CLUBS,
  RULES,
  TIMELINE,
  UNSET,
  attributeName,
  checkpointAttributeIds,
  checkpointAttributesText,
  checkpointLandingText,
  clubAt,
  commandsAvailableAt,
  defaultCheckpoint,
  evaluationOf,
  fmt1,
  goalItems,
  isRestOn,
  isStale,
  isRangeSelection,
  opText,
  selectedDates,
  state,
} from './ui.js';
import {
  $,
  attributePicker,
  closeModal,
  field,
  modalIsOpen,
  numberInput,
  openModal,
  pickedAttributes,
  selectOf,
} from './dom.js';
import {
  addCheckpoint,
  commandIdToChoice,
  removeCheckpoint,
  setClubChange,
  setCommands,
  setPlayedUpTo,
  setSkipped,
  updateCheckpoint,
} from './edits.js';
import { jumpToDate, selectDate } from './calendar.js';

const OP_ENTRIES = [
  ['>=', '≥ 至少达到'],
  ['<', '< 低于（越低越好）'],
];

const SOURCE_ENTRIES = [
  ['global', '全局约束（每个结算日）'],
  ['mini', '小目标（某个日期）'],
  ['ending', '结局目标（终点）'],
];

// ---------------------------------------------------------------- 检查点表

/** 全局约束行的说明：只有数据（落点数、未达标数、首次达成、跌破次数）。 */
function globalTooltip(evaluation) {
  if (!evaluation) return '尚未计算';
  const parts = [`落点 ${evaluation.landings} 个`, `未达标 ${evaluation.unmetLandings} 个`];
  if (evaluation.achieved) {
    parts.push(`首次达成 ${evaluation.firstAchievedDate}，此后跌破 ${evaluation.hardViolations} 次`);
  } else {
    parts.push('尚未达成过');
  }
  return parts.join('；');
}

/** 状态格的悬停说明：只报数据，不解释怎么读。 */
function stateTitle(evaluation) {
  if (evaluation.state === 'violated') {
    return `达成后跌破 ${evaluation.hardViolations} 次（首次达成 ${evaluation.firstAchievedDate}）`;
  }
  if (evaluation.state === 'unmet') return '尚未达成';
  return evaluation.firstAchievedDate ? `达成于 ${evaluation.firstAchievedDate}` : '达标';
}

function checkpointRow(checkpoint, index) {
  const evaluation = evaluationOf(checkpoint.id);
  // 三态：met 达标 / unmet 还欠着（还没到过）/ violated 已破线（到过之后又跌破，一次即永久）。
  const goalState = evaluation ? evaluation.state : null;

  const row = document.createElement('div');
  row.className = `goal-row ${goalState ?? ''}`.trim();

  // 第 1 列：落点 + 属性（CSS 给了 6 列，落点与属性合并成一列显示）。
  // 例外：结局目标的落点是固定不变的（时间轴终点），显示它没有信息量，所以只写属性名。
  const nameCell = document.createElement('span');
  nameCell.className = 'name';
  const isEnding = checkpoint.source === 'ending';
  nameCell.textContent = isEnding
    ? checkpointAttributesText(checkpoint)
    : `${checkpointLandingText(checkpoint)} · ${checkpointAttributesText(checkpoint)}`;
  // 说明文字按来源分三种：全局约束没有落点日期（`date` 恒为 null），结局目标的落点固定、
  // 写出来没有信息量，所以两者都不拼日期——只有小目标写「在 <日期> 结算后评估」。
  nameCell.title = isEnding
    ? '毕业时的目标'
    : checkpoint.source === 'global'
      ? globalTooltip(evaluation)
      : `在 ${checkpoint.date} 结算后评估`;

  const thresholdCell = document.createElement('span');
  thresholdCell.className = 'v';
  thresholdCell.textContent = `${opText(checkpoint.op)} ${checkpoint.value}`;

  const actualCell = document.createElement('span');
  actualCell.className = 'v';
  actualCell.textContent = evaluation ? fmt1(evaluation.actual) : '—';

  const gapCell = document.createElement('span');
  gapCell.className = 'gap';
  if (goalState === 'unmet') gapCell.textContent = `还差 ${fmt1(evaluation.shortfall)}`;
  else if (goalState === 'violated') gapCell.textContent = `破线 ${fmt1(evaluation.shortfall)}`;
  else gapCell.textContent = '—';

  const stateCell = document.createElement('span');
  stateCell.className = 'state';
  if (goalState !== null) {
    const dot = document.createElement('i');
    dot.className = `dot ${goalState}`;
    stateCell.append(dot);
    const text = document.createElement('span');
    text.textContent = goalState === 'met' ? '达标' : goalState === 'violated' ? '已破线' : '未达标';
    stateCell.append(text);
    stateCell.title = stateTitle(evaluation);
  } else {
    stateCell.textContent = '未计算';
  }

  const actionCell = document.createElement('span');
  actionCell.className = 'row-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn';
  edit.textContent = '✎';
  edit.title = '编辑';
  edit.addEventListener('click', () => openCheckpointEditor(index));
  actionCell.append(edit);

  // 结局行不可删：它是最后一个检查点，覆盖除社团经验以外的每一项属性。
  if (checkpoint.source !== 'ending') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = '×';
    remove.title = '删除';
    remove.addEventListener('click', () => removeCheckpoint(index));
    actionCell.append(remove);
  }

  row.append(nameCell, thresholdCell, actualCell, gapCell, stateCell, actionCell);
  return row;
}

function columnsRow(source) {
  const row = document.createElement('div');
  row.className = 'goal-cols';
  const first = source === 'ending' ? '属性' : '落点 · 属性';
  for (const label of [first, '阈值', '当前值', '差距', '状态', '']) {
    const span = document.createElement('span');
    span.textContent = label;
    row.append(span);
  }
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

/** 检查点区域的三段分组（所有者要求保留这个划分）。 */
const GOAL_GROUPS = [
  { source: 'ending', title: '结局目标', order: 'attribute' },
  { source: 'mini', title: '小目标', order: 'date' },
  { source: 'global', title: '全局约束', order: 'attribute' },
];

/**
 * 属性在数据里的默认顺序（体力 → … → 压力，社团经验在最后）；结局目标与全局约束用它排列。
 *
 * ⚠️ 这是**加载时的快照**，顺序就是 `data/rules.json` 里 `attributes` 的书写次序。
 * 界面不得提供"重排属性"的功能——那会让这里静默过期（排序会一直用旧顺序）。
 * 要改顺序就改数据文件。
 */
const ATTRIBUTE_ORDER = new Map(RULES.attributes.map((attribute, index) => [attribute.id, index]));

/** 排序键：属性组取"集合里最早出现的那个属性"的下标；未知属性排到最后。 */
function orderValue(checkpoint, order) {
  if (order === 'date') return checkpoint.date ?? '';
  const ranks = checkpointAttributeIds(checkpoint)
    .map((id) => ATTRIBUTE_ORDER.get(id))
    .filter((rank) => rank !== undefined);
  return ranks.length > 0 ? Math.min(...ranks) : ATTRIBUTE_ORDER.size;
}

export function renderGoals() {
  const host = $('goals');
  host.textContent = '';
  host.classList.toggle('stale', isStale());

  const items = goalItems();
  const head = document.createElement('div');
  head.className = 'goals-head';
  const title = document.createElement('span');
  title.textContent = '检查点';
  const count = document.createElement('span');
  count.className = 'count';
  if (items.length > 0) {
    // 计数只看**数据里声明的检查点**，避免把"未设目标"的兜底条目算进达标率。
    const declared = state.input.checkpoints.map((checkpoint) => evaluationOf(checkpoint.id));
    const metOf = (source) =>
      declared.filter((evaluation) => evaluation?.source === source && evaluation.state === 'met').length;
    const violatedOf = (source) =>
      declared.filter((evaluation) => evaluation?.source === source && evaluation.state === 'violated').length;
    const totalOf = (source) =>
      state.input.checkpoints.filter((checkpoint) => checkpoint.source === source).length;
    // 只保留玩家看得懂的分项：结局目标 / 小目标 / 全局约束，外加一个总达标率。
    // "未设目标"的兜底条目不进这里的任何计数——它不是玩家设的目标（见 GLOSSARY：未设目标）。
    count.textContent = `达标 ${declared.filter((evaluation) => evaluation?.state === 'met').length}/${
      declared.length
    } · 结局目标 ${metOf('ending')}/${totalOf('ending')} · 小目标 ${metOf('mini')}/${totalOf(
      'mini',
    )} · 全局约束 ${metOf('global')}/${totalOf('global')}${
      violatedOf('global') > 0 ? `（${violatedOf('global')} 条已破线）` : ''
    }`;
  } else {
    count.textContent = '尚未计算——下面的状态列显示「未计算」';
  }
  head.append(title, count);
  host.append(head);

  const indexed = state.input.checkpoints.map((checkpoint, index) => ({ checkpoint, index }));
  for (const { source, title: groupTitle, order } of GOAL_GROUPS) {
    const rows = indexed
      .filter(({ checkpoint }) => checkpoint.source === source)
      // 先算一次排序键，再排；并列时用数据里的原始下标，保证顺序稳定、重绘不跳动。
      .map((row) => ({ ...row, sortKey: orderValue(row.checkpoint, order) }))
      .sort((a, b) => (a.sortKey === b.sortKey ? a.index - b.index : a.sortKey < b.sortKey ? -1 : 1));
    const group = document.createElement('div');
    group.className = 'goal-group';
    // 结局目标是**固定九项属性**（每个属性一条，社团经验不在其中），所以不给「加一条」——
    // 加了也只会出现重复属性。要改阈值直接改行里的数值。
    group.append(
      groupHeader(
        groupTitle,
        `${rows.length} 条`,
        source === 'ending'
          ? null
          : () => openCheckpointEditor(null, { source, date: state.selection.to }),
      ),
    );
    group.append(columnsRow(source));
    for (const { checkpoint, index } of rows) group.append(checkpointRow(checkpoint, index));
    host.append(group);
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
  const skipped = dates.filter((entry) => state.input.skippedDays.includes(entry));
  const checkpointsOnDate = state.input.checkpoints.filter((checkpoint) => checkpoint.date === date).length;

  host.append(menuItem('指定指令…', () => openCommandPicker()));
  host.append(
    menuItem('切换社团…', () => openClubPicker(state.selection.to), {
      disabled: weekdayOf(date) !== 0,
      title: weekdayOf(date) === 0 ? undefined : '社团只能在周日加入、更换或退出',
    }),
  );
  host.append(separator());
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
    menuItem('添加检查点…', () => openCheckpointEditor(null, { date }), {
      disabled: range,
      title: range ? '检查点挂在具体某一天（全局约束除外），请先只选一天' : undefined,
    }),
  );
  host.append(
    menuItem(
      checkpointsOnDate > 0 ? `管理这一天的检查点（${checkpointsOnDate}）` : '管理这一天的检查点',
      () => openCheckpointList(date),
      { disabled: range || checkpointsOnDate === 0 },
    ),
  );
  host.append(separator());
  host.append(
    menuItem(`设为已玩到（${state.selection.to}）`, () => setPlayedUpTo(state.selection.to), {
      title: '它同时是时间轴的起点；取选区的最后一天',
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

// ---------------------------------------------------------------- 检查点弹窗

/**
 * 一条检查点的编辑器。
 *
 * `index === null` 是新行：可以选来源（全局 / 小目标 / 结局），落点与属性控件随来源变。
 * 编辑已有行时来源不可改（改来源会连带改落点语义，容易把输入改得不合法）。
 */
export function openCheckpointEditor(index, options = {}) {
  const isNew = index === null;
  let source = isNew ? options.source ?? 'mini' : state.input.checkpoints[index].source;
  // 结局目标是固定九项属性（每项一条，社团经验不在其中），没有"再加一条"的语义：
  // 加了只会产出重复属性。渲染层已经不画「加一条」，这里再挡一次——
  // 否则将来接上别的入口（右键菜单等）就能造出重复项。
  if (isNew && source === 'ending') return;
  // 新行的默认日期：右键那天 / 当前选区 / 时间轴最后结算日。
  let draft = isNew
    ? defaultCheckpoint(source, options.date ?? state.selection.to ?? TIMELINE.lastSettlement)
    : { ...state.input.checkpoints[index] };

  const render = () => {
    const body = document.createElement('div');

    const sourceSelect = isNew
      ? selectOf(SOURCE_ENTRIES, source)
      : null;
    if (sourceSelect) {
      sourceSelect.addEventListener('change', () => {
        source = sourceSelect.value;
        draft = defaultCheckpoint(source, options.date ?? state.selection.to ?? TIMELINE.lastSettlement);
        render();
      });
      body.append(field('来源', sourceSelect));
    } else {
      const fixed = document.createElement('p');
      fixed.className = 'hint';
      fixed.textContent = `来源：${CHECKPOINT_SOURCE_LABELS[source]}（不可更改）`;
      body.append(fixed);
    }

    // 落点
    if (source === 'global') {
      const text = document.createElement('p');
      text.className = 'hint';
      text.textContent = '落点：每个结算日都查一次，用的是当天的数值。';
      body.append(text);
    } else if (source === 'ending') {
      const text = document.createElement('p');
      text.className = 'hint';
      text.textContent = `落点：${TIMELINE.end}（时间轴终点，固定）`;
      body.append(text);
    } else {
      const date = document.createElement('input');
      date.type = 'date';
      date.min = TIMELINE.start;
      date.max = TIMELINE.lastSettlement;
      date.value = draft.date;
      date.addEventListener('change', () => {
        draft = { ...draft, date: date.value };
      });
      body.append(field('截止日期', date));
    }

    // 属性：全局/结局是单属性；小目标可以多选（阈值作用于求和）。
    let picker = null;
    let attributeSelect = null;
    if (source === 'mini') {
      picker = attributePicker(ATTRIBUTES, checkpointAttributeIds(draft));
      body.append(field('属性集合（求和）', picker));
    } else {
      attributeSelect = selectOf(ATTRIBUTES.map((entry) => [entry.id, entry.name]), draft.attribute);
      body.append(field('属性', attributeSelect));
    }

    const op = selectOf(OP_ENTRIES, draft.op);
    const value = numberInput(draft.value, { min: 0, max: 9999, step: 1 });
    body.append(field('方向', op), field('阈值', value));

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      source === 'global'
        ? '每个结算日都查一次：还没到过阈值时只是欠着；一旦到过，以后任何时候跌破都算「已破线」，这份日程就不合格了。'
        : source === 'mini'
          ? '阈值作用于所选属性的求和；集合里可以只选「社团经验」。'
          : '结局目标在时间轴终点逐项评估，不可删除。';
    body.append(hint);

    openModal({
      title: isNew ? `添加${CHECKPOINT_SOURCE_LABELS[source]}` : `编辑${CHECKPOINT_SOURCE_LABELS[source]}`,
      body,
      actions: [
        { label: '取消', onClick: closeModal },
        {
          label: isNew ? '添加' : '保存',
          primary: true,
          onClick: () => {
            const patch = {
              op: op.value,
              value: Number(value.value),
            };
            if (source === 'mini') {
              const attributes = pickedAttributes(picker);
              if (attributes.length === 0) {
                hint.textContent = '至少要选一个属性。';
                return;
              }
              patch.attributes = attributes;
              delete patch.attribute;
            } else {
              patch.attribute = attributeSelect.value;
              delete patch.attributes;
            }
            if (source === 'mini') patch.date = draft.date;
            if (isNew) addCheckpoint({ ...draft, ...patch, source });
            else updateCheckpoint(index, patch);
            closeModal();
          },
        },
      ],
    });
  };

  render();
}

/** 这一天落地的检查点（只列具体日期的：全局约束是"每个结算日"，不是某一天专属）。 */
function openCheckpointList(date) {
  const body = document.createElement('div');
  const list = document.createElement('div');
  list.className = 'modal-list';
  const heading = document.createElement('h4');
  heading.textContent = `${date} 的检查点`;
  list.append(heading);

  const rows = state.input.checkpoints
    .map((checkpoint, index) => ({ checkpoint, index }))
    .filter(({ checkpoint }) => checkpoint.date === date);

  for (const { checkpoint, index } of rows) {
    const row = document.createElement('div');
    row.className = 'mini-row';
    const name = document.createElement('span');
    name.textContent = `${checkpointAttributesText(checkpoint)} ${opText(checkpoint.op)} ${checkpoint.value}`;
    const evaluation = evaluationOf(checkpoint.id);
    const stateCell = document.createElement('span');
    stateCell.className = 'v';
    stateCell.textContent = evaluation
      ? evaluation.state === 'met'
        ? '达标'
        : evaluation.state === 'violated'
          ? '已破线'
          : '未达标'
      : '未计算';
    const actions = document.createElement('span');
    actions.className = 'row-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn';
    edit.textContent = '✎';
    edit.title = '编辑';
    edit.addEventListener('click', () => {
      closeModal();
      openCheckpointEditor(index);
    });
    actions.append(edit);
    if (checkpoint.source !== 'ending') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn';
      remove.textContent = '×';
      remove.title = '删除';
      remove.addEventListener('click', () => {
        removeCheckpoint(index);
        closeModal();
      });
      actions.append(remove);
    }
    row.append(name, stateCell, actions);
    list.append(row);
  }

  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'btn';
  jump.textContent = '跳到这一天';
  jump.addEventListener('click', () => {
    closeModal();
    jumpToDate(date);
  });
  body.append(list, jump);

  openModal({
    title: `${date} 的检查点`,
    body,
    actions: [
      { label: '关闭', onClick: closeModal },
      {
        label: '添加',
        primary: true,
        onClick: () => {
          closeModal();
          openCheckpointEditor(null, { date });
        },
      },
    ],
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
