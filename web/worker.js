// 内联 Web Worker：主线程只收输入、只渲染结果，规划与求解都在后台线程里跑。

import rules from '../data/rules.json';
import { createPlanner } from '../src/plan.js';
import { createSolver } from '../src/solver.js';

const plan = createPlanner(rules);
const solve = createSolver(rules);

self.onmessage = (event) => {
  const message = event.data || {};
  const id = message.id;
  try {
    if (message.type === 'plan') {
      self.postMessage({ id, ok: true, result: plan(message.input, { assignments: message.assignments }) });
      return;
    }
    if (message.type === 'solve') {
      // 求解很慢，先把中间结论交出去也没意义——一次性把日程交回，由主线程再规划一次。
      const assignments = solve(message.input);
      self.postMessage({ id, ok: true, assignments });
      return;
    }
    self.postMessage({ id, ok: false, error: `未知消息类型：${message.type}` });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message });
  }
};
