// 规划入口。
//
// 接缝是 `plan(input, { assignments }) → PlanResult`：规则在**构造时**注入，调用方只传
// input。这一层把日历、社团状态与单日结算接起来：每一天按它实际执行的指令结算；活动日
// 的绑定指令是硬强制，`club`/`clubCamp` 占位符在这里按当天社团展开。指令还没有被"求解"
// 时就是待定。
//
// 检查点的判定在 `evaluateCheckpoints` 里汇总：它读这份逐日结果，自己重算
// 达标 / 未达标 / 已破线 / 首次达成日（含全局硬约束）。这里只负责把每天结算对。

import { isClubCampSlot, isClubSlot } from './commands.js';
import { buildCalendar, createClubLookup } from './calendar.js';
import { buildCheckpointSchedule, evaluateCheckpoints } from './checkpoints.js';
import { clubCommandId, commandBlockReason } from './clubs.js';
import { weekStartOf } from './dates.js';
import { validateInput } from './input.js';
import { validateRules, withSuccessRate } from './rules.js';
import { REST_DAY, WEEKDAY, apply } from './settlement.js';

export function createPlanner(rules) {
  const ruleProblems = validateRules(rules);

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

    const clubAt = createClubLookup(input, rules);
    const calendar = buildCalendar(activeRules, input, assignments, clubAt);
    // 全局约束的落点是每个结算日；日历就在手边，直接传进去，判定与搜索共用同一份。
    const schedule = buildCheckpointSchedule(rules, input, calendar.days);
    let state = { attributes: { ...input.attributes } };
    // 每个社团各自的经验；切换时写回旧社团、读入目标社团。
    const clubExperiences = { ...(input.clubExperiences ?? {}) };

    // 「第一次执行的社团指令必须是周日的日指令」（数据见 `rules.clubFirstCommand`）。
    //
    // **整条豁免**（所有者 2026-10-09 明确）：使用者**已经选了社团**、且「已玩到」落在
    // 集训周内时，按"并非第一次执行社团指令"处理。活动日的强制社团指令也属于"已经在
    // 进行"的活动，不计入这条规则；规则只约束自由选择的第一次社团指令。
    const clubCommandIds = new Set(rules.commands.filter((c) => c.kind === 'club').map((c) => c.id));
    const clubFirstWeekday = rules.clubFirstCommand?.weekday ?? null;
    const snapshotWeek = weekStartOf(input.playedUpTo);
    const snapshotInClubWeek = (rules.calendar?.clubWeeks ?? []).some((week) => week.date === snapshotWeek);
    const clubFirstWaived =
      clubFirstWeekday === null || (clubAt(input.playedUpTo) !== null && snapshotInClubWeek);
    let clubFirstSatisfied = clubFirstWaived;

    const days = calendar.days.map((day) => {
      const club = clubAt(day.date);
      // 「当前社团指令」/「社团集训指令」占位符在这里展开：具体是哪一条取决于当时加入的社团。
      const effectiveCommandId =
        isClubSlot(day.commandId) || isClubCampSlot(day.commandId)
          ? clubCommandId(activeRules, club)
          : day.commandId;
      // 不可执行的原因：社团不符/未解锁/未入社，或「休息日专属指令」被钉在平日。
      const commandBlocked = effectiveCommandId
        ? commandBlockReason(
          activeRules,
          activeRules.commands.find((c) => c.id === effectiveCommandId),
          club,
          day.date,
          day.isRestDay,
        )
        : null;

      // 结算前的快照：小目标 / 结局目标要判"前 1 天的结算值"（所有者 2026-10-07 裁决），
      // 也就是**结算这一天之前**的值——属性在两次结算之间不变，所以这就是前一个自然日的结算结果。
      const attributesBefore = { ...state.attributes };

      // 社团切换：先把旧社团当前经验写回映射，再把当前经验切到目标社团。
      if (day.isSwitch) {
        if (clubAt.oldClub) clubExperiences[clubAt.oldClub] = state.attributes.clubExperience;
        state.attributes.clubExperience = day.switchTarget
          ? (clubExperiences[day.switchTarget] ?? 0)
          : 0;
      }

      if (day.isSettled && effectiveCommandId && commandBlocked === null) {
        // 第 5 参传 `day`：社团经验加成要按"哪一天"判定（见 settlement.js）。
        state = apply(activeRules, state, effectiveCommandId, day.isRestDay ? REST_DAY : WEEKDAY, day);
      }

      // 首次社团指令：活动日强制的社团指令不参与这条规则（它们不是自由选择）。
      const executed = day.isSettled && effectiveCommandId && commandBlocked === null
        ? effectiveCommandId
        : null;
      let clubFirstViolation = false;
      if (!day.isActivity && executed !== null && clubCommandIds.has(executed) && !clubFirstSatisfied) {
        if (day.weekday === clubFirstWeekday) clubFirstSatisfied = true;
        else clubFirstViolation = true;
      }

      return {
        ...day,
        // 占位符已展开成实际执行的指令；界面要显示"这一格真正跑的是什么"。
        effectiveCommandId,
        commandBlocked,
        clubFirstViolation,
        clubFirstWaived,
        attributes: { ...state.attributes },
        // 结算前的值：小目标 / 结局目标的判定基准（见上面的注释）。
        attributesBefore,
      };
    });

    // 当前社团的经验就是结束时的属性值：映射里的当前项要跟上，旧社团的值保持切换时的快照。
    const finalClub = clubAt(rules.timeline.end);
    if (finalClub) clubExperiences[finalClub] = state.attributes.clubExperience;

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
      clubExperiences: { ...clubExperiences },
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
