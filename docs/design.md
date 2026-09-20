# 记忆系统的设计与演进（讨论稿）

> 状态：**讨论中**（2026-09-17 起）。本文件是"最上层记忆"的落点：记录设计决策、理由、被否决的方案与开放问题。
> 目标产品：`dsh-memory-delta` —— 一个可独立使用的 CLI + 一个 DSH 插件，开源到 GitHub（主）/ Gitee（镜像）。

---

## 一、要解决的问题（真实痛点，都实测过）

1. **新会话不记得任何事** —— 已经解决主链：DSH 的 `dsh-agent-instructions` 插件会注入
   `$DSH_HOME/AGENTS.md`（跨工作区）+ `<工作区>/AGENTS.md`（工作区）+ `AGENTS.local.md`（私有叠加层）。已实测生效。
2. **注入没有差分** —— 文件一变，插件就把**整篇**重新注入。实测：一个会话里改 15 次 `AGENTS.local.md`
   （8.5 KB）≈ **58k tokens** 白烧。这是要解决的头号成本问题。
3. **信息集中在一两个文件里必然膨胀** —— 待办、结论、流水全塞一个文件，早晚几万字，
   既贵又难检索，还会互相淹没重点。
4. **记忆会腐化** —— 结论会过时、会被推翻，但旧条目没人删。追加式日志解决不了"当前真相是什么"。
5. **跨工作区/跨项目** —— 有些知识是全局的（账号、机器环境、用户偏好），有些是项目私有的。
   现在靠"全局 AGENTS.md vs 工作区 AGENTS.md"两级硬编码，粒度太粗。
6. **OpenSpec 类的工具（用户在公司用）解决了"代码不跑偏"，但没解决"结论不用重复交代"** ——
   因为它是**拉取式**（pull：靠指令要求 AI 去读 `openspec/`），新会话不会主动想起。
   我们的强项恰好是**推送式**（push：会话开始自动注入）。两者应该合起来。

---

## 二、借鉴 OpenSpec 的哪些机制

参考：[Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)（MIT，"Spec-driven development for AI coding assistants"）。

它的核心结构：`openspec/specs/`（**当前真相**：Requirement + Scenario，WHEN/THEN 格式）
＋ `openspec/changes/<id>/`（**待生效的变更集**：proposal.md / specs/ 增量 / design.md / tasks.md）
＋ 工作流 **propose → apply → archive**（archive 把增量**合并进 specs** 并把变更集移到 `changes/archive/<日期>-<名字>/`）。

值得搬过来的四个机制：

| OpenSpec 机制 | 搬到记忆里的形态 | 解决我们的什么问题 |
| --- | --- | --- |
| `specs/` = 当前真相 | **当前事实层**：只保留"现在成立"的结论，每条带 `status` | 记忆腐化（问题 4） |
| `changes/` = 待生效增量 | **收件箱层**：新结论先落 inbox，未确认的不进常驻 | 误记/未验证结论污染常驻层 |
| **archive = 合并 + 日期归档** | 确认后：写入事实层、旧条目标 `superseded-by`、原文进归档 | 有历史可追溯，但当前真相干净 |
| **`validate` 校验** | `memory validate`：格式、索引一致性、悬空引用、未解决冲突 | 记忆库长期不腐坏 |

另外它那两个"工程化"细节也值得抄：**纯 Markdown、无专有格式**（人可读、可 git diff、可 review、
能像代码一样提交 —— 正好接上用户已有的 Gitee/GitHub 工作流）、以及 **Stores（beta）= 把规划放到独立仓库
共享给多个仓库/团队** —— 这就是"跨工作区记忆"的产品化形态。

---

## 三、分层设计（三层 + 两条通道）

```
        ┌─ PUSH：会话开始自动注入（字节预算硬约束，目标 < 3 KB）
        │    T0 身份与约定     ：用户偏好、机器环境、账号/发布约定  ← $DSH_HOME 级
        │    T1 索引与待办     ：本次要接着办什么 + 记忆库目录索引
        │
记忆库 ─┤
        └─ PULL：按需检索（不占常驻预算，靠工具或 grep）
             T2 事实层 facts/     ：当前成立的结论（status: active / superseded / expired）
             T3 决策层 decisions/ ：为什么这么定 + 被否决的方案（ADR 风格，只增不改）
             T4 收件箱 inbox/     ：候选条目，等确认 → 合并进 facts/ 或 decisions/
             T5 流水 journal/     ：逐次会话的时间线（可无限增长，永不注入）
             T6 原始存档 sessions/：DSH 会话日志解压后的可检索副本（已有工具）
```

**关键约束（来自问题 2）**：只有 T0/T1 进注入范围。T2 及以上一律不注入，靠
"索引 + 检索工具"按需拉取。这样流水再长、事实再多，也不会变成每次会话的固定开销。

**关键约束（来自问题 4）**：T2 的条目**有状态**。注入时只渲染 `active`；
新结论覆盖旧结论时，把旧的标 `superseded-by: <新条目 id>`，而不是删掉或无限追加。

---

## 四、插件形态（`dsh-memory-delta`）

以现有插件 `@deepseek-ai/dsh-agent-instructions` 为参考实现（它的 seam 已确认可用：
`agent/pre-step` 监听 + inbox 组合 + 基于 fs touch 的刷新 + digest 去重 + 字节预算截断 + `</system-reminder>` 转义）。
我们的插件**不替换它**，而是与它共存/接在它之上：

| 能力 | 说明 |
| --- | --- |
| **注入（含差分）** | 会话首步注入 T0+T1；此后**只注入变化块**（planner 记住上次注入的条目 id + digest，做集合差），彻底解决"没有差分" |
| `memory_search` | 跨 T2~T5 检索（Markdown 全文 + frontmatter 过滤：tag/scope/status/日期） |
| `memory_write` | 结构化写入（schema 校验：id、日期、scope、status、来源），默认落 inbox |
| `memory_promote` | inbox → facts / decisions 的合并（含 superseded 标记），对应 OpenSpec 的 archive |
| `memory_validate` | 校验：格式、索引一致性、悬空引用、未解决的冲突、体积预算 |
| 会话结束钩子 | 提示/自动把本次会话蒸馏成候选条目（落 inbox，不直接改事实层） |
| CLI | `memory.mjs`（今天的雏形）独立可用，插件只是它的"在线部分" |

仓库结构（草案）：

```
dsh-memory-delta/
├── package.json / cordis.yml    插件清单（参考 dsh-agent-instructions）
├── src/{index,store,inject,index-builder,validate,tools}.ts
├── bin/memory.mjs               CLI（可与插件分离发布）
├── docs/{design,layering,open-spec-comparison}.md
├── openspec/                    ← 用 OpenSpec 管这个项目自己（吃自己的狗粮）
└── tests/
```

---

## 五、已定决策（2026-09-17）

| # | 决策 | 理由 |
| --- | --- | --- |
| **D1** | **scope（全局/工作区）+ tags（主题）两维** | scope 只回答"这条该不该注入"，tags 只回答"想找的时候能不能搜到" —— 两个问题分开问，逻辑不打架 |
| **D2** | **模型只能写收件箱；事实层的提升需要确认** | 防止错误结论静默进入常驻层、然后被**反复注入** —— 注入本身有成本，错的东西代价更高 |
| **D3** | **先做 CLI + 结构化条目 + validate；插件是很薄的一层** | 数据模型和校验最值得先想清楚；CLI 可独立开源、可测试、不依赖 DSH。避免数据模型被插件实现绑架 |
| **D4** | **只借鉴 OpenSpec 的思想，不做桥接** | 先把自己的分层做封闭，不被别人的格式与 roadmap 约束；将来要加桥也不亏 |
| **D5** | **记忆库 root 可配置，默认 `<工作区>/memory/`** | 不强制、不惊喜；同时给"独立记忆仓"留好口子（`--root` / `DSH_MEMORY_ROOT`）。与现有 `memory/` 目录兼容，零迁移 |

### 仍未定

- **条目 id 方案**：暂定 `YYYY-MM-DD-<slug>`（可读、可手写、冲突时加后缀）；若将来需要内容寻址再换
- 现存 `journal.md` 与 `sessions.md` 是否迁移成结构化条目（倾向：**journal 不迁**，它是流水；`sessions.md` 保持自动生成）

（已答但保留备查）冲突检测靠结构化字段（同 key + 显式 `--supersedes`），不靠模型自由判断；检索先用零依赖的全文/grep，SQLite FTS 留到有性能问题再说。

---

## 六、M1 规格：CLI + 结构化条目 + validate

### 目录布局

```
<memory-root>/
├── memory.config.json   # scope 声明、注入预算、条目目录开关
├── index.md             # 自动生成的目录索引（T1 注入用）
├── facts/               # T2 当前真相：只有 status=active 才参与注入
├── decisions/           # T3 决策记录（只增不改，含被否决方案）
├── inbox/               # T4 候选条目 —— 模型默认只能写这里
├── journal.md           # T5 流水（永不注入）
└── archive/             # 被取代条目的原文归档
```

### 条目格式（Markdown + YAML frontmatter，人可读、可 git diff、可 review）

```markdown
---
id: mem-2026-09-17-win-update-cache
type: fact                 # fact | decision
scope: workspace:D:\idea2023\ai   # global | workspace:<path>
tags: [windows, disk]
status: active             # active | superseded | expired
date: 2026-09-17
source: session-b3eaa198   # 可回溯原始会话
supersedes: []             # 本条目取代了谁
superseded_by: null        # 谁取代了本条目
verify_when: Windows 大版本更新后重新评估
---
## 结论
清 Windows 更新下载缓存实测收益≈0（目录删空但可用空间没涨），不要再折腾。
## 理由
文件已 unlink 但卷统计未变；同时段 servicing 活跃写入吃掉了等量空间。
```

### CLI 命令面

| 命令 | 作用 |
| --- | --- |
| `mem new --type fact\|decision --scope <s> --tags a,b` | 在 **inbox** 创建结构化候选条目（交互/参数填充模板） |
| `mem list [--status --scope --tag --type]` | 过滤列表 |
| `mem show <id>` | 单条详情（含来源会话、被谁取代） |
| `mem promote <id> [--supersedes <id>]` | inbox → facts/decisions；**与已有条目冲突时必须显式 --supersedes** |
| `mem supersede <old> <new>` | 标记失效 + 归档 + 双向链接 |
| `mem validate` | 校验（见下） |
| `mem index` | 重建 index.md（注入用） |
| `mem inject [--budget <bytes>]` | 渲染"当前应注入的内容"，供插件调用或人工核对 |
| `mem recall <关键词> [--all]` | 跨 facts/decisions/journal/sessions 检索 |
| `mem journal add "..."` | 追加流水（今天的 `remember` 就是它） |

### validate 的检查项（M1 必须有）

1. frontmatter 必填字段齐全、枚举值合法（type/status/scope）
2. id 唯一且格式合法
3. `supersedes` / `superseded_by` **双向一致**、无环、目标存在
4. `source` 指向的会话存在（软校验：缺失只告警）
5. `index.md` 与实际文件一致（可 `--fix`）
6. **注入预算**：T0+T1 渲染后 ≤ 预算（默认 3 KB）；超了要指出**哪一条最占地方**
7. 同一 `scope + tags + 语义键` 上存在两条 active 且互相矛盾 → 报冲突

### M1 实测暴露出的三个改进点（2026-09-17 狗粮时发现）

1. **冲突启发式太粗**：现在用「同 scope + 完全相同的 tag 集合」判潜在冲突，结果把所有
   `design,dsh-memory-delta` 的决策都报成冲突。**M2 要引入语义键**（类似 OpenSpec 的
   `Requirement: <名字>`），例如条目增加 `key: inject-budget`，只有**同 key** 才判冲突。
2. **id 不该从结论派生**：中文结论 slugify 之后又长又难看（`2026-09-17-路径含非-ascii-字符时-…`）。
   `new` 应优先要求显式短 id（如 `mem-win-update-cache`），派生只作兜底。
3. **`inject` 超预算原本只警告不报错** —— 已修（返回非零退出码），否则 CI/插件无法判断。

### M1 已实现（`dsh-memory-delta/`，33 个测试全绿）

`mem init | new | list | show | promote | supersede | validate | index | inject | journal | recall`，
零依赖。测试里固化了两条真实踩坑的**回归测试**：非 ASCII 路径下 `fs.rmSync` 静默失败（要用 `unlinkSync`）、
沙箱禁止命名管道（`spawnSync` 要用文件重定向而非管道）。


---

## 七、里程碑

- **M0 ✅**：三层注入可用 + 会话索引 + 解压/检索 CLI + 记忆技能
- **M1 ✅**：journal 与常驻层分离（解决重复注入成本）；CLI（init/new/list/show/promote/supersede/
  validate/index/inject/journal/recall）+ 测试
- **M2 ✅（2026-09-17）**：
  - 显式短 id（`--id` 优先，派生压到 20 字符并自动去重）
  - **语义键 `key` + 「一个 key 一个真相」**：`promote` 在同 scope+key 已有 active 时**拒绝**，
    除非显式 `--supersedes`；`validate` 把同 key 冲突当 **problem**（原先按 tags 判，全是误报）
  - **`inject --json` 差分载荷**：每条带 12 位 hash —— 这是 M3 差分注入的地基
  - `validate --fix`：只修机械问题（归档漏归档的 superseded、重建 index），语义问题绝不自动改
  - **`mem set`**：狗粮时发现的基础能力缺口 —— 条目建好之后总要能改（补 key、改措辞、标 expired），
    否则只能手改文件，frontmatter 的一致性就守不住
  - 顺手修：生成 index.md 时误写入 ANSI 颜色转义
  - 测试 **62 个断言全绿**
- **M3 ✅（2026-09-17）**：DSH 插件三块全部实现，且**决策逻辑与 DSH 解耦**（DSH 依赖全部注入，
  用假 agent/decision 就能完整测试）：
  - **差分注入**：`src/planner.mjs`（纯逻辑）+ `src/hook.mjs`（pre-step 接线）。首次 baseline，
    之后只推「新增/已更新/已失效」，**完全没变化时零注入**。上游状态从会话历史里自己发过的消息
    （`source.entries` 带 `{id,hash}`）恢复，因此会话恢复/回放/压缩后依然正确。
  - **工具**：`memory_search`（跨 facts/decisions/inbox/archive/journal 检索）、
    `memory_write`（只写 inbox，守住 D2）。
  - **会话结束蒸馏提醒**：长会话且记忆已最新时提醒一次用 `memory_write` 落结论；提醒消息
    **不带 entries**，不会把差分基线清零（有专门的回归测试）。
  - 插件 = `src/plugin.mjs` 薄薄一层（读配置、注入 DSH 依赖、注册 pre-step 与工具）；
    **不 spawn CLI**（沙箱禁管道，且没必要 —— store 逻辑直接 import）。
  - 测试 **137 个断言全绿**（CLI 62 + planner 36 + hook 39）。
  - *遗留：装进 live profile 的实机验证（会改动运行中的环境，需用户同意）。*
- **M4 ✅（2026-09-17）**：开源到 GitHub（主）+ Gitee（镜像）：README（中英）、文档、示例、测试。
  两平台 Description/Topics 已填，作者邮箱用 noreply 保证归属正确。
- **M5 ✅（2026-09-17）**：把"记忆真的有用"这件事做扎实 —— 三块**主体能力**，
  顺序是用户对齐过的（先做①，因为另外两块都依赖它）：
  - ① **注入改索引式**（拆规模墙）：见下节「为什么要去掉 id」。
  - ② **检索变准**：`src/search.mjs`（词/中文 bigram 分词 + 加权打分 + 命中片段），
    `mem recall` 与插件 `memory_search` 共用同一套实现。
  - ③ **`verify_when` 落地成会话内提醒**：把死字段变成"到点了主动提醒你复核"。
  - 测试 **802 个断言全绿**（CLI 180 + planner 43 + search 51 + due 93 + hook 63 + plugin 209 + client 165），
    真机预检 15/15。
  - **明确不做**（用户判定过度设计）：仪表盘/健康度看板、使用计数器、相关性推送的复杂机制。

### 为什么要去掉 id（M5①）

注入正文里原本每行都带 `<!-- <id> -->`。id 是**差分用的元数据**，已经随消息的结构化
`source.entries` 一起走（`{id, hash}`），再内联进正文纯属白占预算：

| 指标 | 去掉 id 前 | 去掉 id 后 |
| --- | --- | --- |
| 真实记忆库 6 条的注入文本 | 1450 B | **953 B** |
| 其中 id 注释 | 497 B（**34%**） | 0 |
| 平均每条 | 242 B | **159 B** |
| 3 KB 预算能装 | 约 12 条 | 约 **19 条** |

同时给单条加了 `LINE_CAP = 140` 的截断：一条超长结论不该独占整个预算。
配套改动：`mem inject` 不再自己拼一份渲染，而是复用 `planner.renderBaseline` ——
否则 CLI 显示的文本和字节数跟真正注入的内容是两回事（曾经就是两份实现）。

### 检索为什么要重写（M5②）

原来是 `hay.includes(needle)` 一句话：命中就命中，命中多了**排不出先后**；而且中文连写时
`沙箱 管道`（带空格）必然落空 —— 中文不在词之间加空格，子串匹配对中文几乎无用。

新实现（`src/search.mjs`，纯逻辑）：

- **分词**：ASCII 按词切（保留 `_ . -`，所以 `verify_when` 能整串搜）；中文连写切 **bigram**
  （`沙箱禁管道` → 沙箱/箱禁/禁管/管道）；单字虚词（的/了/是…）丢掉。
- **打分**：字段有权重 —— key/id 6 > tags 4 > 结论 3 > 正文 1（结论行会从正文里挖掉，
  避免重复计分）；同一个 token 在同一字段最多计 3 次（防长文刷词）；整串短语命中额外加成。
- **过滤**：至少要命中一半 token（至少 1 个）—— "只中一个 bigram 的无关文档"进不来，
  "两个关键词只中一个"仍作为弱命中返回。
- **片段**：选**命中最多的那一行**（而不是正文第一行），按命中位置开 160 字窗口。
- **共用**：`mem recall`（人用）与插件 `memory_search`（模型用）走同一个 `collectDocs` + `rankDocs`。
  `index.md` 是条目的派生视图，默认不参与检索，否则每条记忆都会重复命中一次。

### `verify_when` 为什么要变成提醒（M5③）

`verify_when` 之前是个**死字段**：`mem new/set --verify-when` 能写进 frontmatter，但没有任何地方读它。
而它恰恰是"老伙伴该提醒你"的唯一**显式信号** —— 当初记这条的时候就说好了"过一阵子回头看"。

实现（`src/due.mjs`，纯逻辑）：

- **解析**：`2026-03-01` 直接认；`3个月后` / `2周后` / `半年后` / `立即` 相对**条目自己的 `date`** 算；
  其它散文（`等换机器时`）→ `unparsed`，**不算到期**。日期算术一律走 UTC，
  否则本地时区会把"超期 1 天"算歪。
- **收集**：`due <= today + within`；`overdueDays` 正/负/零 = 已超期 / 还有 N 天 / 今天到期；
  最超期的排最前。`within` 就是"提前几天提醒"。
- **提醒**：`mem due`（人看）、`validate` 的**告警**（不影响退出码）、
  以及 hook 的会话内提醒（模型看，`form='due'`，**不带 entries**）。

四个刻意的约束：

1. **只挂显式信号**：散文值永远不触发 —— 否则一条"等换机器时"会让每个会话都弹一次，
   而且用户怎么改都消不掉。提醒必须**可被解决**（取代 / 标过期 / 推后复核时间）。
2. **只在"零注入"的那一轮提醒**：`desired !== null`（要推 baseline/delta）时绝不抢那条消息 ——
   记忆发生变化比复核提醒更该被看到。
3. **一个会话只提醒一次**：WeakSet（同进程）+ 可见消息里的 `form='due'`（会话恢复/回放兜底）。
4. **提醒不带 entries**：和蒸馏提醒同一个理由 —— 带了就会被 `previousStateFrom` 当成上一轮状态、
   把差分基线清零，下一轮又全量重灌。

`dueWithin`（提前 N 天）从 CLI（`mem due --within`）和插件 Config 两处都能配，默认 0（只看已到期）。

### 侧边栏面板：为什么这样设计（M6）

真实使用反馈暴露了四件事，逐条记下取舍：

**① 折叠标志不能用样式藏掉。** 原来用原生 `<details open>` + `list-style:none` +
隐藏 `::-webkit-details-marker`，结果**没有任何"可以展开"的视觉线索**，用户根本不知道能点；
而且 `open` 是受控属性，任何一次重渲染（点刷新）都会把用户刚收起来的分组弹开。
现在：自绘箭头（CSS 三角，展开时旋转 90°）+ 折叠状态由组件自己的 `useState` 持有 + 分组头是
真正的 `<button>`（带 `aria-expanded`，键盘可用）。

**② 面板不做编辑/删除，只做「入口」。** 侧边栏**本来就有**编辑器（`openFile`，预览/编辑/保存）
和文件树（重命名/删除带确认弹窗，还会重定向已打开的页签）。在面板里再造一套增删改 =
重复实现 + 永久维护税。所以：**点条目 → 打开它那个 `.md`**（better-sidebar 官方 API
`BetterSidebarService.openFile`，能力位 `openFile`，v0.12.0+）。

⚠️ **陷阱**：`id` 写在 frontmatter 里、且 `validate` 强制它与文件名一致 ——
**别用文件树直接给记忆条目改名**，那会造出 `id 与文件名不一致`。安全改名得走
`mem rename`（同时改 frontmatter、文件名与引用），面板只**提示**、绝不代替。

**③ "跳到目录"这类按钮**曾经做过，后来**按用户反馈删掉了**。
当时的实现：宿主机开一条 `POST /dsh-memory-delta/reveal`（**白名单目录名**
`root`/`facts`/`decisions`/`inbox`/`archive` + 只认回环来源 + `allowOpenFolder:false` 可关），
用系统文件管理器打开该目录 —— 之所以不走 better-sidebar 内部的 `revealPaths`
（`intercept.tsx` 的 `revealInExplorer` → `store.reduce(revealPaths)`），是因为它**没进公开 API**，
照抄它等于依赖未公开的内部状态，0.18 / 0.19 两代实现不同，一升级就碎。

删掉的理由值得记下来（这是"少即是多"的一次实践）：

- 用户的原话是"有三角箭头和点击打开具体详情可以了" —— **折叠看内容 + 点条目打开详情**已经覆盖了
  全部真实需求，"跳到目录"是给一个**不存在的需求**加的按钮；
- 它同时是**唯一会启动外部进程**的路由（`spawn(explorer.exe)`）—— 一条没人调用的、
  能拉起系统程序的路由是纯粹多出来的安全面，删掉比留着"以备将来"更对；
- 条目行右侧那个「打开」小标签同理删掉了：整行本来就可点（hover 有底色 + `title` 提示），
  再挂一个标签只是噪音。

**留下的原则**：面板里只保留**必须写库或必须由人判断**的动作（收件箱提升、整理文件名），
纯跳转/纯提示类的按钮一律不做 —— 交互靠 hover/可点区域本身表达，而不是再加一排按钮。

**④ "自动归纳"只做确定有用的那一半。** 语义聚类不做（结果不确定、用户还得纠错，
和之前否掉的看板/计数器同类）。做的是：**按标签分组**（取每条第一个标签，没标签的归一组，
组间按条数排序）+ **条目按日期倒序** + 把 `tags` / `date` / **文件名**显示出来。
显示文件名是刻意的：它是"内容混乱"的根源（没给 `key` 的条目会拿到
`2026-09-17-<截断的结论>.md` 这种自动名），**先在界面上暴露出来**，再让 `mem rename` 去修。

**⑤ 面板的写动作必须复用 CLI 的实现，而不是"再写一遍"。**
面板上加了两类按钮：收件箱**一键提升**（`promote`）和**整理文件名**（`rename`）。
它们会真的改记忆库，所以：

- `bin/mem.mjs` 里把逻辑抽成 `promoteEntry()` / `renameEntry()` 并导出，CLI（`cmdPromote` /
  `cmdRename`）与宿主动作路由**共用同一份** —— 面板里再写一遍"一个 key 一个真相"的闸门，
  迟早和 CLI 分叉，而分叉的后果是"模型看到的记忆"和"面板显示的真相"不一致。
- 这两个函数**抛异常**，不调 `fail()`：`fail()` 会 `process.exit(1)`，而动作路由跑在
  **宿主进程**里 —— 用户点一下按钮，整个 DSH 就没了。CLI 侧负责把异常翻译成打印 + exit 1，
  路由侧翻译成 400 + 原因（界面把原因显示出来，"点了没反应"是最难查的体验）。
- `renameEntry` 必须同时改三处：frontmatter 的 `id`、文件名、以及别的条目里指向它的
  `supersedes` / `superseded_by`，最后重建 `index.md`。少改一处就是一条静默腐化的引用。
- 路由只认白名单 op（`promote` / `rename`），**不做"通用改写"后门**；`allowWrite:false` 可整体关掉。

**⑥ 乱名的根因在 `createEntry`，不在界面。** 界面把文件名显示出来之后，真正的原因就清楚了：
给了 `key` 的条目文件名干净（`sandbox-no-egress.md`），没给的会拿到
`<日期>-<截断到 20 字的结论>.md` —— 中文结论必然被截在词中间。所以改的是**生成规则**：
**有 `key` 且该 key 还没被占用 → id（= 文件名）直接用 key**；key 撞车（合法的多 scope 场景）
才退回派生 id。已经存在的乱名用 `mem rename` 收，界面上的「整理文件名」按钮是它的入口。

**⑧ 面板搜索：复用同一套打分，不另开一条检索路径。**
用户问"侧边栏本身支持搜索，能整合进记忆界面吗"。查证结果：better-sidebar **没有**把它的搜索
暴露成公开 API（`src/client/service.ts` 里连 search 方法都没有，文件树那套是自己内部的），
所以"整合它的搜索"这条路不通 —— 但**根本不需要**：我们自己的检索（`src/search.mjs` 的
中文 bigram 分词 + 字段加权 + 命中片段 + "命中不足一半淘汰"）本来就是 M5 的成果，只是此前
只能在 CLI（`mem recall`）和模型工具（`memory_search`）里用到。

做法：

- 三处共用同一个 `searchLibrary(L, {query, where, limit})`（落在 `bin/mem.mjs`），
  `mem recall`、插件工具、面板搜索路由都调它。测试直接钉住这件事：路由的输出必须等于
  `searchLibrary` 的输出，且 `src/plugin.mjs` 里**不许**再出现 `rankDocs(`。
  理由和"面板显示 3 条而模型只收到 2 条"是同一类：检索一旦分叉，"我明明记过这条"就变成
  最难查的那种问题。
- 检索在**宿主**做（面板组件拿不到磁盘，也不可能把整库塞进浏览器）：
  新路由 `POST /dsh-memory-delta/search`，只读、回环校验、`where` 白名单、
  `limit` 上限 100、片段裁到 240 字。
- 客户端只做三件事：输入框（**防抖 200ms** 自动搜 + 回车立即搜）、把命中画出来
  （层标签「事实/流水」+ key + 日期 + 命中片段 + 文件名，整行可点直接打开该文件）、
  清空回分组视图。有搜索词时**只显示结果**，不把两套列表堆在一屏。
- `collectDocs` 顺手给每条文档加了 `file` —— 命中流水行也能点开对应的 `journal.md`，
  而不是"搜到了却打不开"。

**没做的**：正则/高级语法、搜索历史、结果高亮着色（`matched` 已经回传，将来想加随时能加）。
搜索本身不是这套系统的卖点，**"搜出来的东西和模型看到的一致"**才是。

**⑨ 目录命名：为什么"看着分不清"，以及为什么只改说法不改结构（M7）。**
真实反馈："`facts` 这个文件夹，我从名称了解不了它是干啥的，在记忆流程中属于哪一步。"

根因是**两个轴被平铺成了一层目录**：

- **阶段轴**（这条在流程哪一步）：候选 → 常驻 → 归档 = `inbox/` / (`facts/`+`decisions/`) / `archive/`
- **类型轴**（这条内容是什么性质）：关于世界 vs 关于我们 = `facts/` / `decisions/`

于是 `inbox`、`archive` 是**按阶段**命名的，`facts`、`decisions` 是**按类型**命名的 ——
同一个列表里混了两套命名逻辑，而 `facts` 恰好两个轴都能读（"已确认的事实"），最容易被误读。

三条路里选了**最保守的那条**（只改说法、不动结构）：

1. **面板按"流程阶段"重新分组**（第二稿 —— 第一稿只加小字注释，**不够**）：
   第一稿把类型放在最外层、旁边加一行小字说明流程位置，真实反馈是"还是一眼看不出是干啥的"。
   第二稿把**阶段提到最外层**、类型降级成阶段内部的子分组，并加一条**流程条**：

   ```
   流程：模型写入 → 待你确认 3 → 已在用 14 → 已归档 0

   ▾ 待你确认（inbox）  模型想记住的 · 你点头才生效（在那之前不会发给模型）
   ▾ 已在用             每轮会话自动发给模型 · 这就是"它记住了"的部分
       ▾ 事实（facts）     关于世界（能被现实证伪）
       ▾ 决策（decisions） 我们的约定（只有我们改主意才失效）
   ▾ 已归档（archive）  被取代或过期 · 不再发给模型，但搜得到
   ```

   顺手修掉的两个毛病：状态行原本重复报「常驻 N 条 / 候选 N 条 / 归档 N 条」，与流程条数字重复
   → **条数只在流程条里报一次**；说明文字里混了 Markdown 的 `**`，面板不渲染 Markdown，
   于是按字面显示 → 去掉。
2. **库自带一份说明书**：`mem init` 往库根写 `README.md`（四个目录 + 两个轴 + 判据 + 常用命令），
   **已存在就一个字都不改**（它首先是给用户看的）。"看不懂"的问题在**库自己**那儿就解决了，
   不用回来翻项目文档。
3. README（中英）与 design.md 把"两个轴"写成表格说清。

**为什么不在结构上动**（比如 `current/facts`、或把 `facts` 改名成 `conclusions`）：那会破坏**外部契约** ——
CLI 的 `--where facts`、插件的 `where` 白名单、别人装到本地的既有库、注入文本里的 `### 事实/决策`，
全都要跟着改，还得写迁移脚本 + 兼容读旧路径。收益只是"名字更顺眼"，
而"按阶段分组 + 流程条"已经把"一眼看不懂"解决掉了 —— 结构留给真有需求时再动。

**教训**：把"看不懂"当成**信息不足**去补文字（第一稿）往往是错的 ——
先问"信息是不是摆错了层级"（第二稿）。同一条信息放进分组结构，比放进小字注释有效得多。

### 面板为什么显示「全局规范」（M8）

用户问："记忆不是分层了吗？全局的记忆／规范只要在这个工作台里新启会话就生效，应该在面板里展示出来。"

先把归属讲清（这一步最容易搞混）：

- 全局那份**不是本插件注入的**，是 DSH 自带的 `dsh-agent-instructions` —— 它注入
  `$DSH_HOME/AGENTS.md`（用户全局）+ `<项目根>/AGENTS.md`(+`.local`)（项目），
  **每个工作区、每次新会话**都在上下文里（还有预算与截断逻辑）。
- 本插件的记忆库只管 `<工作区>/memory`。所以"换个工作区就看不到记忆"是**设计目标**，
  而"全局规范在新工作区照样生效"同样成立 —— 以前只是**面板没把它显示出来**。

做法：只读展示 + 预览，**不再造第二套全局注入**：

- 宿主读 `$DSH_HOME/AGENTS.md`（`DSH_HOME` 环境变量优先，兜底 `~/.dsh`），回
  `{displayPath, bytes, lines, mtime, preview(前 40 行), source}`。
  `displayPath` **只给展示形式** `~/.dsh/AGENTS.md` —— 绝对路径里带用户名，而这个面板会被截图
  放进公开仓库（截图脚本只裁了「库：」那一行）。
- 客户端把它放在**「已在用」**里最前面（和常驻条目同类：每轮都会进上下文），但**默认折叠**：
  标题上给路径 + 大小就够，既不把整篇糊在脸上，也避免截图带出里面的个人信息。
- 顺带显示本库的源文件 `<库根>/global-AGENTS.md`（我们这套工作流的约定：源在库里、
  同步过去的那份才生效），让"改了源但忘了同步"这件事看得见。
- 记忆库还不存在（全新工作区）时**也**带这一段 —— 它跟库在不在没关系。

**为什么不像 better-sidebar 那样"点一下用编辑器打开"**：它有 workspace fence
（`src/path-security.ts` 的 `assertWithinWorkspace`），**工作区外的路径一律 403**
（除非用户关掉该设置）。面板自己读文件、在面板里给预览：既不受那条 fence 影响，
也更贴合真实需求 —— 用户要的是"看看全局规范是什么"，不是非要用编辑器打开它。

**没做的**：第二套全局库（让全局也有 inbox → promote 流程）。DSH 已有全局指令管道，
再造一个会出现"两个全局真相"，除非先划清边界（硬规范走 `AGENTS.md`、可复核结论走全局库）。
**长规范与流程放 skill**（按需加载，不占常驻预算），这一点写在
`$DSH_HOME/skills/coding-standards/SKILL.md` 里。

### 双向迁移、只删候选、危险动作的行内确认（M9）

用户要求：① 工作区规范也要能编辑 ② 已在用 ⇄ 待你确认要能**双向**迁移 ③ 待你确认要能删除
④ 上述操作最好有确认弹窗，避免误操作。

**① 工作区规范：显示 + 直接复用侧边栏编辑器。**
DSH 注入的还有 `<工作区>/AGENTS.md` 与 `AGENTS.local.md`（项目层），面板把它们列出来。
与全局那份的关键区别：**这两个文件在工作区内** → better-sidebar 的 workspace fence 允许打开，
所以能直接给「编辑」按钮进侧边栏编辑器（预览/编辑/保存都是现成的）。
**不为它们再造编辑 UI**，理由与"面板不做增删改"完全一致。路径只回相对名（`AGENTS.md`），
不带工作区绝对路径（截图会泄露）。

**② 双向迁移：`demote`（撤回）≠ `supersede`（取代）。** 这是这次最需要讲清的一组语义：

| 操作 | 含义 | 去向 | status |
| --- | --- | --- | --- |
| `promote` | 确认这条为真 | inbox → facts/decisions | active |
| **`demote`（新）** | **"先不当真"**：还不确定，或先不想让它每轮发给模型 | facts/decisions → **inbox** | **不改**（仍 active） |
| `supersede` | 这条**错了/过时了**，有新的顶上 | → **archive/** | superseded |

因为 demote **不改 status、只换层**，所以再 `promote` 一次就原样回去 —— 双向且无损。
只接受常驻层的 active 条目（归档层的"复活"要同时理清 `status` 与 `superseded_by`，是另一件事）。

**③ 只允许删候选（`mem rm` / `op:'remove'`）。** 常驻条目一旦被注入过、被别的条目 `supersedes`
引用过，直接删就是**静默消失** —— 它的出路是「撤回」或「取代/标过期」。候选还没被确认过，
删掉只是"这条不算数"。这条限制写在 `removeEntry` 里，CLI 与面板共用（测试两边都钉住了）。

**④ 确认弹窗：用行内确认条，不用 `window.confirm`。** 三个理由：
它会**阻塞页面**、跟界面风格不搭、**无头截图会卡在那里**（我们的产品图靠脚本截）。
行内确认条 = 点危险按钮后该条目下出现一条红色提示 + 「确认删除/确认撤回」+「取消」，
既好测也不会卡住自动化。**真正的闸门是"必须点两次"**，颜色只是提示。

**测试怎么钉住的**（这类"危险动作"值得钉死）：
· CLI：demote 后不再注入、再 promote 能回去、对候选 demote 报错、rm 拒绝删常驻、拒绝后文件还在
· 动作路由：demote/remove 真的搬/删文件；remove 对常驻条目 400
· 客户端：点危险按钮**不立刻发请求**（先出确认条）、点取消什么都不发生、确认后才发对应 op、
  失败时回显宿主原因；工作区规范的「编辑」走 openFile

### 归档：谁在归档、以及补上"手动归档"（M10）

用户问："归档是怎么处理的？之前是不是模型发现有废弃的事实或决策就自动归档啊，能支持手动归档吗？"

先把归属查清（**模型不会自动归档**）：

| 触发 | 谁 | 干了什么 |
| --- | --- | --- |
| `mem supersede <旧> <新>` / `promote --supersedes` | **人** | 旧条目 `status: superseded` + `superseded_by`，并搬进 `archive/` |
| `mem validate --fix` | 人（收尾） | 把"标了 superseded 但文件还在 `facts/`"的搬进 `archive/` |
| `mem archive <id>`（**新增**） | **人** | 不再适用**又没有替代** → `archive/`，`status: expired` |
| `mem restore <id>`（**新增**） | 人 | 从 `archive/` 捞回 `inbox/`，`status` 复位 active，再确认一次 |

模型只有 `memory_write`（写 `inbox/`）与 `memory_search` —— 它**不能** promote / supersede / archive。
它最多在 `verify_when` 到期时被提醒"这条可能过时了，去问用户"。

**发现的坑（补 `archive` 的直接理由）**：`mem set --status expired` 只改 frontmatter、**不搬文件**，
于是条目不参与注入（对）却留在 `facts/` —— 结果**既不在「已在用」（只列 active）也不计入「已归档」
（数的是 `archive/` 里的文件）→ 从界面上彻底消失**。"手动归档"就是把它搬到该去的地方。

**三种"退场"必须分清**（都离开常驻层，但语义/去向/可逆性都不同）：

| 操作 | 什么意思 | 去向 | 可逆 |
| --- | --- | --- | --- |
| `demote` | 先不当真（还不确定 / 先别发给模型） | `inbox/` | 再 `promote` 一次就回去 |
| `archive` | 不再适用，又没有替代 | `archive/`（expired） | `restore` 捞回候选层 |
| `supersede` | 错了/过时了，有新真相顶上 | `archive/`（superseded + 双向链接） | `restore`，或改 `supersedes` |

面板对应：常驻条目「撤回」+「归档」，归档条目「取回」（都要过行内确认条）。
**归档层现在会把条目列出来**（以前只显示条数）—— 否则「取回」没有入口，
用户会以为"记过、后来被取代了"的东西丢了。归档不是删除：它仍能被 `mem recall` 与面板搜索搜到
（这一条有测试钉住）。

`restore` 刻意放回**候选层**而不是直接回常驻：取回之后还要人再确认一次，不绕过"人确认"那道闸。

**⑦ 已知小瑕疵：改名会让注入"抖一下"。** `entryHash` 算了 `id`，而 planner 跨轮也是按 `id` 匹配
条目的 —— 所以**纯改名**会被差分看成"旧 id 消失 + 新 id 出现"，于是那一轮多推一遍该条内容
（实测：13 条改名 → 下一轮 10 条"新增" + 10 条"已失效"，注入字节不变，纯属一次性噪音）。
内容其实一个字没变（注入正文里本来就没有 id）。要彻底消掉它，得让跨轮状态改用
"`key` 优先、没 key 才用 id"的稳定标识 —— 收益只有"改名那一轮安静一点"，
所以记在这里，暂不改。

