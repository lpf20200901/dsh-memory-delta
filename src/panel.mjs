/**
 * 「记忆」侧边栏页签的**宿主半边** —— 一条只读状态路由 + 一条写记忆库的动作路由。
 *
 * 客户端插件（`client/client.js`）拿不到磁盘，所以数据的唯一来源是这里。
 * 这一层刻意做得很薄，而且**只做四件事**：
 *   1. 把 `workspace` / 插件 `root` 配置解析成记忆库根目录；
 *   2. 用**既有实现**（`bin/mem.mjs` 的 `injectPayload` / `readEntryFile`、
 *      `src/due.mjs` 的 `collectDue`）拼出一份面板要的状态；
 *   3. 在 webServer 上挂 `POST /dsh-memory-delta/state`（**只读**），带来源校验；
 *   4. 挂 `POST /dsh-memory-delta/action`（**写库**：收件箱提升 / 安全改名），
 *      逻辑复用 CLI 的 `promoteEntry` / `renameEntry`。
 *
 * 为什么**没有**"用系统文件管理器打开目录"那条路由：曾经有过（`/reveal`，白名单目录 +
 * `explorer.exe`），但界面用不上 —— 用户判定"有折叠箭头 + 点条目打开详情就够了"。
 * 一条没人调用的、会启动外部进程的路由纯粹是多余的安全面，于是连按钮带路由一起删掉了。
 * 要恢复的话：宿主侧需要白名单 + `spawn(..., {stdio:'ignore'})`（沙箱禁命名管道）。
 *
 * 为什么不另写一套解析：`mem tell` / `memory_search` / `mem due` 已经有一套，
 * 面板再抄一份必然漂移 —— 面板显示"3 条常驻"而模型只收到 2 条，是最难查的那种 bug。
 *
 * 为什么用 POST 而不是 GET：workspace 是**绝对路径**（Windows 上是 `D:\...`），
 * 放进 query 要两层编码，出错时只表现为"路径找不到"，很难查。POST 的 JSON body 一步到位，
 * 而且天然绕开"GET 被缓存 / 被预取"的问题。
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, archiveEntry, demoteEntry, ensureLayout, firstLine, injectPayload, promoteEntry, readAll, readEntryFile, removeEntry, renameEntry, restoreEntry, searchLibrary, today } from '../bin/mem.mjs';
import { collectDue } from './due.mjs';

/** 状态路由：exact 匹配。（包名是 dsh-memory-delta，路由跟着包名走） */
export const MEMORY_ROUTE_PATH = '/dsh-memory-delta/state';

/** 动作路由（写记忆库）：收件箱提升/撤回/删除候选、安全改名。 */
export const MEMORY_ACTION_PATH = '/dsh-memory-delta/action';

/**
 * `action` 路由认的操作 —— 白名单，别的一律 400。
 *
 * `promote` 与 `demote` 是**双向**的：候选 ⇄ 常驻。`remove` 只删候选（见 `removeEntry` 的理由）。
 */
export const ACTION_OPS = ['promote', 'demote', 'archive', 'restore', 'remove', 'rename'];

/** 搜索路由：面板搜索框 → 与 `mem recall` / `memory_search` 同一份检索实现。 */
export const MEMORY_SEARCH_PATH = '/dsh-memory-delta/search';

/** 搜索可以限定在哪一层 —— 白名单，不在里面的 where 一律 400（而不是"静默零结果"）。 */
export const SEARCH_WHERE = ['all', 'facts', 'decisions', 'inbox', 'archive', 'journal', 'sessions', 'index'];

/** 面板一次最多列的常驻条目数 —— 面板是"给用户信心"的，不是监控台。 */
export const PANEL_ENTRY_LIMIT = 200;

/** 收件箱候选在状态里最多带几条（只带首行，足够"提示还有这些"。 */
export const PANEL_INBOX_LIMIT = 50;

/** 全局规范在面板里只带前多少行 —— 它是"看一眼"用的，整篇塞进 state 既没必要也白占带宽。 */
export const GLOBAL_PREVIEW_LINES = 40;

/* ------------------------------------------------------------ 小工具 */

/**
 * 丢掉值为 `undefined` 的属性。
 *
 * DSH 的工具层要求**无损 JSON**（值为 undefined 的属性会让整个调用失败）。
 * 这条 HTTP 路由不受那个校验约束，但保持同样的纪律有两个好处：
 * 客户端不用区分「字段不存在」和「字段是 undefined」，而 `JSON.stringify`
 * 本来就会把 undefined 静默丢掉 —— 与其让它悄悄消失，不如在这里显式去掉。
 */
function defined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** 记忆库根目录是否真的存在（**绝不创建** —— 读路径不能有副作用）。 */
function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 安全地读记忆库自己的 `memory.config.json`。
 *
 * ⚠️ **不能**直接调 `bin/mem.mjs` 的 `loadConfig`：它发现 JSON 非法时走 `fail()`
 * → `process.exit(1)`。在 CLI 里这是对的，但在这里会把**整个 DSH 宿主进程**
 * 干掉（用户只要手滑编辑坏一个文件，桌面版就没了）。所以这里自己读、自己容错。
 *
 * @returns {{budget: number|null, scope: string|null}}
 */
function safeConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  try {
    if (!fs.existsSync(file)) return { budget: null, scope: null };
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      budget: Number.isFinite(cfg?.injectBudget) ? cfg.injectBudget : null,
      scope: typeof cfg?.scope === 'string' && cfg.scope ? cfg.scope : null,
    };
  } catch {
    // 配置坏了不是"面板打不开"的理由：退回默认预算，面板照常显示。
    return { budget: null, scope: null };
  }
}

/* ------------------------------------------------------------ 根目录解析 */

/**
 * 把一次请求解析成记忆库根目录。
 *
 * 顺序：**插件配置的 root 优先**（配了就用它，这是用户明确指定的库），
 * 否则 `<workspace>/memory`。两者都没有（workspace 缺失）时返回 `null`，
 * 由调用方给出"空状态"，而不是抛错 —— 客户端挂载时可能还不知道 cwd。
 *
 * @param {{configRoot?: string, workspace?: string}} input
 * @returns {{root: string, workspace: string|null}}
 */
export function resolvePanelRoot({ configRoot, workspace } = {}) {
  const ws = typeof workspace === 'string' && workspace.trim() ? path.resolve(workspace.trim()) : null;
  if (typeof configRoot === 'string' && configRoot.trim()) {
    return { root: path.resolve(configRoot.trim()), workspace: ws };
  }
  if (ws === null) return { root: null, workspace: null };
  return { root: path.join(ws, 'memory'), workspace: ws };
}

/* ------------------------------------------------------ 全局规范（工作区外） */

/**
 * 用户级指令文件 —— **每个工作区、每次新会话都会被 DSH 注入**的那一份。
 *
 * 注意：这份**不是本插件注入的**，是 DSH 自带的 `dsh-agent-instructions`：
 * 它读 `$DSH_HOME/AGENTS.md`（用户全局）+ `<项目根>/AGENTS.md`（项目）。面板把它显示出来，
 * 只是因为"已经在生效的东西"不该在界面上完全看不见 —— 用户会以为全局规范没生效。
 *
 * ⚠️ 只显示**展示形式**的路径（`~/.dsh/AGENTS.md`），不显示绝对路径：绝对路径里带用户名，
 * 而这个面板会被截图放进公开仓库（截图脚本只裁了「库：」那一行）。
 */
export function globalInstructionOf(opts = {}) {
  const home = opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, 'AGENTS.md');
  const out = { file, displayPath: '~/.dsh/AGENTS.md', exists: false, bytes: 0, lines: 0, mtime: null, preview: [] };
  try {
    if (!fs.existsSync(file)) return out;
    const text = fs.readFileSync(file, 'utf8');
    const all = text.split(/\r?\n/);
    out.exists = true;
    out.bytes = Buffer.byteLength(text, 'utf8');
    out.lines = all.length;
    out.mtime = fs.statSync(file).mtime.toISOString();
    // 预览只带前 N 行：面板是"看一眼"的，整篇塞进 state 既没必要也白占带宽
    out.preview = all.slice(0, opts.previewLines ?? GLOBAL_PREVIEW_LINES);
    out.truncated = all.length > out.preview.length;
    return out;
  } catch {
    // 读不了不是"面板打不开"的理由（权限/编码问题都退化成"看不见内容"）
    return out;
  }
}

/**
 * 本库里的全局规范**源文件**（`<库根>/global-AGENTS.md`）。
 *
 * 这是我们这套工作流自己的约定：源文件在库里（可 review / 可 diff），同步一份到
 * `$DSH_HOME/AGENTS.md` 才真正生效。面板把两者并排显示，就是为了让"改了源文件但忘了同步"
 * 这件事看得见。
 */
export function globalSourceOf(L) {
  const file = path.join(L.root, 'global-AGENTS.md');
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    return { name: 'global-AGENTS.md', bytes: Buffer.byteLength(text, 'utf8'), mtime: fs.statSync(file).mtime.toISOString() };
  } catch {
    return null;
  }
}

/**
 * 工作区级指令文件（`<工作区>/AGENTS.md` + `AGENTS.local.md`）—— DSH 也是每个会话都会注入。
 *
 * 和全局那份的区别：**这些在工作区内**，所以 better-sidebar 的 workspace fence 允许打开它们，
 * 面板可以给一个「编辑」按钮直接进编辑器 —— 不需要我们再造一套编辑 UI。
 * 路径只回**相对名**（`AGENTS.md`），绝对路径会带用户名/工作区路径，截图会泄露。
 */
export function workspaceInstructionsOf(workspace) {
  const ws = typeof workspace === 'string' && workspace.trim() ? path.resolve(workspace.trim()) : null;
  if (!ws) return [];
  return ['AGENTS.md', 'AGENTS.local.md']
    .map((name) => {
      const file = path.join(ws, name);
      try {
        if (!fs.existsSync(file)) return { name, exists: false, bytes: 0, mtime: null };
        const text = fs.readFileSync(file, 'utf8');
        return {
          name,
          exists: true,
          file,
          bytes: Buffer.byteLength(text, 'utf8'),
          mtime: fs.statSync(file).mtime.toISOString(),
        };
      } catch {
        return { name, exists: false, bytes: 0, mtime: null };
      }
    })
    .filter((x) => x.exists);
}

/** 归档层在面板里最多列几条 —— 归档是"历史"，不给它无限长度。 */
export const PANEL_ARCHIVE_LIMIT = 50;

/**
 * 归档层的条目（`archive/`）。
 *
 * 为什么要把它们列出来（以前只显示一个条数）：**「取回」需要入口** —— 归档不是终点，
 * 归档错了或情况又变了时，用户得能把它捞回来。而且"我记过、后来归档了"的东西
 * 只靠搜索框找，体验上像是丢了。
 */
function archiveEntriesOf(L) {
  const out = [];
  for (const e of readAll(L)) {
    if (e.error || e.where !== 'archive') continue;
    out.push(e);
  }
  // 新的排前面（同一天按 id 稳定排序）
  out.sort((a, b) => String(b.data?.date ?? '').localeCompare(String(a.data?.date ?? '')) || String(a.id).localeCompare(String(b.id)));
  return out;
}

/* ------------------------------------------------------------ 状态拼装 */

/** 空状态：结构完整、数组为空 —— 客户端不需要为"还没有记忆库"写第二条渲染分支。 */
function emptyState(root, scope, budget, workspace = null) {
  return {
    root: root ?? '',
    scope: scope ?? '',
    // workspace 让客户端**从响应里反推**该用哪个工作区（scope 里没带 cwd 时就能自愈）
    workspace: workspace ?? String(scope || '').replace(/^workspace:/, ''),
    today: today(),
    budget,
    bytes: 0,
    entries: [],
    due: [],
    inbox: [],
    global: null,
    workspaceRules: [],
    archive: [],
    counts: { active: 0, facts: 0, decisions: 0, inbox: 0, archive: 0, due: 0 },
  };
}

/**
 * 拼出面板要的完整状态。
 *
 * @param {{root: string}} L `ensureLayout` 的结果
 * @param {{scope?: string|null, budget?: number|null, dueWithin?: number, entryLimit?: number, inboxLimit?: number}} [opts]
 * @returns {object} 无损 JSON（没有 undefined 值）
 */
export function buildMemoryState(L, opts = {}) {
  const budget = Number.isFinite(opts.budget) && opts.budget > 0 ? opts.budget : 3072;
  // 注意：这里处理的是 `injectPayload` 的**扁平载荷条目**（scope 是字符串），
  // 不是 mem.mjs 的原始条目（scope 在 `e.data.scope`）。以前在这里按 raw 形状取值，
  // 结果整条路由回 500（"Cannot read properties of undefined (reading 'scope')"）。
  const scopeOf = (e) => (typeof e?.scope === 'string' && e.scope ? e.scope : opts.scope || '');
  const scope = opts.scope || '';
  const entryLimit = Number.isFinite(opts.entryLimit) ? opts.entryLimit : PANEL_ENTRY_LIMIT;
  const inboxLimit = Number.isFinite(opts.inboxLimit) ? opts.inboxLimit : PANEL_INBOX_LIMIT;
  const dueWithin = Number.isFinite(opts.dueWithin) ? opts.dueWithin : 0;

  // 注入载荷：**和插件推给模型的是同一个函数**，所以 bytes / entries 一定对得上。
  // 用一个大预算调一次，拿到不截断的条目列表；再按真实预算调一次拿真实字节数。
  const payload = injectPayload(L, budget);
  const allEntries = injectPayload(L, Number.MAX_SAFE_INTEGER).entries;

  // 到期复核：due.mjs 要 {id, line, date, verifyWhen}，这里从载荷里取（与 mem due 同源）。
  const dueInput = payload.entries.map((e) => ({ id: e.id, line: e.line, date: e.date, verifyWhen: e.verifyWhen }));
  const due = collectDue(dueInput, today(), { within: dueWithin });

  const inboxEntries = inboxOf(L);
  const counts = {
    active: allEntries.length,
    facts: allEntries.filter((e) => e.type === 'fact').length,
    decisions: allEntries.filter((e) => e.type === 'decision').length,
    inbox: inboxEntries.length,
    archive: countMd(L.archive),
    due: due.length,
  };

  return {
    root: L.root,
    scope,
    workspace: String(scope || '').replace(/^workspace:/, ''),
    today: today(),
    budget,
    bytes: payload.bytes,
    entries: allEntries.slice(0, entryLimit).map((e) =>
      defined({
        id: e.id,
        type: e.type,
        key: e.key ?? undefined,
        status: e.status,
        tags: Array.isArray(e.tags) ? e.tags : [],
        date: e.date,
        // 文件绝对路径 —— 客户端点条目时用它调 `betterSidebar.openFile` 打开这条记忆。
        file: e.file,
        line: e.line,
        verifyWhen: e.verifyWhen ?? undefined,
        due: due.find((d) => d.id === e.id)?.due,
        overdueDays: due.find((d) => d.id === e.id)?.overdueDays,
        scope: scopeOf(e) || undefined,
      }),
    ),
    due: due.map((d) =>
      defined({
        id: d.id,
        line: d.line,
        verifyWhen: d.verifyWhen,
        due: d.due,
        overdueDays: d.overdueDays,
      }),
    ),
    inbox: inboxEntries.slice(0, inboxLimit).map((e) =>
      defined({ id: e.id, type: e.data.type, line: firstLine(e.body), date: e.data.date, file: e.file }),
    ),
    // 全局规范（工作区外、DSH 自己注入的那份）+ 本库里的源文件 —— 面板要能看见"已经在生效"的东西
    global: defined({
      ...globalInstructionOf({ dshHome: opts.dshHome, previewLines: opts.globalPreviewLines }),
      source: globalSourceOf(L) ?? undefined,
    }),
    // 工作区规范（在工作区内，所以可以点「编辑」直接进侧边栏编辑器）
    workspaceRules: workspaceInstructionsOf(opts.workspace),
    // 归档层：只带首行 + 文件路径（面板要能列出它们、点「取回」）
    archive: archiveEntriesOf(L)
      .slice(0, Number.isFinite(opts.archiveLimit) ? opts.archiveLimit : PANEL_ARCHIVE_LIMIT)
      .map((e) =>
        defined({
          id: e.id,
          type: e.data?.type,
          key: e.data?.key || undefined,
          status: e.data?.status,
          date: e.data?.date,
          line: firstLine(e.body),
          file: e.file,
        }),
      ),
    counts,
  };
}

/**
 * 收件箱里的候选条目。
 *
 * 复用 `readEntryFile`（`mem show` / `readAll` 用的同一个解析器），不自己写一份
 * frontmatter 解析 —— 两份解析必然漂移。
 */
function inboxOf(L) {
  const out = [];
  for (const file of listMd(L.inbox)) {
    try {
      out.push(readEntryFile(file));
    } catch {
      // 单个坏文件不该让整个面板打不开
    }
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

function listMd(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function countMd(dir) {
  return listMd(dir).length;
}

/**
 * 只读地拼状态。
 *
 * @param {{configRoot?: string, workspace?: string, dueWithin?: number, entryLimit?: number, inboxLimit?: number, budget?: number, now?: string}} input
 * @returns {object} `{ok:true, ...状态}`；任何输入异常都降级成空状态，**不抛错**
 */
export function memoryStateOf(input = {}) {
  const { root, workspace } = resolvePanelRoot(input);
  const cfg = root ? safeConfig(root) : { budget: null, scope: null };
  /**
   * 预算以谁为准：**插件配置的 `maxBytes` 优先**（`input.budget`），其次才是库配置的
   * `memory.config.json#injectBudget`。
   *
   * ⚠️ 这里踩过：面板原来只看库配置，于是"插件 maxBytes=4096、库配置还是 3072"时，
   * 面板显示的上限跟**真正生效**的上限不一致 —— 超没超预算会算错、告警会撒谎。
   * 插件侧 `openStore()` 的顺序就是 `config.maxBytes || fileConfig.injectBudget || 3072`，
   * 面板必须与它一致。
   */
  const budget = Number.isFinite(input.budget) && input.budget > 0 ? input.budget : (cfg.budget ?? 3072);
  const scope = cfg.scope ?? (workspace ? `workspace:${workspace}` : '');
  /**
   * 找「工作区规范」用哪个目录。
   *
   * ⚠️ 不能只用 `resolvePanelRoot` 回来的 `workspace`：客户端在 `scope` 里没有 `cwd` 时
   * **不发 workspace**，那时这里会是 null，于是面板会显示"还没有 AGENTS.md"——**假的**
   * （真机上就是这样：明明有 `D:\idea2023\ai\AGENTS.md`，面板却说没有）。
   * 所以退回记忆库配置里的 `scope`（`workspace:<路径>`）—— 那本来就是权威的工作区。
   */
  const scopeWorkspace = typeof scope === 'string' && scope.startsWith('workspace:') ? scope.slice('workspace:'.length) : null;
  const rulesWorkspace = workspace || scopeWorkspace;

  if (!root || !dirExists(root)) {
    // 记忆库还没建（全新工作区）是**正常状态**，不是错误：返回结构化的空状态。
    // 仍然带 `ok: true` —— spec 明确要求"workspace 缺失或目录不存在 → ok:true + 空数组"，
    // 客户端因此只需要一条"没有记忆"的渲染分支，不用去分辨"空"和"坏"。
    return {
      ok: true,
      ...emptyState(root ?? '', scope, budget, workspace),
      // 全局规范是**工作区外**的一份文件，跟记忆库存不存在无关 —— 空状态也要带上
      global: globalInstructionOf({ dshHome: input.dshHome, previewLines: input.globalPreviewLines }),
      workspaceRules: workspaceInstructionsOf(rulesWorkspace),
    };
  }

  try {
    const L = ensureLayout(root, { create: false });
    const state = buildMemoryState(L, {
      scope,
      budget,
      dueWithin: input.dueWithin,
      entryLimit: input.entryLimit,
      inboxLimit: input.inboxLimit,
      dshHome: input.dshHome,
      globalPreviewLines: input.globalPreviewLines,
      workspace: rulesWorkspace,
    });
    return { ok: true, ...state };
  } catch (error) {
    return {
      ...emptyState(root, scope, budget, workspace),
      ok: false,
      error: `读取记忆库失败：${error?.message ?? String(error)}`,
    };
  }
}

/* ------------------------------------------------------------ 路由 */

/** 回环主机名判定 —— 与 `dsh-better-sidebar` 的 `isLoopbackHostname` 同一套规则。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = String(hostname).split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * 来源校验（照 `dsh-better-sidebar` 的 `fence` 做同等级别的检查）。
 *
 * 那条 fence 是 `isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)`
 * （`dsh-better-sidebar/src/index.ts:719`），语义是：
 *   · Host 头必须能解析、且是回环地址或用户配置的可信 authority；
 *   · `sec-fetch-site: cross-site` 拒绝（跨站页面）；
 *   · `Origin` 若存在，其 hostname 必须就是本机 Host 的 hostname（缺 Origin 允许）。
 *
 * 这里**只接受回环**：本插件没有 `webRuntime`（那是 web 组合的另一项服务），
 * 拿不到用户配置的可信 host 列表。宁可拒绝一个自定义域名下的 GUI，也不放宽 ——
 * 这条路由会把用户记忆库里的**结论正文**原样吐出来。
 */
export function isTrustedLoopbackRequest(req) {
  const headers = req?.headers ?? {};
  const host = typeof headers.host === 'string' ? headers.host : undefined;
  if (!host) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  if (origin === undefined) return true;
  try {
    return new URL(origin).hostname === hostUrl.hostname;
  } catch {
    return false;
  }
}

/** 读 JSON body（带上限，防止有人往这里灌无界数据）。 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * 两条写路由共用的前门：来源（loopback）→ 方法（POST）→ body（JSON）。
 * 任何一条不合规都**已经回过响应**，此时返回 null，调用方直接收工。
 *
 * @returns {Promise<object|null>} 解析好的 body，或 null（已回过 4xx）
 */
async function readAllowedBody(req, res) {
  if (!isTrustedLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: '只允许来自本机回环地址的请求' });
    return null;
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: `只支持 POST，收到 ${req.method ?? '未知方法'}` });
    return null;
  }
  try {
    return await readJsonBody(req);
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error.message });
    return null;
  }
}

/**
 * 「搜索」路由：POST `{query, workspace?, where?, limit?}` → 排好序的命中。
 *
 * **复用 `searchLibrary`**（`bin/mem.mjs` → `src/search.mjs`）：和 CLI 的 `mem recall`、
 * 插件工具 `memory_search` 是同一份分词/打分/片段实现 —— 面板搜出来的东西必须和
 * 模型搜出来的完全一致，否则"我明明记得记过这条"就会变成最难查的那种问题。
 *
 * 只读，不写任何东西。
 *
 * @param {{configRoot?: string, allow?: boolean, limit?: number}} [opts]
 */
export function createSearchRoute(opts = {}) {
  return {
    kind: 'exact',
    path: MEMORY_SEARCH_PATH,
    async handler(req, res) {
      try {
        if (opts.allow === false) {
          writeJson(res, 403, { ok: false, error: '配置里关掉了面板（panel=false）' });
          return;
        }
        const body = await readAllowedBody(req, res);
        if (body === null) return;

        const query = typeof body?.query === 'string' ? body.query.trim() : '';
        if (!query) {
          writeJson(res, 400, { ok: false, error: '缺少 query（搜索词不能为空）' });
          return;
        }
        const { root } = resolvePanelRoot({ configRoot: opts.configRoot ?? body?.configRoot, workspace: body?.workspace });
        if (!root) {
          writeJson(res, 400, { ok: false, error: '不知道记忆库在哪：请求里既没有 workspace，插件也没配 root' });
          return;
        }
        const L = ensureLayout(root, { create: false });
        const limit = Number.isFinite(Number(body?.limit)) && Number(body.limit) > 0 ? Math.min(Number(body.limit), 100) : (opts.limit ?? 20);
        const where = body?.where === undefined || body?.where === null || body?.where === '' ? 'all' : body.where;
        if (!SEARCH_WHERE.includes(where)) {
          writeJson(res, 400, { ok: false, error: `不认识的 where：${where}（只支持 ${SEARCH_WHERE.join(' / ')}）` });
          return;
        }
        // 面板展示用不着 400 字的片段，240 够看且省流量
        const found = searchLibrary(L, { query, where, limit, maxLen: 240 });
        writeJson(res, 200, { ok: true, ...found });
      } catch (error) {
        writeJson(res, 500, { ok: false, error: `搜索失败：${error?.message ?? String(error)}` });
      }
    },
  };
}

/**
 * 注册「搜索」路由。
 *
 * @param {object} webServer `ctx.get('webServer')` 的结果
 * @param {{configRoot?: string, allow?: boolean, limit?: number}} [opts]
 * @param {(body: () => any, label?: string) => unknown} [effect] `ctx.effect`
 * @returns {object|null} 路由对象；webServer 不可用时返回 null
 */
export function registerSearchRoute(webServer, opts = {}, effect) {
  if (!webServer || typeof webServer.register !== 'function') return null;
  const route = createSearchRoute(opts);
  if (typeof effect === 'function') effect(() => webServer.register(route), 'dsh-memory-delta: /dsh-memory-delta/search route');
  else webServer.register(route);
  return route;
}

/**
 * 造一个 webServer 路由对象：`{kind, path, handler}`。
 *
 * handler 是 node:http 的 `(req, res)`。四条出口写死在这里，顺序即优先级：
 * 来源不合 → 403；非 POST → 405；body 不是 JSON → 400；其余 → 200。
 * **任何情况下都回 JSON**，客户端不必猜响应体是什么。
 *
 * @param {(input: {configRoot?: string, workspace?: string, dueWithin?: number}) => object} stateOf
 * @returns {{kind: 'exact', path: string, handler: (req, res) => Promise<void>}}
 */
export function createMemoryRoute(stateOf) {
  return {
    kind: 'exact',
    path: MEMORY_ROUTE_PATH,
    async handler(req, res) {
      try {
        const body = await readAllowedBody(req, res);
        if (body === null) return;
        writeJson(res, 200, stateOf(body));
      } catch (error) {
        // 兜底：handler 里任何意外都必须变成一条可读的 JSON，而不是断掉的连接
        writeJson(res, 500, { ok: false, error: `内部错误：${error?.message ?? String(error)}` });
      }
    },
  };
}

/**
 * 注册路由。
 *
 * @param {object} webServer `ctx.get('webServer')` 的结果
 * @param {(input: object) => object} stateOf
 * @param {(body: () => any, label?: string) => unknown} [effect] `ctx.effect` —— 传了就按
 *   Cordis 的方式托管这条副作用（销毁时自动摘掉路由）；不传（测试里）则直接注册。
 * @returns {object|null} 路由对象；webServer 不可用时返回 null
 */
export function registerMemoryRoute(webServer, stateOf, effect) {
  if (!webServer || typeof webServer.register !== 'function') return null;
  const route = createMemoryRoute(stateOf);
  if (typeof effect === 'function') effect(() => webServer.register(route), 'dsh-memory-delta: /dsh-memory-delta/state route');
  else webServer.register(route);
  return route;
}

/**
 * 「动作」路由：面板里那些**会写记忆库**的按钮（收件箱提升、安全改名）。
 *
 * 结构与只读状态路由完全一致（loopback → POST → JSON），唯一的区别是它**会改文件**，
 * 所以两条纪律写死在这里：
 *   1. 只认 `ACTION_OPS` 里的 op，别的一律 400 —— 不做一个"通用改写"后门；
 *   2. 逻辑**必须复用 CLI 的实现**（`promoteEntry` / `renameEntry`），
 *      面板里再写一遍"一个 key 一个真相"的闸门迟早会和 CLI 分叉。
 *      那两个函数是"抛异常"版（CLI 侧负责把异常翻译成 exit 1），这里翻译成 400 + 原因，
 *      所以宿主进程永远不会因为用户点一下按钮就退出。
 *
 * @param {{configRoot?: string, allow?: boolean}} [opts]
 */
export function createActionRoute(opts = {}) {
  return {
    kind: 'exact',
    path: MEMORY_ACTION_PATH,
    async handler(req, res) {
      try {
        if (opts.allow === false) {
          writeJson(res, 403, { ok: false, error: '配置里关掉了「面板写记忆库」（allowWrite=false）' });
          return;
        }
        const body = await readAllowedBody(req, res);
        if (body === null) return;

        const op = typeof body?.op === 'string' ? body.op : '';
        if (!ACTION_OPS.includes(op)) {
          writeJson(res, 400, { ok: false, error: `不认识的 op：${op || '（空）'}（只支持 ${ACTION_OPS.join(' / ')}）` });
          return;
        }
        const { root } = resolvePanelRoot({ configRoot: opts.configRoot ?? body?.configRoot, workspace: body?.workspace });
        if (!root) {
          writeJson(res, 400, { ok: false, error: '不知道记忆库在哪：请求里既没有 workspace，插件也没配 root' });
          return;
        }
        const L = ensureLayout(root, { create: false });
        const id = typeof body?.id === 'string' ? body.id : '';
        if (!id) {
          writeJson(res, 400, { ok: false, error: '缺少 id' });
          return;
        }

        if (op === 'promote') {
          const r = promoteEntry(L, id, { supersedes: body?.supersedes });
          writeJson(res, 200, { ok: true, op, id: r.id, target: r.target, superseded: r.superseded });
          return;
        }
        if (op === 'demote') {
          // 双向的另一半：常驻 → 候选（"先不当真"）。不改 status，只换层。
          const r = demoteEntry(L, id);
          writeJson(res, 200, { ok: true, op, id: r.id, from: r.from, target: r.to });
          return;
        }
        if (op === 'archive') {
          // 手动归档：不再适用、又没有新版本顶上（区别于取代）
          const r = archiveEntry(L, id, { supersededBy: body?.supersededBy });
          writeJson(res, 200, { ok: true, op, id: r.id, from: r.from, status: r.status });
          return;
        }
        if (op === 'restore') {
          // 归档不是终点：捞回候选层，再让人确认一次
          const r = restoreEntry(L, id);
          writeJson(res, 200, { ok: true, op, id: r.id, from: r.from, target: r.to });
          return;
        }
        if (op === 'remove') {
          // 只允许删候选 —— 常驻条目直接删就是"静默消失"（removeEntry 里说明了理由）
          const r = removeEntry(L, id);
          writeJson(res, 200, { ok: true, op, id: r.id });
          return;
        }
        const to = typeof body?.to === 'string' ? body.to : '';
        const r = renameEntry(L, id, to);
        writeJson(res, 200, { ok: true, op, from: r.from, to: r.to, refs: r.refs });
      } catch (error) {
        // 拒绝的理由（key 撞车 / 目标 id 占用 / 非法字符 / 找不到条目）原样交给界面显示 ——
        // "点了没反应"是最难查的体验。
        writeJson(res, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  };
}

/**
 * 注册「动作」路由。
 *
 * @param {object} webServer `ctx.get('webServer')` 的结果
 * @param {{configRoot?: string, allow?: boolean}} [opts]
 * @param {(body: () => any, label?: string) => unknown} [effect] `ctx.effect`
 * @returns {object|null} 路由对象；webServer 不可用时返回 null
 */
export function registerActionRoute(webServer, opts = {}, effect) {
  if (!webServer || typeof webServer.register !== 'function') return null;
  const route = createActionRoute(opts);
  if (typeof effect === 'function') effect(() => webServer.register(route), 'dsh-memory-delta: /dsh-memory-delta/action route');
  else webServer.register(route);
  return route;
}
