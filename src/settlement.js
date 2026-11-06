// 单日结算内核。
//
// 接缝是 `apply(rules, state, commandId, dayKind) → 新状态`：规则在这一层注入，
// 纯函数、不碰 DOM，因此同一份代码既能在内联 Worker 里跑，也能在 Node 测试里直接断言。
//
// **全程小数，不截断**：所有效果按精确值累加，只在每次结算后夹在属性的 [min, max] 内。
// 界面要显示两位小数时自行取整，不在这里做。
//
// 期望值与结算共用同一份 `branches()`：求解器与规划必须同一口径，否则搜索会在与结算
// 不同的世界里寻优，得出的日程一重放就对不上。


export const WEEKDAY = 'weekday';
export const REST_DAY = 'restDay';

/** 社团经验是**第 10 个属性**，它的 id 固定。社团指令的增益加到它上面。 */
export const CLUB_EXPERIENCE_ID = 'clubExperience';

/** 传入指令 id 或指令对象，都解析成指令对象；空过返回 null。 */
export function resolveCommand(rules, commandOrId) {
  if (commandOrId === null || commandOrId === undefined) return null;
  if (typeof commandOrId === 'object') return commandOrId;
  const command = rules.commands.find((c) => c.id === commandOrId);
  if (!command) throw new Error(`未知指令：${commandOrId}`);
  return command;
}

/**
 * 该指令在这一天的两个分支：**休息日成功值**与**失败值**（真实数值，未按成功率加权）。
 *
 * 非压力属性：休息日全部 ×4（日常与社团同倍率）；失败时上升的减半。
 * 压力（负面指标）：成功时上升的不适用休息日倍率，只有下降的适用；失败统一是
 * **成功值的一半 + 1**（平日以未加成成功值为基准，休息日以加成后成功值为基准）。
 */
export function branches(rules, command, dayKind) {
  const restDay = dayKind === REST_DAY;
  const bonus = rules.restDayBonus;
  const negativeId = rules.attributes.find((a) => a.direction === 'down').id;
  const success = {};
  const failure = {};

  for (const attribute of rules.attributes) {
    const id = attribute.id;
    const base = command.effects[id];
    if (id === negativeId) {
      const successValue = restDay && base < 0 ? base * bonus.stressReduction : base;
      const failureValue = base > 0 ? base + 1 : successValue / 2 + 1;
      success[id] = successValue;
      failure[id] = failureValue;
      continue;
    }
    const scaled = restDay ? base * (command.kind === 'club' ? bonus.club : bonus.daily) : base;
    success[id] = scaled;
    failure[id] = scaled > 0 ? scaled / 2 : scaled;
  }
  return { success, failure };
}

/**
 * 期望变动（真实数值）：成功率加权后的当日效果。全部 10 项属性都有值。
 * 这是期望值的**唯一**来源——求解器与结算都从这里取。
 */
export function expectedEffects(rules, commandOrId, dayKind) {
  const command = resolveCommand(rules, commandOrId);
  if (!command) return Object.fromEntries(rules.attributes.map((a) => [a.id, 0]));
  const { success, failure } = branches(rules, command, dayKind);
  const rate = command.successRate;
  const out = {};
  for (const attribute of rules.attributes) {
    const id = attribute.id;
    out[id] = rate * success[id] + (1 - rate) * failure[id];
  }
  return out;
}

/**
 * 某一天的社团经验增益。
 *
 * `社团集训指令`（`clubCamp`）**一律 +2**，不看星期/月份；普通社团指令平日 +1、休息日 +4。
 * `rule` 是这一天的日历对象（含 `activity`）；拿不到活动信息时按普通规则处理。
 */
export function clubExperienceGainOn(rules, dayKind, rule = null) {
  const gain = rules.clubExperienceGain;
  if (rule?.activity?.command === 'clubCamp') return gain.camp;
  return dayKind === REST_DAY ? gain.restDay : gain.weekday;
}

const clamp = (value, attribute) => Math.min(attribute.max, Math.max(attribute.min, value));

/**
 * 推进一天。
 *
 * `commandId` 为 `null` / `undefined` 表示**空过**：不执行、不判定成败、也不结算，
 * 状态原样带入下一天。`state` 不被修改。
 *
 * 第 5 参是这一天的日历对象（含 `activity`），用来判定 `clubCamp` 的社团经验 +2；
 * 不传则按普通社团指令的增益处理。
 */
export function apply(rules, state, commandId, dayKind, rule = null) {
  const attributes = { ...state.attributes };
  const command = resolveCommand(rules, commandId);

  if (!command) return { ...state, attributes };

  const expected = expectedEffects(rules, command, dayKind);
  for (const attribute of rules.attributes) {
    const id = attribute.id;
    attributes[id] = clamp(attributes[id] + expected[id], attribute);
  }

  // 社团经验的增长只由这一处产生：加到**第 10 个属性** `clubExperience` 上，不受成败影响。
  // 落点是属性 `clubExperience`，**不是** `command.clubId`——后者是社团 id（如 `science-club`），
  // 根本不是属性。写错会让增益被静默丢弃（历史上真发生过）。
  if (command.kind === 'club') {
    const gain = clubExperienceGainOn(rules, dayKind, rule);
    const attribute = rules.attributes.find((a) => a.id === CLUB_EXPERIENCE_ID);
    if (!attribute) {
      throw new Error(`规则里缺少社团经验属性 ${CLUB_EXPERIENCE_ID}，社团指令的增益无处可加`);
    }
    attributes[CLUB_EXPERIENCE_ID] = clamp(attributes[CLUB_EXPERIENCE_ID] + gain, attribute);
  }

  return { ...state, attributes };
}
