// 检查点：目标的唯一表达方式。
//
// 原先的三类目标（结局目标 / 小目标 / 全局约束）在这里统一成一种结构。每个检查点
// 含：落点时间、属性集合（或单个属性）、比较符与阈值。区别只在 `source`：
//
//   global  落点是**每个结算日**，逐日检查，判定基准是当天的瞬时值；语义是
//           「先达成者先硬化」——首次达成之前是软约束（欠着只报缺口），一旦达成即转
//           硬约束（此后任何一天跌破都记为硬违反，该日程不合格）。
//           见 ADR-0007 与 GLOSSARY 的「硬约束 / 目标」两分。
//   mini    落点是各自的截止日，评估**属性集合的求和**；
//   ending  落点是最后一个检查点（终点），评估各属性阈值。
//
// 每条属性的**起点值**隐式构成它的第一个检查点，不由数据录入。
//
// 三类来源与目标优先级见 ADR-0007 与 ADR-0009。

import { buildCalendar } from './calendar.js';
import { clubCommandId } from './clubs.js';

/** 检查点涉及的属性 id 列表（单属性或集合）；求解器与判定共用这一份口径。 */
export const attributeIdOf = (checkpoint) =>
  checkpoint.attributes ?? (checkpoint.attribute ? [checkpoint.attribute] : []);

/** 某个检查点在给定状态上要比较的实际值：单属性取值，集合取求和。 */
export function actualOf(checkpoint, attributes) {
  return attributeIdOf(checkpoint).reduce((sum, id) => sum + (attributes[id] ?? 0), 0);
}

/**
 * 距离阈值的还差多少；满足则为 0。
 *
 * **全程小数，所以 `< v` 就是 `< v`。** 早先这里写成 `actual - (value - 1)`（整数时代的
 * 量级），于是 `shortfallOf(49.5, '<', 50)` 得 0.5、把已经达标的压力报成未达标。
 * 属性只在结算后被夹在 `[0,999]` 内、中间值不截断（D4），所以不能靠"整数化"来定义满足。
 */
export function shortfallOf(actual, op, value) {
  const gap = op === '>=' ? value - actual : actual - value;
  // 不满足时保证返回**严格正**的缺口：`x = v` 在 `<` 方向上是未达标，但差值恰好为 0，
  // 于是"达标 ⟺ 缺口为 0"这条等价会破，界面会显示「差 0」却标红。
  if (gap > 0) return gap;
  // `x = v` 且方向为 `<`：未达标，但差值恰好为 0。缺口报 **1**（游戏数值是整数，
  // "差 1 点"比 1e-9 可读），从而"达标 ⟺ 缺口为 0"严格成立。
  return meets(actual, op, value) ? 0 : 1;
}

/** 该实际值是否满足这个检查点。与 `shortfallOf === 0` 同一口径。 */
export function meets(actual, op, value) {
  return op === '>=' ? actual >= value : actual < value;
}

/**
 * 社团集训周的硬约束：`rules.calendar.clubWeeks` 列出的那些自然周里，**该周全部平日
 * 必须执行当前社团的社团指令**。回家社（未加入任何社团）例外，按正常平日处理。
 *
 * 返回该周**强制执行的指令 id**；不是集训周、或回家社、或查不到对应社团指令时返回
 * `null`（都表示"这一周没有强制"）。数据里的 `clubWeeks` 元素形如
 * `{ date, command }`，`date` 是周锚点（周日）——见 `rules.json` 的 `calendar.clubWeeks`。
 *
 * **解锁日之前不强制**：社团指令自 `rules.clubUnlockDate` 起才可用（1995-04-09），
 * 在那之前的集训周没有可执行的社团指令——强制一条"此刻不可用"的指令既无意义，
 * 也会把"解锁日之前社团指令不被结算"这类合法情形误判为违规。
 */
export function clubWeekMandate(rules, club, weekStart) {
  if (!club) return null;
  if (weekStart < rules.clubUnlockDate) return null;
  const weeks = rules.calendar?.clubWeeks ?? [];
  return weeks.some((week) => week.date === weekStart) ? clubCommandId(rules, club) : null;
}

/**
 * 展开成按日期升序的具体落点。
 *
 * `global` 检查点**每个结算日一个落点**（每日检查，见 ADR-0007）。结算日由 `days` 给出
 * ——求解器与 `plan` 手上都有日历，传进来即可；缺省时按 `buildCalendar` 现算一份。
 * 起点是状态快照、终点不结算、空过的日子不结算，所以都不产生落点。
 *
 * `weekly` 字段是历史遗留：落点曾经按自然周生成，现在恒为 `false`，保留只是不打断
 * 仍在读它的旧消费者。
 */
export function buildCheckpointSchedule(rules, input, days = null) {
  const calendarDays = days ?? buildCalendar(rules, input).days;
  const settlementDates = calendarDays.filter((day) => day.isSettled).map((day) => day.date);

  const schedule = [];
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.source === 'global') {
      for (const date of settlementDates) schedule.push({ ...checkpoint, date, weekly: false });
    } else {
      schedule.push({ ...checkpoint, weekly: false });
    }
  }

  return schedule.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 每条属性的目标轨迹：各检查点（含隐式起点）之间的分段线性插值。
 *
 * 返回一个函数 `(date, attributeId) => number`。属性在某个检查点里缺席时，该检查点
 * 对它不构成断点——轨迹直接跨到它上下一个有落点的检查点。
 */
export function createTrajectory(rules, schedule, input) {
  const index = createTrajectoryIndex(rules, schedule);
  return (date, attributeId) => valueAt(index.get(attributeId), date);
}

/**
 * 轨迹断点索引：`Map<attributeId, [{date, value}]>`，首项是隐式起点。
 *
 * 求解器对每个状态、每条属性都要问一次目标值，所以断点表算一次就够；逐次重算
 * 会把这个热点放大成主要开销。
 *
 * **只有"下限方向"的检查点才构成轨迹点位**，且只取终点（结局）那一个：
 *
 *   - `>=` 属性：起点值 → 终点目标，是一条"该往上走多少"的斜线，正是我们要的施压方向。
 *   - `<` 属性（压力）：起点值是 0，终点目标是"低于 50"——把 49 当成轨迹目标会得到一条
 *     **向上**的斜线，于是求解器被奖励把压力升到 49。这不是任何人的本意，而是"线性插值"
 *     用在"上限"上的必然产物。所以这类属性**不设轨迹**：它由全局检查点与终点检查点约束。
 *   - **全局检查点不构成点位**：它的阈值是一条下限（`>=`）或上限（`<`），不是目标值。
 *     把"压力 < 70"的 70 当成目标同样会产生向上的斜线（实测过，压力被推到 999）。
 */
export function createTrajectoryIndex(rules, schedule) {
  const perAttribute = new Map();
  for (const attribute of rules.attributes) {
    perAttribute.set(attribute.id, [{ date: rules.timeline.start, value: attribute.default }]);
  }
  for (const checkpoint of schedule) {
    // 集合型检查点（小目标的求和）对各成员没有单独阈值，不构成点位。
    if (checkpoint.attributes) continue;
    // 全局检查点只是一条阈值线，不是目标值。
    if (checkpoint.source === 'global') continue;
    // 上限方向的属性不设轨迹——见上面对压力的说明。
    if (checkpoint.op !== '>=') continue;
    const points = perAttribute.get(checkpoint.attribute);
    if (points) points.push({ date: checkpoint.date, value: checkpoint.value });
  }
  for (const points of perAttribute.values()) {
    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return perAttribute;
}

/** 在一条断点表上取插值。 */
export function valueAt(points, date) {
  if (!points || points.length === 0) return null;
  if (date <= points[0].date) return points[0].value;
  const last = points[points.length - 1];
  if (date >= last.date) return last.value;

  for (let i = 1; i < points.length; i += 1) {
    const right = points[i];
    if (date > right.date) continue;
    const left = points[i - 1];
    const spanDays = daysBetween(left.date, right.date);
    if (spanDays <= 0) return right.value;
    return left.value + ((right.value - left.value) * daysBetween(left.date, date)) / spanDays;
  }
  return last.value;
}

/** 某属性当前所在的区间（上一个检查点 → 下一个检查点），用于算紧迫度权重。 */
export function intervalAt(rules, schedule, attributeId, date) {
  const points = [{ date: rules.timeline.start, value: null }];
  for (const checkpoint of schedule) {
    if (checkpoint.attributes || !attributeIdOf(checkpoint).includes(attributeId)) continue;
    points.push({ date: checkpoint.date, value: checkpoint.value });
  }
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let left = points[0];
  for (const point of points) {
    if (point.date <= date) left = point;
    else return { start: left.date, end: point.date };
  }
  return { start: left.date, end: left.date };
}

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// 这里曾经有一个 `crossCheckpoint`：每跨过一个落点就把"当时值 vs 当时目标"的绝对偏差
// 累加进 `state.frozenPenalty`，并维护 `state.achieved`。它们服务的是**束搜索的打分函数**
// （"冻结的过去检查点惩罚"与"达成后保持的重罚"），随打分函数一起被删除——
// 两个字段当时已经只写不读，`web/` 对它们零引用。清理后这个函数不再有任何职责，故整个删掉。
//
// **判定口径不受影响**：达标清单（`evaluateCheckpoints`）一直是在读 `days` 时**独立重算**
// `achieved` / `hardViolations` / `firstAchievedDate` 的，不依赖上面那两个字段。
// 清理前后的 `plan()` 判定读数逐字节相同（用 /tmp 临时脚本比对过，见交付报告）。

/**
 * 汇总达标状态，形状与旧的 PlanResult.goals 兼容（界面与导出直接消费）。
 *
 * 每条规则的 `state` 取值：
 *   - `met`      达成过，且达成之后一次都没跌破；
 *   - `unmet`    还从未达成（软约束阶段：欠着只报缺口，不影响 `valid`）；
 *   - `violated` 达成过又跌破（硬约束阶段被违反，一次即永久，该日程不合格）；
 *   - `unset`    这条属性没有设目标（如实标注，不冒充达标）。
 */
export function evaluateCheckpoints(rules, input, days) {
  // 全局落点直接取"传进来的这些结算日"：判定必须对着**这份**逐日结果，
  // 而不是另算一份日历（用合成 days 的单测依赖这一点；`plan` 传的就是它自己那份）。
  const schedule = buildCheckpointSchedule(rules, input, days);
  const byDate = new Map(days.map((day) => [day.date, day]));
  const startValues = Object.fromEntries(rules.attributes.map((a) => [a.id, a.default]));

  const items = [];
  const lastSettled = days.filter((day) => day.isSettled).pop() ?? days[days.length - 1];

  // **按规则聚合**：全局约束展开后是每个结算日一个落点（1000+ 个），但它在界面上只是
  // **一条**规则。逐落点汇报会产出几千行，没法用；所以每条规则只出一行，并给出最紧读数。
  const grouped = new Map();
  for (const checkpoint of schedule) {
    const day = byDate.get(checkpoint.date);
    // 全局约束看**当天结算后**的值；小目标 / 结局目标看**前 1 天的结算值**，
    // 也就是 `plan` 在结算该日之前拍下的 `attributesBefore`（见 plan.js 主循环）。
    // 落点当天不结算（起点快照 / 空过 / 跳过 / 时间轴终点）时两者相同，所以不用特例。
    const basis = checkpoint.source === 'global'
      ? day?.attributes
      : day?.attributesBefore ?? day?.attributes;
    const actual = actualOf(checkpoint, basis ?? startValues);
    const shortfall = shortfallOf(actual, checkpoint.op, checkpoint.value);
    const met = meets(actual, checkpoint.op, checkpoint.value);

    let entry = grouped.get(checkpoint.id);
    if (!entry) {
      entry = {
        id: checkpoint.id,
        label: labelOf(checkpoint),
        // 是否参与"全达标"（`ok`）判定。全局约束不参与 `ok`，它决定的是 `valid`。
        gate: checkpoint.source !== 'global',
        attribute: checkpoint.attribute ?? null,
        attributes: checkpoint.attributes ?? null,
        op: checkpoint.op,
        value: checkpoint.value,
        source: checkpoint.source,
        weekly: checkpoint.weekly,
        // 聚合后的全局规则没有单一落点日期；首次达成时点见 `firstAchievedDate`。
        date: checkpoint.source === 'global' ? null : checkpoint.date,
        landings: 0,
        unmetLandings: 0,
        hardViolations: 0,
        achieved: false,
        firstAchievedDate: null,
        lastActual: actual,
        lastShortfall: shortfall,
        worstActual: actual,
        worstShortfall: shortfall,
      };
      grouped.set(checkpoint.id, entry);
    }

    entry.landings += 1;
    if (!met) {
      entry.unmetLandings += 1;
      // 「先达成者先硬化」：达成之前的每一次不达标只是软缺口（可欠着），
      // 达成之后的每一次都是硬违反。
      if (entry.achieved) entry.hardViolations += 1;
    } else if (!entry.achieved) {
      entry.achieved = true;
      entry.firstAchievedDate = checkpoint.date;
    }
    entry.lastActual = actual;
    entry.lastShortfall = shortfall;
    // 最紧读数**始终**更新，不论达标与否——只在"未达标"时更新会让全部达标的全局规则
    // 报出第一个落点的读数（实测 gc-stamina 报 90.5，而最紧的落点是 57.625）。
    if (shortfall > entry.worstShortfall) {
      entry.worstShortfall = shortfall;
      entry.worstActual = actual;
    }
  }

  for (const entry of grouped.values()) {
    const state = entry.hardViolations > 0 ? 'violated' : entry.achieved ? 'met' : 'unmet';
    items.push({
      id: entry.id,
      label: entry.label,
      gate: entry.gate,
      attribute: entry.attribute,
      attributes: entry.attributes,
      op: entry.op,
      value: entry.value,
      source: entry.source,
      weekly: entry.weekly,
      date: entry.date,
      landings: entry.landings,
      unmetLandings: entry.unmetLandings,
      hardViolations: entry.hardViolations,
      achieved: entry.achieved,
      firstAchievedDate: entry.firstAchievedDate,
      // 达标项报**最近一个落点**的读数（软阶段的欠账在首次达成时清偿，不该拿来吓人）；
      // `unmet` / `violated` 报**最紧**的读数。
      actual: state === 'met' ? entry.lastActual : entry.worstActual,
      shortfall: state === 'met' ? entry.lastShortfall : entry.worstShortfall,
      state,
    });
  }

  // 兜底：**只有当属性既没有结局检查点、也不在豁免之列时**，才补一条"未设目标"的记录。
  //
  // 早先这里无条件补一条 `state: 'met'`，于是社团经验（唯一豁免结局覆盖的属性）
  // 永远凭空多出一条免费达标的条目，界面的"达标项数"因此虚高一项。
  // 现在：未设目标的属性如实标注 `state: 'unset'`，不冒充达标。
  for (const attribute of rules.attributes) {
    const covered = items.some(
      (item) => item.source === 'ending' && (item.attribute === attribute.id || item.attributes?.includes(attribute.id)),
    );
    if (covered) continue;
    const actual = lastSettled?.attributes?.[attribute.id] ?? attribute.default;
    items.push({
      id: `unset-${attribute.id}`,
      label: attribute.name,
      gate: false,
      attribute: attribute.id,
      attributes: null,
      date: rules.timeline.end,
      op: '>=',
      value: 0,
      source: 'unset',
      weekly: false,
      landings: 0,
      unmetLandings: 0,
      hardViolations: 0,
      achieved: false,
      firstAchievedDate: null,
      actual,
      state: 'unset',
      shortfall: 0,
    });
  }

  // 两个顶层判定，对应「硬约束 / 目标」两分（GLOSSARY）：
  //   `ok`    目标是否全部达标——只看参与判定的项（终点目标 + 小目标）。
  //   `valid` 该日程是否合格——没有任何硬违反。本函数能判定的硬约束是**全局约束的硬阶段**
  //           （压力上限由 `gc-stress` 这条全局规则表达）、**社团集训周**与**首次社团指令
  //           必须是周日**（violating days 由 `plan` 在解析出实际执行的指令后逐日标注
  //           `clubWeekViolation` / `clubFirstViolation`）；社团解锁/互斥与钉住的槽位由日历与
  //           求解器在结构上保证，一份排好的日程里不会出现。
  const gated = items.filter((item) => item.gate !== false && item.state !== 'unset');
  const hardViolations = items.reduce((sum, item) => sum + (item.hardViolations ?? 0), 0);
  const clubWeekViolations = days.filter((day) => day.clubWeekViolation === true).length;
  // 「第一次执行的社团指令必须是周日的日指令」（`rules.clubFirstCommand`，由 `plan` 逐日标注）。
  const clubFirstViolations = days.filter((day) => day.clubFirstViolation === true).length;
  // 规则是否**整条豁免**（使用者已选社团 + 「已玩到」落在集训周内，见 plan.js）：如实带出去，
  // 免得"0 天违规"分不清是"满足了"还是"根本没适用"。
  const clubFirstWaived = days.some((day) => day.clubFirstWaived === true);
  return {
    ok: gated.every((item) => item.state === 'met'),
    valid: hardViolations === 0 && clubWeekViolations === 0 && clubFirstViolations === 0,
    hardViolations,
    clubWeekViolations,
    clubFirstViolations,
    clubFirstWaived,
    items,
    gated,
  };
}

function labelOf(checkpoint) {
  const names = attributeIdOf(checkpoint);
  return names.length > 1 ? names.join('+') : names[0] ?? checkpoint.id;
}
