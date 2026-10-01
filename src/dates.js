// 日期表示：全项目统一用 `YYYY-MM-DD` 字符串，字典序即时间序。
//
// 除了形状，还要校验真实日历——`1995-13-45` 形状合法但不是日期。

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** 星期序号：0 = 周日，6 = 周六。 */
export function weekdayOf(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 加减天数，返回同样格式的日期字符串。 */
export function addDays(value, count) {
  const [year, month, day] = value.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + count * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** 所在自然周的周日（周锚点）。 */
export function weekStartOf(value) {
  return addDays(value, -weekdayOf(value));
}
