// 切片 3 的产物冒烟验证。
//
// 这里不启浏览器，而是把产物里内联的代码抽出来**真的执行一次**：
// Worker 源放进隔离环境跑一次 plan 往返，应用脚本交给解析器。
// 它验证的是"产物里的代码可执行且协议通"，不是"界面好看"——真实 DOM 渲染
// 没有被覆盖，那需要浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { buildHtml } from '../tools/build.mjs';
import { defaultInput } from '../src/input.js';
import { loadRules } from './support/rules.js';

const rules = loadRules();

function scriptBlocks(html) {
  const blocks = [];
  const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    blocks.push({ attrs: match[1], source: match[2] });
  }
  return blocks;
}

function workerSource(html) {
  const block = scriptBlocks(html).find((b) => b.attrs.includes('worker-source'));
  assert.ok(block, '产物里找不到内联 Worker 源');
  return block.source;
}

function appSource(html) {
  const block = scriptBlocks(html).find((b) => !b.attrs.includes('worker-source'));
  assert.ok(block, '产物里找不到应用脚本');
  return block.source;
}

test('内联的 Worker 源可执行，并完成一次 plan 往返', () => {
  const replies = [];
  const fakeSelf = {
    onmessage: null,
    postMessage: (message) => replies.push(message),
  };
  vm.runInContext(workerSource(buildHtml()), vm.createContext({ self: fakeSelf }), {
    filename: 'inline-worker.js',
  });
  assert.equal(typeof fakeSelf.onmessage, 'function', 'Worker 没有注册 onmessage');

  fakeSelf.onmessage({ data: { id: 7, type: 'plan', input: defaultInput(rules) } });

  assert.equal(replies.length, 1, '一次请求应恰好得到一次回执');
  assert.equal(replies[0].id, 7, '回执必须带回请求 id');
  assert.equal(replies[0].ok, true, `回执失败：${replies[0].error}`);
  assert.equal(replies[0].result.playedUpTo, '1995-04-04');
  assert.equal(replies[0].result.endDate, '1998-03-01');
  assert.equal(replies[0].result.ruleSummary.commands, 18);
});

test('Worker 对未知消息类型返回错误回执，而不是静默丢弃', () => {
  const replies = [];
  const fakeSelf = { onmessage: null, postMessage: (message) => replies.push(message) };
  vm.runInContext(workerSource(buildHtml()), vm.createContext({ self: fakeSelf }));

  fakeSelf.onmessage({ data: { id: 3, type: '没听说过' } });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.match(replies[0].error, /未知消息类型/);
});

test('内联的应用脚本可以被解析', () => {
  assert.doesNotThrow(() => new vm.Script(appSource(buildHtml())), '应用脚本无法解析');
});

// 规格的「可核查的视觉验收」把这两条定为可机械断言的项：只做亮色，且不引外链。
test('产物是纯亮色：没有 color-scheme 声明，也不含任何外链资源', () => {
  const html = buildHtml();

  assert.ok(!/color-scheme\s*:/.test(html), '产物里仍有 color-scheme 声明');
  assert.ok(!/prefers-color-scheme/.test(html), '产物里仍有暗色模式分支');

  const external = html.match(/https?:\/\/|<link\b|<img\b|@import|url\(/g) ?? [];
  assert.deepEqual(external, [], `产物里有外链资源：${external.join('、')}`);
});
