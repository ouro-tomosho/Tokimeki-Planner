// 社团状态：某个日期上，使用者当前加入的是哪个社团。
//
// 社团切换只在周日发生、自该周日起生效，所以某一天的社团 = 不晚于该日的最后一次切换结果。
// 工具从不自行选择或切换社团。

import { SKIP_DAY } from './commands.js';
import { addDays, weekdayOf } from './dates.js';

/**
 * 某一天所在社团的查询；附带待切换信息。
 *
 * - `input.club` 是当前实际社团。
 * - `input.pendingClub` 是待切换目标：**键缺失 = 不切换**，`null` = 切到回家社。
 * - `rules` 与 `isFreeSunday` 用来算切换/加入日：最近的、没有被活动占用的周日。
 *
 * 返回的 `clubAt(date)` 还带 `.oldClub` / `.target` / `.switchDate` / `.joinDate`。
 */
export function createClubLookupBase(input, rules = null, isFreeSunday = null) {
  const oldClub = input.club ?? null;
  const hasPending = Object.prototype.hasOwnProperty.call(input, 'pendingClub')
    && input.pendingClub !== undefined;
  const target = hasPending ? (input.pendingClub ?? null) : null;
  const free = typeof isFreeSunday === 'function' ? isFreeSunday : () => true;

  const firstFreeSunday = () => {
    if (!rules) return null;
    let date = addDays(input.playedUpTo, 1);
    date = addDays(date, (7 - weekdayOf(date)) % 7);
    for (let i = 0; i < 80 && date <= rules.timeline.lastSettlement; i += 1) {
      if (free(date, oldClub)) return date;
      date = addDays(date, 7);
    }
    return null;
  };

  const switchDate = rules && hasPending && target !== oldClub ? firstFreeSunday() : null;
  const joinDate = rules && oldClub !== null && input.playedUpTo < rules.clubUnlockDate
    ? firstFreeSunday()
    : null;

  function clubAt(date) {
    if (switchDate === null) return oldClub;
    return date < switchDate ? oldClub : target;
  }
  clubAt.oldClub = oldClub;
  clubAt.target = target;
  clubAt.hasPending = hasPending;
  clubAt.switchDate = switchDate;
  clubAt.joinDate = joinDate;
  return clubAt;
}

/**
 * 这一天不能执行这条指令的原因；`null` 表示可以执行。
 *   'club-not-unlocked'  还没到社团解锁日
 *   'club-not-selected'  这个时点没有加入任何社团
 *   'club-mismatch'      加入的是别的社团
 */
export function clubBlockReason(rules, command, club, date) {
  if (command.kind !== 'club') return null;
  if (date < rules.clubUnlockDate) return 'club-not-unlocked';
  if (club === null) return 'club-not-selected';
  if (command.clubId !== club) return 'club-mismatch';
  return null;
}

/** 这一天是不是休息日（周日或固定节假日）——休息日专属指令的判定基准。 */
export function isRestDate(rules, date) {
  return weekdayOf(date) === 0 || (rules.calendar?.restDays ?? []).includes(date);
}

/**
 * 休息日专属指令（电话/约会）在非休息日不可执行。
 *
 * 候选集与界面早就按 `restOnly` 过滤了，但**钉住**（使用者显式指定）曾经绕过这道闸门：
 * 把 `cmd-date` 钉成整周周指令，周一到周六就会照常执行，且判定为合格。
 * 它效果全 0，数值上看不出来，但「只在休息日可用」这条规则就没被兜住（2026-11-06 修）。
 */
export function restOnlyBlockReason(command, isRestDay) {
  if (!command?.restOnly) return null;
  return isRestDay ? null : 'rest-only';
}

/**
 * 一条指令在某一天**不可执行**的原因；可执行返回 `null`。
 *
 * 与 `clubBlockReason` 同一形状，所以判定层、界面与「不结算」的显示都走同一条路。
 */
export function commandBlockReason(rules, command, club, date, isRestDay = isRestDate(rules, date)) {
  return clubBlockReason(rules, command, club, date) ?? restOnlyBlockReason(command, isRestDay);
}

/** 这一天可选的指令 id（受解锁日与当前社团限制）。 */
export function availableCommandIds(rules, club, date) {
  return rules.commands
    .filter((command) => !command.restOnly)
    .filter((command) => clubBlockReason(rules, command, club, date) === null)
    .map((command) => command.id);
}

/**
 * 某个社团对应的那条社团指令 id；`club` 为 null 或未知时返回 null。
 *
 * 用于展开「当前社团指令」占位符（见 `commands.js` 的 `CLUB_COMMAND`）：
 * 记录器标的是「这一格执行社团指令」，而具体是哪一条取决于当时加入的社团。
 */
export function clubCommandId(rules, club) {
  if (!club) return null;
  const command = rules.commands.find((c) => c.kind === 'club' && c.clubId === club);
  return command ? command.id : null;
}

/**
 * 休息日的**日指令**候选。
 *
 * 不含电话/约会（`restOnly`）：它效果全 0，只作为游戏里的记录，**不进候选序列**
 * （所有者 2026-11-06 裁决）——默认把它钉在月末两个周日等于每年白扔 24 天。
 * 也不含「跳过」：求解器不再有"这天什么都不做"的自由度，跳过只作为活动日的硬空过存在。
 */
export function availableDayCommandIds(rules, club, date) {
  return rules.commands
    .filter((command) => !command.restOnly)
    .filter((command) => clubBlockReason(rules, command, club, date) === null)
    .map((command) => command.id);
}
