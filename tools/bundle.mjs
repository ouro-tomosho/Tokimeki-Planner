// 极简零依赖打包器。
//
// 只支持本项目自己使用的两种导入形态：
//   import { a, b } from './x.js';
//   import name from './x.json';
// 以及行首 function/const/let/var/class 的 export 前缀。
//
// 每个模块被包进一个 IIFE，导出收集成命名空间对象，因此各模块的私有名字
// 互不干扰。产物是一段无导入、无导出的普通脚本，可以直接塞进经典 Web Worker。
//
// 两种用法：
//   bundle(entry, { root })
//     单入口，全部依赖内联。
//   bundleShared(entries, { root, isExternal })
//     `isExternal(file)` 为真的依赖**不内联**，改成从共享命名空间（默认全局
//     `__planCore`）里取。这是"worker 与 app 共用同一份核心逻辑、产物里不出现
//     双份"的实现方式：核心由 plan-core 段内联一次，两个入口只引用它。
//
// 已知限制：无法表达循环依赖（会抛错）。需要打破循环时靠注入 hooks 对象，
// 别让两个模块互相 import。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const IMPORT_RE =
  /^[ \t]*import[ \t]+(?:\{([^}]*)\}|([A-Za-z0-9_$]+))[ \t]+from[ \t]+['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm;
// 支持 `export [async] function|const|let|var|class 名字`。
// `async` 是 2026-10-06 为 `suggestSuccessRate`（逐步试算成功率）加的：它是一个
// 需要 await 求解器的导出。打包后是共享作用域里的 `async function`，经典脚本合法。
const SUPPORTED_EXPORT_RE =
  /^[ \t]*export[ \t]+(?:async[ \t]+)?(?:function|const|let|var|class)[ \t]+([A-Za-z0-9_$]+)/gm;

/** 递归收集目录下的 `.js` 模块，按仓库相对路径排序（保证构建确定性）。 */
export function listModules(dir) {
  const found = [];
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** 剥离 import / export 语法，同时收集导出名；遇到不支持的导出形态直接失败。 */
function stripModuleSyntax(source, file) {
  const names = [];
  const withoutImports = source.replace(IMPORT_RE, '');
  const body = withoutImports.replace(SUPPORTED_EXPORT_RE, (match, name) => {
    names.push(name);
    return match.replace(/^[ \t]*export[ \t]+/, '');
  });
  if (/^[ \t]*export[ \t]/m.test(body)) {
    throw new Error(`${file}: 存在未支持的 export 形态，只支持 function/const/let/var/class`);
  }
  if (/^[ \t]*import[ \t]/m.test(body)) {
    throw new Error(
      `${file}: 有解析不了的 import 行。只支持整行 import { … } from '…' 或 import x from '…'（行尾不能带注释）。`,
    );
  }
  return { body, names };
}

function parseImports(source, file) {
  const imports = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const [, named, defaultName, specifier] = match;
    if (!specifier.startsWith('.')) {
      throw new Error(`${file}: 只支持相对导入，收到 ${specifier}`);
    }
    const resolved = path.resolve(path.dirname(file), specifier);
    if (!existsSync(resolved)) {
      throw new Error(
        `${file}: 找不到模块 ${specifier}。` +
          '若这是核心链正在新增/删除的文件（票 07），先让 src/ 与 web/ 的 import 对齐，再构建。',
      );
    }
    if (named !== undefined) {
      if (named.includes(' as ')) {
        throw new Error(`${file}: 不支持 import 别名（${named.trim()}）`);
      }
      const names = named
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 0) throw new Error(`${file}: 空的花括号导入`);
      if (!resolved.endsWith('.js')) throw new Error(`${file}: 具名导入只能来自 .js，收到 ${specifier}`);
      imports.push({ resolved, names });
    } else {
      if (!resolved.endsWith('.json')) {
        throw new Error(`${file}: 默认导入只支持 .json，收到 ${specifier}`);
      }
      imports.push({ resolved, defaultName });
    }
  }
  return imports;
}

/**
 * 从若干入口出发做一次依赖遍历。
 * `isExternal(file)` 命中的文件不遍历、不内联，记进 `external`。
 * `externalExports`（可选）是 Map<绝对路径, Set<导出名>|null>，用来校验跨共享边界的具名导入。
 */
export function collect(entries, { root, isExternal = () => false, externalExports = null } = {}) {
  const moduleSlot = (file) => path.relative(root, file).split(path.sep).join('/');
  const records = new Map();
  const order = [];
  const state = new Map();
  const external = new Set();

  function visit(file) {
    if (isExternal(file)) {
      external.add(file);
      return;
    }
    const seen = state.get(file);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      throw new Error(
        `检测到循环依赖：${moduleSlot(file)}。bundle.mjs 无法表达循环依赖，` +
          '请用注入对象（如 web/ui.js 的 hooks）打破，而不是互相 import。',
      );
    }
    state.set(file, 'visiting');

    if (file.endsWith('.json')) {
      records.set(file, { json: true, value: JSON.parse(readFileSync(file, 'utf8')), imports: [] });
    } else {
      const source = readFileSync(file, 'utf8');
      const imports = parseImports(source, file);
      for (const imp of imports) {
        if (isExternal(imp.resolved)) {
          external.add(imp.resolved);
          if (imp.names && externalExports && externalExports.has(imp.resolved)) {
            const available = externalExports.get(imp.resolved);
            for (const name of imp.names) {
              if (available && !available.has(name)) {
                throw new Error(
                  `${moduleSlot(file)}: 共享核心 ${moduleSlot(imp.resolved)} 里没有导出 ${name}`,
                );
              }
            }
          }
          continue;
        }
        visit(imp.resolved);
      }

      const { body, names } = stripModuleSyntax(source, file);
      const exported = new Set(names);
      for (const imp of imports) {
        if (!imp.names || isExternal(imp.resolved)) continue;
        const target = records.get(imp.resolved);
        for (const name of imp.names) {
          if (!target.exports.has(name)) {
            throw new Error(
              `${moduleSlot(file)}: 从 ${moduleSlot(imp.resolved)} 导入了未导出的 ${name}。` +
                '若 src/ 正在被核心链改造（票 07），两边接口可能暂时对不上。',
            );
          }
        }
      }
      records.set(file, { json: false, body, imports, exports: exported, exportNames: names });
    }

    state.set(file, 'done');
    order.push(file);
  }

  for (const entry of entries) visit(entry);
  return { order, records, moduleSlot, external };
}

/** 把遍历结果拼成一段无导入、无导出的普通脚本。 */
export function emit(graph, { namespace = '__ns', sharedGlobal = '__planCore' } = {}) {
  const { order, records, moduleSlot, external } = graph;
  const parts = [`const ${namespace} = {};`];

  for (const file of order) {
    const record = records.get(file);
    const slot = JSON.stringify(moduleSlot(file));

    if (record.json) {
      parts.push(`${namespace}[${slot}] = ${JSON.stringify(record.value)};`);
      continue;
    }

    const bindings = record.imports.map((imp) => {
      const target = JSON.stringify(moduleSlot(imp.resolved));
      const source = external.has(imp.resolved) ? `${sharedGlobal}[${target}]` : `${namespace}[${target}]`;
      if (imp.defaultName) return `const ${imp.defaultName} = ${source};`;
      return `const { ${imp.names.join(', ')} } = ${source};`;
    });

    parts.push(
      [
        `${namespace}[${slot}] = (() => {`,
        ...bindings,
        record.body.trim(),
        `return { ${record.exportNames.join(', ')} };`,
        '})();',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    );
  }

  return `${parts.join('\n')}\n`;
}

/** 单入口全部内联。 */
export function bundle(entryPath, { root }) {
  return bundleShared([entryPath], { root });
}

/** 多入口，`isExternal` 命中的依赖改为引用共享命名空间。 */
export function bundleShared(entries, options) {
  const { root, isExternal, externalExports = null, namespace = '__ns', sharedGlobal = '__planCore' } =
    options;
  return emit(collect(entries, { root, isExternal, externalExports }), { namespace, sharedGlobal });
}
