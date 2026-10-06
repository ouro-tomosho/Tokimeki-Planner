// 由 `data/rules.json` 生成根目录的 `RULES.md`：单日指令效果表 + 时间轴 + 结算规则。
//
// 为什么是生成的：效果表有 18 × 10 = 180 格，手抄必错，而且数据改了文档不会跟着改。
// 生成 + `--check` 让文档与数据**不可能脱钩**——这是这份文档唯一的可信来源。
//
// 用法：
//   node tools/rules-doc.mjs           写出 RULES.md
//   node tools/rules-doc.mjs --check   只读校验（不一致就非零退出）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES_FILE = path.join(ROOT, 'data', 'rules.json');
const { DEFAULT_SUCCESS_RATE } = await import('../src/input.js');
const { validateRules } = await import('../src/rules.js');
const OUT_FILE = path.join(ROOT, 'RULES.md');

/**
 * 时间轴内（起点含、最后结算日含）的周日天数。
 * 用 UTC 日期运算，不碰本地时区——跨时区跑不能差一天。
 */
function countSundays(start, end) {
  let count = 0;
  const cursor = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (cursor <= stop) {
    if (cursor.getUTCDay() === 0) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/**
 * 百分比文案：`70%`。
 *
 * 两处坑：① 成功率是浮点时 `0.29 * 100` 会渲染成 `28.999999999999996%`，所以取整到 2 位小数；
 * ② `rate` 为 `null` 时不能写成 `0%`——那是在说一件假话，改成如实标注。
 */
function formatPercent(rate) {
  if (rate === null || rate === undefined) return '规则里各指令不一致的共同值';
  const value = Math.round(rate * 100 * 100) / 100;
  return `${value}%`;
}

/** 数字原样输出：数据是 1/16 的倍数，写成小数才能逐位对照。 */
const num = (value) => {
  const text = String(value);
  return text === '-0' ? '0' : text;
};

const signed = (value) => (value > 0 ? `+${num(value)}` : num(value));

function render(rules) {
  // 数据先过引擎自己的校验器：否则删掉 restDayBonus.club 之类会让文档渲染出「×undefined」
  // 而 --check 照样全绿（这类"绿着错"正是本文件要防的）。
  const problems = validateRules(rules);
  if (problems.length > 0) {
    throw new Error(`data/rules.json 未通过引擎校验，拒绝据此生成文档：\n  ${problems.join('\n  ')}`);
  }
  // 下面这些散文里写了「十项」「最后一项」之类的**顺序事实**。它们没法从数据自动推成句子，
  // 但可以**断言**：数据一旦不满足，构建就失败，逼人来改这句散文——而不是让文档悄悄说错。
  const last = rules.attributes[rules.attributes.length - 1]?.id;
  if (last !== 'clubExperience') {
    throw new Error(
      `属性顺序变了（最后一项是 ${last}，不是 clubExperience）：RULES.md 的「社团经验是十项属性里的最后一项」需要同步改写。`,
    );
  }
  const attrs = rules.attributes;
  const commands = rules.commands;
  const daily = commands.filter((c) => c.kind !== 'club');
  const club = commands.filter((c) => c.kind === 'club');
  const rate = new Set(commands.filter((c) => c.successRate !== 1).map((c) => c.successRate));
  const dataRateText = rate.size === 1 ? `${[...rate][0] * 100}%` : [...rate].map((r) => `${r * 100}%`).join(' / ');
  // ⚠️ 数据文件里每条指令写的是 35%，但**计算实际用的是 70%**（`src/input.js` 的
  // DEFAULT_SUCCESS_RATE 在规则级覆盖它）。文档必须写实际用的那个数——
  // 否则读者会按 0.35 去核对，而他永远对不上。
  const computeRate = DEFAULT_SUCCESS_RATE;
  const rest = rules.restDayBonus;

  const header = ['指令', ...attrs.map((a) => a.name)];
  const row = (c) => [
    `${c.name}\`${c.id}\``,
    ...attrs.map((a) => signed(c.effects[a.id])),
  ];
  const table = (rows) =>
    [
      `| ${header.join(' | ')} |`,
      `| --- | ${attrs.map(() => '---:').join(' | ')} |`,
      ...rows.map((c) => `| ${row(c).join(' | ')} |`),
    ].join('\n');

  const clubNames = new Map(rules.clubs.map((c) => [c.id, c.name]));
  const clubRows = club.map((c) => {
    const clubName = clubNames.get(c.clubId) ?? c.clubId;
    return { ...c, name: c.name === clubName ? c.name : `${c.name}（${clubName}）` };
  });

  const restDays = rules.calendar?.restDays ?? [];
  // 休息日 = **全部周日** + 数据表里列出的固定节假日。两个来源，所以天数要算出来：
  // 只报 restDays.length 会把周日漏掉（曾据此写出「休息日 38 天」这种错话）。
  // 数到 timeline.end 而不是 lastSettlement：终点 1998-03-01 本身是周日，
  // 引擎的日历也把它标为 rest day——只数到 lastSettlement 会少一天。
  const sundayCount = countSundays(rules.timeline.start, rules.timeline.end);
  const clubWeeks = rules.calendar?.clubWeeks ?? [];
  const byYear = new Map();
  for (const date of restDays) {
    const year = date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(date.slice(5));
  }
  const gain = rules.clubExperienceGain ?? {};

  return `# 游戏规则

本文只覆盖**这一层**规则（时间轴、属性、单日结算、固定日历）。目标体系（结局目标 /
小目标 / 全局约束，以及"先达成者先硬化"的判定口径）见 [GLOSSARY.md](GLOSSARY.md)。

## 时间轴

| | 日期 |
| --- | --- |
| 起点（游戏开始） | ${rules.timeline.start} |
| 终点（毕业） | ${rules.timeline.end} |
| 最后一次结算 | ${rules.timeline.lastSettlement} |

终点当天不结算：它是时间轴的边界，不是可以下指令的日子。

## 属性

共 ${attrs.length} 项，取值范围见下表，**不会低于各自的下限**——某项已经触底之后，
继续压低它的效果会失效（这条叫「夹逼」）。

| 属性 | 含义 | 起点 | 范围 | 方向 |
| --- | --- | ---: | --- | --- |
${attrs
    .map((a) => {
      const exempt = !rules.checkpoints.some(
        (c) => c.source === 'ending' && (c.attribute === a.id || c.attributes?.includes(a.id)),
      );
      return `| ${a.name} \`${a.id}\` | ${a.direction === 'down' ? '越低越好' : '越高越好'} | ${num(a.default)} | ${a.min}–${a.max} | ${a.direction === 'down' ? '↓' : '↑'}${exempt ? ' |' : ' |'}`;
    })
    .join('\n')}

## 一天的结算

一天的效果由**执行的指令**、**这一天是平日还是休息日**、**指令是否成功**决定。

1. **成败**：每条指令有一个成功率。**默认按 ${formatPercent(computeRate)} 计算**
   （休息指令永远成功，不参与这个数）。计算按成功率加权后的**期望值**进行，不做随机模拟。
   > 规则文件里每条指令写的是 ${dataRateText}——那是**该数值表的原始记录**；工具在规则级把它
   > 覆盖为 ${computeRate * 100}%（见 \`src/input.js\` 的 \`DEFAULT_SUCCESS_RATE\`），因为
   > ${dataRateText} 的期望下排不出全部达标。规则文件里记录的数值本身没有被改动。
2. **倍率**：休息日（周日与游戏固定节假日）执行时，效果 ×${rest.daily}；**社团指令在休息日同样 ×${rest.club}**。
   **休息日不限制指令种类**——日指令可以是任何一条日常指令（不只是「休息」），
   这一点决定了下面第 4 条的压力加成真的会被用到。
3. **失败**：成功时上升的效果，失败时**减半**；成功时下降的效果，失败时不变。
4. **压力特殊**：它是唯一"越低越好"的属性，而且**失败也会上升**——失败值为「成功值 ${signed(1)}」，
   成功时下降的效果则取「成功值的一半 ${signed(1)}」。所以压力没有"白拿"的指令。
   **休息日对下降量另有 ×${rest.stressReduction} 的加成**：任何让压力下降的指令，在休息日执行时
   下降量 ×${rest.stressReduction}（例如培育艺术气质由 ${signed(-0.25)} 变 ${signed(-1)}，休息由
   ${signed(-2.9375)} 变 ${signed(-11.75)}）。**这条是真实生效的规则**，不是死字段——
   休息日的指令池是全部日常指令（见下条），所以下降型指令确实会在休息日执行。
5. **夹逼**：结算后每项属性被夹在自己的范围内（见上表），所以**永远不会低于下限**。

## 社团经验

社团经验是十项属性里的最后一项，但它**不随毕业结算**，所以没有结局目标。

| 情况 | 增益 |
| --- | ---: |
| 平日执行社团指令 | ${num(gain.weekday ?? 1)} |
| 休息日执行社团指令 | ${num(gain.restDay ?? 4)} |
| 8 月集训周的**平日** | ${num(gain.augustWeekday ?? gain.weekday ?? 1)}（**取代**上一行，不是叠加） |

## 单日指令效果

表中是**成功时、平日**的效果，也就是规则文件的原始数值（按 1/16 的步长）。
「社团经验」一列全是 0：它的增益来自另一条规则（见上一节），不写在这张表里。

### 日常指令

${table(daily)}

### 社团指令

同一时刻只能属于一个社团；社团指令只在属于该社时可执行。

${table(clubRows)}

## 游戏固定日历

**休息日**共 ${sundayCount + restDays.length} 天，由两个来源合成，两者没有重叠——
**每一个周日**（${sundayCount} 天，含终点那天；终点不结算，所以那天不下指令）加上下列
**固定节假日**（${restDays.length} 天）。休息日执行自己的日指令，效果 ×${rest.daily}：

${[...byYear.entries()].map(([year, days]) => `- **${year}**：${days.join('、')}`).join('\n')}

**社团集训周**（${clubWeeks.length} 周）——这一周的**每一个平日**都被强制为当前社团的指令，
执行别的指令（或空过）都算违规；**休息日不受这条约束，未加入任何社团时也不受约束**。

${clubWeeks.map((w) => `- ${w.date} 起的一周`).join('\n')}

其中 **8 月的那三周**另有社团经验加成（见上）。

${rules.calendar?.note ? `> ${rules.calendar.note}\n` : ''}
## 其它

- **社团指令**自 ${rules.clubUnlockDate} 起才可执行；社团切换只在周日。这两条在数据里由
  \`clubUnlockDate\` 表达，工具按它判定。
- 起点与终点**当天都不结算**：起点是状态快照（它的结果已经发生在游戏里），终点是时间轴边界。
- 起点之后的每一天有三种可能。工具**不强制**每天都必须有指令，但三者的效果不同：

  | 状态 | 界面显示 | 属性变化 | 怎么产生 |
  | --- | --- | --- | --- |
  | **执行**某条指令 | 指令名 | 按该指令结算 | 使用者指定、或求解器分配 |
  | **空过** | 「空过」 | **无**（当天不结算） | 使用者明确清空：某天进跳过表 / 清空某个休息日的日指令 / 清空某一周的周指令（该周平日一起空过） |
  | **未指定** | 「待定」 | **无** | 既没有指定、也没有求解结果 |

  后两种都**不改变任何属性、都不报错**，区别只在**意图**：空过是使用者明确的选择，
  未指定是还没定。排程求解时求解器会给每一天分配指令，所以算完的正常日程里不会留下待定日。
`;
}

/** 生成文档文本（纯函数，不写盘）。 */
export function renderRulesDoc(rules) {
  return render(rules);
}

/**
 * 只读校验：`RULES.md` 是否等于由 `data/rules.json` 生成的结果。
 * @returns {{ok: boolean, message: string}}
 */
export function checkRulesDoc() {
  const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  const text = render(rules);
  const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
  if (existing === text) return { ok: true, message: `RULES.md 与 data/rules.json 一致（${text.length} 字符）` };
  return {
    ok: false,
    message: 'RULES.md 与 data/rules.json 不一致：规则改了但文档没重新生成。请运行 node tools/rules-doc.mjs',
  };
}

function main() {
  const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  const text = render(rules);
  const checkOnly = process.argv.includes('--check');
  const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;

  if (checkOnly) {
    if (existing === text) {
      console.log(`RULES.md 与 data/rules.json 一致（${text.length} 字符）`);
      return;
    }
    console.error(
      'RULES.md 与 data/rules.json 不一致：规则改了但文档没重新生成。请运行 node tools/rules-doc.mjs',
    );
    process.exitCode = 1;
    return;
  }
  if (existing === text) {
    console.log(`RULES.md 无需改动（${text.length} 字符）`);
    return;
  }
  fs.writeFileSync(OUT_FILE, text);
  console.log(`已写出 RULES.md（${text.length} 字符，${rules.commands.length} 条指令 × ${rules.attributes.length} 项属性）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
