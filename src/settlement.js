// 单日结算内核。
//
// 预先商定的接缝是 `settleDay(状态, 当日指令, 当日类型) → 新状态`：规则在**构造时**
// 注入，纯函数、不碰 DOM，因此同一份代码既能在内联 Worker 里跑，也能在 Node 测试里
// 直接断言。属性以定点整数保存（真实值 × fixedPointScale），每天结算后向下取整
// 到 1e-6 的整数倍并夹在 [min, max] 内。

export const WEEKDAY = 'weekday';
export const REST_DAY = 'restDay';

/**
 * 这条指令在这一天给它的社团加多少经验；非社团指令为 0。
 *
 * 导出是因为除了逐日结算，还有第二处要用它：`rollForward` 重放求解结果来补齐
 * 各社团在起点上的计数（求解结果每天只暴露"当前社团"那一份）。两处共用一个口径。
 */
export function clubExperienceGain(rules, command, dayKind) {
  if (!command || command.kind !== 'club') return 0;
  return dayKind === REST_DAY ? rules.clubExperienceGain.restDay : rules.clubExperienceGain.weekday;
}

export function createSettlement(rules) {
  const scale = rules.fixedPointScale;
  const attributeIds = rules.attributes.map((a) => a.id);
  const limits = new Map(rules.attributes.map((a) => [a.id, a]));
  const negativeIndicatorId = rules.attributes.find((a) => a.direction === 'down').id;
  const commands = new Map(rules.commands.map((c) => [c.id, c]));

  const clampScaled = (value, min, max) =>
    Math.min(max * scale, Math.max(min * scale, Math.floor(value)));

  /**
   * 成功时的当日效果：先套休息日加成。
   * 平日不加成；休息日只把**上升**的加成（日常 ×4、社团 ×6），下降的不动；
   * 负面指标既不参加上升加成，只有「休息」的下降效果在休息日 ×4。
   */
  function boostedEffects(command, dayKind) {
    const out = {};
    for (const id of attributeIds) {
      const value = command.effects[id];

      if (dayKind !== REST_DAY) {
        out[id] = value;
        continue;
      }
      if (id === negativeIndicatorId) {
        out[id] =
          command.isRestCommand && value < 0
            ? value * rules.restDayBonus.restCommandNegative
            : value;
        continue;
      }
      if (value <= 0) {
        out[id] = value;
        continue;
      }
      out[id] = value * (command.kind === 'club' ? rules.restDayBonus.club : rules.restDayBonus.daily);
    }
    return out;
  }

  /**
   * 同一件事失败之后是什么样。
   * 正向属性：上升的减半、下降的照常。
   * 负面指标：**不减半**，取它在成功时的**原值**再额外 +1（不加成也不打折）。
   */
  function failureEffects(original, boosted) {
    const out = {};
    for (const id of attributeIds) {
      if (id === negativeIndicatorId) {
        out[id] = original[id] + 1;
        continue;
      }
      const value = boosted[id];
      out[id] = value > 0 ? value / 2 : value;
    }
    return out;
  }

  /** 期望变动（真实数值）：成功率加权后的当日效果。 */
  function expectedEffects(command, dayKind) {
    const boosted = boostedEffects(command, dayKind);
    const failure = failureEffects(command.effects, boosted);
    const rate = command.successRate;
    const out = {};
    for (const id of attributeIds) {
      out[id] = rate * boosted[id] + (1 - rate) * failure[id];
    }
    return out;
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

    const earned = clubExperienceGain(rules, command, dayKind);
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
