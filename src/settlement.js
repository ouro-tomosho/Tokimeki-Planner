// 单日结算内核。
//
// 预先商定的接缝是 `settleDay(状态, 当日指令, 当日类型) → 新状态`：规则在**构造时**
// 注入，纯函数、不碰 DOM，因此同一份代码既能在内联 Worker 里跑，也能在 Node 测试里
// 直接断言。属性以定点整数保存（真实值 × fixedPointScale），每天结算后向下取整
// 到 1e-6 的整数倍并夹在 [min, max] 内。

export const WEEKDAY = 'weekday';
export const REST_DAY = 'restDay';

export function createSettlement(rules) {
  const scale = rules.fixedPointScale;
  const attributeIds = rules.attributes.map((a) => a.id);
  const limits = new Map(rules.attributes.map((a) => [a.id, a]));
  const reverseIndicatorId = rules.attributes.find((a) => a.direction === 'down').id;
  const commands = new Map(rules.commands.map((c) => [c.id, c]));

  const clampScaled = (value, min, max) =>
    Math.min(max * scale, Math.max(min * scale, Math.floor(value)));

  /** 成功时的当日效果：先套休息日加成。 */
  function boostedEffects(command, dayKind) {
    const bonus = command.kind === 'club' ? rules.restDayBonus.club : rules.restDayBonus.daily;
    const out = {};
    for (const id of attributeIds) {
      const value = command.effects[id];
      if (dayKind !== REST_DAY) {
        out[id] = value;
      } else if (id === reverseIndicatorId) {
        // 负面指标不吃上升加成；只有「休息」的下降效果在休息日 ×4。
        out[id] =
          command.isRestCommand && value < 0
            ? value * rules.restDayBonus.restCommandNegative
            : value;
      } else {
        out[id] = value > 0 ? value * bonus : value;
      }
    }
    return out;
  }

  /** 同一件事失败之后是什么样。 */
  function failureEffects(boosted) {
    const out = {};
    for (const id of attributeIds) {
      const value = boosted[id];
      out[id] = id === reverseIndicatorId
        ? value + 1 // 压力不参与减半，按原值再额外 +1
        : value > 0
          ? value / 2 // 上升的减半
          : value; // 下降的照常
    }
    return out;
  }

  /** 期望变动（真实数值）：成功率加权后的当日效果。 */
  function expectedEffects(command, dayKind) {
    const boosted = boostedEffects(command, dayKind);
    const failure = failureEffects(boosted);
    const rate = command.successRate;
    const out = {};
    for (const id of attributeIds) {
      out[id] = rate * boosted[id] + (1 - rate) * failure[id];
    }
    return out;
  }

  function clubExperienceEarned(command, dayKind) {
    if (command.kind !== 'club') return 0;
    return dayKind === REST_DAY ? rules.clubExperienceGain.restDay : rules.clubExperienceGain.weekday;
  }

  return function settleDay(state, commandId, dayKind) {
    const attributes = { ...state.attributes };
    const clubExperience = { ...state.clubExperience };

    // 空过：不执行、不判定成败、也不结算，状态原样带入下一天。
    if (commandId === null || commandId === undefined) return { attributes, clubExperience };

    const command = commands.get(commandId);
    if (!command) throw new Error(`未知指令：${commandId}`);

    const expected = expectedEffects(command, dayKind);
    for (const id of attributeIds) {
      const limit = limits.get(id);
      attributes[id] = clampScaled(attributes[id] + expected[id] * scale, limit.min, limit.max);
    }

    const earned = clubExperienceEarned(command, dayKind);
    if (earned > 0) {
      const clubId = command.clubId;
      const current = clubExperience[clubId] ?? 0;
      clubExperience[clubId] = clampScaled(
        current + earned * scale,
        rules.clubExperience.min,
        rules.clubExperience.max,
      );
    }

    return { attributes, clubExperience };
  };
}
