// 唯一接触 HiGHS 的地方。
//
// 为什么要有这一层：产物必须**零外链、零动态加载**（ADR-0006/0008），所以 `src/` 里既不能
// `import ... from 'highs'`（打包器只接受相对导入），也不能 动态 import 外部包
// （构建期守卫禁止产物里出现动态 import 调用）。于是 HiGHS 只能从宿主取的全局工厂拿：
//
//   · 浏览器：`index.html` 内联的 `#inline-highs` 定义 `globalThis.createHighs`；
//   · Node（开发期验证）：宿主先执行
//       globalThis.createHighs = (await 动态载入外部包).default;
//
// **必须惰性取**：Worker 里 plan-core 先执行、inline-highs 后执行，模块求值那一刻全局还
// 不存在（实测过的顺序陷阱）。所以这里只缓存 Promise，工厂在真正要解的时候才读。

let instancePromise = null;

function hostFactory() {
  const factory = globalThis.createHighs;
  if (typeof factory !== 'function') {
    throw new Error(
      'HiGHS 求解器不可用：产物里缺少内联的 createHighs()。' +
        '浏览器请使用 index.html（由 npm run build 生成）；Node 请先执行 ' +
        '宿主自行把 HiGHS 的加载器挂到 globalThis.createHighs 上。',
    );
  }
  return factory;
}

/** 取得（并缓存）本 realm 唯一的 HiGHS 实例；加载失败时如实抛错，不降级。 */
export function getHighs() {
  if (!instancePromise) {
    instancePromise = Promise.resolve().then(() => hostFactory()()).catch((error) => {
      instancePromise = null;
      throw error;
    });
  }
  return instancePromise;
}
