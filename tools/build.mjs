// 把纯逻辑源码与数据内联成单个 HTML。零依赖：只用 Node 内置模块。

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundle } from './bundle.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const OUTPUT_URL = new URL('../Tokimeki-Planner.html', import.meta.url);

const WORKER_PLACEHOLDER = '/*__WORKER__*/';
const APP_PLACEHOLDER = '/*__APP__*/';

export function buildHtml() {
  const template = readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  const workerSource = bundle(path.join(ROOT, 'web/worker.js'), { root: ROOT });
  const appSource = bundle(path.join(ROOT, 'web/app.js'), { root: ROOT });

  for (const [label, code] of [
    ['Worker', workerSource],
    ['应用', appSource],
  ]) {
    if (code.includes('</script')) {
      throw new Error(`${label}代码含 "</script"，会截断脚本块`);
    }
  }

  for (const placeholder of [WORKER_PLACEHOLDER, APP_PLACEHOLDER]) {
    const occurrences = template.split(placeholder).length - 1;
    if (occurrences !== 1) {
      throw new Error(`模板里的占位符 ${placeholder} 应恰好出现 1 次，实际 ${occurrences} 次`);
    }
  }

  const html = template
    .replace(WORKER_PLACEHOLDER, () => workerSource)
    .replace(APP_PLACEHOLDER, () => appSource);

  if (/__[A-Z][A-Z_]*__/.test(html)) {
    throw new Error('产物里仍有未替换的占位符');
  }
  return html;
}

export function writeBuild() {
  const html = buildHtml();
  writeFileSync(fileURLToPath(OUTPUT_URL), html, 'utf8');
  return html;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = writeBuild();
  console.log(`已写出 Tokimeki-Planner.html（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB）`);
}
