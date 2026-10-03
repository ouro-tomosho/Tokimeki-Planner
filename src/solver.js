// 求解器：把使用者**没有指定**的那些槽位填满。
//
// 计划：
//   - 只做确定性推算，不掷骰子。同一输入必得同一结果。
//   - 不追求数学最优，也不承诺全局最优（见规格）。
//   - 绝不自行选择或切换社团——社团只来自使用者。
//   - 空过不在候选池里：它只能由使用者的跳过操作产生。
//
// 算法是**滚动时域贪心**：按日期顺序走过每一周，为每个槽位逐一试遍候选，
// 用"离各项目标还差多少"加权打分，取分最高者并落定，然后带着新的状态进入下一周。
//
// 为什么不用"每个候选都重算整份规划"的局部搜索：一次完整规划要 5.8 ms，
// 305 个槽位 × 17 个候选 × 全量重算 ≈ 30 秒/轮，够不上"秒到十几秒"。
// 滚动时域只看当前槽位的那几天（约 0.04 ms/次），整趟几十毫秒，代价是短视。

import { buildCalendar } from './calendar.js';
import { createPlanner } from './plan.js';
import {
  availableCommandIds,
  clubBlockReason,
  createClubLookup,
  seededClubExperience,
} from './clubs.js';
import { meets } from './constraints.js';
import { REST_DAY, WEEKDAY, createSettlement } from './settlement.js';

// 破坏硬不变量的代价按**破坏程度**计，而不是每天一个固定值：
// 固定值在"所有候选都破"的死局里会把梯度抹平，求解器就再也爬不出来。
const BREACH_PENALTY = 1e6;

// 打分里的并列决胜项。它们只在前两层打平时才起作用，与 ADR-0002 的层序一致：
// 先正向属性等权总和（越大越好），再负面指标（越小越好）。
const POSITIVE_SUM_TIEBREAK = 1e-6;
const STRESS_TIEBREAK = 1e-9;

// 打分时给硬不变量留一条安全边距。真实的约束判定仍按原阈值（由 constraints.js 负责），
// 这条边距只影响求解器"愿意贴多近"——只看一周的贪心若贴着悬崖走，迟早会掉下去。
const INVARIANT_MARGIN = 4;

// 终局修补的预算。贪心是滚动时域的、短视的；结局目标只看终点状态，
// 所以排完之后再单独收一次尾，只在前面的结果没达标时才跑（这一步会慢到秒级）。
const REPAIR_PASSES = 2;
const REPAIR_WEEKS = 10;

export function createSolver(rules) {
  const settleDay = createSettlement(rules);
  const scale = rules.fixedPointScale;
  const negativeIndicatorId = rules.attributes.find((a) => a.direction === 'down').id;
  const positiveIds = rules.attributes
    .filter((attribute) => attribute.direction === 'up')
    .map((attribute) => attribute.id);
  const clubExperienceId = rules.clubExperience.id;
  // 必须在这里建：下面的 return 之后就再也执行不到了（函数声明会提升，const 不会）。
  const planner = createPlanner(rules);

  function initialState(input) {
    return {
      attributes: Object.fromEntries(
        Object.entries(input.attributes).map(([id, value]) => [id, value * scale]),
      ),
      clubExperience: seededClubExperience(rules, input, scale),
    };
  }

  /**
   * 排一份日程：滚动时域贪心，不达标再收尾。
   */
  function search(input) {
    const calendar = buildCalendar(rules, input);
    const clubAt = createClubLookup(input);
    const dayByDate = new Map(calendar.days.map((day) => [day.date, day]));

    // 起点已满足的全局约束，在整个规划里都是硬不变量——求解时不得破。
    const hardConstraints = input.globalConstraints.filter((goal) =>
      meets(input.attributes[goal.attribute], goal.op, goal.value),
    );

    const valueOf = (state, club, id) =>
      id === clubExperienceId
        ? club
          ? (state.clubExperience[club] ?? 0) / scale
          : 0
        : state.attributes[id] / scale;

    /**
     * 此刻每个属性"离目标还差多少"，取所有目标里最严的那条。
     * 小目标的求和缺口按集合成员数摊到每个成员头上。
     */
    function targetsAt(state, club, date) {
      const targets = new Map();
      const consider = (attribute, op, value) => {
        const current = targets.get(attribute);
        if (!current) {
          targets.set(attribute, { op, value });
          return;
        }
        if (op === '>=' && (current.op !== '>=' || value > current.value)) {
          targets.set(attribute, { op, value });
        }
        if (op === '<' && (current.op !== '<' || value < current.value)) {
          targets.set(attribute, { op, value });
        }
      };

      for (const goal of input.globalConstraints) consider(goal.attribute, goal.op, goal.value);
      for (const goal of input.endingGoals) consider(goal.attribute, goal.op, goal.value);
      for (const goal of input.miniGoals) {
        if (goal.deadline < date) continue; // 截止日已过，不再影响决策
        const sum = goal.attributes.reduce((total, id) => total + valueOf(state, club, id), 0);
        const gap = goal.op === '>=' ? goal.value - sum : sum - (goal.value - 1);
        if (gap <= 0) continue;
        const share = gap / goal.attributes.length;
        for (const id of goal.attributes) consider(id, '>=', valueOf(state, club, id) + share);
      }
      return targets;
    }

    function needOf(current, target) {
      return target.op === '=' ? 0 : target.op === '>=' ? Math.max(0, target.value - current) : Math.max(0, current - (target.value - 1));
    }

    /** 一个槽位上的候选：不可用的社团指令不进候选池。 */
    const candidatesAt = (date) => availableCommandIds(rules, clubAt(date), date);

    /**
     * 按与 plan 相同的规则结算这几天；不可用的指令不执行。
     * 同时逐日检查硬不变量——只看周末状态会漏掉"周中破了、周末又回来了"。
     */
    function simulate(state, days, commandId) {
      let next = state;
      let breachCost = 0;
      const command = commandId
        ? rules.commands.find((entry) => entry.id === commandId)
        : null;

      for (const day of days) {
        if (day.isSettled && command && clubBlockReason(rules, command, clubAt(day.date), day.date) === null) {
          next = settleDay(next, commandId, day.isRestDay ? REST_DAY : WEEKDAY);
        }
        const club = clubAt(day.date);
        for (const goal of hardConstraints) {
          breachCost += breachSeverity(valueOf(next, club, goal.attribute), goal);
        }
      }
      return { state: next, breachCost };
    }

    /** 破了多少：满足阈值**并留住安全边距**时为 0，否则是差出的量。 */
    function breachSeverity(value, goal) {
      const limit = goal.op === '>=' ? goal.value + INVARIANT_MARGIN : goal.value - INVARIANT_MARGIN;
      if (meets(value, goal.op, limit)) return 0;
      return goal.op === '>=' ? limit - value : value - (limit - 1);
    }

    /** 离各项目标推进了多少：按"还差多少"加权，所以越缺什么越想去补什么。 */
    function goalProgress(before, after, targets, club) {
      let progress = 0;
      for (const [attribute, target] of targets) {
        // 社团经验是独立的一张表，不在 state.attributes 里——必须走同一个取值口径，
        // 否则这里会算出 NaN，导致每个槽位都悄悄退回候选列表的第一个。
        const beforeValue = valueOf(before, club, attribute);
        const afterValue = valueOf(after, club, attribute);
        progress +=
          (target.op === '>=' ? afterValue - beforeValue : beforeValue - afterValue) *
          needOf(beforeValue, target);
      }
      return progress;
    }

    function positiveSumDelta(before, after) {
      let delta = 0;
      for (const id of positiveIds) delta += (after.attributes[id] - before.attributes[id]) / scale;
      return delta;
    }

    const stressDelta = (before, after) =>
      (after.attributes[negativeIndicatorId] - before.attributes[negativeIndicatorId]) / scale;

    /** 打分：破坏代价 → 离目标推进了多少 → 正向总和 → 压力（与 ADR-0002 同序）。 */
    function scoreOf(before, after, breachCost, targets, club) {
      return (
        -BREACH_PENALTY * breachCost +
        goalProgress(before, after, targets, club) +
        POSITIVE_SUM_TIEBREAK * positiveSumDelta(before, after) -
        STRESS_TIEBREAK * stressDelta(before, after)
      );
    }

    function pick(state, days, candidates, club, date) {
      const targets = targetsAt(state, club, date);
      let bestId = candidates[0] ?? null;
      let bestScore = -Infinity;
      for (const id of candidates) {
        const outcome = simulate(state, days, id);
        const score = scoreOf(state, outcome.state, outcome.breachCost, targets, club);
        if (score > bestScore) {
          bestScore = score;
          bestId = id;
        }
      }
      return bestId;
    }

    let state = initialState(input);
    const weekCommands = {};
    const dayCommands = {};

    for (const week of calendar.weeks) {
      const days = week.days.map((date) => dayByDate.get(date));
      const restDays = days.filter((day) => day.isRestDay);
      const workdays = days.filter((day) => !day.isRestDay);

      // 决策顺序就是日历的顺序：先周日的日指令与结算，再定本周周指令，最后各平日。
      for (const day of restDays) {
        const pinned = input.dayCommands[day.date];
        let chosen = pinned;
        if (chosen === undefined) {
          chosen = pick(state, [day], candidatesAt(day.date), clubAt(day.date), day.date);
          dayCommands[day.date] = chosen;
        }
        state = simulate(state, [day], chosen).state;
      }

      if (workdays.length > 0) {
        const pinned = input.weekCommands[week.start];
        let chosen = pinned;
        if (chosen === undefined) {
          const date = workdays[0].date;
          chosen = pick(state, workdays, candidatesAt(date), clubAt(date), date);
          weekCommands[week.start] = chosen;
        }
        state = simulate(state, workdays, chosen).state;
      }
    }

    const assignments = { weekCommands, dayCommands };

    // 滚动时域贪心对"终点长什么样"没有直接视野，只靠加权引导。
    // 没达标就再收一次尾：从后往前逐个槽位试遍候选，只接受让整份规划更好的改动。
    if (planner(input, { assignments }).goals.ok) return assignments;
    return repair(input, assignments);
  }

  /**
   * 排一份日程。合并起点与已玩到之后，求解器不再需要上一份日程、
   * 也不再需要在某个日期之前冻结前缀：每次都是从已玩到（含）往后整份重排。
   */
  return function solve(input) {
    return search(input);
  };

  /** 一份日程的好坏：先看达标，再看还差多少，最后才是正向总和与压力。 */
  function objectiveOf(result) {
    let score = result.goals.score.positiveSum - result.goals.score.negative * 1e-3;
    for (const goal of result.goals.endingGoals) {
      if (goal.state !== 'met') score -= goal.shortfall * 1e3;
    }
    for (const goal of result.goals.miniGoals) {
      if (goal.state !== 'met') score -= goal.shortfall * 1e3;
    }
    for (const goal of result.goals.globalConstraints) {
      if (goal.state !== 'met') score -= 1e6;
    }
    return score;
  }

  function repair(input, assignments) {
    const clubAt = createClubLookup(input);
    const calendar = buildCalendar(rules, input, assignments);
    const dayByDate = new Map(calendar.days.map((day) => [day.date, day]));
    const candidatesAt = (date) => availableCommandIds(rules, clubAt(date), date);

    const evaluate = () => planner(input, { assignments });
    let best = objectiveOf(evaluate());

    for (let pass = 0; pass < REPAIR_PASSES; pass += 1) {
      if (evaluate().goals.ok) break;
      let improved = false;

      // 从终点往回扫：结局目标只取决于终点，越靠近终点越有效。
      const recent = calendar.weeks.slice(-REPAIR_WEEKS).reverse();
      for (const week of recent) {
        const days = week.days.map((date) => dayByDate.get(date));
        const workdays = days.filter((day) => !day.isRestDay);

        const weekDate = workdays[0]?.date;
        if (workdays.length > 0 && weekDate !== undefined && input.weekCommands[week.start] === undefined) {
          const date = workdays[0].date;
          const original = assignments.weekCommands[week.start];
          for (const id of candidatesAt(date)) {
            if (id === original) continue;
            assignments.weekCommands[week.start] = id;
            const score = objectiveOf(evaluate());
            if (score > best) {
              best = score;
              improved = true;
            } else {
              assignments.weekCommands[week.start] = original;
            }
          }
        }

        for (const day of days) {
          if (!day.isRestDay || !day.isSettled) continue;
          if (input.dayCommands[day.date] !== undefined) continue;
          const original = assignments.dayCommands[day.date];
          for (const id of candidatesAt(day.date)) {
            if (id === original) continue;
            assignments.dayCommands[day.date] = id;
            const score = objectiveOf(evaluate());
            if (score > best) {
              best = score;
              improved = true;
            } else {
              assignments.dayCommands[day.date] = original;
            }
          }
        }
      }

      if (!improved) break;
    }
    return assignments;
  }
}
