// 社团状态：某个日期上，使用者当前加入的是哪个社团。
//
// 社团切换只在周日发生、自该周日起生效，所以某一天的社团 = 不晚于该日的最后一次切换结果。
// 工具从不自行选择或切换社团。

import { SKIP_DAY } from './commands.js';

/**
 * 起点那一刻各社团的经验值，按 `scale` 转成定点整数。
 * 每个社团各自一份，由输入直接给出（`clubExperience` 是 `{ clubId: 值 }`），缺席的按 0 起算。
 *
 * 规划与求解都以它为初始状态，所以只此一处口径。
 */
export function seededClubExperience(rules, input, scale) {
  const seeded = input.clubExperience ?? {};
  return Object.fromEntries(
    rules.clubs.map((club) => [club.id, (seeded[club.id] ?? 0) * scale]),
  );
}

/** @returns {(date: string) => string | null} */
export function createClubLookup(input) {
  const changes = [...input.clubChanges].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  return function clubAt(date) {
    let club = input.initialClub;
    for (const change of changes) {
      if (change.date > date) break;
      club = change.clubId;
    }
    return club;
  };
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

/** 这一天可选的指令 id（受解锁日与当前社团限制）。 */
export function availableCommandIds(rules, club, date) {
  return rules.commands
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
 * 休息日的**日指令**候选：可用指令 + 「跳过」。
 *
 * 跳过是空过的等价物（见 `SKIP_DAY`）：它给休息日一个"这天什么都不做"的自由度——
 * 有些休息日执行任何指令都不如空过（属性被拖低、压力也未必划算）。
 * **周指令不在其中**：使用者仍可用「空过」把整周置空，那是输入层的 `null`。
 */
export function availableDayCommandIds(rules, club, date) {
  return [...availableCommandIds(rules, club, date), SKIP_DAY];
}
