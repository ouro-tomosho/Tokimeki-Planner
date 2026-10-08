// 分片：把时间轴按**自然周**切成固定的片，并给出每片的插值目标。
//
// 所有者 2026-10-08 的裁决（见 ADR-0009）：
//   · 片界从**时间轴起点** 1995-04-04 所在自然周起，按 52 个自然周固定，与"已玩到"多晚无关；
//   · 三片 = 52 周 + 52 周 + 余下（当前余下 48 周）；
//   · **严格滚动**：一片算完即冻结它的全部指令，状态前推给下一片，不回头重算；
//   · 每片的**片目标** = 结局目标里除体力与压力外的 7 项，从**游戏初始数值**到结局阈值
//     在整条时间轴上线性插值，取该片最后一个结算日的值；
//   · 体力与压力的**结局目标保留**，只是不参与中间插值，只在最后一片（终点）参与。
//
// 本模块是纯函数：只吃规则与输入，不碰 HiGHS、不碰 DOM，因此可以独立断言。
//
// 片目标为什么软：插值线是一条**我们希望**的节奏，不是游戏规则。够不到时如实报缺口，
// 不让整份日程变成"不合格"——不合格只由硬约束（全局约束的硬阶段、集训周、钉住的槽位）决定。

import { addDays, weekStartOf } from './dates.js';
import { valueAt } from './checkpoints.js';

/** 一片的自然周数（最后一片是余下的部分周）。 */
export const CHUNK_WEEKS = 52;

/** 片数上限：当前时间轴 152 周，52 + 52 + 48。多出来的片在时间轴延长前不会出现。 */
export const CHUNK_COUNT = 3;

/**
 * 不参与插值的结局属性：**体力**与**压力**。
 *
 * 理由不是"它们不重要"，而是线性插值在这两项上会变质：
 *   · 压力是上限方向（`direction: 'down'`），把 `压力 < 50` 当成轨迹目标会得到一条
 *     **向上**的斜线——求解器会被奖励"把压力升到接近 50"。`createTrajectoryIndex`
 *     里已经有同一条教训（实测把压力推到 999）。
 *   · 体力波动大（休息日 ×4、练习消耗），拿它当"每周都应落在斜线上"的节奏会逼求解器
 *     为了一个中间值牺牲别的属性。
 * 两者的**结局目标**照旧在最后一片判定。
 */
export const INTERPOLATION_EXCLUDED = ['stamina', 'stress'];

/**
 * 固定的片界。返回按时间升序的 `[{ index, startDate, endDate, landingDate }]`。
 *
 * 边界的算法：取时间轴起点所在自然周的**周日**为锚点，第 k 片在第 `52k` 个周日结束
 * （即下一片从该周日开始）。最后一片截到 `timeline.lastSettlement`。
 * 由于锚点是周日，任何一片都不会把一个自然周劈成两半。
 *
 * `landingDate` 是**判定日**：片尾之后的第一天。判定取"落点前一天的结算值"，与结局目标
 * 和小目标的口径完全一致（见 ADR-0007 第二条）——最后一片的 `landingDate` 恰好就是
 * `timeline.end`，所以最后一片的判定与结局目标的判定是同一个口径、同一批数值。
 */
export function chunkGeometry(rules) {
  const { start, lastSettlement } = rules.timeline;
  const anchor = weekStartOf(start);
  const chunks = [];
  let cursor = start;

  for (let index = 0; cursor <= lastSettlement && index < CHUNK_COUNT; index += 1) {
    const nextBoundary = addDays(anchor, CHUNK_WEEKS * 7 * (index + 1));
    const endDate = nextBoundary <= lastSettlement ? addDays(nextBoundary, -1) : lastSettlement;
    chunks.push({
      index,
      startDate: cursor,
      endDate,
      landingDate: addDays(endDate, 1),
    });
    cursor = addDays(endDate, 1);
  }

  return chunks;
}

/**
 * 在**任意判定日**上取插值目标：`[{ attribute, value }]`，只含参与插值的属性。
 *
 * 插值线：从**游戏初始数值**（`rules.attributes[].default`）到该属性结局检查点的阈值，
 * 横跨"检查点落点 − 时间轴起点"，在给定判定日取点。锚点用游戏初始数值而不是使用者填的
 * 当前值，是所有者 2026-10-08 的裁决：片目标因此与"已玩到"多晚无关。
 *
 * **判定日 = 落点**（判定取的是"落点前一天的结算值"，见 ADR-0007），所以最后一片
 * （判定日 = 时间轴终点）的目标**恰好等于结局阈值本身**——这才让"求解结局目标"与
 * "满足片目标"成为同一件事。用片尾最后一天取点会得到 129.92 而不是 130。
 *
 * 除数为 0（判定日就是时间轴起点）时退化为初始值，不会除零。
 */
export function interpolatedTargets(rules, input, landingDate) {
  const defaults = new Map(rules.attributes.map((a) => [a.id, a.default]));
  const targets = [];

  // 插值一律走 `checkpoints.js` 的 `valueAt`：它是**判定轨道**用的同一个函数
  // （`createTrajectory` 也用它）。求解器再写一份线性插值 = 两套口径，迟早分叉。
  const at = (from, to, checkpointDate) =>
    valueAt(
      [
        { date: rules.timeline.start, value: from },
        { date: checkpointDate, value: to },
      ],
      landingDate,
    );

  for (const checkpoint of input.checkpoints) {
    if (checkpoint.op !== '>=') continue;

    if (checkpoint.source === 'ending') {
      // 结局目标都是单属性；集合型不会出现在结局组里。体力与压力不参与插值。
      if (!checkpoint.attribute || checkpoint.attributes) continue;
      if (INTERPOLATION_EXCLUDED.includes(checkpoint.attribute)) continue;
      const from = defaults.get(checkpoint.attribute);
      if (from === undefined) continue;
      targets.push({
        key: checkpoint.id,
        kind: 'target',
        terms: [{ attribute: checkpoint.attribute, coefficient: 1 }],
        value: at(from, checkpoint.value, checkpoint.date),
      });
      continue;
    }

    if (checkpoint.source === 'mini') {
      // **小目标同样要提前起速**：它是在整条时间轴上累积出来的（社团经验尤其如此），
      // 若只在它的落点那一片才被追求，滚动求解永远来不及补——实测社团经验差 214。
      // 用同一条插值规则给它一个"进度目标"，落点那一片的进度目标恰等于阈值本身。
      const names = checkpoint.attributes ?? (checkpoint.attribute ? [checkpoint.attribute] : []);
      if (names.length === 0) continue;
      const from = names.reduce((sum, id) => sum + (defaults.get(id) ?? 0), 0);
      targets.push({
        key: checkpoint.id,
        kind: 'mini',
        terms: names.map((attribute) => ({ attribute, coefficient: 1 })),
        value: at(from, checkpoint.value, checkpoint.date),
      });
    }
  }

  return targets;
}

/** 某一**片**的片目标：在这片的判定日上取插值。 */
export function chunkTargets(rules, input, chunk) {
  return interpolatedTargets(rules, input, chunk.landingDate);
}

/**
 * 计划用到的片：几何 + 片目标，并标出哪些片在本次计划里**真的还有结算日**。
 *
 * "已玩到"很晚时，前面的片可能整片落在过去——那些片没有决策可做，也被跳过：
 * 不参与求解、也不报缺口（它们的目标在游戏里早已成为既成事实）。
 *
 * @param settledDates 本次计划里全部结算日（升序、`YYYY-MM-DD`）；缺省由调用方从日历取。
 */
export function planChunks(rules, input, settledDates) {
  const geometry = chunkGeometry(rules);
  const dates = settledDates ?? null;

  return geometry.map((chunk) => {
    const inChunk = dates ? dates.filter((date) => date >= chunk.startDate && date <= chunk.endDate) : null;
    return {
      ...chunk,
      targets: chunkTargets(rules, input, chunk),
      // `null` 表示调用方没有提供日历：调用方自己判定是否求解。
      settledCount: inChunk ? inChunk.length : null,
      active: inChunk ? inChunk.length > 0 : true,
    };
  });
}
