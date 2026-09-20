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
import { MEMORY_SOURCE_KIND } from './planner.mjs';

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
});

/** 把 (config, cwd) 解析成一次可用的记忆库句柄。 */
function openStore(config, cwd, { forWrite = false } = {}) {
  if (config.enabled === false) return null;
  const root = config.root ? path.resolve(config.root) : path.join(cwd ?? process.cwd(), 'memory');
  // 读的时候**绝不产生副作用**（不能在用户每个工作区里都建出 memory/ 目录）；
  // 只有真要写（memory_write）时才按需建目录 —— 否则在一个还没有 memory/ 的工作区里，
  // 工具会抛出让人摸不着头脑的 ENOENT（真机预检抓到的）。
  const L = ensureLayout(root, { create: forWrite });
  const fileConfig = loadConfig(root);
  const budget = config.maxBytes || fileConfig?.injectBudget || 3072;
  // 会话工作区是权威的 scope，显式传下去 —— 否则 createEntry 会退到记忆库声明或
  // process.cwd()，而插件的 process.cwd() 是 harness 的 launch-root（真机试用踩到）。
  const scope = `workspace:${cwd ?? process.cwd()}`;
  return { root, L, budget, scope };
}

const truncated = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function apply(ctx, config = {}) {
  const storeOf = (cwd, opts) => openStore(config, cwd, opts);

  /* ------------------------------------------------------------ 注入 */
  const hook = createMemoryHook({
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
    createMessage: (text, entries, form) =>
      createUserMessage({
        content: [{ type: 'text', text }],
        // entries 只在携带状态时出现；蒸馏提醒（form='nudge'）故意不带 entries，
        // 这样它不会被当成"上一轮状态"而把差分基线清零。
        source: {
          kind: MEMORY_SOURCE_KIND,
          ...(Array.isArray(entries) ? { entries } : {}),
          ...(form ? { form } : {}),
        },
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
        limit: { type: 'integer', description: 'Max matches to return. Default 20.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer', required: true },
            matches: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  where: { type: 'string', required: true },
                  type: { type: 'string' },
                  status: { type: 'string' },
                  key: { type: 'string' },
                  line: { type: 'string', required: true },
                  snippet: { type: 'string' },
                  score: { type: 'number' },
                  matched: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.total === 0 ? 'No memory entries matched.' : `Matched ${value.total} memory entr${value.total === 1 ? 'y' : 'ies'}.`,
          },
        ],
      },
      execute(args, exec) {
        const store = storeOf(exec?.agent?.session?.header?.cwd);
        if (!store) return Promise.resolve({ total: 0, matches: [] });
        const limit = Number.isFinite(args.limit) ? Number(args.limit) : 20;

        // 检索与 `mem recall`、侧边栏搜索框**完全共用一份实现**（`searchLibrary` →
        // `src/search.mjs` 的分词/打分/片段）。返回的是无损 JSON（`searchLibrary` 已经
        // 把值为 undefined 的字段整条省掉了，见那里的注释）。
        const found = searchLibrary(store.L, { query: args.query, where: args.where ?? 'all', limit, maxLen: 240 });
        return Promise.resolve({ total: found.total, matches: found.matches });
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
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Recorded candidate ${value.id} in the memory inbox (not yet injected; needs promotion to become a standing fact).`,
          },
        ],
      },
      execute(args, exec) {
        // forWrite：允许按需建出记忆库目录（读路径绝不建目录）
        const store = storeOf(exec?.agent?.session?.header?.cwd, { forWrite: true });
        if (!store) throw new Error('memory_write: 记忆库不可用（检查插件配置 enabled/root）');
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
        return Promise.resolve({ id: created.id, status: 'inbox' });
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
      { configRoot: config.root || undefined, allow: config.allowWrite !== false },
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

  // 返回 hook：不是为了给 DSH 用（loader 不看返回值），而是留一个**不污染 ctx 的测试缝** ——
  // 只算不做的 `planFor` 是排查"这轮为什么注入/为什么不注入"最直接的入口，
  // 测试可以直接断言它的返回形状，而不是反推 pre-step 结果。
  return hook;
}
