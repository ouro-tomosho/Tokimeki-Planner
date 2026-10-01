// 内联 Web Worker：主线程只收输入、只渲染结果，规划在后台线程里跑。

import rules from '../data/rules.json';
import { plan } from '../src/plan.js';

self.onmessage = (event) => {
  const message = event.data || {};
  const id = message.id;
  try {
    if (message.type === 'plan') {
      self.postMessage({ id, ok: true, result: plan(message.input, rules) });
      return;
    }
    self.postMessage({ id, ok: false, error: `未知消息类型：${message.type}` });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message });
  }
};
