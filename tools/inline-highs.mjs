// 构建期工具：把 HiGHS 的 WASM 与胶水层转成**可内联进单个 HTML**的经典脚本。
//
// 为什么需要它：`file://` 下浏览器禁止 `fetch('./highs.wasm')`（CORS/同源策略），所以
// 旁挂 wasm 会让"双击即用"失效。把 wasm 转 base64 内联，就能保住这条交付承诺。
//
// 构建期必须做的改写（少任何一处，产物都会「看起来构建成功、在浏览器里炸」）：
//
//   1. `import.meta.url` → 一个全局常量。胶水层用它定位 `highs.wasm`，但我们要走
//      `instantiateWasm` 自己喂字节，所以这个 URL 只会被读到、不会被 fetch。而
//      **经典 <script> 里出现 `import.meta` 是语法错误**，必须在文本层替换掉。
//   2. ESM 导出 → 全局挂载。经典脚本没有 `export`。
//   3. wasm 字节 → base64 字符串常量，运行时解码后经 `instantiateWasm` 注入。
//
// 这个文件本身是**生成物**（由 npm run build 产出），不进版本库。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';

export const EXACT_MARKER = '/*__EXACT_HIGHS__*/';

/**
 * 生成"内联 HiGHS"的经典脚本文本。
 *
 * @param {string} highsDir node_modules/highs/build 的绝对路径
 * @returns {string} 可直接放进 <script> 的源码（不含 <script> 标签本身）
 */
export function buildInlineHighs(highsDir) {
  const wasm = readFileSync(path.join(highsDir, 'highs.wasm'));
  const glue = readFileSync(path.join(highsDir, 'highs.mjs'), 'utf8');
  const b64 = wasm.toString('base64');

  let source = glue;
  // 1. import.meta.url：经典脚本里是语法错误，先换掉
  const metaHits = (source.match(/import\.meta\.url/g) ?? []).length;
  if (metaHits === 0) {
    throw new Error('胶水层里找不到 import.meta.url——上游产物结构变了，内联改写需要重新核对');
  }
  source = source.replace(/import\.meta\.url/g, 'globalThis.__HIGHS_BASE_URL');
  if (source.includes('import.meta')) {
    throw new Error('替换后仍残留 import.meta（可能有别的用法），不能内联');
  }
  // 2. ESM 导出 → 全局挂载。胶水层是压缩过的，导出语句不一定落在行首，所以不锚定行首。
  source = source.replace(/export\s*\{[^}]*\}\s*;?/g, '');
  source = source.replace(/export\s+default\s+/g, 'globalThis.__highsFactory = ');
  source = source.replace(/(^|[;\s])export\s+(?=(async\s+)?(function|const|let|var|class)\b)/g, '$1');
  // 判据用**真正的经典脚本语法校验**，而不是正则：
  //   - 正则会被 `await import("node:module")` 这类 Node 分支里的动态 import 误伤
  //     （它在浏览器/Worker 里永远不会执行，因为 ENVIRONMENT_IS_NODE 为假）；
  //   - 而 `vm.Script` 直接回答"这段文本能不能当经典脚本 `new Function` 一样跑"，
  //     这才是构建期真正要保证的事。
  try {
    new Script(source, { filename: 'inline-highs.js' });
  } catch (error) {
    throw new Error(`内联改写后不是合法的经典脚本：${error.message}`);
  }
  // 3. 零外链守卫：产物不得含任何 URL（见 tools/build.mjs 的 EXTERNAL_RESOURCE_RE）。
  //    胶水层只在一条错误信息里带了个 CPLEX 格式文档链接，屏蔽掉主机名即可。
  const urlHits = source.match(/https?:\/\//g) ?? [];
  if (urlHits.length > 0) {
    source = source.replace(/https?:\/\//g, '');
    if (/https?:\/\//.test(source)) {
      throw new Error('替换后仍残留 URL，不能通过零外链守卫');
    }
  }

  // 4. 零联网 / 零动态加载守卫（tools/build.mjs 的产物断言：不得出现 `fetch(` 与 `import(`）。
  //    胶水层里这两处都只在"我们没提供 instantiateWasm / 跑在 Node 里"的分支才会执行——
  //    永远不会走到。但"不会执行到"不是保证，"根本没有这段代码"才是。所以把它们换成
  //    直接抛错的桩：一旦将来有人改坏引导脚本，浏览器里会立刻报错，而不是偷偷联网。
  const fetchHits = (source.match(/\bfetch\s*\(/g) ?? []).length;
  source = source.replace(/\bfetch\s*\(/g, 'globalThis.__HIGHS_NO_FETCH(');
  const importHits = (source.match(/\bimport\s*\(/g) ?? []).length;
  source = source.replace(/\bimport\s*\(\s*(["'])node:[^"']*\1\s*\)/g, 'globalThis.__HIGHS_NO_DYNAMIC_IMPORT()');
  if (/\bfetch\s*\(/.test(source) || /\bimport\s*\(/.test(source)) {
    throw new Error('替换后仍残留 fetch( 或 import(，零联网守卫会红');
  }

  void fetchHits;
  void importHits;
  return `// ---- 内联 HiGHS（生成物；由 npm run build 注入，唯一产物 index.html）----
// wasm ${(wasm.length / 1048576).toFixed(2)} MB → base64 ${(b64.length / 1048576).toFixed(2)} MB。
// 不发起任何网络请求：字节在下面这个常量里，解码后经 \`instantiateWasm\` 直接交给 Emscripten。
(function () {
  var __HIGHS_B64 = '${b64}';
  // 走 instantiateWasm 时 locateFile 永远不会被调用，所以这里不需要也不该有真 URL
  //（产物有"零外部资源引用"的构建期守卫，见 tools/build.mjs 的 EXTERNAL_RESOURCE_RE）。
  globalThis.__HIGHS_BASE_URL = '';
  globalThis.__HIGHS_NO_FETCH = function () {
    throw new Error('本产物零外部资源：内联 HiGHS 只能走 instantiateWasm，不联网');
  };
  globalThis.__HIGHS_NO_DYNAMIC_IMPORT = function () {
    throw new Error('本产物零外部资源：不允许运行时动态加载');
  };

  globalThis.__decodeHighsWasm = function () {
    var binary = atob(__HIGHS_B64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  // 胶水层：把 \`instantiateWasm\` 接上"我们自己的字节"，它就不会去找 fetch。
  ${source}

  var __factory = globalThis.__highsFactory;
  var __instancePromise = null;

  /** 取得 HiGHS 实例（同一个页面内只实例化一次，约 3.4 MB 的编译开销只付一次）。 */
  globalThis.createHighs = function () {
    if (!__instancePromise) {
      __instancePromise = Promise.resolve().then(function () {
        return __factory({
          instantiateWasm: function (imports, receiveInstance) {
            WebAssembly.instantiate(globalThis.__decodeHighsWasm(), imports).then(function (result) {
              receiveInstance(result.instance || result);
            });
            return {};
          },
        });
      });
    }
    return __instancePromise;
  };
})();
`;
}
