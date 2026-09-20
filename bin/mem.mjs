#!/usr/bin/env node
/**
 * mem — dsh-memory-delta CLI（M1）
 *
 * 设计要点（见 memory/design/dsh-memory-delta-plugin.md）：
 *   · 分层：inbox（候选）→ facts/decisions（当前真相）→ archive（被取代）
 *   · 模型默认只能写 inbox；提升到事实层需要显式 promote —— 防止错误结论被反复注入
 *   · 条目是「Markdown + 极简 YAML frontmatter」：人可读、可 git diff、可 review
 *   · 零依赖。frontmatter 只支持一层标量 / 行内数组，故意不支持嵌套（保持可手写、可校验）
 *
 * 根目录解析顺序：--root > $DSH_MEMORY_ROOT > <cwd>/memory
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { renderBaseline } from '../src/planner.mjs';
import { collectDue, duePhrase } from '../src/due.mjs';
import { findMatches, rankDocs } from '../src/search.mjs';

const VERSION = '0.1.0';
const CONFIG_FILE = 'memory.config.json';
const TYPES = ['fact', 'decision'];
const STATUSES = ['active', 'superseded', 'expired'];
const DIR_OF = { fact: 'facts', decision: 'decisions', inbox: 'inbox', archive: 'archive' };
const FM_KEYS = ['id', 'type', 'scope', 'key', 'tags', 'status', 'date', 'source', 'supersedes', 'superseded_by', 'verify_when'];

/* ------------------------------------------------------------------ 输出 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const ok = (s) => console.log(`${c(32, '✓')} ${s}`);
const warn = (s) => console.log(`${c(33, '!')} ${s}`);
const bad = (s) => console.log(`${c(31, '✗')} ${s}`);
const dim = (s) => c(90, s);

function fail(msg, code = 1) {
  console.error(`${c(31, 'error')} ${msg}`);
  process.exit(code);
}

/* ------------------------------------------------------------ 根与配置 */

function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.DSH_MEMORY_ROOT) return path.resolve(process.env.DSH_MEMORY_ROOT);
  return path.join(process.cwd(), 'memory');
}

function defaultConfig(root) {
  return {
    version: 1,
    scope: `workspace:${path.resolve(process.env.DSH_MEMORY_WORKSPACE || process.cwd())}`,
    injectBudget: 3072,
    createdAt: new Date().toISOString().slice(0, 10),
  };
}

function loadConfig(root) {
  const f = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    fail(`${CONFIG_FILE} 不是合法 JSON：${err.message}`);
  }
}

function ensureLayout(root, { create = true } = {}) {
  if (create) {
    for (const d of ['facts', 'decisions', 'inbox', 'archive']) fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  return {
    root,
    facts: path.join(root, 'facts'),
    decisions: path.join(root, 'decisions'),
    inbox: path.join(root, 'inbox'),
    archive: path.join(root, 'archive'),
    index: path.join(root, 'index.md'),
    journal: path.join(root, 'journal.md'),
    config: path.join(root, CONFIG_FILE),
  };
}

/* -------------------------------------------------- frontmatter 解析/序列化 */

/**
 * 只支持这个子集（故意）：
 *   key: 字符串       key: [a, b]       key: null/true/false/123
 * 不支持嵌套 map、多行字符串、锚点 —— 保持"可手写 + 可校验"。
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { data: {}, body: text, hasFrontmatter: false };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text, hasFrontmatter: false };
  const data = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val === '') data[key] = null;
    else if (val === 'null' || val === '~') data[key] = null;
    else if (val === 'true') data[key] = true;
    else if (val === 'false') data[key] = false;
    else if (/^-?\d+$/.test(val)) data[key] = Number(val);
    else if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else data[key] = val.replace(/^["']|["']$/g, '');
  }
  return { data, body: text.slice(m[0].length), hasFrontmatter: true };
}

function renderFrontmatter(data) {
  const lines = ['---'];
  for (const k of FM_KEYS) {
    if (!(k in data)) continue;
    const v = data[k];
    if (v === null || v === undefined) lines.push(`${k}: null`);
    else if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function serializeEntry(entry) {
  const body = (entry.body || '').replace(/\s*$/, '');
  return `${renderFrontmatter(entry.data)}\n\n${body}\n`;
}

/* ------------------------------------------------------------ 条目读写 */

function readEntryFile(file) {
  const { data, body, hasFrontmatter } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  return { file, id: data.id || path.basename(file, '.md'), data, body, hasFrontmatter };
}

function listDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(dir, f));
}

function readAll(L) {
  const out = [];
  for (const key of ['inbox', 'facts', 'decisions', 'archive']) {
    for (const file of listDir(L[key])) {
      try {
        out.push({ ...readEntryFile(file), where: key });
      } catch (err) {
        out.push({ file, id: path.basename(file, '.md'), error: err.message, where: key, data: {}, body: '' });
      }
    }
  }
  return out;
}

function findById(L, id) {
  return readAll(L).filter((e) => e.id === id);
}

function requireOne(L, id) {
  const hits = findById(L, id);
  if (hits.length === 0) fail(`找不到条目：${id}`);
  if (hits.length > 1) fail(`id 重复（${hits.length} 处）：${id}\n  ${hits.map((h) => h.file).join('\n  ')}`);
  return hits[0];
}

/**
 * `requireOne` 的**抛异常**版本。
 *
 * 写操作现在有两个调用方：CLI（`bin/mem.mjs` 自己被 node 执行）和
 * **DSH 宿主的动作路由**（`src/panel.mjs` 的面板按钮）。后者跑在宿主进程里，
 * 一旦走到 `fail()` 就会 `process.exit(1)` —— 用户点一下按钮，整个 DSH 就没了。
 * 所以共用逻辑必须是"能抛错"的，由各自的外层决定是打印还是回 JSON。
 */
function requireOneOrThrow(L, id) {
  const hits = findById(L, id);
  if (hits.length === 0) throw new Error(`找不到条目：${id}`);
  if (hits.length > 1) throw new Error(`id 重复（${hits.length} 处）：${id}`);
  return hits[0];
}

/** 把结论压成 id 片段。默认只取 20 字符 —— 派生 id 要短，否则中文结论会变成很长的一串。 */
function slugify(s, max = 20) {
  const base = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return base || 'entry';
}

const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ 命令 */

function cmdInit(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root);
  if (fs.existsSync(L.config)) {
    warn(`配置已存在，保持不变：${L.config}`);
  } else {
    const cfg = defaultConfig(root);
    if (opts.scope) cfg.scope = opts.scope;
    fs.writeFileSync(L.config, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    ok(`已创建 ${L.config}`);
  }
  if (!fs.existsSync(L.journal)) {
    fs.writeFileSync(
      L.journal,
      '# 记忆流水（journal）\n\n> 不参与自动注入 —— 流水可以随便长。由 `mem journal add` 追加。\n\n## 流水\n\n',
      'utf8',
    );
  }
  ok(`记忆库就绪：${root}`);
  console.log(dim('  facts/ decisions/ inbox/ archive/ journal.md index.md'));
}

/**
 * 创建一个候选条目（落在 inbox）—— CLI 的 `new` 与插件的 `memory_write` 工具共用这一份逻辑，
 * 保证"模型只能写收件箱"这条纪律只有一处实现。
 *
 * @returns {{id: string, file: string}}
 */
export function createEntry(L, { type, conclusion, reason, tags, scope, key, id: explicitId, source, verifyWhen }) {
  if (!TYPES.includes(type)) throw new Error(`type 必须是 ${TYPES.join(' | ')}`);
  const text = String(conclusion ?? '').trim();
  if (!text) throw new Error('缺少结论（conclusion）');

  const k = key ? String(key).trim() : null;
  if (k && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(k)) throw new Error(`key 只允许字母/数字/._-（收到：${k}）`);

  let id;
  if (explicitId) {
    id = String(explicitId).trim();
    if (!/^[A-Za-z0-9\u4e00-\u9fa5._-]+$/.test(id)) throw new Error(`id 含非法字符：${id}`);
    if (findById(L, id).length) throw new Error(`id 已存在：${id}`);
  } else {
    const base = `${today()}-${slugify(text)}`;
    id = base;
    let n = 2;
    while (findById(L, id).length) {
      id = `${base}-${n}`;
      n += 1;
    }
  }

  const data = {
    id,
    type,
    scope: scope || loadConfig(L.root)?.scope || defaultConfig(L.root).scope,
    key: k,
    tags: Array.isArray(tags) ? tags : tags ? String(tags).split(',').map((s) => s.trim()).filter(Boolean) : [],
    status: 'active',
    date: today(),
    source: source || null,
    supersedes: [],
    superseded_by: null,
    verify_when: verifyWhen || null,
  };
  const body = ['## 结论', text, '', '## 理由', String(reason || '（待补充）').trim(), ''].join('\n');
  const file = path.join(L.inbox, `${id}.md`);
  if (fs.existsSync(file)) throw new Error(`文件已存在：${file}`);
  fs.writeFileSync(file, serializeEntry({ data, body }), 'utf8');
  return { id, file };
}

function cmdNew(opts) {
  const root = resolveRoot(opts.root);
  const cfg = loadConfig(root);
  const L = ensureLayout(root);
  const conclusion = opts.conclusion || opts._.join(' ').trim();
  if (!conclusion) fail('缺少内容。用法：mem new --type fact --conclusion "结论一句话" [--reason "..."] [--tags a,b]');

  // 具体逻辑在 createEntry（CLI 与插件的 memory_write 工具共用同一份实现）
  let created;
  try {
    created = createEntry(L, {
      type: opts.type,
      conclusion,
      reason: opts.reason,
      tags: opts.tags,
      scope: opts.scope || (cfg && cfg.scope),
      key: opts.key,
      id: opts.id,
      source: opts.source,
      verifyWhen: opts['verify-when'],
    });
  } catch (err) {
    fail(err.message.replace(/\n/g, '\n  '));
  }

  const { id, file } = created;
  if (opts.json) console.log(JSON.stringify({ id, file, status: 'inbox' }));
  else {
    ok(`已创建候选条目 ${c(1, id)}  →  ${dim(path.relative(root, file))}`);
    console.log(dim('  它在 inbox/ 里，不会参与注入。确认后用 `mem promote ' + id + '` 提升到事实层。'));
  }
}

function cmdList(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root, { create: false });
  let entries = readAll(L);
  if (!opts.all) entries = entries.filter((e) => e.where !== 'archive');
  if (opts.status) entries = entries.filter((e) => e.data.status === opts.status);
  if (opts.type) entries = entries.filter((e) => e.data.type === opts.type);
  if (opts.scope) entries = entries.filter((e) => e.data.scope === opts.scope);
  if (opts.tag) entries = entries.filter((e) => (e.data.tags || []).includes(opts.tag));
  if (opts.where) entries = entries.filter((e) => e.where === opts.where);
  entries.sort((a, b) => String(b.data.date || '').localeCompare(String(a.data.date || '')) || a.id.localeCompare(b.id));

  if (opts.json) {
    console.log(JSON.stringify(entries.map((e) => ({ ...e.data, where: e.where })), null, 2));
    return;
  }
  if (!entries.length) {
    console.log(dim('（无匹配条目）'));
    return;
  }
  for (const e of entries) {
    const st = e.data.status === 'active' ? c(32, 'active') : e.data.status === 'superseded' ? c(90, 'superseded') : c(33, String(e.data.status));
    console.log(`${st.padEnd(20)} ${c(36, e.id)}  ${dim(`[${e.where}] ${e.data.type} ${e.data.date || ''}`)}`);
    console.log(`    ${firstLine(e.body)}`);
  }
  console.log(dim(`\n共 ${entries.length} 条`));
}

function firstLine(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines[0] || dim('（无正文）');
}

function cmdShow(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root, { create: false });
  const id = opts._[0] || fail('用法：mem show <id>');
  const e = requireOne(L, id);
  if (opts.json) {
    console.log(JSON.stringify({ ...e.data, where: e.where, file: e.file, body: e.body }, null, 2));
    return;
  }
  console.log(`${c(1, e.id)}   ${dim(`[${e.where}]`)}`);
  for (const k of FM_KEYS) if (k !== 'id' && e.data[k] !== null && e.data[k] !== undefined && !(Array.isArray(e.data[k]) && !e.data[k].length)) {
    console.log(`  ${k.padEnd(14)} ${Array.isArray(e.data[k]) ? e.data[k].join(', ') : e.data[k]}`);
  }
  console.log(`\n${e.body.trim()}`);
  if (e.where === 'inbox') console.log(`\n${dim(`提示：用 mem promote ${e.id} 提升到事实层`)}`);
}

/**
 * 删除文件并**回读核实**。
 *
 * ⚠️ 必须用 `unlinkSync`，**不要用 `rmSync`**：
 * 实测（2026-09-17，DSH 沙箱，Node 24）—— 当**路径中含非 ASCII 字符**时
 * （例如 `C:\Users\<非 ASCII 用户名>\...`，或中文文件名），`fs.rmSync(p, {force:true})`
 * **会静默失败且不抛任何错误**，文件仍然存在；而 `fs.unlinkSync(p)` 正常工作。
 * 对照矩阵：ASCII 路径下两者都成功；非 ASCII 路径下 rmSync 失败、unlinkSync 成功。
 *
 * 这个坑很阴：`rmSync` 的 `force` 会把错误吞掉，于是"移动"变成"复制"，
 * 条目会同时存在于 inbox/ 和 facts/ —— 所以这里再回读核实一次，绝不相信"删了就删了"。
 */
function removeFile(file) {
  if (!fs.existsSync(file)) return;
  try {
    fs.unlinkSync(file);
  } catch (err) {
    fail(`删除失败：${file}\n  ${err.code || ''} ${err.message}`);
  }
  if (fs.existsSync(file)) {
    fail(
      `删除后文件仍然存在：${file}\n` +
        `  可能原因：沙箱/权限拦截，或路径含非 ASCII 字符时 rmSync 静默失败（本函数已改用 unlinkSync）。`,
    );
  }
}

/**
 * 把条目写到新位置并删源。
 *
 * ⚠️ 必须把**内存中的序列化结果**写过去，不能用 `copyFileSync` 复制磁盘原文件 ——
 * 否则调用方在内存里刚改的字段（status / superseded_by / supersedes）会全部丢失，
 * 表现为"旧条目归档后还是 active、新条目没有 supersedes"。
 * 这个 bug 是被 test/run-tests.mjs 的「双向链接一致」断言抓出来的。
 */
function moveEntry(from, to, content) {
  if (fs.existsSync(to)) fail(`目标已存在：${to}`);
  fs.writeFileSync(to, content !== undefined ? content : fs.readFileSync(from, 'utf8'), 'utf8');
  if (!fs.existsSync(to)) fail(`写入未生效：${to}`);
  removeFile(from);
}

/**
 * 把 inbox 里的候选提升到事实层（`facts/` 或 `decisions/`，由条目的 `type` 决定）。
 *
 * **CLI（`mem promote`）与侧边栏面板的按钮共用这一份实现** —— 面板里那个"提升"按钮
 * 如果自己再写一遍"一个 key 一个真相"的闸门，迟早会和 CLI 分叉。
 *
 * 与 CLI 版本的唯一区别：**抛异常**而不是 `process.exit`（见 `requireOneOrThrow`）。
 *
 * @param {object} L `ensureLayout` 的结果
 * @param {string} id inbox 条目的 id
 * @param {{supersedes?: string|string[]}} [opts] 显式指定被取代的旧条目
 * @returns {{id: string, target: string, superseded: string[]}}
 */
export function promoteEntry(L, id, opts = {}) {
  const e = requireOneOrThrow(L, id);
  if (e.where !== 'inbox') throw new Error(`条目不在 inbox 里（当前在 ${e.where}/），无需提升`);
  const target = DIR_OF[e.data.type];
  if (!target) throw new Error(`未知 type：${e.data.type}（只支持 ${TYPES.join(' / ')}）`);

  const raw = [].concat(opts.supersedes ?? []).filter(Boolean);

  // 「一个 key 一个真相」—— 同一 scope+key 上已有 active 条目时，必须显式说明谁取代谁。
  // 这是把"记忆腐化"挡在常驻层之外的关键闸门：不显式取代，就别想把矛盾的东西推进事实层。
  if (e.data.key) {
    const covered = new Set(raw);
    const clash = readAll(L).filter(
      (x) =>
        !x.error &&
        x.id !== e.id &&
        x.data.status === 'active' &&
        x.data.key === e.data.key &&
        x.data.scope === e.data.scope &&
        (x.where === 'facts' || x.where === 'decisions') &&
        !covered.has(x.id),
    );
    if (clash.length) {
      throw new Error(
        `同一个 key（${e.data.key}）上已经有 active 条目：${clash.map((x) => x.id).join(', ')}\n` +
          `  一个 key 只能有一个真相。显式取代：mem promote ${e.id} --supersedes ${clash[0].id}\n` +
          `  或者换一个 key —— 如果它们其实是两件事。`,
      );
    }
  }

  const superseded = [];
  for (const oldId of raw) {
    const old = requireOneOrThrow(L, oldId);
    if (old.id === e.id) throw new Error('不能自己取代自己');
    old.data.status = 'superseded';
    old.data.superseded_by = e.id;
    const archived = path.join(L.archive, `${old.id}.md`);
    if (path.resolve(old.file) === path.resolve(archived)) fs.writeFileSync(archived, serializeEntry(old), 'utf8');
    else moveEntry(old.file, archived, serializeEntry(old));
    e.data.supersedes = [...new Set([...(e.data.supersedes || []), old.id])];
    superseded.push(old.id);
  }

  moveEntry(e.file, path.join(L[target], `${e.id}.md`), serializeEntry(e));
  return { id: e.id, target, superseded };
}

/**
 * **安全改名**：`id`（frontmatter）与文件名一起改，并同步别处对它的引用。
 *
 * 为什么需要它：条目的 `id` 写在 frontmatter 里，**文件名必须与之一致**
 * （`validate` 强制）。没给 `key` 的条目会拿到 `2026-09-17-<截断的结论>.md` 这种
 * 自动生成的长名 —— 想整理就得**同时**改三处：frontmatter 的 id、文件名、
 * 以及其它条目里指向它的 `supersedes` / `superseded_by`。
 * 手改或用文件树改名只会造出 `id 与文件名不一致`。
 *
 * @returns {{from: string, to: string, file: string, refs: string[]}} refs = 被顺带改过的条目 id
 */
export function renameEntry(L, oldId, newId) {
  const to = String(newId ?? '').trim();
  if (!to) throw new Error('新 id 不能为空');
  if (!/^[A-Za-z0-9\u4e00-\u9fa5._-]+$/.test(to)) throw new Error(`新 id 含非法字符：${to}（只允许字母/数字/._-/中文）`);
  if (to === oldId) throw new Error('新旧 id 一样，什么也没做');

  const e = requireOneOrThrow(L, oldId);
  const taken = findById(L, to).filter((x) => x.id !== oldId);
  if (taken.length) throw new Error(`目标 id 已被占用：${to}（${taken[0].file}）`);

  const dest = path.join(path.dirname(e.file), `${to}.md`);
  if (path.resolve(dest) !== path.resolve(e.file) && fs.existsSync(dest)) {
    throw new Error(`目标文件已存在：${dest}`);
  }

  const from = e.id;
  e.data.id = to;
  moveEntry(e.file, dest, serializeEntry(e));

  // 引用同步：别的条目里 supersedes / superseded_by 指向旧 id 的，一起改掉
  const refs = [];
  for (const other of readAll(L)) {
    if (other.error || other.id === from) continue;
    let touched = false;
    if (Array.isArray(other.data.supersedes) && other.data.supersedes.includes(from)) {
      other.data.supersedes = [...new Set(other.data.supersedes.map((x) => (x === from ? to : x)))];
      touched = true;
    }
    if (other.data.superseded_by === from) {
      other.data.superseded_by = to;
      touched = true;
    }
    if (touched) {
      fs.writeFileSync(other.file, serializeEntry(other), 'utf8');
      refs.push(other.id);
    }
  }

  writeIndex(L);
  return { from, to, file: dest, refs };
}

function cmdPromote(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root, { create: false });
  const id = opts._[0] || fail('用法：mem promote <id> [--supersedes <旧id>]');
  let result;
  try {
    result = promoteEntry(L, id, { supersedes: opts.supersedes });
  } catch (error) {
    // CLI 的契约是"出错打印一行并退出 1"；共用实现抛异常，这里翻译回来。
    fail(error.message);
  }
  ok(`已提升 ${c(1, result.id)} → ${result.target}/`);
  if (result.superseded.length) ok(`并标记 ${result.superseded.join(', ')} 为 superseded 并归档`);
}

/** `mem rename <旧id> <新id>` —— 见 `renameEntry` 的说明（这是"整理文件名"的正确姿势）。 */
function cmdRename(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root, { create: false });
  const [oldId, newId] = opts._;
  if (!oldId || !newId) fail('用法：mem rename <旧id> <新id>');
  let result;
  try {
    result = renameEntry(L, oldId, newId);
  } catch (error) {
    fail(error.message);
  }
  ok(`${c(1, result.from)} → ${c(1, result.to)}（${path.basename(result.file)}）`);
  if (result.refs.length) ok(`顺带更新了引用：${result.refs.join(', ')}`);
}

function cmdSupersede(opts) {
  const root = resolveRoot(opts.root);
  ensureLayout(root, { create: false });
  const [oldId, newId] = opts._;
  if (!oldId || !newId) fail('用法：mem supersede <旧id> <新id>');
  cmdPromoteInternal(root, newId, oldId);
}

function cmdPromoteInternal(root, newId, oldId) {
  const L = ensureLayout(root, { create: false });
  const e = requireOne(L, newId);
  const old = requireOne(L, oldId);
  if (old.data.status === 'superseded') fail(`${oldId} 已经被取代过了（superseded_by=${old.data.superseded_by}）`);
  old.data.status = 'superseded';
  old.data.superseded_by = newId;
  const archived = path.join(L.archive, `${old.id}.md`);
  if (path.resolve(old.file) === path.resolve(archived)) fs.writeFileSync(archived, serializeEntry(old), 'utf8');
  else moveEntry(old.file, archived, serializeEntry(old));
  e.data.supersedes = [...new Set([...(e.data.supersedes || []), oldId])];
  fs.writeFileSync(e.file, serializeEntry(e), 'utf8');
  ok(`${oldId} → superseded by ${newId}（已归档）`);
}

/** 替换正文里的某个 `## 标题` 小节；不存在就追加。 */
function replaceSection(body, title, text) {
  const re = new RegExp(`(##\\s*${title}\\r?\\n)([\\s\\S]*?)(?=\\r?\\n##\\s|$)`);
  if (re.test(body)) return body.replace(re, `$1${text.trim()}\n`);
  return `${body.replace(/\s*$/, '')}\n\n## ${title}\n${text.trim()}\n`;
}

/**
 * 改已有条目。为什么必须有：条目建好之后总要能修正 —— 补一个 key、
 * 改措辞、调整 scope、标 expired。没有它就只能手改文件，frontmatter 的
 * 一致性就守不住了（而这正是这个工具存在的意义）。
 */
function cmdSet(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root, { create: false });
  const id = opts._[0];
  if (!id) {
    fail(
      '用法：mem set <id> [--key k] [--tags a,b] [--scope s] [--status active|superseded|expired]\n' +
        '       [--verify-when "…"] [--conclusion "…"] [--reason "…"]\n' +
        '  给 key 传空字符串可清除：--key ""',
    );
  }
  const e = requireOne(L, id);
  const changed = [];

  if (opts.key !== undefined) {
    const k = opts.key === true ? '' : String(opts.key).trim();
    if (k && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(k)) fail(`--key 只允许字母/数字/._-（收到：${k}）`);
    e.data.key = k || null;
    changed.push('key');
  }
  if (opts.tags !== undefined) {
    e.data.tags = opts.tags === true ? [] : String(opts.tags).split(',').map((s) => s.trim()).filter(Boolean);
    changed.push('tags');
  }
  if (opts.scope) {
    e.data.scope = String(opts.scope);
    changed.push('scope');
  }
  if (opts['verify-when'] !== undefined) {
    e.data.verify_when = opts['verify-when'] === true ? null : String(opts['verify-when']);
    changed.push('verify_when');
  }
  if (opts.status) {
    if (!STATUSES.includes(opts.status)) fail(`--status 必须是 ${STATUSES.join(' | ')}`);
    e.data.status = String(opts.status);
    changed.push('status');
  }
  if (opts.conclusion) {
    e.body = replaceSection(e.body, '结论', String(opts.conclusion));
    changed.push('结论');
  }
  if (opts.reason) {
    e.body = replaceSection(e.body, '理由', String(opts.reason));
    changed.push('理由');
  }
  if (!changed.length) fail('没有任何改动。跑 mem set 看用法。');

  fs.writeFileSync(e.file, serializeEntry(e), 'utf8');
  ok(`已更新 ${c(1, id)}（${e.where}/）：${changed.join('、')}`);
  if (changed.includes('结论') || changed.includes('key')) {
    console.log(dim('  提示：内容变了，注入给模型的 hash 也会变（这正是差分注入的依据）。'));
  }
}

function cmdJournal(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root, { create: false });
  const sub = opts._[0];
  if (sub !== 'add') fail('用法：mem journal add "内容"');
  const text = opts._.slice(1).join(' ').trim();
  if (!text) fail('缺少内容。用法：mem journal add "内容"');
  const bullet = `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${text}`;
  let body = fs.existsSync(L.journal) ? fs.readFileSync(L.journal, 'utf8') : '# 记忆流水（journal）\n\n## 流水\n\n';
  body = body.includes('<!-- memory:append -->')
    ? body.replace('<!-- memory:append -->', `${bullet}\n<!-- memory:append -->`)
    : `${body.replace(/\s*$/, '')}\n${bullet}\n`;
  fs.writeFileSync(L.journal, body, 'utf8');
  ok(`已追加到 ${path.relative(root, L.journal)}（${Buffer.byteLength(body, 'utf8')} 字节，不注入）`);
}

function writeIndex(L) {
  const entries = readAll(L);
  const lines = [
    '# 记忆索引（自动生成，勿手改）',
    '',
    `由 \`mem index\` 生成，最后更新：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    `共 ${entries.length} 条｜active ${entries.filter((e) => e.data.status === 'active').length}` +
      `｜inbox ${entries.filter((e) => e.where === 'inbox').length}` +
      `｜superseded ${entries.filter((e) => e.data.status === 'superseded').length}`,
    '',
  ];
  for (const [title, where, filter] of [
    ['事实（当前真相）', 'facts', (e) => e.data.status === 'active'],
    ['决策', 'decisions', (e) => e.data.status === 'active'],
    ['候选（收件箱，未注入）', 'inbox', () => true],
  ]) {
    const list = entries.filter((e) => e.where === where && filter(e));
    lines.push(`## ${title}`, '');
    // 注意：这里生成的是**文件内容**，不能带 ANSI 颜色转义
    if (!list.length) lines.push('（空）', '');
    for (const e of list.sort((a, b) => a.id.localeCompare(b.id))) {
      const tags = (e.data.tags || []).length ? `  #${(e.data.tags || []).join(' #')}` : '';
      const key = e.data.key ? `  [key: ${e.data.key}]` : '';
      lines.push(`- \`${e.id}\` — ${firstLine(e.body)}${key}${tags}`);
    }
    lines.push('');
  }
  fs.writeFileSync(L.index, `${lines.join('\n')}\n`, 'utf8');
  return entries.length;
}

function cmdIndex(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root, { create: false });
  const n = writeIndex(L);
  ok(`已生成 ${path.relative(root, L.index)}（${n} 条）`);
}

/** 当前参与注入的条目：事实层 + 决策层里的 active。 */
function activeEntries(L) {
  return readAll(L)
    .filter((e) => !e.error && (e.where === 'facts' || e.where === 'decisions') && e.data.status === 'active')
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 条目指纹 —— **差分注入的基础**。
 * 插件每轮记住上次注入的各条 hash，下次只推 hash 变了的条目，而不是整篇重灌。
 * （这正是上游 dsh-agent-instructions 缺的能力：文件一变就整篇重注入。）
 */
function entryHash(e) {
  return createHash('sha1')
    .update([e.id, e.data.type, e.data.key || '', e.data.scope || '', firstLine(e.body)].join('\u0000'))
    .digest('hex')
    .slice(0, 12);
}

/**
 * 渲染「应该注入的内容」。
 *
 * **和插件共用同一套渲染**（`src/planner.mjs` 的 `renderBaseline`）—— 否则
 * `mem inject` 显示的文本、以及 validate 算出来的字节数，都会和真正注入的内容不一致
 * （历史教训：这里曾自己拼一份、还往每行塞 `<!-- id -->`，白占 40% 预算）。
 */
function renderInject(L) {
  return renderBaseline(
    activeEntries(L).map((e) => ({
      id: e.id,
      type: e.data.type,
      key: e.data.key || null,
      hash: entryHash(e),
      line: firstLine(e.body),
    })),
  );
}

/** 差分注入用的结构化载荷：每条带 hash，插件据此只推变化块。 */
function injectPayload(L, budget) {
  const entries = activeEntries(L).map((e) => ({
    id: e.id,
    type: e.data.type,
    scope: e.data.scope,
    key: e.data.key || null,
    tags: e.data.tags || [],
    status: e.data.status,
    where: e.where,
    // 条目文件（绝对路径）。给侧边栏面板"点一下直接打开这条记忆"用 ——
    // 不参与 hash/差分（那是 id + type + key + scope + 结论首行算的）。
    file: e.file,
    hash: entryHash(e),
    line: firstLine(e.body),
    // 下面两个字段是给"到期提醒"用的（src/due.mjs）：日期作相对写法的基准、
    // verify_when 判断是否到复核期。只增不改 —— 差分只认 id + hash。
    date: e.data.date,
    verifyWhen: e.data.verify_when ?? null,
  }));
  const text = renderInject(L);
  const bytes = Buffer.byteLength(text, 'utf8');
  return { version: 1, bytes, budget, overBudget: bytes > budget, entries, text };
}

function cmdInject(opts) {
  const root = resolveRoot(opts.root);
  const cfg = loadConfig(root) || defaultConfig(root);
  const L = ensureLayout(root, { create: false });
  const budget = opts.budget ? Number(opts.budget) : cfg.injectBudget;
  const payload = injectPayload(L, budget);

  if (opts.json) {
    console.log(JSON.stringify(payload, null, opts.pretty ? 2 : 0));
  } else {
    console.log(payload.text || dim('（没有 active 条目）'));
    console.log('');
    const head = `${payload.bytes} / ${payload.budget} 字节`;
    if (payload.overBudget) {
      bad(`${head} —— 超出预算，需要精简或提升预算`);
      process.exitCode = 1; // 供 CI / 插件调用判断：超预算就是失败，不能只看输出文字
    } else {
      ok(`${head} —— 在预算内（${payload.entries.length} 条，已带 hash 供差分注入）`);
    }
  }
}

/**
 * 把记忆库摊平成「可检索文档」列表。
 *
 * `mem recall`（人用）与插件 `memory_search`（模型用）**共用这一个**，
 * 两条检索路径的结果才不会有差异（历史教训：同一个"搜索"曾经有两份实现）。
 *
 * @param {object} L ensureLayout 的结果
 * @param {{where?: string}} [opts] all | facts | decisions | inbox | archive | journal | sessions | index
 */
function collectDocs(L, { where = 'all' } = {}) {
  const want = where || 'all';
  const keep = (w) => want === 'all' || want === w;
  const docs = [];

  for (const e of readAll(L)) {
    if (e.error || !keep(e.where)) continue;
    docs.push({
      id: e.id,
      where: e.where,
      type: e.data.type,
      status: e.data.status,
      key: e.data.key || null,
      tags: e.data.tags || [],
      date: e.data.date || '',
      conclusion: firstLine(e.body),
      text: e.body,
    });
  }

  // 流水 / 会话索引 / 条目索引：逐行当文档，这样"我在哪次会话聊过 X"也能检索。
  // index.md 是条目的**派生视图**，默认不参与（否则每条记忆都会重复命中一次），
  // 想看它得显式 `--where index`。
  for (const [layer, file] of [['journal', L.journal], ['sessions', path.join(L.root, 'sessions.md')], ['index', L.index]]) {
    if (!keep(layer) || (layer === 'index' && want !== 'index') || !fs.existsSync(file)) continue;
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('---') || /^[a-z_]+:\s/i.test(line)) return;
        docs.push({ id: `${layer}:${i + 1}`, where: layer, conclusion: line, text: line });
      });
  }

  return docs;
}

/** 把片段里的关键词标色 —— 扫结果时这一步最省事。 */
function highlight(text, tokens) {
  const spans = findMatches(text, tokens);
  if (!spans.length) return text;
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + c(33, text.slice(s.start, s.end));
    at = s.end;
  }
  return out + text.slice(at);
}

function cmdRecall(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root, { create: false });
  const query = String(opts._[0] || '').trim();
  if (!query) fail('用法：mem recall <关键词> [--where all|facts|decisions|inbox|archive|journal|sessions|index] [--limit N] [--json]');

  const docs = collectDocs(L, { where: typeof opts.where === 'string' ? opts.where : 'all' });
  const hits = rankDocs(docs, query, { limit: opts.limit ? Number(opts.limit) : 20 });

  if (opts.json) {
    console.log(JSON.stringify({ query, total: hits.length, matches: hits }, null, 2));
    return;
  }
  if (!hits.length) {
    console.log(dim(`（没有匹配 "${query}" 的记忆或流水）`));
    console.log(dim('  换个说法，或拆成几个关键词再试 —— 中文连写会自动切 bigram，不用手动加空格。'));
    return;
  }
  for (const h of hits) {
    console.log(`${c(36, String(h.where).padEnd(9))} ${c(1, h.id.padEnd(34))} ${dim(`score ${h.score.toFixed(1)}`)}`);
    console.log(`    ${highlight(h.snippet, h.matched)}`);
  }
  console.log(dim(`\n命中 ${hits.length} 条（按相关度排序；--json 可机器读）`));
}

/* ---------------------------------------------------------------- due */

/** 把 active 条目摊成 due.mjs 要的形状（verify_when / date 都来自 frontmatter）。 */
function dueInput(L) {
  return activeEntries(L).map((e) => ({ id: e.id, line: firstLine(e.body), date: e.data.date, verifyWhen: e.data.verify_when ?? null }));
}

/**
 * 列出到了 `verify_when` 复核期的条目。
 *
 * 为什么要有它：`verify_when` 如果只能写不能读，就只是个装饰性的字段 ——
 * 记忆的真正问题是"当初记的时候说好了要回头看，然后就再也没看过"。
 */
function cmdDue(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root, { create: false });
  const day = today();
  const within = opts.within ? Number(opts.within) : 0;
  const list = collectDue(dueInput(L), day, { within });

  if (opts.json) {
    console.log(JSON.stringify({ today: day, within, total: list.length, due: list }, null, 2));
    return;
  }
  if (!list.length) {
    // 没有到期项是**正常状态**，不是失败：退出码保持 0，方便脚本直接串起来
    console.log(dim('没有到期的复核项'));
    return;
  }
  for (const d of list) {
    // 最超期的排最前面（collectDue 已排好），颜色沿用 cmdList 那套：黄=要注意，青=id
    console.log(`${c(33, duePhrase(d.overdueDays).padEnd(14))} ${c(36, String(d.id).padEnd(30))} ${dim(`verify_when: ${d.verifyWhen}${d.due ? ` → ${d.due}` : ''}`)}`);
    console.log(`    ${d.line}`);
  }
  console.log(dim(`\n共 ${list.length} 条到期（今天 ${day}，within ${within} 天；--json 可机器读）`));
  console.log(dim('  不再成立的：mem supersede <旧id> <新id>；仍然成立的：mem set <id> --verify-when "…"'));
}

/* ------------------------------------------------------------- validate */

function cmdValidate(opts) {
  const root = resolveRoot(opts.root);
  const L = ensureLayout(root, { create: false });
  const cfg = loadConfig(root);

  // --fix：只做**机械可判定**的修：把已 superseded 但没归档的搬进 archive/，重建 index。
  // 语义层面的问题（冲突、缺 key）绝不自动改 —— 那需要人判断。
  if (opts.fix) {
    let moved = 0;
    for (const e of readAll(L)) {
      if (e.error || e.data.status !== 'superseded' || e.where === 'archive') continue;
      const dest = path.join(L.archive, `${e.id}.md`);
      if (fs.existsSync(dest)) continue;
      fs.writeFileSync(dest, serializeEntry(e), 'utf8');
      removeFile(e.file);
      moved += 1;
    }
    if (moved) ok(`--fix：把 ${moved} 条 superseded 条目归档`);
    writeIndex(L);
    ok('--fix：已重建 index.md');
  }

  const entries = readAll(L);
  const problems = [];
  const warnings = [];
  const seen = new Map();

  if (!cfg) warnings.push(`缺少 ${CONFIG_FILE}（可跑 mem init 生成）`);

  for (const e of entries) {
    const rel = path.relative(root, e.file);
    if (e.error) {
      problems.push(`${rel}: 读取失败 ${e.error}`);
      continue;
    }
    if (!e.hasFrontmatter) problems.push(`${rel}: 缺少 frontmatter`);
    for (const k of ['id', 'type', 'scope', 'status', 'date']) {
      if (e.data[k] === undefined || e.data[k] === null || e.data[k] === '') problems.push(`${rel}: frontmatter 缺少必填字段 ${k}`);
    }
    if (e.data.type && !TYPES.includes(e.data.type)) problems.push(`${rel}: type 非法（${e.data.type}）`);
    if (e.data.status && !STATUSES.includes(e.data.status)) problems.push(`${rel}: status 非法（${e.data.status}）`);
    if (e.data.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(e.data.date))) problems.push(`${rel}: date 应为 YYYY-MM-DD（${e.data.date}）`);
    if (e.data.id && e.data.id !== path.basename(e.file, '.md')) problems.push(`${rel}: id 与文件名不一致（id=${e.data.id}）`);
    if (!/##\s*结论/.test(e.body)) warnings.push(`${rel}: 正文没有「## 结论」小节`);
    if (!e.data.source) warnings.push(`${rel}: 没有 source（无法回溯到原始会话）`);

    if (e.id) {
      if (seen.has(e.id)) problems.push(`id 重复：${e.id}（${path.relative(root, seen.get(e.id))} 与 ${rel}）`);
      else seen.set(e.id, e.file);
    }
    // inbox 里的条目不该是 superseded/expired
    if (e.where === 'inbox' && e.data.status && e.data.status !== 'active') {
      warnings.push(`${rel}: inbox 里的条目 status=${e.data.status}，是否该归档？`);
    }
  }

  const byId = new Map(entries.filter((e) => !e.error).map((e) => [e.id, e]));
  for (const e of entries) {
    if (e.error) continue;
    for (const oldId of e.data.supersedes || []) {
      const old = byId.get(oldId);
      if (!old) problems.push(`${e.id}: supersedes 指向不存在的条目 ${oldId}`);
      else if (old.data.superseded_by !== e.id) problems.push(`${e.id}: supersedes ${oldId}，但对方的 superseded_by=${old.data.superseded_by}（应双向一致）`);
    }
    if (e.data.superseded_by) {
      const nw = byId.get(e.data.superseded_by);
      if (!nw) problems.push(`${e.id}: superseded_by 指向不存在的条目 ${e.data.superseded_by}`);
      else if (!(nw.data.supersedes || []).includes(e.id)) problems.push(`${e.id}: superseded_by=${e.data.superseded_by}，但对方没有 supersedes ${e.id}`);
      if (e.data.status !== 'superseded') problems.push(`${e.id}: 有 superseded_by 但 status=${e.data.status}（应为 superseded）`);
      if (e.where !== 'archive') warnings.push(`${e.id}: 已被取代但文件不在 archive/（在 ${e.where}/）`);
    }
  }

  // 环检测
  for (const e of entries) {
    if (e.error) continue;
    const chain = [e.id];
    let cur = e.data.superseded_by;
    while (cur) {
      if (chain.includes(cur)) {
        problems.push(`supersede 链存在环：${[...chain, cur].join(' → ')}`);
        break;
      }
      chain.push(cur);
      cur = byId.get(cur)?.data?.superseded_by;
    }
  }

  // 冲突检测：按**语义键 key**（不是按 tags —— 按 tags 会把一堆无关的决策全报成冲突）。
  // 「一个 key 一个真相」是硬不变量，所以这里是 problem 而不是 warning。
  const byKey = new Map();
  let activeWithoutKey = 0;
  for (const e of entries.filter((x) => !x.error && x.data.status === 'active' && (x.where === 'facts' || x.where === 'decisions'))) {
    if (!e.data.key) {
      activeWithoutKey += 1;
      continue;
    }
    const k = `${e.data.scope}|${e.data.key}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  for (const [k, list] of byKey) {
    if (list.length < 2) continue;
    const uniq = new Set(list.map((e) => firstLine(e.body)));
    if (uniq.size > 1) {
      problems.push(
        `冲突：同一个 key 上有 ${list.length} 条 active 且结论不同（${k}）\n` +
          `      用 --supersedes 明确谁取代谁：\n      ${list.map((e) => e.id).join('\n      ')}`,
      );
    } else {
      warnings.push(`同一个 key 上有 ${list.length} 条 active 但结论相同（可合并）：${k}`);
    }
  }
  if (activeWithoutKey > 0) {
    warnings.push(`${activeWithoutKey} 条 active 条目没有 key —— 它们不参与冲突检测（给事实/决策指定 --key 更安全）`);
  }

  // index 一致性
  if (fs.existsSync(L.index)) {
    const idx = fs.readFileSync(L.index, 'utf8');
    for (const e of entries.filter((x) => !x.error && (x.where === 'facts' || x.where === 'decisions') && x.data.status === 'active')) {
      if (!idx.includes(`\`${e.id}\``)) warnings.push(`index.md 未包含 ${e.id}（跑 mem index 重建）`);
    }
  } else warnings.push('index.md 不存在（跑 mem index 生成）');

  // 注入预算
  const text = renderInject(L);
  const bytes = Buffer.byteLength(text, 'utf8');
  const budget = cfg?.injectBudget ?? 3072;
  if (bytes > budget) problems.push(`注入体积超预算：${bytes} / ${budget} 字节（超 ${bytes - budget}）`);

  // 到期复核项：**告警**不是问题 —— "有条目该复核了"是记忆库正常运转的表现，
  // 不是格式错误，所以它绝不影响退出码（CI 里 validate 仍应通过）。
  const due = collectDue(dueInput(L), today(), { within: 0 });
  if (due.length) warnings.push(`${due.length} 条记忆到了 verify_when 复核期（跑 mem due 看明细）`);

  console.log(`\n检查 ${entries.length} 个条目（${path.relative(process.cwd(), root) || '.'}）`);
  if (!problems.length && !warnings.length) {
    ok('全部通过');
    return;
  }
  for (const p of problems) bad(p);
  for (const w of warnings) warn(w);
  console.log(`\n${problems.length} 个问题，${warnings.length} 个告警`);
  process.exitCode = problems.length ? 1 : 0;
}

/* ------------------------------------------------------------------ 入口 */

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else if (key === 'supersedes' && opts[key]) opts[key] = [].concat(opts[key], next), (i += 1);
      else {
        opts[key] = next;
        i += 1;
      }
    } else opts._.push(a);
  }
  return opts;
}

/**
 * 只有**被直接执行**时才跑 CLI；被 import 时只暴露函数。
 * 这样 DSH 插件可以直接复用这里的 store 逻辑，**不必 spawn 子进程**
 * （沙箱禁止命名管道，捕获子进程输出会 EPERM；而且也没必要）。
 */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  const opts = parseArgs(argv);

  switch (cmd) {
    case 'init': cmdInit(opts); break;
    case 'new': cmdNew(opts); break;
    case 'list': cmdList(opts); break;
    case 'show': cmdShow(opts); break;
    case 'promote': cmdPromote(opts); break;
    case 'rename': cmdRename(opts); break;
    case 'supersede': cmdSupersede(opts); break;
    case 'set': cmdSet(opts); break;
    case 'validate': cmdValidate(opts); break;
    case 'index': cmdIndex(opts); break;
    case 'inject': cmdInject(opts); break;
    case 'journal': cmdJournal(opts); break;
    case 'recall': cmdRecall(opts); break;
    case 'due': cmdDue(opts); break;
    case 'version': case '--version': console.log(VERSION); break;
    case 'help': case '--help': case undefined: usage(); break;
    default: fail(`未知命令：${cmd}\n跑 mem help 看用法`);
  }
}

export {
  VERSION,
  CONFIG_FILE,
  TYPES,
  STATUSES,
  DIR_OF,
  FM_KEYS,
  resolveRoot,
  defaultConfig,
  loadConfig,
  ensureLayout,
  parseFrontmatter,
  renderFrontmatter,
  serializeEntry,
  readEntryFile,
  readAll,
  findById,
  activeEntries,
  collectDocs,
  entryHash,
  injectPayload,
  renderInject,
  writeIndex,
  firstLine,
  slugify,
  today,
};

function usage() {
  console.log(`mem ${VERSION} — dsh-memory-delta CLI

用法： mem <命令> [选项]

  init                    初始化记忆库（--root <路径> 可指定；默认 <cwd>/memory）
  new --type fact|decision --conclusion "…" [--key <语义键>] [--id <短id>]
      [--reason "…"] [--tags a,b] [--scope s]
                          在 inbox 创建候选条目（--json 输出机器可读结果）
                          · --key：一个 scope+key 上只能有一个 active 真相（冲突检测依据）
                          · --id ：推荐显式给短 id；不给则从结论派生（压到 20 字符）
  list [--status --type --scope --tag --where --all --json]
  show <id> [--json]
  promote <id> [--supersedes <旧id>]     inbox → facts/decisions
  rename <旧id> <新id>                   安全改名（id + 文件名 + 引用一起改）
                          同 key 已有 active 时必须显式 --supersedes
  supersede <旧id> <新id>                标记取代 + 归档 + 双向链接
  set <id> [--key k] [--tags a,b] [--scope s] [--status …] [--conclusion "…"]
      [--verify-when "…"]  修改已有条目（补 key、改措辞、标 expired）
                           · --verify-when：复核时机。写 '2026-03-01' 或相对条目日期的
                             '3个月后' / '2周后'（相对写法取条目自己的 date 为基准）
  validate [--fix]        校验（格式 / id / 双向链接 / 环 / 同 key 冲突 / 索引 / 注入预算）
                          --fix 只修机械问题：归档漏归档的 superseded、重建 index
  index                   重建 index.md
  inject [--budget <字节>] [--json]  渲染"应注入的内容"并核对预算
                          --json 输出带 per-entry hash 的结构化载荷（差分注入用）
  journal add "内容"       追加流水（不注入）
  recall <关键词> [--where <层>] [--limit N] [--json]
                           相关度排序检索；中文自动切 bigram，结果带命中片段
                           --where：all（默认）| facts | decisions | inbox | archive | journal | sessions | index
  due [--within N] [--json]
                           列出到了 verify_when 复核期的 active 条目（默认只看已到期）
                           --within N 提前 N 天提醒；没有到期项时不算失败（退出码 0）

根目录解析：--root > $DSH_MEMORY_ROOT > <cwd>/memory`);
}

