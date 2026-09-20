/**
 * 插件集成测试 —— 用桩模块把 `src/plugin.mjs` **真正 apply 起来**并驱动它，
 * 覆盖"注册了 pre-step 与工具、配置生效、注入走差分、工具真的能读写记忆库"。
 *
 * 跑：node --import ./test/stub-loader.mjs test/plugin-tests.mjs
 * （不能在没有 loader 的情况下直接 import 插件 —— 它依赖 DSH 提供的包）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config, apply, inject as injectServices, name } from '../src/plugin.mjs';
import { createEntry, ensureLayout, injectPayload, readAll } from '../bin/mem.mjs';
import { MEMORY_REVEAL_PATH, MEMORY_ROUTE_PATH, createMemoryRoute, createRevealRoute, memoryStateOf, registerMemoryRoute, registerRevealRoute, resolvePanelRoot, resolveRevealDir } from '../src/panel.mjs';
import { MEMORY_SOURCE_KIND } from '../src/planner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 沙箱目录**按进程分**：两套测试同时跑（两个 agent 并行、或边跑测试边手动验证）时
// 共用同一个 `.test-sandbox` 会互相 rmrf，表现为"随机失败且每次失败项都不同" —— 真实踩过。
const SANDBOX = process.env.MEM_TEST_SANDBOX || path.join(HERE, '..', `.test-sandbox-${process.pid}`);

let pass = 0;
let fail = 0;
const failures = [];
function check(n, c, d = '') {
  if (c) {
    pass += 1;
    console.log(`  ok   ${n}`);
  } else {
    fail += 1;
    failures.push(`${n}${d ? ` — ${d}` : ''}`);
    console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`);
  }
}
const section = (t) => console.log(`\n${t}`);

/**
 * 递归校验"无损 JSON" —— DSH 的工具层要求返回值里不能有 `undefined`（也不能有函数 / Date /
 * 类实例等）：只要有一个属性是 `undefined`，**整个工具调用就失败**
 * （`value is not lossless JSON`）。桩模块不校验这个，所以这里自己校验。
 * 真机上踩到过：命中流水行（没有 type/status）或没有 key 的条目时，输出里漏出了 undefined。
 */
function losslessError(value, path = '$') {
  if (value === undefined) return `${path} 是 undefined（DSH 判为非法）`;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return null;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const e = losslessError(v, `${path}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return `${path} 不是普通对象`;
    for (const [k, v] of Object.entries(value)) {
      const e = losslessError(v, `${path}.${k}`);
      if (e) return e;
    }
    return null;
  }
  return `${path} 的类型 ${t} 不是 JSON 值`;
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) rmrf(path.join(p, e));
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}

/* -------------------------------------------------------- 假的 DSH ctx/agent */

function fakeCtx() {
  const handlers = new Map();
  const registered = [];
  const warnings = [];
  return {
    handlers,
    registered,
    warnings,
    on(event, fn) {
      handlers.set(event, fn);
    },
    tools: {
      register(tool) {
        registered.push(tool);
      },
    },
    logger: { warn: (...a) => warnings.push(a[0]) },
    get: () => undefined,
  };
}

/**
 * 带 webServer 的假 ctx —— 用来验证「记忆」页签那条只读路由的**真实接线**。
 *
 * 关键：假 ctx 实现 `inject(deps, cb)`（cordis 的真实语义是"服务可用后才跑回调"），
 * 并且**默认模拟"webServer 晚于 apply 才出现"**：这正是真机上踩到的 bug ——
 * 用 `ctx.get('webServer')` 在 apply 那一刻读，拿到 undefined，路由静默没注册，
 * 页签点开只报 "HTTP 405"（未知路径落到 SPA 回退）。
 *
 * @param {{ late?: boolean }} [opts] late=true（默认）：回调先存起来，由测试手动触发；
 *   late=false：`inject` 立刻执行回调，模拟服务早就就绪
 */
function fakeCtxWithWebServer({ late = true } = {}) {
  const ctx = fakeCtx();
  const routes = [];
  const effects = [];
  const pending = [];
  ctx.routes = routes;
  ctx.effects = effects;
  ctx.pendingInjects = pending;
  const server = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  ctx.effect = (fn, label) => {
    effects.push(label);
    return fn();
  };
  ctx.get = (name) => (name === 'webServer' ? server : undefined);
  ctx.inject = (deps, callback) => {
    const names = Array.isArray(deps) ? deps : Object.keys(deps);
    const run = () => {
      const fork = fakeCtx();
      fork.effect = ctx.effect;
      Object.assign(fork, { webServer: server });
      callback(fork);
    };
    if (names.includes('webServer')) {
      if (late) {
        pending.push(run);
        return { dispose() {} };
      }
      run();
      return { dispose() {} };
    }
    // 其它依赖：本插件没有，直接拒绝以暴露写错依赖的情况
    throw new Error(`fakeCtxWithWebServer: 意外的 inject 依赖 ${names.join(',')}`);
  };
  return ctx;
}

/* ------------------------------------------- 假的 req / res（node:http 形状） */

function fakeRes() {
  const state = { status: null, headers: null, body: '' };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers ?? null;
    },
    end(chunk) {
      if (chunk !== undefined) state.body += String(chunk);
    },
    json() {
      return JSON.parse(state.body || '{}');
    },
  };
}

function fakeReq({ method = 'POST', body = '', headers = { host: '127.0.0.1:23278' }, url = MEMORY_ROUTE_PATH } = {}) {
  const listeners = new Map();
  return {
    method,
    url,
    headers,
    on(event, fn) {
      listeners.set(event, fn);
      return this;
    },
    // 手动投递 body：所有 on() 都注册完之后再调，避免监听器还没挂上就已结束
    send() {
      if (body !== '') listeners.get('data')?.(Buffer.from(body, 'utf8'));
      listeners.get('end')?.();
    },
  };
}

/** 跑一次 handler，返回 {status, json} —— res 收集写入的 body。 */
async function callRoute(route, options = {}) {
  const req = fakeReq(options);
  const res = fakeRes();
  const pending = route.handler(req, res);
  req.send();
  await pending;
  return { status: res.state.status, json: res.json(), headers: res.state.headers };
}

function fakeAgent(cwd, id = 'session-test') {
  const nextStep = [];
  const inbox = {
    nextStep,
    prepend(queue, message) {
      if (queue !== 'next-step') throw new Error(`unexpected queue ${queue}`);
      nextStep.unshift(message);
    },
    replace(mid, message) {
      const i = nextStep.findIndex((m) => m.id === mid);
      if (i < 0) throw new Error(`replace miss ${mid}`);
      nextStep[i] = message;
    },
    remove(mid) {
      const i = nextStep.findIndex((m) => m.id === mid);
      if (i >= 0) nextStep.splice(i, 1);
    },
  };
  return { session: { header: { cwd, id } }, inbox };
}

/* ------------------------------------------------------------------ 准备记忆库 */

rmrf(SANDBOX);
const ROOT = path.join(SANDBOX, 'proj', 'memory');
ensureLayout(ROOT);
const L = ensureLayout(ROOT, { create: false });
createEntry(L, { type: 'fact', id: 'known-fact', conclusion: '路径含非 ASCII 时不要用 rmSync', tags: ['node'], source: 's0' });
const known = readAll(L).find((e) => e.id === 'known-fact');
fs.writeFileSync(path.join(L.facts, 'known-fact.md'), fs.readFileSync(known.file, 'utf8'), 'utf8');
fs.unlinkSync(known.file);

/* ------------------------------------------------------------------ 契约 */

section('插件契约（导出形状）');
{
  check('name 是 memory', name === 'memory', name);
  check('inject 声明了 tools 服务', Array.isArray(injectServices) && injectServices.includes('tools'), JSON.stringify(injectServices));
  check('Config 声明了 root/maxBytes/enabled/dueWithin', ['root', 'maxBytes', 'enabled', 'dueWithin'].every((k) => !!Config[k]), Object.keys(Config).join(','));
}

/* ------------------------------------------------------------------ 接线 */

section('apply() 接线：注册 pre-step 与两个工具');
const ctx = fakeCtx();
const cwdOfProject = path.join(SANDBOX, 'proj');
// apply 的返回值不是给 DSH 用的，而是留一个不污染 ctx 的测试缝（见 src/plugin.mjs 末尾注释）
const plugin = apply(ctx, { root: ROOT, maxBytes: 3072, enabled: true });

check('注册了 agent/pre-step', typeof ctx.handlers.get('agent/pre-step') === 'function');
check('注册了 2 个工具', ctx.registered.length === 2, ctx.registered.map((t) => t.name).join(","));
check('工具名正确', ctx.registered.map((t) => t.name).sort().join(",") === 'memory_search,memory_write', ctx.registered.map((t) => t.name).join(","));
for (const tool of ctx.registered) {
  check(`${tool.name} 有 description/parameters/execute/output`, !!tool.description && !!tool.parameters && typeof tool.execute === 'function' && !!tool.output);
}

/* ------------------------------------------------- 差分注入：端到端三轮 */

section('差分注入：通过插件真实跑三轮');
const preStep = ctx.handlers.get('agent/pre-step');
{
  const agent = fakeAgent(cwdOfProject);
  const userMsg = { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '干活' }] };

  // 第 1 轮：step 1、还没有已领取消息 → 进 inbox
  const d1 = { kind: 'ok', messages: [] };
  const o1 = await preStep({ agent, messages: [], step: 1 }, async () => d1);
  check('第 1 轮不打断 decision', o1 === d1);
  check('第 1 轮把 baseline 排进 inbox', agent.inbox.nextStep.length === 1);
  const baseline = agent.inbox.nextStep[0];
  check('baseline 内容是记忆条目', baseline.content[0].text.includes('不要用 rmSync'), baseline.content[0].text.slice(0, 60));
  check('baseline 带 source.entries', Array.isArray(baseline.source.entries) && baseline.source.entries[0].id === 'known-fact');

  // 第 2 轮：已领取里含上轮那条 → 状态一致 → 零注入
  const claimed = [userMsg, baseline];
  const d2 = { kind: 'ok', messages: [...claimed] };
  const o2 = await preStep({ agent: fakeAgent(cwdOfProject), messages: claimed, step: 2 }, async () => d2);
  check('第 2 轮零注入（记忆没变化）', o2.messages.length === d2.messages.length, String(o2.messages.length));

  // 第 3 轮：新写入一条并提升为 active → 只推差异
  const created = createEntry(L, { type: 'fact', id: 'new-fact', conclusion: '新结论：沙箱禁管道', tags: ['dsh'], source: 's1' });
  fs.writeFileSync(path.join(L.facts, 'new-fact.md'), fs.readFileSync(created.file, 'utf8'), 'utf8');
  fs.unlinkSync(created.file);
  const payload = injectPayload(L, 3072);
  check('记忆库现在有 2 条 active', payload.entries.length === 2, String(payload.entries.length));

  const d3 = { kind: 'ok', messages: [...claimed] };
  const o3 = await preStep({ agent: fakeAgent(cwdOfProject), messages: claimed, step: 3 }, async () => d3);
  check('第 3 轮插入 1 条', o3.messages.length === d3.messages.length + 1, String(o3.messages.length));
  const delta = o3.messages.find((m) => m.source?.kind === MEMORY_SOURCE_KIND && m.content[0].text.includes('新增'));
  check('第 3 轮推的是 delta', !!delta, JSON.stringify(o3.messages.map((m) => m.content[0].text.slice(0, 24))));
  check('delta 只含新条目', delta && /沙箱禁管道/.test(delta.content[0].text) && !/rmSync/.test(delta.content[0].text), delta?.content[0].text.slice(0, 120));
  // 回归：id 只走 source.entries，不进正文（曾占掉 40% 注入字节）
  check('注入正文不含 id 注释', delta && !delta.content[0].text.includes('<!--'), delta?.content[0].text.slice(0, 120));
  check('baseline 正文也不含 id 注释', !baseline.content[0].text.includes('<!--'), baseline.content[0].text.slice(0, 120));

  // 到期复核要用 payload 里的 date / verify_when —— 缺了它们，hook 就算不出"到点了"
  check('injectPayload 每条都带 date 键', payload.entries.every((e) => 'date' in e), JSON.stringify(payload.entries.map((e) => e.date)));
  check('injectPayload 每条都带 verifyWhen 键（没写则为 null）', payload.entries.every((e) => 'verifyWhen' in e && (e.verifyWhen === null || typeof e.verifyWhen === 'string')), JSON.stringify(payload.entries.map((e) => e.verifyWhen)));
}

/* ------------------------------------------------------------------ 工具 */

section('工具：memory_write 与 memory_search');
const writeTool = ctx.registered.find((t) => t.name === 'memory_write');
const searchTool = ctx.registered.find((t) => t.name === 'memory_search');
const toolAgent = fakeAgent(cwdOfProject, 'session-tool');

{
  const result = await writeTool.execute(
    { type: 'decision', conclusion: '模型只能写收件箱', reason: '防止错误结论被反复注入', tags: ['design'], key: 'inbox-only' },
    { agent: toolAgent },
  );
  check('memory_write 返回 id 与 inbox 状态', !!result.id && result.status === 'inbox', JSON.stringify(result));

  const inboxCount = fs.readdirSync(L.inbox).filter((f) => f.endsWith('.md')).length;
  check('memory_write 真的写进了 inbox', inboxCount === 1, String(inboxCount));

  // D2 的关键验证：刚写的候选**不能**进入注入
  const after = injectPayload(L, 3072);
  check('候选条目未进入注入载荷（D2：模型不能直接改事实层）', !after.entries.some((e) => e.id === result.id), after.entries.map((e) => e.id).join(','));

  const rendered = writeTool.output.render({}, result);
  check('工具输出可渲染成文本', Array.isArray(rendered) && typeof rendered[0].text === 'string', JSON.stringify(rendered));
  check('渲染文案提到 inbox', /inbox/.test(rendered[0].text), rendered[0].text);

  // 真机试用踩到的 bug：工具写的条目 scope 落到了 harness 进程的 cwd（launch-root）。
  // 断言 scope 跟随**会话工作区**，绝不可能是 harness 进程的 cwd。
  const writtenRaw = fs.readFileSync(path.join(L.inbox, `${result.id}.md`), 'utf8');
  const writtenScope = /scope:\s*(.+)/.exec(writtenRaw)?.[1]?.trim();
  check('memory_write 的 scope 跟随会话工作区', writtenScope === `workspace:${cwdOfProject}`, String(writtenScope));
  check('scope 不是 harness 进程 cwd 那种值', !/launch-root|dsh-desktop/i.test(String(writtenScope)), String(writtenScope));
}

{
  const hit = await searchTool.execute({ query: 'rmSync' }, { agent: toolAgent });
  check('memory_search 能搜到已有事实', hit.total >= 1 && hit.matches.some((m) => m.id === 'known-fact'), JSON.stringify(hit).slice(0, 200));

  const byKey = await searchTool.execute({ query: 'inbox-only' }, { agent: toolAgent });
  check('memory_search 能按 key 搜到 inbox 候选', byKey.matches.some((m) => m.where === 'inbox'), JSON.stringify(byKey.matches));

  const none = await searchTool.execute({ query: '绝对搜不到的词xyzzy' }, { agent: toolAgent });
  check('搜不到时 total=0', none.total === 0, JSON.stringify(none));

  const journalLine = await searchTool.execute({ query: '流水一行' }, { agent: toolAgent });
  check('memory_search 覆盖 journal（本轮没写则为 0）', journalLine.total === 0 || journalLine.matches.some((m) => m.where === 'journal'), JSON.stringify(journalLine.total));

  // 中文连写检索：查询不带空格也要命中（bigram 分词）—— 老实现（纯子串）这里必然落空
  const zh = await searchTool.execute({ query: '沙箱禁管道' }, { agent: toolAgent });
  check('memory_search 支持中文连写检索', zh.matches.some((m) => m.id === 'new-fact'), JSON.stringify(zh).slice(0, 200));
  check('memory_search 结果带 score 与 snippet', typeof zh.matches[0]?.score === 'number' && !!zh.matches[0]?.snippet, JSON.stringify(zh.matches[0] ?? {}).slice(0, 200));

  // --where 收窄到 facts：inbox 里的候选不应该出现
  const factsOnly = await searchTool.execute({ query: '沙箱禁管道', where: 'facts' }, { agent: toolAgent });
  check('where=facts 只返回事实层', factsOnly.matches.length > 0 && factsOnly.matches.every((m) => m.where === 'facts'), JSON.stringify(factsOnly.matches.map((m) => m.where)));

  const rendered = searchTool.output.render({}, none);
  check('无可渲染输出时不炸', Array.isArray(rendered) && typeof rendered[0].text === 'string', JSON.stringify(rendered));

  // 回归（真机踩到）：命中**没有 key 的条目**或**流水行**时，输出里曾漏出 `undefined`，
  // 而 DSH 要求无损 JSON → 整个 memory_search 调用直接失败（"value is not lossless JSON"）。
  const keyless = await searchTool.execute({ query: 'rmSync' }, { agent: toolAgent });
  check('命中无 key 条目时输出是无损 JSON', losslessError(keyless) === null, losslessError(keyless) ?? '');
  check('无 key 条目确实命中了（不是空结果蒙过去）', keyless.matches.length > 0 && keyless.matches.every((m) => !('key' in m)), JSON.stringify(keyless.matches.map((m) => Object.keys(m))));

  // 流水行没有 type/status/key —— 这些字段必须整条省掉，而不是留成 undefined
  fs.appendFileSync(path.join(L.root, 'journal.md'), '- 2026-01-01 流水：命名管道那条坑\n', 'utf8');
  const journalHit = await searchTool.execute({ query: '命名管道那条坑', where: 'journal' }, { agent: toolAgent });
  check('流水行能被检索到', journalHit.total > 0, JSON.stringify(journalHit).slice(0, 160));
  check('命中流水行时输出是无损 JSON', losslessError(journalHit) === null, losslessError(journalHit) ?? '');
  check(
    '流水行命中不含 type/status/key 字段（省掉而不是留 undefined）',
    journalHit.matches.every((m) => !('type' in m) && !('status' in m) && !('key' in m)),
    JSON.stringify(journalHit.matches.map((m) => Object.keys(m))),
  );
  check('memory_write 的输出也是无损 JSON', losslessError(await writeTool.execute({ type: 'fact', conclusion: '无损 JSON 探针' }, { agent: toolAgent })) === null);
}

/* ------------------------------------------------- 到期复核：真接线跑一遍 */

section('到期复核：通过插件真实接线发出 form=due 的提醒');
{
  // 造一条"早已过期"的条目（verify_when 是过去日期），直接写进 facts/
  const created = createEntry(L, { type: 'fact', id: 'stale-fact', conclusion: '该复核的老结论', source: 's2' });
  fs.writeFileSync(path.join(L.facts, 'stale-fact.md'), fs.readFileSync(created.file, 'utf8'), 'utf8');
  fs.unlinkSync(created.file);
  const stalePath = path.join(L.facts, 'stale-fact.md');
  fs.writeFileSync(stalePath, fs.readFileSync(stalePath, 'utf8').replace('verify_when: null', 'verify_when: 2000-01-01'), 'utf8');

  const dueCtx = fakeCtx();
  apply(dueCtx, { root: ROOT, maxBytes: 3072 });
  const agent = fakeAgent(cwdOfProject, 'session-due');

  // 传一份"已含全部当前记忆状态"的历史：这样 plan 是 none，走的正是到期提醒该出场的那条路
  const state = injectPayload(L, 3072).entries.map((e) => ({ id: e.id, hash: e.hash }));
  const seen = { id: 'seen', source: { kind: MEMORY_SOURCE_KIND, entries: state }, content: [{ type: 'text', text: '之前注入过' }] };
  const claimed = [{ id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }, seen];
  const d = { kind: 'ok', messages: [...claimed] };

  const out = await dueCtx.handlers.get('agent/pre-step')({ agent, messages: claimed, step: 2 }, async () => d);
  const dueMsg = out.messages.find((m) => m.source?.form === 'due');
  check('插件接线能发出到期提醒', !!dueMsg, JSON.stringify(out.messages.map((m) => m.source?.form)));
  check('提醒通过真实 createUserMessage 构造', !!dueMsg && dueMsg.role === 'user' && Array.isArray(dueMsg.content), JSON.stringify(dueMsg?.content));
  check('提醒的 source.entries 是 undefined（不污染差分基线）', dueMsg && dueMsg.source.entries === undefined, JSON.stringify(dueMsg?.source));
  check('提醒文案含该复核的条目', !!dueMsg && /该复核的老结论/.test(dueMsg.content[0].text), dueMsg?.content[0].text.slice(0, 160));
  check('这一轮不重复注入记忆（desired 本来就是 null）', out.messages.filter((m) => m.source?.kind === MEMORY_SOURCE_KIND).length === 2, String(out.messages.length));

  // 同一个会话再跑一步 → 不再提醒
  const nextMessages = [...out.messages];
  const d2 = { kind: 'ok', messages: [...nextMessages] };
  const out2 = await dueCtx.handlers.get('agent/pre-step')({ agent, messages: nextMessages, step: 3 }, async () => d2);
  check('同一会话不重复提醒（真实接线）', out2 === d2, String(out2.messages.length));
  check('到期提醒没带来告警噪音', dueCtx.warnings.length === 0, JSON.stringify(dueCtx.warnings));

  // verify_when 写成**人话** → 一律不提醒（否则每个会话都弹一次、永远消不掉）
  fs.writeFileSync(stalePath, fs.readFileSync(stalePath, 'utf8').replace('verify_when: 2000-01-01', 'verify_when: 等换机器时'), 'utf8');
  const proseCtx = fakeCtx();
  apply(proseCtx, { root: ROOT, maxBytes: 3072 });
  const proseAgent = fakeAgent(cwdOfProject, 'session-prose');
  const state2 = injectPayload(L, 3072).entries.map((e) => ({ id: e.id, hash: e.hash }));
  const seen2 = { id: 'seen2', source: { kind: MEMORY_SOURCE_KIND, entries: state2 }, content: [{ type: 'text', text: '之前注入过' }] };
  const claimed2 = [{ id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }, seen2];
  const d3 = { kind: 'ok', messages: [...claimed2] };
  const out3 = await proseCtx.handlers.get('agent/pre-step')({ agent: proseAgent, messages: claimed2, step: 2 }, async () => d3);
  check('verify_when 是人话时不提醒（真实接线）', out3 === d3, JSON.stringify(out3.messages.map((m) => m.source?.form)));

  // dueWithin 从插件 Config **真的透传**到 hook：条目 10 天后才到复核期，
  // 默认（0）不提醒，"提前 30 天"要提醒。只看 schema 有没有字段是不够的 —— 得走真接线。
  const soonRoot = path.join(SANDBOX, 'due-within', 'memory');
  ensureLayout(soonRoot);
  const soonL = ensureLayout(soonRoot, { create: false });
  const inTenDays = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const soonCreated = createEntry(soonL, { type: 'fact', id: 'soon-fact', conclusion: '十天后该复核的事', verifyWhen: inTenDays, source: 's1' });
  fs.writeFileSync(path.join(soonL.facts, 'soon-fact.md'), fs.readFileSync(soonCreated.file, 'utf8'), 'utf8');
  fs.unlinkSync(soonCreated.file);

  const soonCwd = path.join(SANDBOX, 'due-within');
  const soonState = injectPayload(soonL, 3072).entries.map((e) => ({ id: e.id, hash: e.hash }));
  const seenSoon = { id: 'seen-soon', source: { kind: MEMORY_SOURCE_KIND, entries: soonState }, content: [{ type: 'text', text: '之前注入过' }] };
  const claimedSoon = [{ id: 'u-soon', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }, seenSoon];
  const dSoon = { kind: 'ok', messages: [...claimedSoon] };

  const offCtxSoon = fakeCtx();
  apply(offCtxSoon, { root: soonRoot });
  const outSoonOff = await offCtxSoon.handlers.get('agent/pre-step')({ agent: fakeAgent(soonCwd, 'session-soon-off'), messages: claimedSoon, step: 2 }, async () => dSoon);
  check('dueWithin 默认 0：还没到期的条目不提醒', outSoonOff === dSoon, JSON.stringify(outSoonOff.messages.map((m) => m.source?.form)));

  const onCtxSoon = fakeCtx();
  apply(onCtxSoon, { root: soonRoot, dueWithin: 30 });
  const outSoonOn = await onCtxSoon.handlers.get('agent/pre-step')({ agent: fakeAgent(soonCwd, 'session-soon-on'), messages: claimedSoon, step: 2 }, async () => dSoon);
  const dueSoon = outSoonOn.messages.find((m) => m.source?.form === 'due');
  check('dueWithin=30：还没到期但快了 → 提醒（Config 真的透传到了 hook）', !!dueSoon, JSON.stringify(outSoonOn.messages.map((m) => m.source?.form)));
  check('到期提醒里带上 verify_when 原值', !!dueSoon && dueSoon.content[0].text.includes(inTenDays), dueSoon?.content[0].text.slice(0, 120));
  check('dueWithin 生效时也不带 entries（不污染差分基线）', !!dueSoon && dueSoon.source.entries === undefined, JSON.stringify(dueSoon?.source));
}

/* --------------------------------------- 侧边栏「记忆」页签的数据路由 */

section('侧边栏「记忆」页签：只读 JSON 路由');
{
  // 根目录解析：插件 root 优先；否则 <workspace>/memory
  const r1 = resolvePanelRoot({ configRoot: ROOT, workspace: path.join(SANDBOX, 'other') });
  check('配置了插件 root 就用它（不受 workspace 影响）', r1.root === ROOT, String(r1.root));
  const r2 = resolvePanelRoot({ workspace: cwdOfProject });
  check('没配 root 时用 <workspace>/memory', r2.root === path.join(cwdOfProject, 'memory'), String(r2.root));
  const r3 = resolvePanelRoot({});
  check('workspace 缺失时返回根目录 null（调用方给空状态，不抛错）', r3.root === null, String(r3.root));

  // 真接线：apply 时 webServer **还没就绪**（真机就是这样）→ 走 ctx.inject 等它出现
  const panelCtx = fakeCtxWithWebServer(); // late=true：回调先挂着
  apply(panelCtx, { root: ROOT, maxBytes: 3072, dueWithin: 0 });
  // 回归（真机踩到）：这里如果断言 0 条路由就说明又退回"apply 时 ctx.get 一眼定生死"了，
  // 那时页签会出现、点开只报 HTTP 405（未知路径落到 SPA 回退）
  check('apply 那一刻还没 webServer → 不注册（也不报错）', panelCtx.routes.length === 0, String(panelCtx.routes.length));
  check('用 ctx.inject 挂了一个等待 webServer 的回调', panelCtx.pendingInjects.length === 1, String(panelCtx.pendingInjects.length));
  check('工具照常注册（不等 webServer）', panelCtx.registered.length === 2, String(panelCtx.registered.length));

  panelCtx.pendingInjects[0](); // webServer 出现了
  check('webServer 出现后注册了 2 条路由（状态 + 打开目录）', panelCtx.routes.length === 2, String(panelCtx.routes.length));
  const route = panelCtx.routes.find((r) => r.path === MEMORY_ROUTE_PATH) ?? panelCtx.routes[0];
  check('路由 kind 是 exact', route.kind === 'exact', String(route.kind));
  check('路由路径是 /dsh-memory-delta/state', route.path === MEMORY_ROUTE_PATH && route.path === '/dsh-memory-delta/state', String(route.path));
  const revealRoute = panelCtx.routes.find((r) => r.path === MEMORY_REVEAL_PATH);
  check('第二条路由是「打开目录」', revealRoute?.path === '/dsh-memory-delta/reveal', panelCtx.routes.map((r) => r.path).join(','));

  // 路径在**两处**各写了一遍（宿主 `src/panel.mjs`、客户端 `client/client.js`）——
  // 写歪一处就是"页签一直是空的"这种最难查的故障。这里直接把两边钉成同一个字符串。
  const clientSrc = fs.readFileSync(path.join(HERE, '..', 'client', 'client.js'), 'utf8');
  const clientUrl = /const STATE_URL = '([^']+)'/.exec(clientSrc)?.[1];
  check('客户端 fetch 的 URL 与宿主路由路径完全一致', clientUrl === MEMORY_ROUTE_PATH, `${clientUrl} vs ${MEMORY_ROUTE_PATH}`);
  const clientId = /id:\s*'([^']+)',\s*\n\s*factory:/.exec(clientSrc)?.[1];
  check('客户端 bundle 的 id 是包名 dsh-memory-delta', clientId === 'dsh-memory-delta', String(clientId));
  // 客户端必须用 POST —— 宿主路由只认 POST，用 GET 会得到 405（而且回退服务器也回 405，极易误判）
  check('客户端用 POST 请求这条路由', /fetch\(STATE_URL,\s*\{\s*\n\s*method:\s*'POST'/.test(clientSrc), 'client/client.js 里的 fetch 选项');
  check('路由通过 ctx.effect 托管（可随插件卸载）', panelCtx.effects.length === 2, JSON.stringify(panelCtx.effects));
  check('effect 带可读的标签（含新包名）', panelCtx.effects[0] === 'dsh-memory-delta: /dsh-memory-delta/state route', String(panelCtx.effects[0]));
  check('「打开目录」路由也受 ctx.effect 托管', panelCtx.effects[1] === 'dsh-memory-delta: /dsh-memory-delta/reveal route', String(panelCtx.effects[1]));

  // 服务早就就绪的组合（late=false）→ 回调立刻跑
  const earlyCtx = fakeCtxWithWebServer({ late: false });
  apply(earlyCtx, { root: ROOT, maxBytes: 3072 });
  check('webServer 早已就绪时也注册', earlyCtx.routes.length === 2, String(earlyCtx.routes.length));

  // 没有 ctx.inject 的极简 ctx（老版本 / 测试替身）→ 退回 ctx.get，有就注册、没有不抛
  const plainCtx = fakeCtx();
  plainCtx.get = (n) => (n === 'webServer' ? { register: () => () => {} } : undefined);
  let plainThrew = null;
  try {
    apply(plainCtx, { root: ROOT });
  } catch (error) {
    plainThrew = error;
  }
  check('没有 ctx.inject 时不抛错（退回 ctx.get）', plainThrew === null, String(plainThrew?.message));

  // panel:false → 连等待都不挂
  const offPanelCtx = fakeCtxWithWebServer();
  apply(offPanelCtx, { root: ROOT, panel: false });
  check('panel:false 时不注册也不等待', offPanelCtx.routes.length === 0 && offPanelCtx.pendingInjects.length === 0, `${offPanelCtx.routes.length}/${offPanelCtx.pendingInjects.length}`);

  // 正常：POST + 回环来源
  // 临时库：专门用来钉"到期条目"的展示形状（共享库里的 stale-fact 在别处被改成
  // 了人话写法 verify_when，那是**故意不提醒**的场景，不适合拿来断言 due）。
  const panelRoot = path.join(SANDBOX, 'panel', 'memory');
  ensureLayout(panelRoot);
  const panelL = ensureLayout(panelRoot, { create: false });
  const panelStale = createEntry(panelL, { type: 'fact', id: 'panel-stale', conclusion: '面板要看到这条已过期的复核项', source: 's-panel' });
  fs.writeFileSync(
    path.join(panelL.facts, 'panel-stale.md'),
    fs.readFileSync(panelStale.file, 'utf8').replace('verify_when: null', 'verify_when: 2000-01-01'),
    'utf8',
  );
  fs.unlinkSync(panelStale.file);
  const dueJson = memoryStateOf({ configRoot: panelRoot, workspace: cwdOfProject });

  // 注意：这条路由的 root **由插件的 config.root 决定**（配了就以它为准），
  // 所以请求里的 workspace 只影响 scope 文案，不改变读的是哪个库 —— 下面按这个契约断言。
  const okRes = await callRoute(route, { body: JSON.stringify({ workspace: cwdOfProject }) });
  const directState = memoryStateOf({ configRoot: ROOT, workspace: cwdOfProject });
  check('POST 回环来源 → 200', okRes.status === 200, String(okRes.status));
  check('响应的 content-type 是 JSON', /application\/json/.test(String(okRes.headers?.['content-type'])), String(okRes.headers?.['content-type']));
  check('响应 ok:true', okRes.json.ok === true, JSON.stringify({ ok: okRes.json.ok, error: okRes.json.error }));
  check('响应带 root', okRes.json.root === ROOT, String(okRes.json.root));
  check('配了 config.root 时它就是权威（workspace 不改变读哪个库）', okRes.json.root === directState.root, `${okRes.json.root} vs ${directState.root}`);
  check('响应带 today（YYYY-MM-DD）', /^\d{4}-\d{2}-\d{2}$/.test(String(okRes.json.today)), String(okRes.json.today));
  check('响应带 budget 与 bytes', okRes.json.budget === 3072 && typeof okRes.json.bytes === 'number', JSON.stringify({ b: okRes.json.budget, y: okRes.json.bytes }));
  check('空状态时明确给出 error 文案（客户端据此显示错误行）', okRes.json.error === undefined || typeof okRes.json.error === 'string', JSON.stringify(okRes.json.error));
  check('entries 与 injectPayload 同源', okRes.json.entries.length === injectPayload(L, 3072).entries.length, `${okRes.json.entries.length} vs ${injectPayload(L, 3072).entries.length}`);
  check('entries 每条都带 id/type/line', okRes.json.entries.length > 0 && okRes.json.entries.every((e) => !!e.id && !!e.type && !!e.line), JSON.stringify(okRes.json.entries).slice(0, 200));
  check(
    'due 里带 overdueDays 与 verify_when（用一个临时库钉住，不看共享库的时点状态）',
    dueJson !== null && dueJson.due.length === 1 && dueJson.due[0].id === 'panel-stale' && dueJson.due[0].overdueDays > 0 && dueJson.due[0].verifyWhen === '2000-01-01',
    JSON.stringify(dueJson?.due ?? null),
  );
  check('due 项的 due 日期与 counts.due 一致', dueJson.entries.find((e) => e.id === 'panel-stale')?.due === dueJson.due[0].due && dueJson.counts.due === 1, JSON.stringify(dueJson.due[0]));
  check('counts 六个字段齐全', ['active', 'facts', 'decisions', 'inbox', 'archive', 'due'].every((k) => typeof okRes.json.counts[k] === 'number'), JSON.stringify(okRes.json.counts));
  check('counts.due 与 due 长度一致', okRes.json.counts.due === okRes.json.due.length, `${okRes.json.counts.due} vs ${okRes.json.due.length}`);
  check('counts.active 与 entries 长度一致', okRes.json.counts.active === okRes.json.entries.length, `${okRes.json.counts.active} vs ${okRes.json.entries.length}`);
  check('inbox 列出候选（memory_write 写过一条）', okRes.json.inbox.length >= 1 && okRes.json.inbox.every((e) => !!e.id && !!e.line), JSON.stringify(okRes.json.inbox).slice(0, 160));
  check('响应是无损 JSON（没有 undefined 值）', losslessError(okRes.json) === null, losslessError(okRes.json) ?? '');
  check('响应带 workspace（客户端据此反推）', okRes.json.workspace === cwdOfProject, String(okRes.json.workspace));

  // 面板要能"点一下打开这条记忆"：每条必须带**绝对文件路径**（客户端拿不到磁盘，只能由宿主给）。
  check(
    '每条常驻记忆都带绝对 file 路径（点条目要打开它）',
    okRes.json.entries.length > 0 && okRes.json.entries.every((e) => typeof e.file === 'string' && path.isAbsolute(e.file) && e.file.endsWith('.md')),
    JSON.stringify(okRes.json.entries.map((e) => e.file)).slice(0, 200),
  );
  check(
    'file 指向的文件真的存在',
    okRes.json.entries.every((e) => fs.existsSync(e.file)),
    okRes.json.entries.map((e) => e.file).join('|'),
  );
  check('每条带 tags 数组与 date（界面要显示）', okRes.json.entries.every((e) => Array.isArray(e.tags) && typeof e.date === 'string'), JSON.stringify(okRes.json.entries[0]).slice(0, 200));
  check('收件箱候选也带 file（promote 之前也能打开看）', okRes.json.inbox.every((e) => typeof e.file === 'string' && path.isAbsolute(e.file)), JSON.stringify(okRes.json.inbox).slice(0, 200));

  // 空请求体（客户端还没拿到 cwd 时就是这么发的）→ 仍然是 200 + ok:true
  const noWs = await callRoute(route, { body: '' });
  check('body 为空 → 仍 200 且 ok:true', noWs.status === 200 && noWs.json.ok === true, `${noWs.status} ${JSON.stringify({ ok: noWs.json.ok, error: noWs.json.error })}`);
  check('body 为空时仍然给出配置的 root（客户端据此把面板画出来）', noWs.json.root === ROOT, String(noWs.json.root));
  check('body 为空时 entries 照常返回', noWs.json.entries.length === okRes.json.entries.length, String(noWs.json.entries.length));
  check('body 为空时 scope/workspace 是空串（而不是 undefined）', noWs.json.scope === '' && noWs.json.workspace === '', JSON.stringify({ scope: noWs.json.scope, workspace: noWs.json.workspace }));

  // 没有 root 配置、workspace 又指向不存在目录：结构化的空状态，不是错误
  const emptyRoute = createMemoryRoute((input) =>
    memoryStateOf({ configRoot: undefined, workspace: input?.workspace }),
  );
  const missing = await callRoute(emptyRoute, { body: JSON.stringify({ workspace: path.join(SANDBOX, 'no-such-workspace') }) });
  check('workspace 指向不存在的目录 → 200', missing.status === 200, String(missing.status));
  check(
    '不存在时 ok:true + 空数组（不是 4xx、不抛错）',
    missing.json.ok === true && missing.json.entries.length === 0 && missing.json.due.length === 0 && missing.json.inbox.length === 0,
    JSON.stringify({ ok: missing.json.ok, e: missing.json.entries.length, d: missing.json.due.length, i: missing.json.inbox.length }),
  );
  check(
    '不存在时仍然给出 <workspace>/memory 作为 root（让用户看懂面板指向哪）',
    missing.json.root === path.join(SANDBOX, 'no-such-workspace', 'memory'),
    String(missing.json.root),
  );
  check('不存在时 counts 全 0', Object.values(missing.json.counts).every((v) => v === 0), JSON.stringify(missing.json.counts));
  check('不存在时 scope 从 workspace 推出来', missing.json.scope === `workspace:${path.join(SANDBOX, 'no-such-workspace')}`, String(missing.json.scope));

  // 来源校验：只接受回环来源
  const badHost = await callRoute(route, { headers: { host: 'evil.example.com' }, body: '{}' });
  check('非回环 Host → 403', badHost.status === 403, String(badHost.status));
  check('403 带明确原因', /回环/.test(String(badHost.json.error)), JSON.stringify(badHost.json));
  const noHost = await callRoute(route, { headers: {}, body: '{}' });
  check('没有 Host 头 → 403', noHost.status === 403, String(noHost.status));
  const crossSite = await callRoute(route, { headers: { host: '127.0.0.1:23278', 'sec-fetch-site': 'cross-site' }, body: '{}' });
  check('sec-fetch-site: cross-site → 403', crossSite.status === 403, String(crossSite.status));
  const badOrigin = await callRoute(route, { headers: { host: '127.0.0.1:23278', origin: 'http://evil.example.com' }, body: '{}' });
  check('Origin 与 Host 不同源 → 403', badOrigin.status === 403, String(badOrigin.status));
  const goodOrigin = await callRoute(route, { headers: { host: '127.0.0.1:23278', origin: 'http://127.0.0.1:23278' }, body: '{}' });
  check('Origin 与 Host 同源（回环）→ 200', goodOrigin.status === 200, String(goodOrigin.status));
  const localhostOrigin = await callRoute(route, { headers: { host: 'localhost:23278', origin: 'http://localhost:23278' }, body: '{}' });
  check('localhost 也算回环', localhostOrigin.status === 200, String(localhostOrigin.status));

  // 方法校验
  const getRes = await callRoute(route, { method: 'GET', body: '' });
  check('非 POST → 405', getRes.status === 405, String(getRes.status));
  check('405 里说明收到的方法', /GET/.test(String(getRes.json.error)), JSON.stringify(getRes.json));

  // body 校验
  const badJson = await callRoute(route, { body: '{ 不是 json' });
  check('body 不是 JSON → 400', badJson.status === 400, String(badJson.status));
  check('400 带明确原因', /JSON/.test(String(badJson.json.error)), JSON.stringify(badJson.json));

  // 记忆库读不了时也要回一条可读的 JSON，而不是断掉的连接
  const brokenRoute = createMemoryRoute(() => {
    throw new Error('模拟内部错误');
  });
  const brokenRes = await callRoute(brokenRoute, { body: '{}' });
  check('handler 内部异常 → 500 且仍是 JSON', brokenRes.status === 500 && /模拟内部错误/.test(String(brokenRes.json.error)), JSON.stringify(brokenRes.json));

  // 无 webServer 时必须优雅降级：不注册、不抛错、其余功能照旧
  const headlessCtx = fakeCtx();
  let headlessThrew = null;
  try {
    apply(headlessCtx, { root: ROOT });
  } catch (error) {
    headlessThrew = error;
  }
  check('没有 webServer 时不抛错（headless 优雅降级）', headlessThrew === null, headlessThrew ? String(headlessThrew.message) : '');
  check('没有 webServer 时工具照旧注册', headlessCtx.registered.length === 2, String(headlessCtx.registered.length));
  check('没有 webServer 时 pre-step 照旧注册', typeof headlessCtx.handlers.get('agent/pre-step') === 'function');
  check('没有 webServer 时零告警噪音', headlessCtx.warnings.length === 0, JSON.stringify(headlessCtx.warnings));

  // panel:false 关掉路由但保留其它
  const offCtx = fakeCtxWithWebServer();
  apply(offCtx, { root: ROOT, panel: false });
  check('panel:false 时不注册路由', offCtx.routes.length === 0, String(offCtx.routes.length));
  check('panel:false 时工具仍在', offCtx.registered.length === 2, String(offCtx.registered.length));

  // registerMemoryRoute 的返回值与容错
  check('webServer 缺失时 registerMemoryRoute 返回 null', registerMemoryRoute(undefined, memoryStateOf) === null);
  const noEffectRoutes = [];
  const returned = registerMemoryRoute({ register: (r) => noEffectRoutes.push(r) }, memoryStateOf);
  check('没传 effect 时直接注册并返回路由对象', returned?.path === MEMORY_ROUTE_PATH && noEffectRoutes.length === 1, String(returned?.path));
  check('webServer 缺失时 registerRevealRoute 返回 null', registerRevealRoute(undefined, {}) === null);
}

/* ------------------------------------------- 「打开目录」路由（写动作） */

section('「打开目录」路由');
{
  // 真库：确保 facts/decisions 都存在（路由要求目录存在，不存在回 404）
  const revealRoot = path.join(SANDBOX, 'reveal', 'memory');
  ensureLayout(revealRoot);

  const opened = [];
  const route = createRevealRoute({
    configRoot: revealRoot,
    open: (dir) => {
      opened.push(dir);
      return 'fake-opener';
    },
  });

  const ok = await callRoute(route, { body: JSON.stringify({ where: 'facts' }) });
  check('POST {where:facts} → 200 并真的调了系统打开', ok.status === 200 && ok.json.ok === true, JSON.stringify(ok.json));
  check('打开的是 <库>/facts 这个绝对目录', opened[0] === path.join(revealRoot, 'facts'), String(opened[0]));
  check('响应里回显开了哪个目录（客户端可提示）', ok.json.dir === path.join(revealRoot, 'facts'), String(ok.json.dir));

  const rootOpen = await callRoute(route, { body: JSON.stringify({ where: 'root' }) });
  check('where:root → 打开库根目录本身', rootOpen.status === 200 && opened[1] === revealRoot, String(opened[1]));

  const deflt = await callRoute(route, { body: '{}' });
  check('不传 where 默认开库根目录', deflt.status === 200 && deflt.json.dir === revealRoot, JSON.stringify(deflt.json));

  // 白名单：这条路由会启动系统文件管理器，绝不能接受任意路径
  const arbitrary = await callRoute(route, { body: JSON.stringify({ where: '..' }) });
  check('不在白名单里的目标一律 400', arbitrary.status === 400 && arbitrary.json.ok === false, JSON.stringify(arbitrary.json));
  check('路径穿越（..）被白名单挡下，没有把库外目录交出去', !opened.some((d) => !d.startsWith(revealRoot)), opened.join('|'));
  const absolute = await callRoute(route, { body: JSON.stringify({ where: 'C:\\Windows' }) });
  check('绝对路径不是合法目标（按目录名匹配）', absolute.status === 400, JSON.stringify(absolute.json));

  // 来源 / 方法 / body 三道前门与状态路由同一套
  const badOrigin = await callRoute(route, {
    body: JSON.stringify({ where: 'facts' }),
    headers: { host: '127.0.0.1:23278', origin: 'https://evil.example' },
  });
  check('跨站 Origin 一律 403', badOrigin.status === 403, JSON.stringify(badOrigin.json));
  const getMethod = await callRoute(route, { method: 'GET', url: MEMORY_REVEAL_PATH });
  check('GET 一律 405（这条路由只做动作）', getMethod.status === 405, JSON.stringify(getMethod.json));
  const badBody = await callRoute(route, { body: '{oops' });
  check('body 不是 JSON → 400', badBody.status === 400, JSON.stringify(badBody.json));

  // 目录不存在（例如还没 init 的库）→ 404，而不是"静默什么都没发生"
  const missing = await callRoute(createRevealRoute({ configRoot: path.join(SANDBOX, 'reveal-nope'), open: () => 'never' }), {
    body: JSON.stringify({ where: 'inbox' }),
  });
  check('目录不存在时 404 并说清是哪个目录', missing.status === 404 && String(missing.json.error).includes('不存在'), JSON.stringify(missing.json));

  // 没有 workspace 也没配 root → 400（不是 500）
  const noRoot = await callRoute(createRevealRoute({ open: () => 'never' }), { body: JSON.stringify({ where: 'facts' }) });
  check('不知道库在哪时 400 而不是 500', noRoot.status === 400, JSON.stringify(noRoot.json));

  // 配置关掉时明确拒绝（客户端会显示这句话，而不是"点了没反应"）
  const off = await callRoute(createRevealRoute({ configRoot: revealRoot, allow: false, open: () => 'never' }), {
    body: JSON.stringify({ where: 'facts' }),
  });
  check('allowOpenFolder:false → 403 + 说明原因', off.status === 403 && String(off.json.error).includes('allowOpenFolder'), JSON.stringify(off.json));

  // 解析函数本身（不看 HTTP 层）
  const dir = resolveRevealDir({ configRoot: revealRoot, where: 'decisions' });
  check('resolveRevealDir 拼出 <root>/decisions', dir.dir === path.join(revealRoot, 'decisions'), JSON.stringify(dir));
  const ws = resolveRevealDir({ workspace: path.join(SANDBOX, 'reveal'), where: 'inbox' });
  check('没配 root 时按 <workspace>/memory 解析', ws.dir === path.join(SANDBOX, 'reveal', 'memory', 'inbox'), JSON.stringify(ws));
}

/* ------------------------------------------------------------ 配置与容错 */

section('配置与容错');
{
  // enabled:false → 不注入（但工具仍在）
  const off = fakeCtx();
  apply(off, { enabled: false, root: ROOT });
  const agent = fakeAgent(cwdOfProject, 'session-off');
  const d = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
  const out = await off.handlers.get('agent/pre-step')({ agent, messages: [], step: 2 }, async () => d);
  check('enabled:false 时不注入', out === d, String(out.messages.length));
  check('enabled:false 时工具仍注册', off.registered.length === 2);

  // root 指向不存在的目录 → 不注入、不抛异常、**零告警噪音**
  const empty = fakeCtx();
  const emptyHook = apply(empty, { root: path.join(SANDBOX, 'nope', 'memory') });
  const agent2 = fakeAgent(path.join(SANDBOX, 'nope'), 'session-nope');
  const d2 = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
  const out2 = await empty.handlers.get('agent/pre-step')({ agent: agent2, messages: [], step: 2 }, async () => d2);
  check('记忆库不存在时不注入也不抛错', out2 === d2);
  // 连续跑两步：以前 due 字段漏在早退分支上时，每一步都会抛 TypeError 被 catch 成"加载失败"，
  // 于是这里会看到 2 条告警（`<= 1` 的旧阈值恰好放过了它）。现在必须**一条都没有**。
  const out2b = await empty.handlers.get('agent/pre-step')({ agent: agent2, messages: [], step: 3 }, async () => d2);
  check('记忆库不存在时第二步也不注入', out2b === d2, String(out2b.messages.length));
  check('记忆库不存在时连续两步零告警（早退分支字段齐全）', empty.warnings.length === 0, JSON.stringify(empty.warnings));

  // 直接钉住 planFor 的返回形状：任何返回路径上 due 都必须是数组。
  // （曾经早退分支漏了 due → 解构成 undefined → due.length 抛 TypeError 被 catch 成"加载失败"。）
  const planned = await emptyHook.planFor(agent2, [], d2);
  check('planFor 早退分支也返回 due 数组', Array.isArray(planned.due) && planned.due.length === 0, JSON.stringify(planned));
  check('planFor 早退分支的 plan/desired 为 null', planned.plan === null && planned.desired === null, JSON.stringify(planned).slice(0, 160));
  check('planFor 早退分支也返回 entries 数组', Array.isArray(planned.entries), JSON.stringify(planned).slice(0, 160));
  const plannedOk = await plugin.planFor(fakeAgent(cwdOfProject, 'session-plan'), [], { kind: 'ok', messages: [] });
  check('记忆库正常时 planFor 也返回 due 数组', Array.isArray(plannedOk.due), JSON.stringify(plannedOk).slice(0, 160));

  // 全新工作区：目录还不存在 —— memory_write 应该**按需创建**，而不是抛 ENOENT（真机预检抓到的）
  const freshRoot = path.join(SANDBOX, 'fresh', 'memory');
  const freshCtx = fakeCtx();
  apply(freshCtx, { root: freshRoot });
  const freshWrite = freshCtx.registered.find((t) => t.name === 'memory_write');
  const freshResult = await freshWrite.execute({ type: 'fact', conclusion: '新工作区里的第一条' }, { agent: fakeAgent(path.join(SANDBOX, 'fresh'), 'session-fresh') });
  check('新工作区里 memory_write 按需创建记忆库', fs.existsSync(path.join(freshRoot, 'inbox', `${freshResult.id}.md`)), freshResult.id);

  // 但**读路径不能有副作用**：只读取不该在用户每个工作区里都建出 memory/
  const readOnlyRoot = path.join(SANDBOX, 'readonly-probe', 'memory');
  const readCtx = fakeCtx();
  apply(readCtx, { root: readOnlyRoot });
  const agentRO = fakeAgent(path.join(SANDBOX, 'readonly-probe'), 'session-ro');
  const dRO = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
  await readCtx.handlers.get('agent/pre-step')({ agent: agentRO, messages: [], step: 2 }, async () => dRO);
  await readCtx.registered.find((t) => t.name === 'memory_search').execute({ query: 'x' }, { agent: agentRO });
  check('读路径不创建目录（无副作用）', !fs.existsSync(readOnlyRoot), readOnlyRoot);

  // enabled:false → 工具明确报错，而不是静默什么都不做
  const offCtx = fakeCtx();
  apply(offCtx, { enabled: false, root: ROOT });
  const offWrite = offCtx.registered.find((t) => t.name === 'memory_write');
  let threw = null;
  try {
    await offWrite.execute({ type: 'fact', conclusion: 'x' }, { agent: toolAgent });
  } catch (e) {
    threw = e;
  }
  check('enabled:false 时 memory_write 明确报错', !!threw, String(threw?.message));
}

rmrf(SANDBOX);
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
