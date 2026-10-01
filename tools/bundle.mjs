// 极简零依赖打包器。
//
// 只支持本项目自己使用的两种导入形态：
//   import { a, b } from './x.js';
//   import name from './x.json';
// 以及行首 function/const/let/var/class 的 export 前缀。
//
// 每个模块被包进一个 IIFE，导出收集成命名空间对象，因此各模块的私有名字
// 互不干扰。产物是一段无导入、无导出的普通脚本，可以直接塞进经典 Web Worker。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const IMPORT_RE =
  /^[ \t]*import[ \t]+(?:\{([^}]*)\}|([A-Za-z0-9_$]+))[ \t]+from[ \t]+['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm;
const SUPPORTED_EXPORT_RE =
  /^[ \t]*export[ \t]+(?:function|const|let|var|class)[ \t]+([A-Za-z0-9_$]+)/gm;

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
      throw new Error(`${file}: 找不到模块 ${specifier}`);
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

export function bundle(entryPath, { root }) {
  const moduleSlot = (file) => path.relative(root, file).split(path.sep).join('/');
  const records = new Map();
  const order = [];
  const state = new Map();

  function visit(file) {
    const seen = state.get(file);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`检测到循环依赖：${file}`);
    state.set(file, 'visiting');

    if (file.endsWith('.json')) {
      records.set(file, { json: true, value: JSON.parse(readFileSync(file, 'utf8')), imports: [] });
    } else {
      const source = readFileSync(file, 'utf8');
      const imports = parseImports(source, file);
      for (const imp of imports) visit(imp.resolved);

      const { body, names } = stripModuleSyntax(source, file);
      const exported = new Set(names);
      for (const imp of imports) {
        if (!imp.names) continue;
        const target = records.get(imp.resolved);
        for (const name of imp.names) {
          if (!target.exports.has(name)) {
            throw new Error(
              `${moduleSlot(file)}: 从 ${moduleSlot(imp.resolved)} 导入了未导出的 ${name}`,
            );
          }
        }
      }
      records.set(file, { json: false, body, imports, exports: exported, exportNames: names });
    }

    state.set(file, 'done');
    order.push(file);
  }

  visit(entryPath);
  return emit(order, records, moduleSlot);
}

function emit(order, records, moduleSlot) {
  const parts = ['const __ns = {};'];

  for (const file of order) {
    const record = records.get(file);
    const slot = JSON.stringify(moduleSlot(file));

    if (record.json) {
      parts.push(`__ns[${slot}] = ${JSON.stringify(record.value)};`);
      continue;
    }

    const bindings = record.imports.map((imp) => {
      const targetSlot = JSON.stringify(moduleSlot(imp.resolved));
      if (imp.defaultName) return `const ${imp.defaultName} = __ns[${targetSlot}];`;
      return `const { ${imp.names.join(', ')} } = __ns[${targetSlot}];`;
    });

    parts.push(
      [
        `__ns[${slot}] = (() => {`,
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
