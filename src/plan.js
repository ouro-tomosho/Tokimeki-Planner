// 规划入口。
//
// 接缝是 `plan(input, { assignments }) → PlanResult`：规则在**构造时**注入，调用方只传
// input。这一层把日历、社团状态与单日结算接起来：每一天按它实际执行的指令结算，不可用
// 的社团指令不会被结算。指令还没有被"求解"时就是待定。
//
// 检查点的判定在 `evaluateCheckpoints` 里汇总：它读这份逐日结果，自己重算
// 达标 / 未达标 / 已破线 / 首次达成日（含全局硬约束）。这里只负责把每天结算对。

import { isClubSlot } from './commands.js';
import { buildCalendar } from './calendar.js';
import { buildCheckpointSchedule, clubWeekMandate, evaluateCheckpoints } from './checkpoints.js';
import { clubBlockReason, clubCommandId, createClubLookup } from './clubs.js';
import { validateInput } from './input.js';
import { validateRules, withSuccessRate } from './rules.js';
import { REST_DAY, WEEKDAY, apply } from './settlement.js';

export function createPlanner(rules) {
  const ruleProblems = validateRules(rules);
  const schedule = null;

  return function plan(input, { assignments = null } = {}) {
    if (ruleProblems.length > 0) {
      return { ok: false, status: 'invalid-rules', problems: ruleProblems };
    }

    const inputProblems = validateInput(input, rules);
    if (inputProblems.length > 0) {
      return { ok: false, status: 'invalid-input', problems: inputProblems };
    }

    // 成功率覆盖的**唯一**应用点：日历、结算、检查点、重放全部走这份"有效规则"，
    // 免得"求解用的成功率"与"判定用的成功率"分叉（这个项目最贵的一条教训）。
    const activeRules = withSuccessRate(rules, input.successRate);

    const calendar = buildCalendar(activeRules, input, assignments);
    const clubAt = createClubLookup(input);
    // 全局约束的落点是每个结算日；日历就在手边，直接传进去，判定与搜索共用同一份。
    const schedule = buildCheckpointSchedule(rules, input, calendar.days);
    let state = { attributes: { ...input.attributes } };

    // 「第一次执行的社团指令必须是周日的日指令」（数据见 `rules.clubFirstCommand`）。
    // 休息日只会解析到**日指令**（见 calendar.js 的 `resolveCommand`：休息日读 `dayCommands`），
    // 而周日按定义就是休息日——所以"周日的日指令"落到判定上就是"该天的 weekday 等于规则里的值"。
    // 未配置这条规则时 `clubFirstSatisfied` 直接为真，判定不受影响。
    const clubCommandIds = new Set(rules.commands.filter((c) => c.kind === 'club').map((c) => c.id));
    const clubFirstWeekday = rules.clubFirstCommand?.weekday ?? null;
    let clubFirstSatisfied = clubFirstWeekday === null;

    const days = calendar.days.map((day) => {
      const club = clubAt(day.date);
      // 「当前社团指令」占位符在这里展开：具体是哪一条取决于**当时加入的社团**。
      const effectiveCommandId = isClubSlot(day.commandId) ? clubCommandId(activeRules, club) : day.commandId;
      const commandBlocked = effectiveCommandId
        ? clubBlockReason(activeRules, activeRules.commands.find((c) => c.id === effectiveCommandId), club, day.date)
        : null;

      // 结算前的快照：小目标 / 结局目标要判"前 1 天的结算值"（所有者 2026-10-07 裁决），
      // 也就是**结算这一天之前**的值——属性在两次结算之间不变，所以这就是前一个自然日的结算结果。
      // 不能用 days 数组的"前一个 index"来取：时间轴上有不结算的日子（起点快照、空过、跳过、终点）。
      const attributesBefore = { ...state.attributes };

      if (day.isSettled && effectiveCommandId && commandBlocked === null) {
        // 第 5 参传 `day`：8 月集训周的社团经验加成要按"哪一天"判定（见 settlement.js）。
        state = apply(activeRules, state, effectiveCommandId, day.isRestDay ? REST_DAY : WEEKDAY, day);
      }

      // 社团集训周：该周全部平日必须执行当前社团的指令（回家社例外）。空过、待定、
      // 换成别的指令都算违反；休息日执行自己的日指令，不受这条约束。
      const mandate = clubWeekMandate(rules, club, day.weekStart);
      const executed = day.isSettled && effectiveCommandId && commandBlocked === null
        ? effectiveCommandId
        : null;
      const clubWeekViolation = mandate !== null
        && !day.isRestDay
        && (day.isSettled || day.isEmpty)
        && executed !== mandate;

      // 首次社团指令：只有在**那之前**还没出现过合规的首次执行时才算违规。
      // 于是"先在工作日用了社团指令、之后才在周日补一次"仍然违规（违规天 = 周日那次之前的社团天），
      // 而"第一个社团指令就落在周日"完全合规。
      //
      // **集训周强制的那几天豁免**：集训周是另一条硬约束（必须执行社团指令），当"已玩到"落在
      // 集训周中间时，本时间轴上第一个社团指令**必然**是工作日——两条规则会互相判死。
      // 所以这条规则只管**自由选择**的社团指令：强制执行的既不算合规、也不算违规。
      const isMandatedClub = mandate !== null && !day.isRestDay && executed === mandate;
      let clubFirstViolation = false;
      if (executed !== null && clubCommandIds.has(executed) && !isMandatedClub && !clubFirstSatisfied) {
        if (day.weekday === clubFirstWeekday) clubFirstSatisfied = true;
        else clubFirstViolation = true;
      }

      return {
        ...day,
        // 占位符已展开成实际执行的指令；界面要显示"这一格真正跑的是什么"。
        effectiveCommandId,
        commandBlocked,
        clubWeekViolation,
        clubFirstViolation,
        attributes: { ...state.attributes },
        // 结算前的值：小目标 / 结局目标的判定基准（见上面的注释）。
        attributesBefore,
      };
    });

    return {
      ok: true,
      status: 'planned',
      playedUpTo: input.playedUpTo,
      endDate: rules.timeline.end,
      lastSettlement: rules.timeline.lastSettlement,
      days,
      weeks: calendar.weeks,
      sequence: calendar.sequence,
      summary: calendar.summary,
      goals: evaluateCheckpoints(activeRules, input, days),
      finalAttributes: { ...state.attributes },
      successRate: input.successRate ?? null,
      ruleSummary: {
        attributes: rules.attributes.length,
        commands: rules.commands.length,
        clubs: rules.clubs.length,
        checkpoints: schedule.length,
      },
    };
  };
}

/** 这一天是不是它所在自然周的第一天。 */
function isWeekStart(day) {
  return day.date === day.weekStart;
}
