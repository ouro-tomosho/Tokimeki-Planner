// 切片 3：零依赖打包与单文件产物。
//
// 产物必须真的是"一个文件、双击即用"：不含任何外部引用，领域数据内联其中，
// 并且与源码保持一致（磁盘上的产物不允许悄悄过期）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildHtml, OUTPUT_URL } from '../tools/build.mjs';

test('构建是确定性的：两次构建字节完全相同', () => {
  assert.equal(buildHtml(), buildHtml());
});

test('产物是单个 HTML，且不含任何外部引用', () => {
  const html = buildHtml();
  assert.match(html, /^<!doctype html>/i);
  assert.doesNotMatch(html, /<script[^>]+\bsrc=/i, '不得引入外部脚本');
  assert.doesNotMatch(html, /<link[^>]+\brel=["']?stylesheet/i, '不得引入外部样式');
  assert.doesNotMatch(html, /\bhttps?:\/\//, '不得包含任何外部地址');
  assert.doesNotMatch(html, /\bfetch\s*\(/, '不得联网');
  assert.doesNotMatch(html, /\bimport\s*\(/, '不得在运行时动态加载');
});

test('领域数据被内联进产物', () => {
  const html = buildHtml();
  assert.ok(html.includes('研读文科'), '指令名未内联');
  assert.ok(html.includes('c-lanqiushe'), '指令 id 未内联');
  assert.ok(html.includes('1998-03-01'), '时间轴终点未内联');
  assert.ok(html.includes('社团经验'), '社团经验未内联');
});

test('产物内没有残留的构建占位符，也没有会截断脚本块的字符序列', () => {
  const html = buildHtml();
  assert.doesNotMatch(html, /__[A-Z][A-Z_]*__/, '存在未替换的占位符');

  const workerBlock = html.match(
    /<script id="worker-source" type="text\/plain">([\s\S]*?)<\/script>/,
  );
  assert.ok(workerBlock, '找不到内联 Worker 源');
  assert.ok(workerBlock[1].trim().length > 0, 'Worker 源为空');
});

test('内置 Worker 通过 HTML 脚本块承载，且脚本块内不含结束标签', () => {
  const html = buildHtml();
  const blocks = html.match(/<script id="worker-source" type="text\/plain">([\s\S]*?)<\/script>/g);
  assert.equal(blocks.length, 1, '必须恰好有一个 Worker 源块');
  assert.equal(html.split('</script>').length - 1, 2, '本产物应恰好有两个脚本块（Worker 源 + 应用）');
});

test('磁盘上的产物是最新的：等于一次新鲜构建', () => {
  const path = fileURLToPath(OUTPUT_URL);
  assert.ok(existsSync(path), '产物不存在，请先运行 npm run build');
  assert.equal(readFileSync(path, 'utf8'), buildHtml(), '产物已过期，请重新构建');
});
