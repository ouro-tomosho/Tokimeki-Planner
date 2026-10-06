// DOM 原语：只碰 document，不碰领域状态、不 import 任何应用模块。
//
// 从 `web/ui.js` 里拆出来的（票 10）：ui.js 原先同时是"可变状态 + 领域查询 + 日期数学 +
// DOM 原语"的上帝模块。这里只留最后一项，ui.js 只留前三项。
//
// 依赖方向：dom.js ← ui.js ← edits.js ← panels.js ← app.js；dom.js 不 import任何人。

/** 按 id 取元素。全应用只有这一处 `getElementById`。 */
export const $ = (id) => document.getElementById(id);

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

/** `fields` 是 `[{ id, name }]`；调用方传值，dom.js 不 import 领域常量。 */
export function attributePicker(fields, selected) {
  const host = document.createElement('div');
  host.className = 'attr-picker';
  const chosen = new Set(selected);
  for (const field2 of fields) {
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
