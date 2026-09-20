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
import { createEntry, ensureLayout, injectPayload, promoteEntry, readAll, searchLibrary } from '../bin/mem.mjs';
import { MEMORY_ACTION_PATH, MEMORY_ROUTE_PATH, MEMORY_SEARCH_PATH, createActionRoute, createMemoryRoute, createSearchRoute, memoryStateOf, registerActionRoute, registerMemoryRoute, registerSearchRoute, resolvePanelRoot } from '../src/panel.mjs';
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
  // 给了 key 就用 key 当 id/文件名 —— 否则中文结论会被截成
  // `2026-09-20-模型只能写收件箱-防止错误结论被反复注入.md` 这种长名（库里真实发生过）
  check('带 key 写入时文件名就是 key（不再生成截断长名）', result.id === 'inbox-only' && fs.existsSync(path.join(L.inbox, 'inbox-only.md')), result.id);

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

/* --------------------------- 超预算：在**写入那一刻**就提醒（不占注入预算） */

section('超预算：memory_write 当场给一句可读告警');
{
  const tight = fakeCtx();
  const tightRoot = path.join(SANDBOX, 'tight-budget', 'memory');
  apply(tight, { root: tightRoot, maxBytes: 300 });
  const L2 = ensureLayout(tightRoot);
  const w = tight.registered.find((t) => t.name === 'memory_write');
  // 塞几条把预算撑破（结论首行都不短）
  for (let i = 0; i < 4; i += 1) {
    const c = createEntry(L2, { type: 'fact', conclusion: `第 ${i} 条占预算的结论：${'很长很长'.repeat(6)}`, key: `budget-${i}`, tags: [] });
    promoteEntry(L2, c.id);
  }
  const payloadNow = injectPayload(L2, 300);
  check('前置条件：预算已被撑破', payloadNow.overBudget === true, `${payloadNow.bytes} / 300`);

  const filled = await w.execute({ type: 'fact', conclusion: '再加一条' }, { agent: fakeAgent(path.join(SANDBOX, 'tight-budget'), 'session-budget') });
  check('超预算时 memory_write 带 budgetNote', typeof filled.budgetNote === 'string' && filled.budgetNote.includes('over by'), JSON.stringify(filled).slice(0, 170));
  check(
    'budgetNote 说清"超了多少 + 怎么处理"',
    /over by \d+/.test(String(filled.budgetNote)) && /archive|maxBytes/.test(String(filled.budgetNote)),
    String(filled.budgetNote).slice(0, 220),
  );
  check('带 budgetNote 的返回仍是无损 JSON', losslessError(filled) === null, losslessError(filled) ?? '');
  const renderedOver = w.output.render({}, filled)
    .map((b) => b.text)
    .join('');
  check('工具输出里也提醒了超预算', /WARNING: the standing memory is over/.test(renderedOver), renderedOver.slice(0, 200));

  // 预算宽裕的库：不带这个字段（省字节、不制造噪音）—— 换一个 ctx（config.root/maxBytes 不同）
  const roomyRoot = path.join(SANDBOX, 'roomy-budget', 'memory');
  ensureLayout(roomyRoot);
  const roomy = fakeCtx();
  apply(roomy, { root: roomyRoot, maxBytes: 4096 });
  const roomyWrite = roomy.registered.find((t) => t.name === 'memory_write');
  const loose = await roomyWrite.execute({ type: 'fact', conclusion: '不超预算' }, { agent: fakeAgent(path.join(SANDBOX, 'roomy-budget'), 'session-loose') });
  check('预算宽裕时不带 budgetNote（整条省掉）', !('budgetNote' in loose), JSON.stringify(loose).slice(0, 140));
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
  check('webServer 出现后注册了 3 条路由（状态 + 搜索 + 动作）', panelCtx.routes.length === 3, String(panelCtx.routes.length));
  const route = panelCtx.routes.find((r) => r.path === MEMORY_ROUTE_PATH) ?? panelCtx.routes[0];
  check('路由 kind 是 exact', route.kind === 'exact', String(route.kind));
  check('路由路径是 /dsh-memory-delta/state', route.path === MEMORY_ROUTE_PATH && route.path === '/dsh-memory-delta/state', String(route.path));
  const searchRoute = panelCtx.routes.find((r) => r.path === MEMORY_SEARCH_PATH);
  check('第二条路由是「搜索」', searchRoute?.path === '/dsh-memory-delta/search', panelCtx.routes.map((r) => r.path).join(','));
  const actionRoute = panelCtx.routes.find((r) => r.path === MEMORY_ACTION_PATH);
  check('第三条路由是「动作」（写记忆库）', actionRoute?.path === '/dsh-memory-delta/action', panelCtx.routes.map((r) => r.path).join(','));
  check(
    '没有「打开目录」路由了（按用户要求删掉按钮，也不留没人调用的外部进程入口）',
    !panelCtx.routes.some((r) => /reveal/.test(r.path)),
    panelCtx.routes.map((r) => r.path).join(','),
  );

  // 路径在**两处**各写了一遍（宿主 `src/panel.mjs`、客户端 `client/client.js`）——
  // 写歪一处就是"页签一直是空的"这种最难查的故障。这里直接把两边钉成同一个字符串。
  const clientSrc = fs.readFileSync(path.join(HERE, '..', 'client', 'client.js'), 'utf8');
  const clientUrl = /const STATE_URL = '([^']+)'/.exec(clientSrc)?.[1];
  check('客户端 fetch 的 URL 与宿主路由路径完全一致', clientUrl === MEMORY_ROUTE_PATH, `${clientUrl} vs ${MEMORY_ROUTE_PATH}`);
  const clientId = /id:\s*'([^']+)',\s*\n\s*factory:/.exec(clientSrc)?.[1];
  check('客户端 bundle 的 id 是包名 dsh-memory-delta', clientId === 'dsh-memory-delta', String(clientId));
  // 客户端必须用 POST —— 宿主路由只认 POST，用 GET 会得到 405（而且回退服务器也回 405，极易误判）
  check('客户端用 POST 请求这条路由', /fetch\(STATE_URL,\s*\{\s*\n\s*method:\s*'POST'/.test(clientSrc), 'client/client.js 里的 fetch 选项');
  check('路由通过 ctx.effect 托管（可随插件卸载）', panelCtx.effects.length === 3, JSON.stringify(panelCtx.effects));
  check('effect 带可读的标签（含新包名）', panelCtx.effects[0] === 'dsh-memory-delta: /dsh-memory-delta/state route', String(panelCtx.effects[0]));
  check('「搜索」路由也受 ctx.effect 托管', panelCtx.effects[1] === 'dsh-memory-delta: /dsh-memory-delta/search route', String(panelCtx.effects[1]));
  check('「动作」路由也受 ctx.effect 托管', panelCtx.effects[2] === 'dsh-memory-delta: /dsh-memory-delta/action route', String(panelCtx.effects[2]));

  // 服务早就就绪的组合（late=false）→ 回调立刻跑
  const earlyCtx = fakeCtxWithWebServer({ late: false });
  apply(earlyCtx, { root: ROOT, maxBytes: 3072 });
  check('webServer 早已就绪时也注册', earlyCtx.routes.length === 3, String(earlyCtx.routes.length));

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

  // 预算以"实际生效"的为准：插件 maxBytes 优先于库配置的 injectBudget
  //（踩过：面板原来只看库配置 → 显示的上限和真正生效的不一致，超预算告警会撒谎）
  {
    const budgetRoot = path.join(SANDBOX, 'budget-priority', 'memory');
    ensureLayout(budgetRoot);
    fs.writeFileSync(path.join(budgetRoot, 'memory.config.json'), JSON.stringify({ version: 1, injectBudget: 1234 }), 'utf8');
    check('没传 budget 时用库配置的 injectBudget', memoryStateOf({ configRoot: budgetRoot }).budget === 1234, String(memoryStateOf({ configRoot: budgetRoot }).budget));
    check(
      '传了 budget（插件 maxBytes）时以它为准',
      memoryStateOf({ configRoot: budgetRoot, budget: 4096 }).budget === 4096,
      String(memoryStateOf({ configRoot: budgetRoot, budget: 4096 }).budget),
    );
  }

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
}

/* ------------------------------- 工作区规范（在工作区内，可点「编辑」） */

section('「工作区规范」：AGENTS.md / AGENTS.local.md');
{
  const ws = path.join(SANDBOX, 'wsrules');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# 工作区记忆\n\n- 这个工作区的事\n', 'utf8');
  fs.writeFileSync(path.join(ws, 'AGENTS.local.md'), '# 私有层\n', 'utf8');

  const state = memoryStateOf({ configRoot: ROOT, workspace: ws });
  check('列出工作区里的两个规范文件', state.workspaceRules.length === 2, JSON.stringify(state.workspaceRules.map((r) => r.name)));
  check('带相对名 + 绝对 file（客户端要用它调 openFile）+ 字节数', state.workspaceRules.every((r) => r.name.endsWith('.md') && path.isAbsolute(r.file) && r.bytes > 0), JSON.stringify(state.workspaceRules));
  check('工作区规范是无损 JSON', losslessError(state.workspaceRules) === null, losslessError(state.workspaceRules) ?? '');

  // 只存在一个时只列一个
  fs.unlinkSync(path.join(ws, 'AGENTS.local.md'));
  check('只存在一个就只列一个', memoryStateOf({ configRoot: ROOT, workspace: ws }).workspaceRules.length === 1);
  fs.unlinkSync(path.join(ws, 'AGENTS.md'));
  check('一个都没有时是空数组（面板给空态）', memoryStateOf({ configRoot: ROOT, workspace: ws }).workspaceRules.length === 0);

  /**
   * 回归（真机踩到）：客户端 scope 里没有 cwd 时不发 workspace，这时必须退回**记忆库配置里的 scope** ——
   * 否则面板会显示"还没有 AGENTS.md"，而那个文件明明存在（假的空态）。
   */
  const scopedRoot = path.join(SANDBOX, 'wsrules-scoped');
  fs.mkdirSync(scopedRoot, { recursive: true });
  fs.writeFileSync(path.join(scopedRoot, 'AGENTS.md'), '# 有\n', 'utf8');
  fs.writeFileSync(path.join(scopedRoot, 'memory.config.json'), JSON.stringify({ scope: `workspace:${scopedRoot}` }), 'utf8');
  const viaScope = memoryStateOf({ configRoot: scopedRoot });
  check(
    '★ 请求里没有 workspace 时，用记忆库配置的 scope 找到工作区规范',
    viaScope.workspaceRules.length === 1 && viaScope.workspaceRules[0].name === 'AGENTS.md',
    JSON.stringify(viaScope.workspaceRules),
  );
}

/* ------------------------------- 「全局规范」（工作区外、DSH 注入的那份） */

section('「全局规范」：显示 DSH 的用户级指令文件（不是本插件注入的）');
{
  // 造一个假的 DSH_HOME：里面放一份 AGENTS.md
  const fakeHome = path.join(SANDBOX, 'dshhome');
  fs.mkdirSync(fakeHome, { recursive: true });
  const lines = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：全局规范内容`);
  fs.writeFileSync(path.join(fakeHome, 'AGENTS.md'), `# 全局记忆\n\n${lines.join('\n')}\n`, 'utf8');

  const state = memoryStateOf({ configRoot: ROOT, dshHome: fakeHome });
  check('状态里带 global 段', state.global && typeof state.global === 'object', JSON.stringify(state.global).slice(0, 120));
  check(
    'global.exists = true 且带字节/行数/修改时间',
    state.global.exists === true && state.global.bytes > 0 && state.global.lines > 0 && typeof state.global.mtime === 'string',
    JSON.stringify(state.global).slice(0, 160),
  );
  check(
    '只给**展示形式**的路径（绝对路径带用户名，截图会泄露）',
    state.global.displayPath === '~/.dsh/AGENTS.md' && !String(state.global.displayPath).includes('\\'),
    String(state.global.displayPath),
  );
  check('预览确实是文件内容', Array.isArray(state.global.preview) && state.global.preview.some((l) => l.includes('全局记忆')), JSON.stringify(state.global.preview.slice(0, 2)));
  check(
    '预览有行数上限（不把整篇塞进 state）',
    state.global.preview.length <= 40 && state.global.truncated === true,
    `${state.global.preview.length} / truncated=${state.global.truncated}`,
  );
  check('响应仍然是无损 JSON', losslessError(state) === null, losslessError(state) ?? '');

  // 文件不存在时也要有结构（面板显示"还没有这份文件"）
  const none = memoryStateOf({ configRoot: ROOT, dshHome: path.join(SANDBOX, 'no-dshhome') });
  check('没有这份文件时 exists=false 且不抛错', none.global.exists === false && none.global.preview.length === 0, JSON.stringify(none.global).slice(0, 120));

  // 记忆库不存在（全新工作区）时也要带上 global —— 它跟库在不在没关系
  const emptyWs = memoryStateOf({ workspace: path.join(SANDBOX, 'no-such-ws'), dshHome: fakeHome });
  check('记忆库不存在时也带 global', emptyWs.global && emptyWs.global.exists === true, JSON.stringify(emptyWs.global).slice(0, 120));

  // 本库里的源文件（改完要同步过去的那份）
  fs.writeFileSync(path.join(ROOT, 'global-AGENTS.md'), '# 全局记忆（源）\n', 'utf8');
  const withSource = memoryStateOf({ configRoot: ROOT, dshHome: fakeHome });
  check(
    '显示本库源文件 global-AGENTS.md',
    withSource.global.source?.name === 'global-AGENTS.md' && withSource.global.source.bytes > 0,
    JSON.stringify(withSource.global.source),
  );
  fs.unlinkSync(path.join(ROOT, 'global-AGENTS.md'));
}

/* ------------------------------------- 「搜索」路由（与 CLI / 工具同一份实现） */

section('「搜索」路由');
{
  const searchRoot = path.join(SANDBOX, 'search', 'memory');
  const SL = ensureLayout(searchRoot);
  createEntry(SL, { type: 'fact', conclusion: '沙箱禁止命名管道：捕获子进程输出会 EPERM', key: 'sandbox-no-pipe', tags: ['sandbox'], source: 's' });
  createEntry(SL, { type: 'fact', conclusion: '路径含非 ASCII 时 fs.rmSync 会静默失败', key: 'node-rm-nonascii', tags: ['node'], source: 's' });
  fs.writeFileSync(
    path.join(searchRoot, 'journal.md'),
    '# 流水\n\n2026-09-20 今天在讨论把面板接上检索，复用 rankDocs。\n',
    'utf8',
  );

  const route = createSearchRoute({ configRoot: searchRoot });

  // 中文连写（不手动空格）必须命中 —— 这是老实现必然落空的地方
  const zh = await callRoute(route, { body: JSON.stringify({ query: '沙箱禁管道' }) });
  check('中文连写查询命中', zh.status === 200 && zh.json.total >= 1, JSON.stringify(zh.json).slice(0, 200));
  check('命中的是那条事实', zh.json.matches.some((m) => m.id === 'sandbox-no-pipe'), JSON.stringify(zh.json.matches.map((m) => m.id)));
  check('每条命中带 file（面板点一下就要能打开）', zh.json.matches.every((m) => typeof m.file === 'string' && path.isAbsolute(m.file)), JSON.stringify(zh.json.matches.map((m) => m.file)));
  check(
    'file 指向真实存在的文件',
    zh.json.matches.every((m) => fs.existsSync(m.file)),
    zh.json.matches.map((m) => m.file).join('|'),
  );
  check('带 score / snippet / matched（界面要显示相关度与片段）', zh.json.matches.every((m) => typeof m.score === 'number' && typeof m.snippet === 'string' && Array.isArray(m.matched)), JSON.stringify(zh.json.matches[0]));
  check('结果是无损 JSON', losslessError(zh.json) === null, losslessError(zh.json) ?? '');

  // 英文标识符 + 流水层
  const en = await callRoute(route, { body: JSON.stringify({ query: 'rmsync' }) });
  check('英文标识符命中', en.json.matches.some((m) => m.id === 'node-rm-nonascii'), JSON.stringify(en.json.matches.map((m) => m.id)));
  const journalHit = await callRoute(route, { body: JSON.stringify({ query: 'rankDocs' }) });
  check('流水层也能搜到（面板搜索不只是条目）', journalHit.json.matches.some((m) => m.where === 'journal'), JSON.stringify(journalHit.json.matches.map((m) => m.where)));
  const noHit = await callRoute(route, { body: JSON.stringify({ query: '数据库迁移' }) });
  check('无关关键词零命中（不会瞎给结果）', noHit.status === 200 && noHit.json.total === 0, JSON.stringify(noHit.json).slice(0, 160));

  // 「只有一份实现」这件事要能被测试钉住：
  //   ① 路由的结果 === searchLibrary(...) 的结果（同一个库、同一条 query）
  //   ② 插件源码里 memory_search 用的是 searchLibrary，且**不再**自己拼 collectDocs + rankDocs
  const shared = searchLibrary(SL, { query: '沙箱禁管道', maxLen: 240 });
  check(
    '面板搜索就是 searchLibrary 的输出（没有第二份实现）',
    JSON.stringify(shared.matches.map((m) => m.id)) === JSON.stringify(zh.json.matches.map((m) => m.id)),
    `${JSON.stringify(shared.matches.map((m) => m.id))} vs ${JSON.stringify(zh.json.matches.map((m) => m.id))}`,
  );
  const pluginSrc = fs.readFileSync(path.join(HERE, '..', 'src', 'plugin.mjs'), 'utf8');
  check('memory_search 工具复用 searchLibrary', /searchLibrary\(store\.L/.test(pluginSrc), 'plugin.mjs 里的检索调用');
  check('插件里没有第二份"collectDocs + rankDocs"拼装', !/rankDocs\s*\(/.test(pluginSrc), 'plugin.mjs 不该直接调 rankDocs');

  // where 白名单 + 空查询 + 三道前门
  const scoped = await callRoute(route, { body: JSON.stringify({ query: 'rankDocs', where: 'facts' }) });
  check('where 限定层生效（facts 里搜不到流水那句）', scoped.json.total === 0, JSON.stringify(scoped.json).slice(0, 160));
  const badWhere = await callRoute(route, { body: JSON.stringify({ query: 'x', where: 'nope' }) });
  check('不在白名单的 where → 400（不是静默零结果）', badWhere.status === 400 && /不认识的 where/.test(String(badWhere.json.error)), String(badWhere.json.error).slice(0, 120));
  const empty = await callRoute(route, { body: JSON.stringify({ query: '   ' }) });
  check('空查询 → 400', empty.status === 400 && /缺少 query/.test(String(empty.json.error)), String(empty.json.error));
  const crossSite = await callRoute(route, { body: JSON.stringify({ query: 'x' }), headers: { host: '127.0.0.1:23278', origin: 'https://evil.example' } });
  check('跨站 Origin → 403', crossSite.status === 403, String(crossSite.status));
  const getMethod = await callRoute(route, { method: 'GET', url: MEMORY_SEARCH_PATH });
  check('GET → 405', getMethod.status === 405, String(getMethod.status));

  // 注册函数
  check('webServer 缺失时 registerSearchRoute 返回 null', registerSearchRoute(undefined, {}) === null);
  const registered = [];
  const returned = registerSearchRoute({ register: (r) => registered.push(r) }, { configRoot: searchRoot });
  check('没传 effect 时直接注册并返回路由对象', returned?.path === MEMORY_SEARCH_PATH && registered.length === 1, String(returned?.path));
}

/* ------------------------------------- 「动作」路由（真的写记忆库） */

section('「动作」路由（promote / rename）');
{
  const actionRoot = path.join(SANDBOX, 'action', 'memory');
  const L = ensureLayout(actionRoot);
  const route = createActionRoute({ configRoot: actionRoot });

  // ① 收件箱提升：面板按钮对应的就是这一步
  const candidate = createEntry(L, { type: 'fact', conclusion: '面板提升按钮应当复用 CLI 的实现', key: 'panel-promote', tags: ['panel'] });
  check('候选先落在 inbox/', fs.existsSync(path.join(L.inbox, `${candidate.id}.md`)), candidate.id);

  const promoted = await callRoute(route, { body: JSON.stringify({ op: 'promote', id: candidate.id }) });
  check('promote → 200', promoted.status === 200 && promoted.json.ok === true, JSON.stringify(promoted.json));
  check('响应说明提到哪个目录', promoted.json.target === 'facts', JSON.stringify(promoted.json));
  check('文件真的从 inbox/ 移到 facts/', fs.existsSync(path.join(L.facts, `${candidate.id}.md`)) && !fs.existsSync(path.join(L.inbox, `${candidate.id}.md`)), candidate.id);
  check('提升后的条目带 active 状态、能进注入载荷', injectPayload(L, 3072).entries.some((e) => e.id === candidate.id), candidate.id);

  // ② 同一个 key 上已有 active 条目 → 拒绝（且**宿主不能退出进程**：
  //    这正是 promoteEntry 必须"抛异常"而不是 fail() 的原因，走了 fail 这个测试进程会直接死）
  const clash = createEntry(L, { type: 'fact', conclusion: '同一个 key 的第二条真相', key: 'panel-promote', tags: [] });
  const refused = await callRoute(route, { body: JSON.stringify({ op: 'promote', id: clash.id }) });
  check('key 撞车 → 400 而不是崩溃', refused.status === 400, String(refused.status));
  check('拒绝理由说清是哪个 key 撞了', /panel-promote/.test(String(refused.json.error)) && /一个 key 只能有一个真相/.test(String(refused.json.error)), String(refused.json.error).slice(0, 120));
  check('拒绝之后文件仍在 inbox/（没有半途改动）', fs.existsSync(path.join(L.inbox, `${clash.id}.md`)), clash.id);

  // ③ 安全改名
  const renamed = await callRoute(route, { body: JSON.stringify({ op: 'rename', id: candidate.id, to: 'panel-promote-renamed' }) });
  check('rename → 200', renamed.status === 200 && renamed.json.to === 'panel-promote-renamed', JSON.stringify(renamed.json));
  check('文件名与 frontmatter 的 id 一起改了', fs.existsSync(path.join(L.facts, 'panel-promote-renamed.md')) && readAll(L).some((e) => e.id === 'panel-promote-renamed'), JSON.stringify(renamed.json));
  const renameClash = await callRoute(route, { body: JSON.stringify({ op: 'rename', id: 'panel-promote-renamed', to: clash.id }) });
  check('改成已存在的 id → 400', renameClash.status === 400 && /已被占用/.test(String(renameClash.json.error)), String(renameClash.json.error));
  const renameIllegal = await callRoute(route, { body: JSON.stringify({ op: 'rename', id: 'panel-promote-renamed', to: 'a b' }) });
  check('非法名字 → 400', renameIllegal.status === 400 && /非法字符/.test(String(renameIllegal.json.error)), String(renameIllegal.json.error));

  // ④ 白名单：不做"通用改写"后门
  const unknownOp = await callRoute(route, { body: JSON.stringify({ op: 'delete', id: candidate.id }) });
  check('不在白名单的 op 一律 400（没有通用删改后门）', unknownOp.status === 400 && /不认识的 op/.test(String(unknownOp.json.error)), String(unknownOp.json.error));
  check('未知 op 不会碰文件', readAll(L).some((e) => e.id === 'panel-promote-renamed'), 'entry survived');
  const noId = await callRoute(route, { body: JSON.stringify({ op: 'promote' }) });
  check('缺 id → 400', noId.status === 400 && /缺少 id/.test(String(noId.json.error)), String(noId.json.error));

  // ⑤ 双向：demote（常驻 → 候选）与 remove（只删候选）
  const demoted = await callRoute(route, { body: JSON.stringify({ op: 'demote', id: 'panel-promote-renamed' }) });
  check(
    'demote → 200 且说明从哪层回到哪层',
    demoted.status === 200 && demoted.json.from === 'facts' && demoted.json.target === 'inbox',
    JSON.stringify(demoted.json),
  );
  check('文件真的回到 inbox/', fs.existsSync(path.join(L.inbox, 'panel-promote-renamed.md')) && !fs.existsSync(path.join(L.facts, 'panel-promote-renamed.md')), 'moved');
  check('撤回后不再参与注入', !injectPayload(L, 3072).entries.some((e) => e.id === 'panel-promote-renamed'));
  const demoteAgain = await callRoute(route, { body: JSON.stringify({ op: 'demote', id: 'panel-promote-renamed' }) });
  check('对候选再 demote → 400 且说清原因', demoteAgain.status === 400 && /已经在 inbox/.test(String(demoteAgain.json.error)), String(demoteAgain.json.error));

  const removed = await callRoute(route, { body: JSON.stringify({ op: 'remove', id: 'panel-promote-renamed' }) });
  check('remove → 200', removed.status === 200 && removed.json.ok === true, JSON.stringify(removed.json));
  check('候选文件被删掉', !fs.existsSync(path.join(L.inbox, 'panel-promote-renamed.md')), 'deleted');
  const keepStanding = createEntry(L, { type: 'fact', conclusion: '常驻条目不能直接删', key: 'keep-standing', tags: [] });
  promoteEntry(L, keepStanding.id);
  const removeStanding = await callRoute(route, { body: JSON.stringify({ op: 'remove', id: keepStanding.id }) });
  check(
    'remove 拒绝删常驻条目（避免静默消失）',
    removeStanding.status === 400 && /只能删除 inbox/.test(String(removeStanding.json.error)),
    JSON.stringify(removeStanding.json),
  );
  check('拒绝之后常驻文件还在', fs.existsSync(path.join(L.facts, `${keepStanding.id}.md`)), keepStanding.id);

  // ⑥ 归档（不再适用）与取回
  const archived = await callRoute(route, { body: JSON.stringify({ op: 'archive', id: keepStanding.id }) });
  check('archive → 200 且 status=expired', archived.status === 200 && archived.json.status === 'expired', JSON.stringify(archived.json));
  check('文件搬进 archive/', fs.existsSync(path.join(L.archive, `${keepStanding.id}.md`)) && !fs.existsSync(path.join(L.facts, `${keepStanding.id}.md`)), 'moved');
  const restored = await callRoute(route, { body: JSON.stringify({ op: 'restore', id: keepStanding.id }) });
  check('restore → 200 且回到 inbox', restored.status === 200 && restored.json.from === 'archive' && restored.json.target === 'inbox', JSON.stringify(restored.json));
  check('取回后文件在 inbox/', fs.existsSync(path.join(L.inbox, `${keepStanding.id}.md`)), 'restored');
  const restoreAgain = await callRoute(route, { body: JSON.stringify({ op: 'restore', id: keepStanding.id }) });
  check('对非归档条目 restore → 400', restoreAgain.status === 400 && /只有归档里的条目/.test(String(restoreAgain.json.error)), String(restoreAgain.json.error));

  // ⑥ 来源与配置开关
  const crossSite = await callRoute(route, { body: JSON.stringify({ op: 'promote', id: 'x' }), headers: { host: '127.0.0.1:23278', origin: 'https://evil.example' } });
  check('跨站 Origin → 403', crossSite.status === 403, String(crossSite.status));
  const getMethod = await callRoute(route, { method: 'GET', url: MEMORY_ACTION_PATH });
  check('GET → 405', getMethod.status === 405, String(getMethod.status));
  const writeOff = await callRoute(createActionRoute({ configRoot: actionRoot, allow: false }), { body: JSON.stringify({ op: 'promote', id: 'x' }) });
  check('allowWrite:false → 403 + 说明原因', writeOff.status === 403 && /allowWrite/.test(String(writeOff.json.error)), String(writeOff.json.error));

  // ⑥ workspace 解析（没配 root 时按 <workspace>/memory）
  const wsRoute = createActionRoute({});
  const wsCandidate = createEntry(ensureLayout(path.join(SANDBOX, 'action2', 'memory')), {
    type: 'decision',
    conclusion: '按 workspace 解析记忆库',
    key: 'ws-resolve',
    tags: [],
  });
  const byWorkspace = await callRoute(wsRoute, { body: JSON.stringify({ op: 'promote', id: wsCandidate.id, workspace: path.join(SANDBOX, 'action2') }) });
  check('没配 root 时按 workspace 解析到 <workspace>/memory', byWorkspace.status === 200 && byWorkspace.json.target === 'decisions', JSON.stringify(byWorkspace.json));
  const noRoot = await callRoute(createActionRoute({}), { body: JSON.stringify({ op: 'promote', id: 'x' }) });
  check('既没 root 也没 workspace → 400 而不是 500', noRoot.status === 400, JSON.stringify(noRoot.json));

  // 注册函数
  check('webServer 缺失时 registerActionRoute 返回 null', registerActionRoute(undefined, {}) === null);
  const registered = [];
  const returned = registerActionRoute({ register: (r) => registered.push(r) }, { configRoot: actionRoot });
  check('没传 effect 时直接注册并返回路由对象', returned?.path === MEMORY_ACTION_PATH && registered.length === 1, String(returned?.path));
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
