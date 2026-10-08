# 内联 HiGHS：三处构建期改写与零外链守卫

**Status**: accepted（2026-10-06 裁决内联；2026-10-08 随精确求解落地整理）

## 决策

**产物只有一个：根 `index.html`，内联 HiGHS（WASM + 胶水层）。** 运行时零依赖、零网络请求。

| | |
| --- | --- |
| 构建命令 | `npm run build`（唯一命令） |
| 产物 | `index.html`，内联 core + HiGHS + worker + app |
| 体积 | 原始约 5.0 MB；gzip 传输约 1.8 MB |
| 依赖 | 构建期需要 `highs`（`npm install --no-save highs`）；**运行时零依赖、零网络请求** |
| 交付形态 | 单文件，拷到任何地方、断网双击即可用 |

**内联需要三处构建期改写**（都在 `tools/inline-highs.mjs`）：

1. **`import.meta.url` → 全局常量（空串）**。经典 `<script>` 里出现 `import.meta` 是**语法错误**；
   它唯一的用途是 `locateFile` 定位 wasm 文件，而我们走 `instantiateWasm` 自己喂字节，
   那条路径永远不会执行——所以空串是安全的，不是"碰巧能用"。
2. **ESM 导出 → 全局挂载**。胶水层被压缩过，导出语句不一定落在行首，替换不能锚定行首。
3. **剥掉唯一的 URL**：胶水层有一条错误信息带文档链接，会命中"零外链"正则，把主机名替换掉即可
   （语义不变）。

此外把 `fetch(` 与对 Node 内置模块的动态 `import(` 换成**直接抛错的桩**：胶水层里这两处只在
"我们没提供 `instantiateWasm` / 跑在 Node 里"的分支才会执行，永远不会走到——但"不会执行到"
不是保证，"根本没有这段代码"才是。

**判据用真正的语法校验（`node:vm` 的 `new Script`），不用正则**：正则会被动态 import 之类的
Node 分支误伤，而那个分支在浏览器/Worker 里永远不会执行。

## 运行时契约

- **`await globalThis.createHighs()`** 取得 HiGHS 实例（Promise 缓存，3.4 MB 的编译开销只付一次）。
- **Worker 与主线程都能拿到**：内联脚本在主线程的 `<script>` 中，所以引导脚本必须把
  `#inline-highs` 的文本**一并前置给 Worker 源**（`core + inline + worker` 三段）。漏掉这一步的
  表现是"主线程有、Worker 没有"，属静默失灵，因此有机械测试断言拼接顺序。
- **顺序陷阱**：Worker 里 core 先执行、内联的 HiGHS 后执行，所以核心模块**求值那一刻**
  `globalThis.createHighs` 还不存在。取用必须**惰性发生在调用时**，不能在模块顶层读
  （`src/highs.js` 就是这一层）。
- **`WebAssembly.instantiate(bytes, imports)`（字节形式）返回 `{ module, instance }`**，
  而 Emscripten 的 `instantiateWasm` 回调要的是**裸 instance**。接错的报错是
  `Cannot read properties of undefined`，因此有测试锁住。

求解侧**怎么用它**（模型怎么建、解怎么取、闸门怎么过）见
[ADR-0009](0009-exact-solver-wired-up.md)。

## 背景与理由

### 为什么内联而不是旁挂

`file://` 协议下浏览器禁止加载旁边的 `highs.wasm`（同源/CORS 限制），而本项目的交付承诺是
**"拷一个文件到任何地方、断网双击就能用"**（[ADR-0006](0006-generated-artifacts.md)）。
旁挂 wasm 会让这条承诺失效——文件必须与 HTML 放在一起，且不能双击打开。

内联则两者兼得：**单文件、零依赖、零网络请求**。代价是 HTML 涨到约 5.0 MB（gzip 约 1.8 MB），
这是所有者明确接受的代价。

## Consequences

- **`index.html` 约 5.0 MB**（gzip 约 1.8 MB）。GitHub Pages 侧无障碍：仓库 1 GB / 单文件
  100 MB 的限制远超需求。
- **`highs` 仍是开发期依赖**——精确求解是"构建期把二进制烤进产物"，不是运行时依赖。
- **`plan-core.js` 仍是中间产物**，两段构建（core → html）不变。
- **机械守卫**（`tools/build.mjs`，属 `npm run verify`）：① 产物内零外部资源引用
  （无 `http(s)://`、无 `<link`、无 `<img`、无 `@import`、无 `url(`）；② 产物内零联网/零动态加载
  （无 `fetch(`、无 `import(`、无外链 `<script src>`）；③ 五个脚本块的形态与顺序正确；
  ④ 双份内联自检（核心命名空间与 `rules.json` 各只出现一次）。
- **规模换能力是明确取舍**：5 MB 换"判定结论可信"。
  更需要记住的是**接线纪律**：产物里内联了什么，不等于运行时就用了什么——这条在 2026-10-06
  到 2026-10-08 之间真实地发生过一次（HiGHS 被内联进产物却从未被调用），
  见 ADR-0009 的「背景」一节。
