/**
 * dsh-memory-delta 的 **DSH 插件**（Cordis）。
 *
 * 这一层刻意做得很薄：所有决策逻辑都在 `hook.mjs`（已单测，用假 agent/decision 完整覆盖），
 * 这里只负责三件事 —— 读配置、把 DSH 的依赖注进去、注册 pre-step 与两个工具。
 * 这样即使插件本身没法在无 DSH 环境里跑，它的行为也是被测试覆盖的。
 *
 * 与上游 `@deepseek-ai/dsh-agent-instructions` 的关系：**共存，不替换**。
 * 那个插件负责把 AGENTS.md 等工作区指令文件推进上下文；本插件负责把结构化的长期记忆
 * 推进上下文，并且**只推变化的部分**（上游没有差分，文件一变就整篇重注入）。
 */

import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createEntry, ensureLayout, injectPayload, loadConfig, searchLibrary } from '../bin/mem.mjs';
import { createMemoryHook } from './hook.mjs';
import { memoryStateOf, registerActionRoute, registerMemoryRoute, registerSearchRoute } from './panel.mjs';
import { memorySource } from './planner.mjs';
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, SKILL_SOURCE, SKILL_WHEN_TO_USE } from './skill.mjs';

export const name = 'memory';
export const inject = ['tools'];

export const Config = z.object({
  /** 记忆库根目录；留空则用会话工作目录下的 `memory/`。 */
  root: z.string().default(''),
  /** 首次（baseline）注入的字节预算；差分注入通常远小于它。 */
  maxBytes: z.number().step(1).min(256).default(3072),
  /** 关掉注入但保留工具（调试用）。 */
  enabled: z.boolean().default(true),
  /** `verify_when` 提前几天提醒复核（0 = 只在已到期时提醒）。 */
  dueWithin: z.number().step(1).min(0).default(0),
  /** 关掉侧边栏「记忆」页签的数据路由（无 webServer 时本来就不注册）。 */
  panel: z.boolean().default(true),
  /**
   * 允许面板里的按钮**写记忆库**：收件箱一键提升（promote）、整理文件名（rename）。
   * 默认开；关掉后按钮会显示"配置里关掉了"，而不是静默失效。
   */
  allowWrite: z.boolean().default(true),
  /**
   * 注册**插件自带的技能**（装了插件就能 `/dsh-memory-delta` 调出用法与边界说明）。
   * 默认开；不想要技能目录里多一行（约 20~40 tokens/会话）就关掉。
   */
  skill: z.boolean().default(true),
});

/**
 * 把 (config, cwd) 解析成一次可用的记忆库句柄；**解析不出来就返回 null，绝不猜**。
 *
 * ⚠️ 这里以前是 `path.join(cwd ?? process.cwd(), 'memory')` —— 而插件的 `process.cwd()` 是
 * harness 的启动目录（launch-root），不是会话的工作区。后果是"静默搜错库"：
 * `memory_search` 会去 `<启动目录>/memory` 里找，返回空（模型以为"没记过"）或**别的工作区**的命中；
 * `memory_write` 更糟 —— 它 `forWrite`，会在那个目录里**真的建出一个记忆库**。
 * 拿不到工作区时应该是"用不了"，不是"随便挑一个"。
 *
 * @param {object} config 插件配置
 * @param {string|null} cwd 会话工作区（`agent.session.header.cwd`）；缺了就不能靠猜
 * @returns {{root: string, L: object, budget: number, scope: string}|null}
 */
function openStore(config, cwd, { forWrite = false } = {}) {
  if (config.enabled === false) return null;
  // 显式配了 root 时与工作区无关（用户在别处维护的库）—— 这种情况不需要 cwd
  if (!config.root && !cwd) return null;
  const root = config.root ? path.resolve(config.root) : path.join(cwd, 'memory');
  // 读的时候**绝不产生副作用**（不能在用户每个工作区里都建出 memory/ 目录）；
  // 只有真要写（memory_write）时才按需建目录 —— 否则在一个还没有 memory/ 的工作区里，
  // 工具会抛出让人摸不着头脑的 ENOENT（真机预检抓到的）。
  const L = ensureLayout(root, { create: forWrite });
  const fileConfig = loadConfig(root);
  const budget = config.maxBytes || fileConfig?.injectBudget || 3072;
  // 会话工作区是权威的 scope，显式传下去 —— 否则 createEntry 会退到记忆库声明或
  // process.cwd()，而插件的 process.cwd() 是 harness 的 launch-root（真机试用踩到）。
  // 只有在**没有工作区**时（插件配了固定 root 的那种部署）才退回用库根当 scope 名。
  const scope = cwd ? `workspace:${cwd}` : `workspace:${path.resolve(config.root)}`;
  return { root, L, budget, scope };
}

/** 拿不到会话工作区时的统一说法（工具、hook 都复用它，别各写各的）。 */
const NO_CWD_MESSAGE =
  '拿不到会话工作目录（agent.session.header.cwd），无法确定是哪个工作区的记忆库 —— ' +
  '本会话里记忆功能不可用（如果你把插件的 root 显式配成了固定的库，就不会有这个问题）';

/** `memory_search` 一次最多返回多少条 —— 与面板搜索路由同一个上界（防止一次灌满上下文）。 */
export const SEARCH_LIMIT_MAX = 100;

const truncated = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 真有文件可读的层（流水/会话索引是**行级**命中，路径给了也用不上，id 里已经带行号）。 */
const ENTRY_WHERE = new Set(['facts', 'decisions', 'inbox', 'archive']);

/**
 * 丢掉值为 `undefined` 的属性 —— DSH 的工具返回值必须是**无损 JSON**
 * （值为 undefined 的属性会让整个工具调用失败，见记忆库的 tool-output-lossless-json）。
 */
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

export function apply(ctx, config = {}) {
  const storeOf = (cwd, opts) => openStore(config, cwd, opts);

  /* ------------------------------------------------ 差分状态（侧车文件） */

  /**
   * 状态放 `$DSH_HOME/storages/dsh-memory-delta/inject-state/<sessionId>.json`。
   *
   * ⚠️ 为什么必须外置：DSH 会话格式的 v0 白名单只允许 plugin source 带
   * `kind/plugin/form/sections/summary`（见 planner.mjs 注释），把差分状态塞进 source 会被
   * 迁移拒绝、让整个会话**永久打不开**。放这里既不受格式约束，也不占模型预算。
   * DSH_HOME 拿不到（脱离 DSH 单独跑）时降级为不持久化：进程内存里照常差分，
   * 重启后重灌一次全量记忆（正确性不受影响）。
   */
  const stateDir = () => {
    // 测试 / CI 显式指向沙箱，免得把差分状态写进真实的 DSH_HOME
    if (process.env.DSH_MEMORY_DELTA_STATE_DIR) return process.env.DSH_MEMORY_DELTA_STATE_DIR;
    const home = process.env.DSH_HOME;
    return home ? path.join(home, 'storages', 'dsh-memory-delta', 'inject-state') : null;
  };
  const loadState = (sessionId) => {
    const dir = stateDir();
    if (!dir || !sessionId) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') ctx.logger?.warn?.('memory: 读取差分状态失败 %o', error);
      return null;
    }
  };
  const saveState = (sessionId, payload) => {
    const dir = stateDir();
    if (!dir || !sessionId || !payload) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(payload), 'utf8');
    } catch (error) {
      ctx.logger?.warn?.('memory: 写出差分状态失败 %o', error);
    }
  };

  /* ------------------------------------------------------------ 注入 */
  const hook = createMemoryHook({
    loadState,
    saveState,
    loadPayload: async (cwd) => {
      const store = storeOf(cwd);
      if (!store) return null;
      try {
        return injectPayload(store.L, store.budget);
      } catch (error) {
        ctx.logger?.warn?.('memory: 读取记忆库失败 %o', error);
        return null;
      }
    },
    createMessage: (text) =>
      createUserMessage({
        content: [{ type: 'text', text }],
        // 形状统一定义在 planner.mjs 的 memorySource()：v0 白名单只允许 kind + plugin。
        // 差分状态不在这里，走上面 loadState/saveState 的侧车。
        source: memorySource(),
      }),
    logger: ctx.logger,
    dueWithin: config.dueWithin ?? 0,
  });

  ctx.on('agent/pre-step', (input, next) => hook.handlePreStep(input, next));

  /* -------------------------------------------------------- 读取工具 */
  ctx.tools.register(
    defineTool({
      name: 'memory_search',
      description:
        'Search the project long-term memory (dsh-memory-delta): confirmed facts, decisions, the journal, ' +
        'the session index, and the inbox of pending candidates. Use it when the user refers to past ' +
        'decisions, conventions, or "we already figured this out". Results are ranked by relevance and ' +
        'each carries a snippet; Chinese queries are matched by bigram, so no need to add spaces.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Keywords to look for (id, conclusion, key, tags, journal text). Chinese works without spaces.',
        },
        where: {
          type: 'string',
          enum: ['all', 'facts', 'decisions', 'inbox', 'archive', 'journal', 'sessions', 'index'],
          description: 'Narrow the search to one layer. Default all.',
        },
        limit: { type: 'integer', description: `Max matches to return (default 10, hard cap ${SEARCH_LIMIT_MAX}). Each hit renders a snippet plus its file path (~300 bytes), so keep it small; \`truncated\` in the result tells you when more matched.` },
      },
      output: {
        // ⚠️ 这里的字段清单必须**覆盖 searchLibrary 真正会返回的每一个键**。
        //
        // 真机踩到（2026-09-21）：`tags` / `date` / `file` 曾没声明，而 `searchLibrary`
        // 给每条命中都带上 `file` —— DSH 在 `ToolRuntime.createSuccessResult()` 里会对返回值
        // 跑一遍 `additionalProperties: false` 校验，于是**只要有任何命中**，整个工具调用就变成
        // `Error: tool "memory_search" returned invalid output: "value.matches[0].file" is not a
        // declared property`；只有"零命中"才看起来正常。
        //
        // 这个坑能活下来是因为两条测试都绕过了这一步：plugin-tests 用桩 defineTool（identity，
        // 不校验），preflight 只调 `execute()`（校验发生在 runtime 层）。现在两边都补上了
        // 对输出契约的断言 —— **改 searchLibrary 的返回字段时，同步改这里**。
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer', required: true, description: 'Number of matches actually returned (bounded by `limit`, so it is not the total number of hits).' },
            truncated: { type: 'boolean', description: 'True when more matched than `limit` allowed (or when journal lines were folded): narrow the query, or search `where: journal` for process records.' },
            lineDropped: { type: 'integer', description: 'How many journal / session-index lines matched but were **folded away** — those layers are down-weighted and capped so a broad query does not spend the context on process records. Use `where: "journal"` to see them.' },
            matches: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  where: { type: 'string', required: true, description: 'facts | decisions | inbox | archive | journal | sessions | index' },
                  type: { type: 'string' },
                  status: { type: 'string' },
                  key: { type: 'string' },
                  topic: { type: 'string', description: 'The human-assigned topic this entry is filed under (absent when unclassified).' },
                  tags: { type: 'array', items: { type: 'string' } },
                  date: { type: 'string', description: 'Date the entry was recorded (YYYY-MM-DD); use it to judge how fresh the conclusion is.' },
                  file: { type: 'string', description: 'Absolute path of the entry (or journal/sessions) file — read it for the full conclusion and reason, since the snippet is clipped.' },
                  line: { type: 'string', required: true },
                  snippet: { type: 'string' },
                  score: { type: 'number' },
                  matched: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        // ⚠️⚠️ **模型只看得到 render 产出的文本** —— `value`（结构化的 matches）到不了它眼前：
        //   · dsh-agent-loop/lib/index.js:307   content: result.content  → 进 `tool/result` 消息
        //   · dsh-llm-deepseek/lib/index.js:158 content: flattenText(result.content) || "(no output)"
        // 所以**命中列表必须渲染成文本**。这里曾经只有一句 `Matched N memory entries.` ——
        // 调用不报错、`value` 里字段也齐全，但模型一条都看不到（id / 片段 / 路径全凭空消失），
        // 等于"搜了个寂寞"。改 render 时记住：output.schema 只决定**校验**，render 才决定**模型看到什么**。
        render: (_args, value) => {
          if (!value.total) {
            return [
              {
                type: 'text',
                text: 'No memory entries matched. Chinese is matched by bigram, so no spaces are needed — try other keywords or one distinctive term.',
              },
            ];
          }
          const lines = [
            `Matched ${value.total} memory entr${value.total === 1 ? 'y' : 'ies'}` +
              (value.truncated ? ` (capped at ${SEARCH_LIMIT_MAX} — narrow the query to see the rest)` : '') +
              ':',
          ];
          value.matches.forEach((m, i) => {
            const head = [`${i + 1}. [${m.where}] ${m.id}`];
            if (m.key && m.key !== m.id) head.push(`key=${m.key}`);
            if (m.topic) head.push(`topic=${m.topic}`);
            if (m.date) head.push(String(m.date));
            head.push(`score=${m.score}`);
            lines.push(head.join('  '));
            const body = m.snippet || m.line;
            if (body) lines.push(`   ${body}`);
            if (m.file && ENTRY_WHERE.has(m.where)) lines.push(`   file: ${m.file}`);
          });
          lines.push('Snippets are clipped — read the file for the full conclusion and reason.');
          if (value.lineDropped > 0) {
            lines.push(
              `(${value.lineDropped} more journal/session lines matched and were folded away — ` +
                'they are down-weighted on purpose; call again with where="journal" if you need the process record.)',
            );
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      execute(args, exec) {
        const store = storeOf(exec?.agent?.session?.header?.cwd);
        // 拿不到工作区就**明确报错**：以前这里返回"零命中"，模型会把"搜错库"读成"没记过"
        if (!store) throw new Error(`memory_search: ${NO_CWD_MESSAGE}`);
        // 默认 10（不是 CLI/面板的 20）：命中现在会**连片段一起**渲染给模型（约 300 字节/条），
        // 20 条 ≈ 7 KB ≈ 2k tokens。
        // ⚠️ **必须封顶**：工具描述在教模型"不够就 raise limit"，而这里原本没有上界 ——
        // 一次 `limit: 100000` 就能把整个库（几十 KB）灌进上下文，正好把这个插件省的 token 全吐回去。
        // 面板那条路由一直是 100，现在两边口径一致。
        const requested = Number.isFinite(args.limit) ? Number(args.limit) : 10;
        const limit = Math.max(1, Math.min(requested, SEARCH_LIMIT_MAX));

        // 检索与 `mem recall`、侧边栏搜索框**完全共用一份实现**（`searchLibrary` →
        // `src/search.mjs` 的分词/打分/片段）。返回的是无损 JSON（`searchLibrary` 已经
        // 把值为 undefined 的字段整条省掉了，见那里的注释）。
        const found = searchLibrary(store.L, { query: args.query, where: args.where ?? 'all', limit, maxLen: 240 });
        return Promise.resolve({ total: found.total, truncated: found.truncated, lineDropped: found.lineDropped, matches: found.matches });
      },
      presentCall: (args) => ({ card: 'generic', title: `Search memory: ${truncated(args.query, 60)}`, kind: 'other', rawInput: args }),
    }),
  );

  /* -------------------------------------------------------- 写入工具 */
  ctx.tools.register(
    defineTool({
      name: 'memory_write',
      description:
        'Record a durable candidate entry into the project memory INBOX. Use it when the user expresses a ' +
        'preference, fixes a convention, reaches a conclusion, or hits a pitfall worth remembering. ' +
        'Entries land in inbox/ and do NOT get injected until a human promotes them to the fact layer — ' +
        'so write freely, but write conclusions (not process).',
      parameters: {
        type: { type: 'string', required: true, enum: ['fact', 'decision'], description: 'fact = a truth about the project; decision = a choice plus its reason.' },
        conclusion: { type: 'string', required: true, description: 'One-line conclusion, not a narrative.' },
        reason: { type: 'string', description: 'Why it holds / why it was chosen.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Topic tags for later retrieval.' },
        key: { type: 'string', description: 'Semantic key: only one active fact may exist per key. Lowercase, [a-z0-9._-]. Strongly recommended — when given (and id is not), the key becomes the file name, which keeps the store readable.' },
        id: { type: 'string', description: 'Optional short explicit id; derived from key when a key is given, otherwise from the conclusion.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            status: { type: 'string', required: true },
            // 超预算时才出现（普通情况下整条省掉）—— 在"写入那一刻"提醒，
            // 比等面板变红更及时；而且它只在写的时候回一次，**不占每轮的注入预算**。
            budgetNote: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Recorded candidate ${value.id} in the memory inbox (not yet injected; needs promotion to become a standing fact).` +
              (value.budgetNote ? `\n\nWARNING: the standing memory is over its injection budget — ${value.budgetNote}` : ''),
          },
        ],
      },
      execute(args, exec) {
        // forWrite：允许按需建出记忆库目录（读路径绝不建目录）
        const store = storeOf(exec?.agent?.session?.header?.cwd, { forWrite: true });
        if (!store) throw new Error(`memory_write: ${NO_CWD_MESSAGE}`);
        const created = createEntry(store.L, {
          type: args.type,
          conclusion: args.conclusion,
          reason: args.reason,
          tags: args.tags,
          key: args.key,
          id: args.id,
          scope: store.scope,
          source: exec?.agent?.session?.header?.id ?? null,
        });
        // 写完之后检查预算：已经超了就顺手告诉模型（也让用户从对话里看到）
        let budgetNote;
        try {
          const payload = injectPayload(store.L, store.budget);
          if (payload.overBudget) {
            budgetNote = `injection is ${payload.bytes} / ${payload.budget} bytes (${payload.entries.length} standing entries, over by ${payload.bytes - payload.budget}). Ask the user to archive/retire entries or keep conclusion first lines short (only the first line + key is injected), or raise maxBytes.`;
          }
        } catch {
          // 预算算不出来不该让写入失败
        }
        return Promise.resolve(defined({ id: created.id, status: 'inbox', budgetNote }));
      },
      presentCall: (args) => ({ card: 'generic', title: `Remember: ${truncated(args.conclusion, 60)}`, kind: 'other', rawInput: args }),
    }),
  );

  /* ------------------------------------------- 侧边栏「记忆」页签的数据路由 */
  // webServer 是**可选**依赖：headless / CLI 组合里没有它，所以不能写进 `inject`
  // （Cordis 的 `inject` 是硬依赖，声明了插件会一直 PENDING 直到服务出现）。
  //
  // ⚠️ 但也不能用 `ctx.get('webServer')` 一眼定生死 —— **实测踩到**：
  // 本插件的行插在用户 patch 层里，apply 那一刻 webServer 可能还没就绪，`ctx.get`
  // 返回 undefined，于是路由**静默没注册**；页签照常出现，点开时报 "HTTP 405"，
  // 因为未知路径落到 SPA 回退，而那个服务器对非 GET 一律 405 —— 看起来像"方法不对"，
  // 实际是"路由压根不存在"。（排查方式：`GET /<路径>` 得 404、POST 得 405 = 回退在答；
  // 已注册的路径会用自己的语义回答，比如 better-sidebar 的 /sidebar/api 前缀回自己的 404。）
  //
  // 正确姿势是 `ctx.inject(deps, cb)`：**等服务可用之后**才跑回调，服务消失/重建时
  // fork 会被卸载重跑（cordis/src/registry.ts 的 RegistryService.inject）。
  const registerPanelRoute = (target, effectOwner) => {
    // root 优先：配了插件 root 就以它为准（用户在别处维护的记忆库）；
    // 否则 <workspace>/memory。客户端把 scope.cwd 作为 workspace 传进来。
    registerMemoryRoute(
      target,
      (input) =>
        memoryStateOf({
          configRoot: config.root || undefined,
          workspace: input?.workspace,
          dueWithin: config.dueWithin ?? 0,
          // 预算必须传**实际生效**的那个（插件 maxBytes 优先）—— 否则面板算超没超预算会和真实注入不一致
          budget: config.maxBytes || undefined,
        }),
      effectOwner?.effect?.bind(effectOwner) ?? ctx.effect?.bind(ctx),
    );
    // 只读状态路由之外，再挂两条：
    //   · 「搜索」= 复用 searchLibrary（与 mem recall / memory_search 同一份实现）
    //   · 「动作」= 写记忆库（promote / rename），复用 CLI 的 promoteEntry / renameEntry
    registerSearchRoute(
      target,
      { configRoot: config.root || undefined },
      effectOwner?.effect?.bind(effectOwner) ?? ctx.effect?.bind(ctx),
    );
    registerActionRoute(
      target,
      { configRoot: config.root || undefined, allow: config.allowWrite !== false, logger: ctx.logger },
      effectOwner?.effect?.bind(effectOwner) ?? ctx.effect?.bind(ctx),
    );
  };

  if (config.panel !== false) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (forkCtx) => registerPanelRoute(forkCtx.webServer, forkCtx));
    } else {
      // 极简 / 老版本 ctx（测试替身走这条）：退回到"读一下，有就注册"
      const webServer = ctx.get?.('webServer');
      if (webServer) registerPanelRoute(webServer, ctx);
      else ctx.logger?.debug?.('memory: 没有 ctx.inject，且当前拿不到 webServer，跳过面板路由');
    }
  }

  /* ------------------------------------------- 自带技能：装了插件就有用法说明 */

  // 为什么是"运行时注册"而不是随包发一个 SKILL.md：DSH 的技能发现根是
  // `<工作区>/.dsh/skills`、`$DSH_HOME/skills` 这类**目录**，**package 里的文件扫不到** ——
  // 发文件等于没发。`skills.register()` 把技能绑在 ctx 生命周期上（内部 effect），
  // 插件卸载/重载即注销，也不会在用户目录里留文件。
  //
  // service 名是 **`skills`**（复数，见 @deepseek-ai/dsh-tool-skill 的 `inject`）——
  // 写成 `skill` 的话回调永远不触发，而且**静默**（和 webServer 一样的坑）。
  const registerSkill = (skills) => {
    if (typeof skills?.register !== 'function') return;
    try {
      skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        // ⚠️ source 必填：register() 只补 provider，"目录里看得见但加载时报错"就是漏了它
        source: SKILL_SOURCE,
        content: SKILL_CONTENT,
      });
    } catch (error) {
      // 宿主进程：绝不能让注册失败把插件 apply 打断
      ctx.logger?.warn?.('memory: 注册自带技能失败（不影响记忆功能）%o', error);
    }
  };

  if (config.skill !== false) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['skills'], (forkCtx) => registerSkill(forkCtx.skills));
    } else {
      // 极简 / 老版本 ctx（测试替身走这条）
      registerSkill(ctx.get?.('skills'));
    }
  }

  // 返回 hook：不是为了给 DSH 用（loader 不看返回值），而是留一个**不污染 ctx 的测试缝** ——
  // 只算不做的 `planFor` 是排查"这轮为什么注入/为什么不注入"最直接的入口，
  // 测试可以直接断言它的返回形状，而不是反推 pre-step 结果。
  return hook;
}
