// 切片 3 的产物冒烟验证。
//
// 这里不启浏览器，而是把产物里内联的 Worker 源抽出来，放进隔离环境真跑一次
// plan 往返——它验证的是"产物里的代码确实可执行且协议通"，不是"界面好看"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildHtml } from '../tools/build.mjs';
import { defaultInput } from '../src/input.js';

const rules = JSON.parse(
  readFileSync(fileURLToPath(new URL('../data/rules.json', import.meta.url)), 'utf8'),
);

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
  const context = vm.createContext({ self: fakeSelf });

  vm.runInContext(workerSource(buildHtml()), context, { filename: 'inline-worker.js' });
  assert.equal(typeof fakeSelf.onmessage, 'function', 'Worker 没有注册 onmessage');

  fakeSelf.onmessage({ data: { id: 7, type: 'plan', input: defaultInput(rules) } });

  assert.equal(replies.length, 1, '一次请求应恰好得到一次回执');
  assert.equal(replies[0].id, 7, '回执必须带回请求 id');
  assert.equal(replies[0].ok, true, `回执失败：${replies[0].error}`);
  assert.equal(replies[0].result.startDate, '1995-04-04');
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

test('内联的应用脚本语法正确，并且确实从内联源创建 Worker', () => {
  const source = appSource(buildHtml());
  assert.doesNotThrow(() => new vm.Script(source), '应用脚本无法解析');
  assert.match(source, /new Worker\(/, '应用没有创建 Worker');
  assert.match(source, /worker-source/, '应用没有读取内联的 Worker 源');
});

test('产物把规则数据内联了两份（Worker 与应用各自独立打包）', () => {
  const html = buildHtml();
  assert.ok(html.split('c-lanqiushe').length - 1 >= 2, '两份打包都应含有规则数据');
});

test('应用脚本查询的每个元素 id 都真实存在于产物里', () => {
  const html = buildHtml();
  const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const queried = new Set([...appSource(html).matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

  assert.ok(queried.size >= 5, `只查到 ${queried.size} 处元素查询，检查是否漏了`);
  for (const id of queried) {
    assert.ok(present.has(id), `应用查询了产物里不存在的 id：${id}`);
  }
});
