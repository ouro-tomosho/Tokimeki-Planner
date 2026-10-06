// 输入本地保存。
//
// 只存**输入**，不存结果：刷新之后回到「尚未计算」，由使用者自己点「计算」。
// 求解是确定性的（同一输入两次结果完全相同），所以重算就能复原，不必把结果落盘。
//
// 键名带输入版本号：版本一变，旧键自然读不到，等于"版本不匹配即丢弃重来"。
// 浏览器禁止 localStorage 时（隐私模式，或某些浏览器打开 file:// 单文件）静默降级为不保存，
// 应用照常工作——保存是便利，不是依赖。

import { CURRENT_VERSION, fromJson, toJson } from '../src/input.js';

const KEY = `tokimeki-planner/input/v${CURRENT_VERSION}`;

/** 能读写就返回它，否则 null。探测一次，避免每个调用点各写一份 try/catch。 */
function usableStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = `${KEY}/probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/** 读回上次的输入；没有、读坏、或版本不对都返回 null。 */
export function loadInput(rules) {
  const storage = usableStorage();
  if (!storage) return null;

  let text = null;
  try {
    text = storage.getItem(KEY);
  } catch {
    return null;
  }
  if (text === null) return null;

  try {
    return fromJson(text, rules);
  } catch {
    // 存坏了的输入不该让应用起不来：丢掉它，回到出厂默认。
    try {
      storage.removeItem(KEY);
    } catch {
      /* 删不掉也就算了 */
    }
    return null;
  }
}

export function saveInput(input) {
  const storage = usableStorage();
  if (!storage) return;
  try {
    storage.setItem(KEY, toJson(input));
  } catch {
    /* 配额满等情况：不保存，也不打扰使用者 */
  }
}
