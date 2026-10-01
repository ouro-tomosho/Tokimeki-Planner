// 日期表示：全项目统一用 `YYYY-MM-DD` 字符串，字典序即时间序。

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value) {
  return typeof value === 'string' && DATE_PATTERN.test(value);
}
