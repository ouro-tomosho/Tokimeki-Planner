// 约束判定与目标函数。
//
// 三层（见 ADR-0002）：全部硬约束达标 → 正向属性等权总和最大 → 负面指标最小。
//
// 三类硬约束：
//   全局约束  每次每日结算后都要成立。起点已满足 → 硬不变量；起点未满足 → 尽快满足。
//   小目标    截止日期 + 一个属性集合 + 一个求和阈值。
//   结局目标  在时间轴终点逐项评估。
//
// 空过的天不发生结算，因此**不参与**全局约束的判定。

const EPSILON = 1e-9;

/** 阈值比较：小数部分直接舍去（见数据需求清单）。 */
export function meets(value, op, threshold) {
  const floored = Math.floor(value);
  return op === '>=' ? floored >= threshold : floored < threshold;
}

/** 还差多少才能满足这个阈值。 */
export function shortfallOf(actual, op, threshold) {
  if (meets(actual, op, threshold)) return 0;
  return op === '>=' ? threshold - actual : actual - (threshold - 1);
}

export function evaluateGoals(rules, input, days) {
  const positiveIds = rules.attributes.filter((a) => a.direction === 'up').map((a) => a.id);
  const negativeId = rules.attributes.find((a) => a.direction === 'down').id;
  const endState = days.length > 0 ? days[days.length - 1].attributes : input.attributes;
  const settledDays = days.filter((day) => day.isSettled);

  const globalConstraints = input.globalConstraints.map((goal) =>
    evaluateGlobalConstraint(goal, input.attributes, settledDays),
  );
  const miniGoals = input.miniGoals.map((goal) => evaluateMiniGoal(rules, goal, days));
  const endingGoals = input.endingGoals.map((goal) => evaluateEndingGoal(goal, endState));

  return {
    ok: [...globalConstraints, ...miniGoals, ...endingGoals].every(
      (entry) => entry.state === 'met',
    ),
    globalConstraints,
    miniGoals,
    endingGoals,
    score: {
      positiveSum: positiveIds.reduce((sum, id) => sum + endState[id], 0),
      negative: endState[negativeId],
    },
  };
}

function evaluateGlobalConstraint(goal, startAttributes, settledDays) {
  // 起点已满足 → 往后每天都不得破；起点未满足 → 尽快满足，不直接判定无解。
  const mode = meets(startAttributes[goal.attribute], goal.op, goal.value) ? 'invariant' : 'asap';

  const violatedOn = [];
  let metOn = null;
  for (const day of settledDays) {
    if (meets(day.attributes[goal.attribute], goal.op, goal.value)) {
      if (metOn === null) metOn = day.date;
    } else {
      violatedOn.push(day.date);
    }
  }

  const state =
    mode === 'invariant' ? (violatedOn.length === 0 ? 'met' : 'unmet') : metOn === null ? 'unmet' : 'met';

  return { ...goal, mode, state, metOn, violatedOn };
}

function valueOf(rules, day, id) {
  return id === rules.clubExperience.id ? day.clubExperience : day.attributes[id];
}

function evaluateMiniGoal(rules, goal, days) {
  // 在截止日当天（含）结算之后评估；若截止日落在时间轴之外，取最靠后的那一天。
  const at = [...days].reverse().find((day) => day.date <= goal.deadline) ?? days[0];
  const actual = goal.attributes.reduce((sum, id) => sum + valueOf(rules, at, id), 0);

  return {
    ...goal,
    evaluatedOn: at.date,
    actual,
    state: meets(actual, goal.op, goal.value) ? 'met' : 'unmet',
    shortfall: shortfallOf(actual, goal.op, goal.value),
  };
}

function evaluateEndingGoal(goal, endState) {
  const actual = endState[goal.attribute];
  return {
    ...goal,
    actual,
    state: meets(actual, goal.op, goal.value) ? 'met' : 'unmet',
    shortfall: shortfallOf(actual, goal.op, goal.value),
  };
}

/**
 * ADR-0002 的三层比较：硬约束 → 正向等权总和最大 → 负面指标最小。
 * 返回负数表示 a 更优，正数表示 b 更优，0 表示打平。
 */
export function comparePlans(a, b) {
  if (a.goals.ok !== b.goals.ok) return a.goals.ok ? -1 : 1;

  const sumDelta = a.goals.score.positiveSum - b.goals.score.positiveSum;
  if (Math.abs(sumDelta) > EPSILON) return sumDelta > 0 ? -1 : 1;

  const negativeDelta = a.goals.score.negative - b.goals.score.negative;
  if (Math.abs(negativeDelta) > EPSILON) return negativeDelta < 0 ? -1 : 1;

  return 0;
}
