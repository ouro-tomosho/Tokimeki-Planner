# 社团加入/切换：周日指令完成切换，社团经验按社团分开

**Status**: accepted（2026-11-05 所有者裁决）

## 决策

默认社团仍是管乐社（不改开局默认）。当前日期 ≤ 1995-04-09 时，最近的周日日指令强制为当前社团指令（加入）；其余时刻按已加入处理。规划中校正属性改社团时，最近的周日日指令强制为目标社团指令；在此之前实际社团仍是旧社团，旧社团指令仍可用，目标社团指令不可用。活动日优先；活动指令与社团有关时用旧社团，切换顺延。改回家社则在最近的周日直接变，日指令自由。加入/切换完成后，社团经验切换为对应社团的经验；输入恢复 `clubExperiences` 映射，求解/判定只用当前社团经验。社团加 `category`（sports/cultural）；`clubCamp` 一律 +2，删 `isAugustClubWeek` / `augustWeekday`；体育类社团每月第 3 个周日日指令强制为社团指令；活动日优先、切换优先。首次社团指令规则变成结构性规则，不再做 `clubFirstViolation` 判定。

## 背景与理由

游戏开局所有人都在回家社，必须周日选社团指令才算加入；旧模型用 `clubChanges` + 单一 `clubExperience`，无法表达待切换与多社团经验。旧 8 月加成只对 8 月组有效，且整周强制；新日历是逐日 `clubCamp`，直接让指令自带 +2。

## Considered Options

- **单一社团经验 + 切换时手动填新值**：输入简单，但“社团经验也切换为对应社团的”要求自动切换；否决。
- **按社团映射 + 周日切换（本决策）**：能表达中途开局、切换、退出、重入；代价是输入多一个映射。
- **保留 8 月才加成的规则**：需要按月份判定，且和逐日 `clubCamp` 冲突；否决。

## Consequences

- 旧 `clubWeekMandate` / `clubWeekViolation` / `checkClubWeekMandate`、`isAugustClubWeek`、`augustWeekday` 删除；`clubWeeks` 从 `rules.json` 移除。
- `clubCamp` 与 `club` 只差社团经验增长；`clubCamp` 一律 +2。
- 待切换期间目标社团指令不可用，旧社团指令可用；切换完成前手动指定受限制。
- 体育类第 3 个周日是事件槽；活动日优先。

## 与其它 ADR 的关系

- [ADR-0007](0007-clamp-is-domain-semantics.md)：其中「社团集训周」「首次社团指令」两节被本 ADR 取代。
- [ADR-0009](0009-solver-architecture.md)：其中「首次社团指令」一节被本 ADR 取代；求解器架构不变。
- [ADR-0010](0010-activity-day-axis.md)：活动日的日指令轴；`clubCamp` / `club` 是活动绑定指令。
