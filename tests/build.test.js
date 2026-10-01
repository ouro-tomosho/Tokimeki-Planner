// 切片 3：零依赖打包与单文件产物。
//
// 断言的是**产物的性质**：真的是一个文件、不含任何外部引用、领域数据内联其中、
// 内容完整，并且与源码保持一致（磁盘上的产物不允许悄悄过期）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildHtml, assertTemplateCoversAppIds, OUTPUT_URL } from '../tools/build.mjs';

const TEMPLATE = '<div id="one"></div><div id="two"></div>';

test('构建守卫：应用引用了模板里不存在的元素 id 时，构建必须失败', () => {
  const app = "const a = $('one'); $('two'); $('three'); $('four'); $('five');";
  assert.throws(() => assertTemplateCoversAppIds(TEMPLATE, app), /不存在的元素 id：three、four、five/);
});

test('构建守卫：全部引用都存在时放行', () => {
  const app = "const a = $('one'); $('two'); $('one'); $('two'); $('one');";
  assert.doesNotThrow(() => assertTemplateCoversAppIds(TEMPLATE, app));
});

test('构建守卫：解析不到元素引用时自己失败，避免守卫静默失效', () => {
  assert.throws(
    () => assertTemplateCoversAppIds(TEMPLATE, 'const a = 1;'),
    /只从应用代码里解析出 0 个元素引用/,
  );
});

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
  assert.ok(html.includes('cmd-club-basketball'), '指令 id 未内联');
  assert.ok(html.includes('1998-03-01'), '时间轴终点未内联');
  assert.ok(html.includes('社团经验'), '社团经验未内联');
});

test('产物内容完整：没有残留的占位符，内联的 Worker 源非空', () => {
  const html = buildHtml();
  assert.doesNotMatch(html, /__[A-Z][A-Z_]*__/, '存在未替换的占位符');

  const workerBlock = html.match(
    /<script id="worker-source" type="text\/plain">([\s\S]*?)<\/script>/,
  );
  assert.ok(workerBlock, '找不到内联 Worker 源');
  assert.ok(workerBlock[1].trim().length > 0, 'Worker 源为空');
});

test('磁盘上的产物是最新的：等于一次新鲜构建', () => {
  const path = fileURLToPath(OUTPUT_URL);
  assert.ok(existsSync(path), '产物不存在，请先运行 npm run build');
  assert.equal(readFileSync(path, 'utf8'), buildHtml(), '产物已过期，请重新构建');
});
