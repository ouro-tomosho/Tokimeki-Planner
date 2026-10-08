// 一片的 MILP 模型：精确夹逼 + 分层字典序目标，交给 HiGHS 求解。
//
// 为什么在这里重新做 MILP（ADR-0008 记过一次失败）：那次失败的原因是**编码**，不是数学。
// 把逐日夹逼写成「辅助变量 L ≥ 0 表示被吸收掉的量」时，L 无条件放开会让模型**凭空抬高**
// 属性，而 LP 松弛里"抬高"与"真实吸收"同价，于是整数最优解大量靠假抬高满足目标。
//
// 本模块的做法是给夹逼的**两个方向各配一个 0-1 变量**，让 `v = clamp(pre, min, max)` 成为
// **唯一**可行解——不靠目标函数惩罚去"逼出"正确行为（那正是上次的坑）。
//
// 模型（每一片独立求解，片与片之间由 solve.js 严格滚动）：
//
//   槽位变量 x[s][c] ∈ {0,1}     非固定槽位的指令选择（周指令 / 休息日日指令）
//   属性变量 v[t][a] ∈ [lo,hi]   第 t 个结算日结算后的属性 a
//   夹逼变量 l[t][a], h[t][a]    当天下夹逼 / 上夹逼是否生效（**按可达性逐日剪枝**）
//   全局变量 g[r][t] ∈ {0,1}     全局规则 r 在第 t 天结束时是否已达成过（单调不减）
//   目标变量 p[i] / u[i] / e[i]  缺口 / 未达标 / 超额
//
// 三层剪枝让模型保持可解（都是**只删掉永不可行分支**的安全剪枝，不改变可行域）：
//
//   ① **已强制的全局规则不需要 0-1 变量**：进入本片时已达成（`base`）的规则，g 恒为 1，
//      直接写成 `v[t][a] ≥ θ` 的普通约束，连变量带目标项一起省掉。
//   ② **强制阈值抬高了有效值域**：`stamina ≥ 20`、`appearance ≥ 35`、`stress < 70` 一旦成为
//      硬约束，属性的实际取值范围就比 `[min,max]` 窄，用它去剪夹逼分支、收紧大 M。
//   ③ **按前缀可达性逐日剪枝**：第 t 天要触底，当且仅当"起点 − 前 t 天最大负效果之和"能掉到
//      有效下界之下。高位起步的属性（文科 40、容姿 60…）在前几十天根本不可能触底，那些
//      0-1 变量可以整片删掉。
//
// 目标（严格字典序，用分层权重压成一个标量；量级依据见 WEIGHTS 的注释）：
//   ① 全局约束：达成的**条数**最多 → 其次欠着的**天数**最少
//   ② 小目标：未达标条数 → 绝对缺口和
//   ③ 片目标（最后一包里含体力/压力的结局目标）：未达标条数 → 绝对缺口和
//   ④ 超额小奖励（严格从属，只在前三层全部打平时才可能起作用）
//
// 本文件不做 IO、不碰 DOM：给定输入产出 LP 文本，给定解产出指令。

import { availableCommandIds, availableDayCommandIds, clubCommandId, createClubLookup } from './clubs.js';
import { clubWeekMandate } from './checkpoints.js';
import { clubExperienceGainOn, expectedEffects, REST_DAY, WEEKDAY } from './settlement.js';
import { isClubSlot, isSkip } from './commands.js';

const CLUB_EXPERIENCE = 'clubExperience';

/** 严格不等式的余量：连续变量上的 `< v` 要写成 `≤ v − EPS`。 */
const EPS = 1e-6;

/**
 * 分层权重。**每一层的"一个单位"都必须重于下一层的全部可能改进**，否则优先级会被目标
 * 函数自己抹平（这个项目实测过的失效形态：小目标没满足、结局目标却超额一堆）。
 *
 * 量级依据（片内上界）：
 *   · 全局达成条数 ≤ 4 条        → 1e9，大于 4 条 × 上游天数 × 1e5 ≈ 1.4e8
 *   · 全局欠账天数 ≤ 4 × 天数    → 1e5，大于全局层以下的全部（约 2e3）
 *   · 小目标未达标条数 ≤ 2       → 1e3，大于片目标层全部（约 92）
 *   · 片目标未达标条数 ≤ 9       → 1e1，大于缺口层全部（≤ 1.9）
 *   · 绝对缺口：按**点**计，整体缩小 1000 倍（等比缩放不改变 argmin）→ 1e-3
 *   · 超额：**负**权重 1e-8——刻意小到"只有前四层全部打平时才可能影响结果"，
 *     这正是所有者要的"只给小奖励，不能把重心从优先满足未达标上挪走"。
 */
export const WEIGHTS = {
  achievedRule: 1e9,
  unmetGlobalDay: 1e5,
  // 终点余量（见 HEADROOM_CAP）：它属于**最高层（全局约束）**内部的一个次级偏好，
  // 位置在"欠账天数"之下、小目标之上——因为"让全局约束全程守得住"本就是那一层的目标。
  headroom: 20,
  unmetMini: 1e3,
  unmetTarget: 1e1,
  gap: 1e-3,
  excess: -1e-8,
};

/**
 * 块尾余量的上限（点）。**不是安全余量要求，是滚动的可行性条件**。
 *
 * 实测：严格滚动下，若块尾正好压在硬阈值上（体力 20.00、人缘 101.19 对 100），下一块
 * 的 LP 松弛直接**不可行**——它必须在整块里同时守住"体力 ≥ 20"和"人缘 ≥ 100"，而从
 * 零余量出发没有任何机动空间（把起点体力抬到 25 立刻就可行）。原因是每块都在为片目标
 * 消耗体力，而硬约束只要求"不越线"，于是最优解**恰好贴线**。
 *
 * 这个偏好只在最高层内部起作用：它不会放宽任何阈值（阈值仍是硬约束），只是在对可行解
 * 排序时，优先选择块尾留有余量的那些。上限把它限制成"小偏好"而不是"越多越好"。
 */
export const HEADROOM_CAP = 8;

// ---------------------------------------------------------------- 数字与 LP 文本

/** 紧凑但足够精确的十进制：整数不带小数点，其余保留 12 位有效数字。 */
function fmt(value) {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toPrecision(12)).toString();
}

/** 把 `[[变量名, 系数], …]` 拼成 LP 的线性表达式。 */
function linear(terms) {
  let out = '';
  for (const [name, coefficient] of terms) {
    if (coefficient === 0 || !Number.isFinite(coefficient)) continue;
    const sign = coefficient < 0 ? '-' : '+';
    out += `${out ? ' ' : ''}${sign} ${fmt(Math.abs(coefficient))} ${name}`;
  }
  return out || '0';
}

const negate = (terms) => terms.map(([name, coefficient]) => [name, -coefficient]);

// ---------------------------------------------------------------- 日效果（唯一来源）

/**
 * 一条指令在一天里的属性效果（期望值 + 社团经验增益）。
 *
 * 系数**只能**来自 `settlement.js` 的 `expectedEffects` 与 `clubExperienceGainOn`——
 * 求解器与真实引擎各算一套是这项目最贵的一条教训（ADR-0007）。
 * 与 `apply()` 的唯一差别：`apply` 先夹一次、社团经验再加一次再夹；两次夹逼等价于把总和
 * 夹一次（同一个区间、且单调），所以这里直接相加。
 *
 * 第三参是**日类型常量**（`WEEKDAY` / `REST_DAY`），不是布尔量：早先这里写成布尔参数而
 * 调用点传常量字符串，字符串恒为真，于是每个效果都被乘上了休息日的 ×4——实测重放偏差
 * 21.4 点。参数名与语义必须一致。
 */
function dailyEffect(rules, commandId, dayKind, weekStart, ids) {
  const out = new Float64Array(ids.length);
  if (!commandId || isSkip(commandId)) return out;

  const command = rules.commands.find((c) => c.id === commandId);
  if (!command) throw new Error(`未知指令：${commandId}`);

  const base = expectedEffects(rules, command, dayKind);
  for (let i = 0; i < ids.length; i += 1) {
    let value = base[ids[i]] ?? 0;
    if (ids[i] === CLUB_EXPERIENCE && command.kind === 'club') {
      value += clubExperienceGainOn(rules, dayKind, { weekStart });
    }
    out[i] = value;
  }
  return out;
}

/** 使用者钉住的槽位取值：`'club'` 占位符要展开成"当时那个社团"的指令。 */
function expandPinned(rules, pinned, club) {
  return isClubSlot(pinned) ? clubCommandId(rules, club) : pinned;
}

// ---------------------------------------------------------------- 模型构造

/**
 * 构造一片的模型。
 *
 * @param rules    有效规则（成功率覆盖后）
 * @param input    输入
 * @param days     本片的**结算日**（升序；调用方已剔除空过、起点快照、时间轴终点）
 * @param incoming `{ [attributeId]: number }`：本片第一个结算日**之前**的状态
 * @param achieved `{ [checkpointId]: boolean }`：进入本片时**已经达成过**的全局规则
 * @param targets  `[{ key, kind, terms, op, value, day }]`：本片要判定的目标
 *   · `kind: 'mini' | 'target'` 只影响权重（小目标优先于片目标）；
 *   · `terms` 是属性上的线性组合（小目标是求和、片目标是单项）；
 *   · `day` 是判定日在本片 `days` 里的下标，缺省为片尾最后一个结算日。
 */
export function buildChunkModel({ rules, input, days, incoming, achieved, targets }) {
  const ids = rules.attributes.map((a) => a.id);
  const index = Object.fromEntries(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const clubAt = createClubLookup(input);
  const T = days.length;
  if (T === 0) throw new Error('空片不能被建模（调用方应跳过没有结算日的片）');

  // ---- 全局规则：已强制的（进入本片前就达成过）直接成为普通约束 ----
  const globalRules = input.checkpoints
    .filter((cp) => cp.source === 'global')
    .map((cp) => ({
      id: cp.id,
      ai: index[cp.attribute ?? cp.attributes?.[0]],
      op: cp.op,
      value: cp.value,
      base: achieved?.[cp.id] === true,
    }));
  for (const rule of globalRules) {
    if (rule.ai === undefined) throw new Error(`全局约束 ${rule.id} 的属性不在规则里`);
  }

  // ---- 值域 ----
  //
  // `mins`/`maxs` 是**属性的真实值域**，夹逼就发生在这两条线上（ADR-0007）。
  // `effMin`/`effMax` 是"被已强制的全局阈值收窄后的有效区间"，它**只用于收缩变量的界**，
  // 绝不可以拿去当夹逼阈值——那是把"约束"误当"领域语义"，实测会让模型宣称体力=20 而真实是 0。
  const mins = rules.attributes.map((a) => a.min);
  const maxs = rules.attributes.map((a) => a.max);
  const effMin = rules.attributes.map((a) => a.min);
  const effMax = rules.attributes.map((a) => a.max);
  for (const rule of globalRules) {
    if (!rule.base) continue;
    const a = rule.ai;
    if (rule.op === '>=') effMin[a] = Math.max(effMin[a], rule.value);
    else effMax[a] = Math.min(effMax[a], rule.value - EPS);
  }
  for (let a = 0; a < n; a += 1) {
    if (effMin[a] > effMax[a] + 1e-9) {
      throw new Error(
        `全局约束互相冲突：属性 ${ids[a]} 的有效区间变成 [${effMin[a]}, ${effMax[a]}]。` +
          '请检查是否把同一条属性的下限抬到了上限之上。',
      );
    }
  }
  const maxValue = Math.max(...effMax);

  // ---- 槽位：求解器要做的一次选择 ----
  //
  // 使用者钉住的槽位（`input.weekCommands` / `input.dayCommands` 里有值）不进变量，也**不必**
  // 出现在 assignments 里：`plan()` 解析时使用者显式指定优先于求解器。它们的日效果改成常量。
  const weekSlots = new Map();
  const daySlots = new Map();
  const dayChoice = new Array(T);

  for (let t = 0; t < T; t += 1) {
    const day = days[t];
    const club = clubAt(day.date);

    if (day.isRestDay) {
      const pinned = input.dayCommands[day.date];
      if (pinned !== undefined) {
        dayChoice[t] = {
          kind: 'fixed',
          effect: dailyEffect(rules, expandPinned(rules, pinned, club), REST_DAY, day.weekStart, ids),
        };
        continue;
      }
      let slot = daySlots.get(day.date);
      if (!slot) {
        const cands = availableDayCommandIds(rules, club, day.date);
        slot = { cands, effs: cands.map((c) => dailyEffect(rules, c, REST_DAY, day.weekStart, ids)) };
        daySlots.set(day.date, slot);
      }
      dayChoice[t] = { kind: 'var', key: day.date, slot, isRestDay: true };
      continue;
    }

    const pinned = input.weekCommands[day.weekStart];
    if (pinned !== undefined) {
      dayChoice[t] = {
        kind: 'fixed',
        effect: dailyEffect(rules, expandPinned(rules, pinned, club), WEEKDAY, day.weekStart, ids),
      };
      continue;
    }
    let slot = weekSlots.get(day.weekStart);
    if (!slot) {
      const mandate = clubWeekMandate(rules, club, day.weekStart);
      const cands = mandate ? [mandate] : availableCommandIds(rules, club, day.weekStart);
      slot = { cands, effs: cands.map((c) => dailyEffect(rules, c, WEEKDAY, day.weekStart, ids)) };
      weekSlots.set(day.weekStart, slot);
    }
    dayChoice[t] = { kind: 'var', key: day.weekStart, slot, isRestDay: false };
  }

  // 槽位清单（顺序固定 → LP 文本确定）：先周槽位，后日槽位。
  const slots = [];
  for (const [key, slot] of weekSlots) slots.push({ key, slot, isRestDay: false });
  for (const [key, slot] of daySlots) slots.push({ key, slot, isRestDay: true });
  const slotIndex = new Map(slots.map((s, i) => [`${s.isRestDay ? 'd' : 'w'}:${s.key}`, i]));
  const slotOfDay = dayChoice.map((c) =>
    c.kind === 'var' ? slotIndex.get(`${c.isRestDay ? 'd' : 'w'}:${c.key}`) : -1,
  );

  // ---- 变量命名 ----
  const vName = (t, a) => `v${t}_${a}`;
  const lName = (t, a) => `l${t}_${a}`;
  const hName = (t, a) => `h${t}_${a}`;
  const xName = (s, c) => `x${s}_${c}`;
  const gName = (r, t) => `g${r}_${t}`;
  const pName = (i) => `p${i}`;
  const uName = (i) => `u${i}`;
  const eName = (i) => `e${i}`;
  /** 片尾最后一个结算日的下标：终点余量与片目标都看这一天。 */
  const last = T - 1;

  // ---- 逐日可达性（前缀）与夹逼剪枝 ----
  //
  // 下界：`v[t] ≥ incoming − Σ_{s≤t} max(0, −e_s)`（夹逼只会抬高、不会把值压到这条线以下）。
  // 上界：`v[t] ≤ incoming + Σ_{s≤t} max(0, e_s)`（同理）。两条界都只用"每天可选效果里
  // 最极端的那个"，因此是**安全**的：删掉的只是永远不可行的分支。
  const low = new Array(T); // 每天每属性是否还需要下夹逼变量
  const high = new Array(T);
  const bigM = new Array(T);
  const boundLo = new Array(T); // 逐日可达下界（对 v 的合法收紧，见下）
  const boundHi = new Array(T);
  for (let t = 0; t < T; t += 1) {
    low[t] = new Array(n).fill(false);
    high[t] = new Array(n).fill(false);
    bigM[t] = new Array(n).fill(0);
    boundLo[t] = new Array(n).fill(0);
    boundHi[t] = new Array(n).fill(0);
  }

  const reachMin = new Float64Array(n);
  const reachMax = new Float64Array(n);
  for (let a = 0; a < n; a += 1) {
    reachMin[a] = incoming[ids[a]] ?? 0;
    reachMax[a] = incoming[ids[a]] ?? 0;
  }
  for (let t = 0; t < T; t += 1) {
    const choice = dayChoice[t];
    const effs = choice.kind === 'fixed' ? [choice.effect] : choice.slot.effs;
    for (let a = 0; a < n; a += 1) {
      let positive = 0;
      let negative = 0;
      for (const eff of effs) {
        if (eff[a] > positive) positive = eff[a];
        if (-eff[a] > negative) negative = -eff[a];
      }
      reachMax[a] += positive;
      reachMin[a] -= negative;
      // 夹逼发生在**属性的真实值域** [min, max] 上；全局阈值是**约束**，不是夹逼边界。
      // 早先这里误用 effMin 当夹逼下界，于是模型把"体力 ≥ 20"直接夹到 20——它宣称满足
      // 全局约束，而真实引擎那一天的体力是 0。重放闸门当场抓住了这个 20 点的偏差。
      low[t][a] = reachMin[a] < mins[a] - 1e-9;
      high[t][a] = reachMax[a] > maxs[a] + 1e-9;
      bigM[t][a] =
        Math.max(maxs[a] - mins[a], Math.ceil(reachMax[a]), Math.ceil(-reachMin[a])) + 1;
      // 逐日可达界：`v[t]` 必落在 [max(effMin, reachMin), min(effMax, reachMax)] 内。
      // 这两条是**合法的变量上下界**（不是约束），能显著收紧 LP 松弛——大 M 公式的松弛
      // 之所以弱，很大一部分就是因为 v 只有 [min,max] 这种极宽的界。
      // 变量上下界只是"合法的收缩"：v 既不能超出属性值域，也不能超出可达区间，
      // 还要满足已强制的全局阈值（那条硬约束本来就会单独写出来，这里是它的冗余收紧）。
      boundLo[t][a] = Math.max(mins[a], effMin[a], reachMin[a]);
      boundHi[t][a] = Math.min(maxs[a], effMax[a], reachMax[a]);
    }
  }

  // ---- 行 ----
  const rows = [];
  const row = (terms, op, rhs) => rows.push(`${linear(terms)} ${op} ${fmt(rhs)}`);

  /** 一天的"夹逼前值"：`v[t−1][a] + 常量 + Σ_c e[c][a]·x[s][c]`。 */
  const preOf = (t, a) => {
    const choice = dayChoice[t];
    const terms = t === 0 ? [] : [[vName(t - 1, a), 1]];
    let shift = t === 0 ? (incoming[ids[a]] ?? 0) : 0;
    if (choice.kind === 'fixed') {
      shift += choice.effect[a];
    } else {
      const s = slotOfDay[t];
      const effs = choice.slot.effs;
      for (let c = 0; c < effs.length; c += 1) {
        if (effs[c][a] !== 0) terms.push([xName(s, c), effs[c][a]]);
      }
    }
    return { terms, shift };
  };

  for (const [s, { slot }] of slots.entries()) {
    row(
      slot.cands.map((_, c) => [xName(s, c), 1]),
      '=',
      1,
    );
  }

  for (let t = 0; t < T; t += 1) {
    for (let a = 0; a < n; a += 1) {
      const v = vName(t, a);
      const l = lName(t, a);
      const h = hName(t, a);
      const pre = preOf(t, a);
      // `pre` 是 `Σ pre.terms + pre.shift`；下面凡是要"v 减 pre"的行，都必须用 negate 后的项，
      // 并把常量 shift 挪到右端（符号写反会让整片模型变成另一个问题——实测过）。
      const neg = negate(pre.terms);
      const shift = pre.shift;
      const span = maxs[a] - mins[a];
      const needLow = low[t][a];
      const needHigh = high[t][a];
      const M = bigM[t][a];

      if (!needLow && !needHigh) {
        row([...neg, [v, 1]], '=', shift);
        continue;
      }
      if (needLow && !needHigh) {
        row([[v, 1], [l, span]], '<=', maxs[a]);
        row([...neg, [v, 1], [l, M]], '>=', shift);
        row([...neg, [v, 1], [l, -M]], '<=', shift);
        row([...pre.terms, [l, M]], '<=', mins[a] + M - shift);
        continue;
      }
      if (!needLow && needHigh) {
        row([[v, 1], [h, -span]], '>=', mins[a]);
        row([...neg, [v, 1], [h, M]], '>=', shift);
        row([...neg, [v, 1], [h, -M]], '<=', shift);
        row([...pre.terms, [h, -M]], '>=', maxs[a] - M - shift);
        continue;
      }
      row([[v, 1], [l, span]], '<=', maxs[a]);
      row([[v, 1], [h, -span]], '>=', mins[a]);
      row([...neg, [v, 1], [l, M], [h, M]], '>=', shift);
      row([...neg, [v, 1], [l, -M], [h, -M]], '<=', shift);
      row([...pre.terms, [l, M]], '<=', mins[a] + M - shift);
      row([...pre.terms, [h, -M]], '>=', maxs[a] - M - shift);
      row([[l, 1], [h, 1]], '<=', 1);
    }
  }

  // ---- 全局约束：先达成者先硬化 ----
  //
  //   已强制的规则（`base`）：不建变量，直接 `v[t][a] ≥ θ`（或 `≤ θ − EPS`）——它也把
  //   有效值域收窄了（见上面的 effMin/effMax）。
  //   未强制的规则：g[r][t] 单调不减；g＝1 ⇒ 当天必须满足阈值。g 也可以一直是 0
  //   （"还没达成"），此时不违反任何东西，只按欠账天数计分。
  const flexibleRules = [];
  const forcedRules = [];
  for (let r = 0; r < globalRules.length; r += 1) {
    const rule = globalRules[r];
    const a = rule.ai;
    if (rule.base) {
      forcedRules.push({ rule, index: forcedRules.length });
      for (let t = 0; t < T; t += 1) {
        if (rule.op === '>=') row([[vName(t, a), 1]], '>=', rule.value);
        else row([[vName(t, a), 1]], '<=', rule.value - EPS);
      }
      continue;
    }
    flexibleRules.push({ rule, ruleIndex: flexibleRules.length });
  }

  for (const { rule, ruleIndex: r } of flexibleRules) {
    const a = rule.ai;
    // 大 M 只需盖住"阈值到有效值域"的距离：g=0 时必须让约束真正失效。
    const GM = Math.max(1, rule.value - effMin[a], effMax[a] - rule.value) + 1;
    row([[gName(r, 0), 1]], '>=', 0);
    for (let t = 1; t < T; t += 1) {
      row([[gName(r, t), 1], [gName(r, t - 1), -1]], '>=', 0);
    }
    for (let t = 0; t < T; t += 1) {
      const v = vName(t, a);
      // g 必须是**精确指示量**，不能是自由选择：GLOSSARY 的「硬约束阶段」定义是
      // **首次达成**（首次达到阈值）即转硬。若只写"g=1 ⇒ 达标"，求解器就能先达标、
      // 再让它掉下去、并声称"从未达成过"——这是对领域语义的偏离（实测它会走到这一步，
      // 下一片因此继承一个互相冲突的强制集合）。两个方向都要写：
      //   g=1 ⇒ v 达标        g=0 ⇒ v 未达标（严格小于阈值）
      if (rule.op === '>=') {
        row([[v, 1], [gName(r, t), -GM]], '>=', rule.value - GM);
        row([[v, 1], [gName(r, t), -GM]], '<=', rule.value - EPS);
      } else {
        row([[v, 1], [gName(r, t), GM]], '<=', rule.value - EPS + GM);
        row([[v, 1], [gName(r, t), GM]], '>=', rule.value);
      }
    }
  }

  // ---- 终点余量（软，最高层内部的次级偏好）----
  const headVars = [];
  for (const { rule, index: h } of forcedRules) {
    const a = rule.ai;
    const q = `q${h}`;
    const v = vName(last, a);
    if (rule.op === '>=') {
      // q ≤ v_end − θ ：块尾至少高出阈值 q 点
      row([[q, 1], [v, -1]], '<=', -rule.value);
    } else {
      // q ≤ θ − EPS − v_end ：块尾至少低于上限 q 点
      row([[q, 1], [v, 1]], '<=', rule.value - EPS);
    }
    headVars.push({ name: q, ruleId: rule.id });
  }

  // ---- 目标（软） ----
  //
  // 判定基准是**某个指定结算日**的结算后值：与结局目标/小目标的"落点前一天的结算值"
  // 同一口径（片目标在 chunks.js 里按判定日取点，最后一片的判定日 = 时间轴终点）。
  // 小目标的落点可能落在片的中间，所以每个目标自带 `day`；缺省是片尾最后一个结算日。
  const targetInfo = targets.map((target, i) => {
    const dayIndex = Math.min(last, Math.max(0, target.day ?? last));
    const terms = target.terms
      .filter((term) => index[term.attribute] !== undefined)
      .map((term) => [vName(dayIndex, index[term.attribute]), term.coefficient]);
    const value = target.value;
    const scale = terms.reduce((sum, [, c]) => sum + Math.abs(c), 0) * maxValue + Math.abs(value) + 1;

    if (target.op === '>=') {
      // 缺口：p ≥ τ − expr；未达标：u=1 ⇒ expr ≤ τ−EPS，u=0 ⇒ expr ≥ τ；超额：e ≥ expr − τ
      row([[pName(i), 1], ...terms], '>=', value);
      row([...terms, [uName(i), scale]], '>=', value);
      row([...terms, [uName(i), scale]], '<=', value - EPS + scale);
      row([[eName(i), 1], ...negate(terms)], '>=', -value);
    } else {
      // 缺口：p ≥ expr − τ；未达标：u=1 ⇒ expr ≥ τ，u=0 ⇒ expr ≤ τ−EPS
      row([[pName(i), 1], ...negate(terms)], '>=', -value);
      row([...terms, [uName(i), -scale]], '>=', value - scale);
      row([...terms, [uName(i), -scale]], '<=', value - EPS);
    }
    return { ...target, index: i };
  });

  // ---- 目标函数 ----
  const objective = [];
  for (const { ruleIndex: r } of flexibleRules) {
    objective.push([gName(r, last), -WEIGHTS.achievedRule]);
    for (let t = 0; t < T; t += 1) objective.push([gName(r, t), -WEIGHTS.unmetGlobalDay]);
  }
  for (const { name } of headVars) objective.push([name, -WEIGHTS.headroom]);
  for (const target of targetInfo) {
    const i = target.index;
    objective.push([uName(i), target.kind === 'mini' ? WEIGHTS.unmetMini : WEIGHTS.unmetTarget]);
    objective.push([pName(i), WEIGHTS.gap]);
    if (target.op === '>=') objective.push([eName(i), WEIGHTS.excess]);
  }

  // ---- LP 文本 ----
  const bounds = [];
  for (let t = 0; t < T; t += 1) {
    for (let a = 0; a < n; a += 1) {
      bounds.push(`${fmt(boundLo[t][a])} <= ${vName(t, a)} <= ${fmt(boundHi[t][a])}`);
    }
  }
  for (const { name } of headVars) bounds.push(`0 <= ${name} <= ${HEADROOM_CAP}`);

  const binaries = [];
  for (let s = 0; s < slots.length; s += 1) {
    for (let c = 0; c < slots[s].slot.cands.length; c += 1) binaries.push(xName(s, c));
  }
  let clampBinaries = 0;
  for (let t = 0; t < T; t += 1) {
    for (let a = 0; a < n; a += 1) {
      if (low[t][a]) {
        binaries.push(lName(t, a));
        clampBinaries += 1;
      }
      if (high[t][a]) {
        binaries.push(hName(t, a));
        clampBinaries += 1;
      }
    }
  }
  for (const { ruleIndex: r } of flexibleRules) {
    for (let t = 0; t < T; t += 1) binaries.push(gName(r, t));
  }
  for (const target of targetInfo) binaries.push(uName(target.index));

  const lp = [
    'Minimize',
    ` obj: ${linear(objective)}`,
    'Subject To',
    ...rows.map((text, i) => ` r${i}: ${text}`),
    'Bounds',
    ...bounds,
    'Binaries',
    ` ${binaries.join(' ')}`,
    'End',
  ].join('\n');

  return {
    lp,
    T,
    n,
    ids,
    index,
    slots: slots.map(({ key, isRestDay, slot }) => ({ key, isRestDay, cands: slot.cands })),
    globalRules,
    flexibleRules: flexibleRules.map(({ rule, ruleIndex }) => ({ id: rule.id, index: ruleIndex })),
    targetInfo,
    stateVar: vName,
    counts: {
      rows: rows.length,
      binaries: binaries.length,
      columns: binaries.length + T * n,
      clampBinaries,
      forcedRules: forcedRules.length,
      headroomVars: headVars.length,
      flexibleRules: flexibleRules.length,
    },
  };
}

// ---------------------------------------------------------------- 取解

const round01 = (value) => (value > 0.5 ? 1 : 0);

/**
 * 从 HiGHS 的解里取出本片的指令选择。
 *
 * 只回填**非固定槽位**：使用者钉住的槽位由 `plan()` 直接读输入，重复回填反而会把两种来源
 * 混在一起（`web/edits.js` 也依赖"钉住的就是钉住的"）。
 */
export function extractAssignments(model, columns) {
  const weekCommands = {};
  const dayCommands = {};
  for (let s = 0; s < model.slots.length; s += 1) {
    const slot = model.slots[s];
    let chosen = -1;
    let hits = 0;
    for (let c = 0; c < slot.cands.length; c += 1) {
      const column = columns[`x${s}_${c}`];
      if (column && round01(column.Primal ?? 0) === 1) {
        chosen = c;
        hits += 1;
      }
    }
    if (chosen === -1 || hits !== 1) {
      throw new Error(
        `HiGHS 的解里槽位 ${s}（${slot.key}）选出了 ${hits} 条指令——解不是 0-1 或槽位约束被破坏`,
      );
    }
    if (slot.isRestDay) dayCommands[slot.key] = slot.cands[chosen];
    else weekCommands[slot.key] = slot.cands[chosen];
  }
  return { weekCommands, dayCommands };
}

/**
 * 从解里读回**这一块内真的达成过**的全局规则（`g` 为精确指示量，见上）。
 *
 * 严格滚动要靠它把"强制集合"传给下一块。**不能用"轨迹里某天碰巧达标"来推断**：
 * 那比模型自己的承诺更强，会把下一块逼进一个它无法维持的强制集合。
 */
export function modelAchieved(model, columns) {
  const result = {};
  for (const { id, index } of model.flexibleRules) {
    const column = columns[`g${index}_${model.T - 1}`];
    result[id] = column ? round01(column.Primal ?? 0) === 1 : false;
  }
  return result;
}

/** 模型声明的逐日状态（用于与真实引擎重放逐条比对）。 */
export function modelState(model, columns) {
  return (t, attributeId) => {
    const column = columns[model.stateVar(t, model.index[attributeId])];
    if (!column) {
      throw new Error(`HiGHS 的解里缺少状态变量 ${model.stateVar(t, model.index[attributeId])}`);
    }
    return column.Primal;
  };
}
