// 指令槽位的取值。
//
// 槽位里除了真实指令 id，还能放三种**非指令**取值，它们各自表达一件不同的事：
//
//   `null`       使用者显式指定"空过"（优先权最高）
//   `'skip'`     求解器选出的跳过——空过的等价物，但要与使用者的 `null` 区分开
//   `'club'`     **当前社团指令**的占位符：那一天/那一周执行"当时所在社团"的指令
//
// `'club'` 为什么需要：日历记录器标的是"这一格执行社团指令"，而不是"执行科学社指令"。
// 真实游戏里那段日期只能选社团指令，具体是哪一条取决于**当时加入的社团**——而社团是
// 使用者输入的一部分，求解器不自行选择。所以占位符必须保留到求解/规划时才展开。

export const SKIP_DAY = 'skip';

/** **当前社团指令**的占位符。展开见 `resolveClubSlot`。 */
export const CLUB_COMMAND = 'club';

/** 这个槽位取值是不是「跳过」。 */
export function isSkip(value) {
  return value === SKIP_DAY;
}

/** 这个槽位取值是不是「当前社团指令」占位符。 */
export function isClubSlot(value) {
  return value === CLUB_COMMAND;
}

/**
 * 把「当前社团指令」占位符展开成真实指令 id。
 *
 * @param value `'club'` 或真实指令 id
 * @param clubCommandId 该日期上"当前社团"对应的指令 id；没有社团时为 null
 * @returns 真实指令 id，或 `null`（该日没有社团指令可用）
 */
export function resolveClubSlot(value, clubCommandId) {
  if (!isClubSlot(value)) return value;
  return clubCommandId ?? null;
}

/**
 * 把槽位取值解析成「实际执行的指令 id」；跳过与未指定都返回 `null`。
 *
 * 规划、求解、界面三处必须共用这一个口径，否则"跳过"会在某一层被当成未知指令。
 * **注意**：社团占位符不在这里展开——展开需要"当时是哪个社团"，那是调用方才知道的事。
 */
export function commandIdOf(value) {
  if (value === undefined || value === null) return null;
  return isSkip(value) ? null : value;
}
