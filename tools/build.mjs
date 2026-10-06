// 构建管道（ADR-0006）：两段式，零依赖，只用 Node 内置模块。
//
//   ① src/ 全部模块 + data/rules.json  → plan-core.js   中间产物：Node 可直接 import
//   ② plan-core.js + web/template.html  → index.html      最终产物：双击即用
//
// 两个生成物的开头都有"本文件由 npm run build 生成，禁止手改"声明。
//
// 关键设计：核心逻辑在产物里**只内联一份**。旧管道把 web/worker.js 与 web/app.js
// 当两个独立入口分别打包，于是 data/rules.json 与全部 src/ 逻辑各出现两遍（约 50 KB
// 纯冗余）。现在：
//   · plan-core.js（经典脚本形态）内联成页面里的 #plan-core，主线程直接执行；
//   · worker 与 app 这两个入口里对 src/ 与 rules.json 的 import 被改写为
//     从全局 __planCore 取（见 bundle.mjs 的 isExternal）；
//   · 一小段引导脚本（模板里的 BOOTSTRAP 占位符）把同一份核心文本前置给 Worker 源，
//     再把 #plan-core 元素移出 DOM，所以磁盘与运行时都只有一份。
//
// 构建期守卫失败必须让构建变红，不允许"悄悄产出过期/错误产物"。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listModules, collect, emit, bundleShared } from './bundle.mjs';
import { buildInlineHighs, EXACT_MARKER } from './inline-highs.mjs';
import { checkRulesDoc } from './rules-doc.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = path.join(ROOT, 'src');
const RULES_FILE = path.join(ROOT, 'data', 'rules.json');
const TEMPLATE_FILE = path.join(ROOT, 'web', 'template.html');
const WORKER_FILE = path.join(ROOT, 'web', 'worker.js');
const APP_FILE = path.join(ROOT, 'web', 'app.js');
const HIGHS_DIR = path.join(ROOT, 'node_modules', 'highs', 'build');

// 产物落在仓库根目录：index.html 是 GitHub Pages 的站点入口，必须用这个文件名。
export const OUTPUT_URL = new URL('../index.html', import.meta.url);
/** 精确版产物（内联 HiGHS，约 5 MB）。默认版不受影响，见 ADR-0008。 */
export const PLAN_CORE_URL = new URL('../plan-core.js', import.meta.url);

const CORE_GLOBAL = '__planCore'; // 全局共享命名空间（主线程与 Worker 都看得到）
const CORE_NS = '__planCoreNs'; // 核心段内部的模块命名空间

const GENERATED_HEADER =
  '// 本文件由 `npm run build` 生成，禁止手改。开发源在 src/ 与 data/，改动请改源再构建。';
const HTML_HEADER =
  '<!-- 本文件由 `npm run build` 生成，禁止手改。开发源在 web/template.html、src/ 与 data/。 -->';

// plan-core.js 里 Node 导出段的起止标记。内联进 HTML 时，这一段被替换成
// `self.__planCore = …`，因为经典 <script> 里不能有 export。
const ESM_MARKER = '// --- Node 加载入口（ESM）：内联进 HTML 时整段替换为全局挂载 ---';
const ESM_END = '// --- ESM 导出段结束 ---';
const CLASSIC_TAIL = `self.${CORE_GLOBAL} = ${CORE_NS};`;

const PLACEHOLDERS = {
  core: '/*__CORE__*/',
  worker: '/*__WORKER__*/',
  bootstrap: '/*__BOOTSTRAP__*/',
  app: '/*__APP__*/',
  // 唯一产物：内联 HiGHS（ADR-0008 已改判为单产物，见 buildHtml）。
  exactHighs: '/*__EXACT_HIGHS__*/',
};

// 引导脚本：见文件顶部说明。它由构建生成，模板里只留占位符（模板不放逻辑）。
const BOOTSTRAP_SOURCE = `// 构建管道引导：核心逻辑（#plan-core）在页面里只内联一份。
// 主线程已由上一个 <script> 执行它；这里把同一份文本前置给 Worker 源，
// 使 Worker 与界面共用同一份核心，然后把 #plan-core 移出 DOM。
//
// 求解跑在 Worker 里，所以**精确版的内联 HiGHS 也要一并前置**——否则 Worker 里
// 没有 createHighs()。默认版的那个脚本是空注释，拼过去也无害。
(function () {
  var core = document.getElementById('plan-core');
  var worker = document.getElementById('worker-source');
  if (!core || !worker) return;
  var inline = document.getElementById('inline-highs');
  var inlineText = inline ? inline.textContent : '';
  worker.textContent = core.textContent + '\\n' + inlineText + '\\n' + worker.textContent;
  core.remove();
  if (inline) inline.remove();
})();`;

// 已删除模块的特征字符串（ADR-0006：产物里不得出现已删除模块的引用，
// 防止"两代求解器并存、上线了错的那个"重新发生）。
//
// 2026-10-07 补入束搜索那一代（`src/beam.js` / `src/score.js`）：它们已从仓库删除，
// 产物的模块槽位里也不该再出现这两个路径。
const DELETED_MARKERS = [
  'REPAIR_WEEKS',
  'BREACH_PENALTY',
  'DOMINANCE_EPSILON',
  'URGENCY_CAP',
  'beamScore',
  'fixedPointScale',
  'src/beam.js',
  'src/score.js',
  'DEFAULT_WIDTH',
  'createBeamSearch',
  'expandWeek',
  'prunedInWeek',
  'createScorer',
  'compareStates',
  'progressBase',
  'URGENCY_GAIN',
];

// 产物零外部资源：这五类命中数都必须是 0。
const EXTERNAL_RESOURCE_RE = /https?:\/\/|<link\b|<img\b|@import|url\(/g;

// ---------------------------------------------------------------- 工具

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function readText(file, label) {
  if (!existsSync(file)) throw new Error(`找不到 ${label}：${path.relative(ROOT, file)}`);
  return readFileSync(file, 'utf8');
}

/** 核心模块集合：src/ 下全部 .js（自动跟随实际内容，不硬编码模块清单）+ data/rules.json。 */
function coreEntries() {
  const modules = listModules(SRC_DIR);
  if (modules.length === 0) throw new Error('src/ 里没有找到任何 .js 模块');
  if (!existsSync(RULES_FILE)) throw new Error('找不到 data/rules.json');
  return [...modules, RULES_FILE];
}

function isCoreModule(file) {
  const rel = path.relative(ROOT, file);
  return rel === path.join('data', 'rules.json') || rel === 'src' || rel.startsWith(`src${path.sep}`);
}

function coreGraph() {
  return collect(coreEntries(), { root: ROOT });
}

/** 核心模块的导出索引，用于校验入口对共享核心的具名导入。 */
function coreExportIndex() {
  const graph = coreGraph();
  const index = new Map();
  for (const file of graph.order) {
    const record = graph.records.get(file);
    index.set(file, record.json ? null : new Set(record.exportNames));
  }
  return index;
}

function jsModules(graph) {
  return graph.order.filter((file) => !graph.records.get(file).json);
}

/** Node 导出段：一个 planCore 命名空间 + 跨模块唯一的扁平导出名，方便测试直接调用。 */
function esmTail(graph) {
  const reserved = new Set(['planCore', 'rules', CORE_GLOBAL, CORE_NS]);
  const counts = new Map();
  for (const file of jsModules(graph)) {
    for (const name of graph.records.get(file).exportNames) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  // 只导出跨模块唯一的短名；重名的（如 constraints.js 与 checkpoints.js 都有的
  // shortfallOf）语义有歧义，只通过 planCore[模块路径] 访问。
  const flatNames = [...counts]
    .filter(([name, count]) => count === 1 && !reserved.has(name) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
    .map(([name]) => name);

  const refs = jsModules(graph).map(
    (file) => `${CORE_NS}[${JSON.stringify(graph.moduleSlot(file))}]`,
  );
  const lines = [
    ESM_MARKER,
    `export const planCore = ${CORE_NS};`,
    `export const rules = ${CORE_NS}[${JSON.stringify(graph.moduleSlot(RULES_FILE))}];`,
    'const __planCoreFlat = Object.assign({}, ' + refs.join(', ') + ');',
  ];
  if (flatNames.length > 0) lines.push(`export const { ${flatNames.join(', ')} } = __planCoreFlat;`);
  lines.push(ESM_END);
  return `${lines.join('\n')}\n`;
}

/** 中间产物不能被入口 import：共享是通过全局 __planCore 完成的（见文件顶部说明）。 */
function assertEntriesDoNotImportCore() {
  const importCoreRe = /^\s*import[\s\S]*?from\s+['"]([^'"]*plan-core\.js)['"]/gm;
  for (const file of listModules(path.join(ROOT, 'web'))) {
    const match = importCoreRe.exec(readFileSync(file, 'utf8'));
    if (match) {
      throw new Error(
        `${path.relative(ROOT, file)}: 不能 import ${match[1]}。` +
          'plan-core.js 是构建产物，入口对 src/ 与 data/rules.json 的正常 import 会被自动改写为' +
          ` 从全局 ${CORE_GLOBAL} 取，产物里核心只内联一份。`,
      );
    }
  }
}

/** 生成 plan-core.js 全文（第一段产物）。 */
export function buildCoreSource() {
  const graph = coreGraph();
  const body = emit(graph, { namespace: CORE_NS, sharedGlobal: CORE_GLOBAL });
  return `${GENERATED_HEADER}\n${body}\n${esmTail(graph)}`;
}

/** 把 plan-core.js 的 ESM 导出段换成经典脚本的全局挂载，供内联进 HTML。 */
export function toClassicCore(coreSource) {
  const at = coreSource.indexOf(ESM_MARKER);
  if (at === -1 || !coreSource.includes(ESM_END)) {
    throw new Error(
      `plan-core.js 里找不到 ESM 导出段标记（${ESM_MARKER}）。` +
        '它必须由 tools/build.mjs 生成，手改过的中间产物不受支持。',
    );
  }
  return `${coreSource.slice(0, at)}${CLASSIC_TAIL}\n`;
}

function bundleEntry(entryFile) {
  return bundleShared([entryFile], {
    root: ROOT,
    isExternal: isCoreModule,
    externalExports: coreExportIndex(),
  });
}

// ---------------------------------------------------------------- 构建期守卫

function assertNoScriptTagBreak(source, label) {
  if (/<\/script/i.test(source)) {
    throw new Error(`${label}含 "</script"，会截断脚本块`);
  }
}

function assertPlaceholders(template) {
  for (const [name, placeholder] of Object.entries(PLACEHOLDERS)) {
    const occurrences = countOccurrences(template, placeholder);
    if (occurrences !== 1) {
      throw new Error(`模板里的占位符 ${placeholder}（${name}）应恰好出现 1 次，实际 ${occurrences} 次`);
    }
  }
}

function assertNoUnresolvedPlaceholders(html) {
  if (/__[A-Z][A-Z_]*__/.test(html)) {
    throw new Error('产物里仍有未替换的占位符');
  }
}

/** 找出产物里出现的已删除模块特征字符串，并指出它们来自哪些源文件。 */
export function findDeletedMarkers(text) {
  return DELETED_MARKERS.filter((marker) => text.includes(marker));
}

function markerSources(markers) {
  const hits = new Map();
  for (const file of listModules(SRC_DIR)) {
    const rel = path.relative(ROOT, file);
    const base = path.basename(file);
    const source = readFileSync(file, 'utf8');
    for (const marker of markers) {
      if (source.includes(marker) || base.includes(marker)) {
        if (!hits.has(marker)) hits.set(marker, new Set());
        hits.get(marker).add(rel);
      }
    }
  }
  return hits;
}

function assertNoDeletedMarkers(text, label) {
  const found = findDeletedMarkers(text);
  if (found.length === 0) return;
  const sources = markerSources(found);
  const detail = found
    .map((marker) => `${marker}（${[...(sources.get(marker) ?? ['来源未知'])].join('、')}）`)
    .join('、');
  throw new Error(
    `${label} 里出现已删除模块的特征字符串：${detail}。` +
      '产物里不允许出现已删除模块的痕迹（ADR-0006）——历史上出现过"两代求解器并存、用户拿到错的那个"。' +
      '请删掉引入它的代码；若这是**新**删除的模块，把它的特征串补进本文件的 DELETED_MARKERS。',
  );
}

export function externalResourceHits(text) {
  return text.match(EXTERNAL_RESOURCE_RE) ?? [];
}

function assertNoExternalResources(text, label) {
  const hits = externalResourceHits(text);
  if (hits.length > 0) {
    throw new Error(`${label} 含外部资源引用：${[...new Set(hits)].join('、')}`);
  }
}

/** 产物里不得出现"联网 / 运行时动态加载"两类调用（零外链铁律的另一半）。 */
function assertNoNetworkCalls(html) {
  for (const [re, what] of [
    [/\bfetch\s*\(/, 'fetch('],
    [/\bimport\s*\(/, 'import('],
    [/<script[^>]+\bsrc=/i, '<script src='],
    [/<link[^>]+\brel=["']?stylesheet/i, '<link rel=stylesheet'],
  ]) {
    if (re.test(html)) throw new Error(`index.html 里出现 ${what}：产物必须零外链、零联网`);
  }
}

/** 两个生成物开头的"禁止手改"声明与 index.html 的首两行结构。 */
function assertGeneratedHeaders(core, html) {
  const coreFirst = core.split('\n')[0];
  if (!coreFirst.startsWith('//') || !coreFirst.includes('禁止手改')) {
    throw new Error('plan-core.js 第 1 行不是"禁止手改"的生成声明');
  }
  const lines = html.split('\n');
  if (!lines[0].startsWith('<!--') || !lines[0].includes('禁止手改')) {
    throw new Error('index.html 第 1 行不是"禁止手改"的生成声明');
  }
  if (!/^<!doctype html>/i.test(lines[1])) throw new Error('index.html 第 2 行不是 doctype');
}

function scriptBlocks(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({
    attrs: m[1],
    source: m[2],
  }));
}

/**
 * 5 个脚本块的形态与顺序：plan-core → inline-highs → worker-source → 引导 → 应用。
 * 顺序错了界面会静默失灵（Worker 拿不到核心），所以在这里挡掉而不是等浏览器报错。
 */
function assertScriptBlockShape(html) {
  const blocks = scriptBlocks(html);
  if (blocks.length !== 5) throw new Error(`index.html 应有 5 个脚本块，实际 ${blocks.length} 个`);
  const expected = [
    { index: 0, res: [/id="plan-core"/], label: '#plan-core' },
    { index: 1, res: [/id="inline-highs"/], label: '#inline-highs' },
    { index: 2, res: [/id="worker-source"/, /type="text\/plain"/], label: '#worker-source 且 type="text/plain"' },
  ];
  for (const { index, res, label } of expected) {
    for (const re of res) {
      if (!re.test(blocks[index].attrs)) throw new Error(`第 ${index + 1} 块应为 ${label}，实际属性：${blocks[index].attrs}`);
    }
  }
  for (const index of [3, 4]) {
    if (blocks[index].attrs.trim() !== '') {
      throw new Error(`第 ${index + 1} 块（${index === 3 ? '引导' : '应用'}）不应带属性：${blocks[index].attrs}`);
    }
  }
  if (!/self\.__planCore\s*=/.test(blocks[0].source)) {
    throw new Error('核心块没有把命名空间挂到全局 __planCore');
  }
  if (!/getElementById\('plan-core'\)/.test(blocks[3].source)) {
    throw new Error('引导脚本没有取 #plan-core');
  }
  if (/\bself\.onmessage\s*=/.test(blocks[4].source)) {
    throw new Error('第 5 块（应用）不应注册 Worker 的 onmessage——它取成了 worker 源');
  }
}

/** 领域数据真的被内联了（防"产物是空壳"这类静默故障）。 */
function assertDomainDataInlined(html) {
  for (const needle of ['cmd-club-basketball', '1998-03-01', '社团经验', '研读文科']) {
    if (!html.includes(needle)) throw new Error(`index.html 里找不到内联的领域数据：${needle}`);
  }
}

/** 所有者要求产物是**纯亮色**：不得有 color-scheme 声明或暗色分支。 */
function assertLightOnly(html) {
  if (/color-scheme\s*:/.test(html)) throw new Error('index.html 里仍有 color-scheme 声明');
  if (/prefers-color-scheme/.test(html)) throw new Error('index.html 里仍有暗色模式分支');
}

/**
 * 双份内联自检：核心命名空间声明与同一段 rules.json 在产物里各应只出现 1 次。
 * 出现 2 次意味着"两代求解器并存"那类问题回来了（见 ADR-0006）。
 */
function assertNoDuplication(html) {
  const report = duplicationReport(html);
  if (report.coreNamespaceDeclarations !== 1 || report.rulesJsonCopies !== 1) {
    throw new Error(
      `双份内联自检失败：核心命名空间声明 ${report.coreNamespaceDeclarations} 次、` +
        `rules.json ${report.rulesJsonCopies} 份（都应为 1）`,
    );
  }
}

/** plan-core.js 的 Node 加载契约：ESM 导出段必须存在且导出 planCore / rules / 扁平名。 */
function assertEsmContract(coreSource) {
  for (const needle of [`export const planCore = ${CORE_NS};`, 'export const rules = ', 'export const { ']) {
    if (!coreSource.includes(needle)) {
      throw new Error(`plan-core.js 缺少 ESM 导出段的一部分：${needle.trim()}`);
    }
  }
}

/**
 * 构建期守卫：应用代码用 `$('id')` 取的元素，模板里必须真的存在。
 * 这类拼写错不会让测试变红，只会让界面在浏览器里静默失灵，所以在构建期挡掉。
 */
export function assertTemplateCoversAppIds(template, appSource) {
  const declared = new Set([...template.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = [...appSource.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);

  if (referenced.length < 5) {
    throw new Error(`只从应用代码里解析出 ${referenced.length} 个元素引用，检查 $() 约定是否还在`);
  }

  const missing = [...new Set(referenced)].filter((id) => !declared.has(id));
  if (missing.length > 0) {
    throw new Error(`应用引用了模板里不存在的元素 id：${missing.join('、')}`);
  }
}

// ---------------------------------------------------------------- 第二段：template + core → index.html

export function buildHtml({ coreSource = null } = {}) {
  assertEntriesDoNotImportCore();
  const template = readText(TEMPLATE_FILE, 'web/template.html');
  const source = coreSource ?? buildCoreSource();
  const core = toClassicCore(source);
  const workerSource = bundleEntry(WORKER_FILE);
  const appSource = bundleEntry(APP_FILE);

  assertNoScriptTagBreak(core, '内联核心');
  assertNoScriptTagBreak(workerSource, 'Worker 代码');
  assertNoScriptTagBreak(appSource, '应用代码');
  assertNoScriptTagBreak(BOOTSTRAP_SOURCE, '引导脚本');
  assertPlaceholders(template);
  assertTemplateCoversAppIds(template, appSource);

  // 唯一产物：`index.html` 内联 HiGHS（所有者 2026-10-06 改判，舍弃纯 JS 版本与双产物）。
  const exactSource = buildInlineHighs(HIGHS_DIR);

  const html = template
    .replace(PLACEHOLDERS.core, () => core)
    .replace(PLACEHOLDERS.worker, () => workerSource)
    .replace(PLACEHOLDERS.bootstrap, () => BOOTSTRAP_SOURCE)
    .replace(PLACEHOLDERS.exactHighs, () => exactSource)
    .replace(PLACEHOLDERS.app, () => appSource);

  // 生成声明先拼上，后面所有形态断言都对着**最终文本**——否则"第 1 行是声明"这类断言
  // 会对着还没有声明的中间文本判，永远失败。
  const finalHtml = `${HTML_HEADER}\n${html}`;

  const label = 'index.html';
  assertNoUnresolvedPlaceholders(finalHtml);
  assertNoDeletedMarkers(finalHtml, label);
  assertNoExternalResources(finalHtml, label);
  assertNoNetworkCalls(finalHtml);
  assertGeneratedHeaders(core, finalHtml);
  assertScriptBlockShape(finalHtml);
  assertDomainDataInlined(finalHtml);
  assertLightOnly(finalHtml);
  assertNoDuplication(finalHtml);
  return finalHtml;
}

/** 双份内联自检：核心命名空间声明与同一段 rules.json 在产物里各应只出现 1 次。 */
export function duplicationReport(html) {
  const rules = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  const probe = JSON.stringify(rules).slice(0, 60);
  return {
    coreNamespaceDeclarations: countOccurrences(html, `const ${CORE_NS} = {};`),
    rulesJsonCopies: countOccurrences(html, probe),
  };
}

// ---------------------------------------------------------------- 写出

function assertDeterministic(buildOnce, label) {
  const first = buildOnce();
  const second = buildOnce();
  if (first !== second) throw new Error(`${label} 构建不确定：两次生成字节不同`);
  return first;
}

/** 第一段：生成并校验 plan-core.js（不写盘）。 */
export function buildPlanCore() {
  const coreSource = assertDeterministic(buildCoreSource, 'plan-core.js');
  assertNoScriptTagBreak(coreSource, 'plan-core.js');
  assertNoDeletedMarkers(coreSource, 'plan-core.js');
  assertNoExternalResources(coreSource, 'plan-core.js');
  assertEsmContract(coreSource);
  return coreSource;
}

export function writeBuild() {
  // 两段都在内存里构建并校验通过后，才写盘——不留下一个半新半旧的产物对。
  const coreSource = buildPlanCore();
  const html = assertDeterministic(() => buildHtml({ coreSource }), 'index.html');
  writeFileSync(fileURLToPath(PLAN_CORE_URL), coreSource, 'utf8');
  writeFileSync(fileURLToPath(OUTPUT_URL), html, 'utf8');
  // 写完立刻读回逐字节比对：写盘被截断/编码出问题时当场变红，而不是等下次打开页面。
  assertDiskMatches(PLAN_CORE_URL, coreSource, 'plan-core.js');
  assertDiskMatches(OUTPUT_URL, html, 'index.html');

  // 文档与数据也必须一致。放在这里而不是只放在 package.json 的脚本里，
  // 是为了让**每一条**校验入口都覆盖它——否则 `node tools/build.mjs --check` 会报
  // "校验通过"，而 RULES.md 可能早就与 data/rules.json 脱钩了。
  const doc = checkRulesDoc();
  if (!doc.ok) throw new Error(doc.message);
  console.log(doc.message);
  return { coreSource, html };
}

/**
 * 磁盘产物 == 一次新鲜构建（"改了源码忘记重新构建"的机械防线）。
 *
 * 注意它**不能**放在 `npm run build` 的写盘之前断言：构建本身就会让两者不同（那正是构建的目的）。
 * 所以它是一条**独立的校验**：`npm run verify`（= `build.mjs --check`），只读不写，
 * 过期或缺失就以非零退出码失败。这条校验原先由测试套件承担，2026-10-07 起移到这里。
 */
function assertDiskMatches(url, expected, label) {
  const file = fileURLToPath(url);
  if (!existsSync(file)) throw new Error(`磁盘上找不到 ${label}，请先运行 npm run build`);
  const actual = readFileSync(file, 'utf8');
  if (actual !== expected) {
    throw new Error(
      `${label} 与一次新鲜构建不一致（磁盘 ${Buffer.byteLength(actual)} 字节 vs 新鲜 ${Buffer.byteLength(expected)} 字节）：` +
        '产物不是当前源码与数据的构建结果。请运行 npm run build；' +
        '若刚构建过仍报这一条，说明构建之后有东西又改了产物——产物禁止手改。',
    );
  }
}

/**
 * 只读校验：产物是否等于一次新鲜构建、plan-core.js 能否被 Node 当 ESM 加载并导出契约。
 * 这是 2026-10-07 删掉测试套件之后"验证"这一步的落点（`npm run verify`）。
 */
export async function verifyBuild() {
  const coreSource = buildPlanCore();
  const html = assertDeterministic(() => buildHtml({ coreSource }), 'index.html');
  assertDiskMatches(PLAN_CORE_URL, coreSource, 'plan-core.js');
  assertDiskMatches(OUTPUT_URL, html, 'index.html');

  // 文档与数据也必须一致。放在这里而不是只放在 package.json 的脚本里，
  // 是为了让**每一条**校验入口都覆盖它——否则 `node tools/build.mjs --check` 会报
  // "校验通过"，而 RULES.md 可能早就与 data/rules.json 脱钩了。
  const doc = checkRulesDoc();
  if (!doc.ok) throw new Error(doc.message);
  console.log(doc.message);

  const coreFile = fileURLToPath(PLAN_CORE_URL);
  const module = await import(`${pathToFileURL(coreFile).href}?v=${Date.now()}`);
  if (!module.planCore) throw new Error('plan-core.js 未导出 planCore');
  if (module.rules?.timeline?.end !== '1998-03-01') throw new Error('plan-core.js 的扁平 rules 导出不对');
  const rulesOnDisk = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  if (JSON.stringify(module.rules) !== JSON.stringify(rulesOnDisk)) {
    throw new Error('plan-core.js 里的 rules 与 data/rules.json 不一致');
  }
  if (!Object.keys(module.planCore).includes('data/rules.json')) {
    throw new Error('planCore 缺少 data/rules.json 槽位');
  }
  const exported = Object.keys(module).filter((name) => name !== 'default');
  if (exported.length < 3) throw new Error(`plan-core.js 的扁平导出太少：${exported.join('、')}`);
  return { coreSource, html, exported };
}

function isMain() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function formatKb(text) {
  return `${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`;
}

if (isMain()) {
  const flags = new Set(process.argv.slice(2));
  const coreOnly = flags.has('--core-only');
  const htmlOnly = flags.has('--html-only');
  const check = flags.has('--check');
  if (check) {
    // 只读校验：不写盘。过期/缺失/契约不符都以非零退出码失败。
    const { coreSource, html, exported } = await verifyBuild();
    console.log(`校验通过：磁盘产物 == 一次新鲜构建（plan-core.js ${formatKb(coreSource)}、index.html ${formatKb(html)}）`);
    console.log(`plan-core.js 可被 Node import：扁平导出 ${exported.length} 个（含 planCore / rules）。`);
  } else if (htmlOnly) {
    const html = assertDeterministic(buildHtml, 'index.html');
    writeFileSync(fileURLToPath(OUTPUT_URL), html, 'utf8');
    assertDiskMatches(OUTPUT_URL, html, 'index.html');
    console.log(`已写出 index.html（${formatKb(html)}）`);
    reportInline(html);
  } else if (coreOnly) {
    const core = buildPlanCore();
    writeFileSync(fileURLToPath(PLAN_CORE_URL), core, 'utf8');
    assertDiskMatches(PLAN_CORE_URL, core, 'plan-core.js');
    console.log(`已写出 plan-core.js（${formatKb(core)}，${moduleCount()} 个模块）`);
    console.log('Node 可直接 import 它并调用核心导出（见 planCore / 扁平的唯一导出名）。');
  } else {
    const { coreSource, html } = writeBuild();
    console.log(`已写出 plan-core.js（${formatKb(coreSource)}，${moduleCount()} 个模块）`);
    console.log(`已写出 index.html（${formatKb(html)}）`);
    reportInline(html);
  }
}

function moduleCount() {
  return jsModules(coreGraph()).length;
}

function reportInline(html) {
  const report = duplicationReport(html);
  console.log(
    `双份内联自检：核心命名空间声明 ${report.coreNamespaceDeclarations} 次、rules.json ${report.rulesJsonCopies} 份` +
      '（都应为 1；worker 与 app 只引用共享的全局 __planCore）。',
  );
}
