#!/usr/bin/env node
/**
 * 记忆插件「接线逻辑」的测试 —— 用**假的 agent / decision** 模拟 DSH 的 pre-step 合约，
 * 因此在没有 DSH 的环境里也能完整验证插件行为（这是刻意的设计：决策逻辑与 DSH 解耦）。
 *
 * 跑：node test/hook-tests.mjs
 */

import { createMemoryHook, isMemoryMessage, sameMemoryPayload } from '../src/hook.mjs';
import { renderDue } from '../src/due.mjs';
import { MEMORY_PLUGIN_ID, memorySource } from '../src/planner.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (t) => console.log(`\n${t}`);

/* -------------------------------------------------------------- 假 DSH */

let seq = 0;
/** 与真实插件同形：source 由 planner.mjs 的 memorySource() 构造（不带状态 —— 状态走侧车） */
function fakeCreateMessage(text) {
  seq += 1;
  return {
    id: `mem-${seq}`,
    content: [{ type: 'text', text }],
    source: memorySource(),
  };
}

const SESSION_ID = 'session-test';

function fakeAgent(cwd = 'D:\\proj', id = SESSION_ID) {
  const nextStep = [];
  return {
    session: { header: { cwd, id } },
    inbox: {
      nextStep,
      prepend(queue, message) {
        if (queue !== 'next-step') throw new Error(`unexpected queue: ${queue}`);
        nextStep.unshift(message);
      },
      replace(id, message) {
        const i = nextStep.findIndex((m) => m.id === id);
        if (i < 0) throw new Error(`replace: id not found: ${id}`);
        nextStep[i] = message;
      },
      remove(id) {
        const i = nextStep.findIndex((m) => m.id === id);
        if (i >= 0) nextStep.splice(i, 1);
      },
    },
  };
}

const entry = (id, hash, extra = {}) => ({ id, hash, type: 'fact', key: null, line: `结论 ${id}`, ...extra });

/**
 * 造一个 hook；payload（条目集合）可以在测试中途改。
 *
 * 差分状态从 v1.3.1 起走**侧车**（`loadState`/`saveState`）。测试用一张 Map 当侧车，
 * 用 `seedState()` 模拟"上一轮已经注入过"。
 */
function makeHook(entriesRef, { logger = { warn() {} }, nudgeAfterTurns = 99, today, dueWithin, states = new Map() } = {}) {
  return createMemoryHook({
    loadPayload: async () => ({ entries: entriesRef.current, budget: 3072 }),
    createMessage: fakeCreateMessage,
    loadState: async (sessionId) => (sessionId && states.has(sessionId) ? states.get(sessionId) : null),
    saveState: async (sessionId, payload) => {
      if (sessionId) states.set(sessionId, payload);
    },
    logger,
    // 默认把蒸馏提醒关掉（设很大），免得干扰别的用例；提醒本身有专门的测试段
    nudgeAfterTurns,
    // 到期判断也注入"今天"，否则测试结果会随运行日期漂移
    ...(today ? { today } : {}),
    ...(dueWithin === undefined ? {} : { dueWithin }),
  });
}

/** 模拟"上一轮已经注入过这些条目"：把状态塞进侧车。 */
function seedState(states, state, extra = {}) {
  states.set(SESSION_ID, { state, ...extra });
}

/* --------------------------------------------------- 第一次：路走到 inbox */
section('step 1（本步还没开始）→ 只排队进 inbox');
{
  const entries = { current: [entry('a', 'h1')] };
  const states = new Map();
  const hook = makeHook(entries, { states });
  const agent = fakeAgent();
  const messages = [];
  const decision = { kind: 'ok', messages: [] };

  const out = await hook.handlePreStep({ agent, messages, step: 1 }, async () => decision);
  check('decision 原样返回（本步不动它）', out === decision);
  check('消息进了 inbox', agent.inbox.nextStep.length === 1);
  check('进的是我们的消息', isMemoryMessage(agent.inbox.nextStep[0]));
  check('内容是全量 baseline', agent.inbox.nextStep[0].content[0].text.includes('结论 a'));
  check('source 是合法 v4 来源（生产者自有 kind，只有 kind 一个键）', agent.inbox.nextStep[0].source.kind === `plugin:${MEMORY_PLUGIN_ID}` && Object.keys(agent.inbox.nextStep[0].source).length === 1, JSON.stringify(agent.inbox.nextStep[0].source));
  // 第 1 步只是排队（还没进上下文）→ 状态**不能**落盘，否则"排队后又被清掉"会永久丢一批注入
  check('排队阶段不落盘', states.get(SESSION_ID) === undefined, JSON.stringify(states.get(SESSION_ID)));
}

/* ------------------------------------------- 第二次：没有变化 → 什么都不做 */
section('第二轮（记忆没变化）→ 零注入');
{
  const entries = { current: [entry('a', 'h1')] };
  const states = new Map();
  seedState(states, { a: 'h1' });                  // 侧车：上一轮注入的就是当前这份
  const hook = makeHook(entries, { states });
  const agent = fakeAgent();
  const previous = fakeCreateMessage('whatever');
  const messages = [previous];
  const decision = { kind: 'ok', messages: [previous] };

  agent.inbox.nextStep.push(fakeCreateMessage('陈旧排队'));
  const out = await hook.handlePreStep({ agent, messages, step: 2 }, async () => decision);
  check('没有新消息被插入', out.messages.length === decision.messages.length, JSON.stringify(out.messages.length));
  check('陈旧的排队消息被清掉', agent.inbox.nextStep.length === 0, `剩 ${agent.inbox.nextStep.length}`);
}

/* ------------------------------------------------- 第二轮：有变化 → 只推差异 */
section('第二轮（记忆变了）→ 只注入变化块，且插在已领取消息之后');
{
  const entries = { current: [entry('a', 'h1'), entry('b', 'h2')] };
  const states = new Map();
  seedState(states, { a: 'h1' });                  // 侧车：上一轮只有 a
  const hook = makeHook(entries, { states });
  const agent = fakeAgent();
  const prev = fakeCreateMessage('旧的全量');
  const claimed = [{ id: 'user-1', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, prev];
  const decision = { kind: 'ok', messages: [...claimed] };

  const out = await hook.handlePreStep({ agent, messages: claimed, step: 2 }, async () => decision);
  check('插入了 1 条新消息', out.messages.length === claimed.length + 1, String(out.messages.length));
  const inserted = out.messages.find((m) => isMemoryMessage(m) && m !== prev);
  check('插入的是记忆消息', !!inserted);
  check('插入位置在最后一条已领取消息之后', out.messages.indexOf(inserted) === out.messages.indexOf(prev) + 1, `at ${out.messages.indexOf(inserted)} vs prev ${out.messages.indexOf(prev)}`);
  check('内容是 delta（含"新增"）', /新增：/.test(inserted.content[0].text), inserted.content[0].text.slice(0, 80));
  check('delta 不复述未变化条目', !inserted.content[0].text.includes('结论 a'));
  check('source 是合法 v4 来源（不带状态）', inserted.source.kind === `plugin:${MEMORY_PLUGIN_ID}` && Object.keys(inserted.source).length === 1, JSON.stringify(inserted.source));
  // 新语义：这一步只是"插进 decision"，状态要等它真的进了上下文（下一次 pre-step 可见）才落盘 ——
  // 否则"排队后又被清掉"的消息会让状态虚增、模型永久少看一批记忆。
  check('还没落盘（可见后才记账）', states.get(SESSION_ID)?.state?.b === undefined, JSON.stringify(states.get(SESSION_ID)));
  const dVisible = { kind: 'ok', messages: [...out.messages] };
  await hook.handlePreStep({ agent, messages: out.messages, step: 3 }, async () => dVisible);
  check('真的进了上下文之后把状态落盘', JSON.stringify(states.get(SESSION_ID)?.state) === JSON.stringify({ a: 'h1', b: 'h2' }), JSON.stringify(states.get(SESSION_ID)));
}

/* --------------------------------------------------------- 重复调用的幂等 */
section('同一步里 pre-step 再次触发 → 不重复插入');
{
  const entries = { current: [entry('a', 'h1')] };
  const states = new Map();
  seedState(states, { a: 'h1' });
  const hook = makeHook(entries, { states });
  const agent = fakeAgent();
  const mine = fakeCreateMessage('已注入');
  const claimed = [{ id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }];
  const decision = { kind: 'ok', messages: [...claimed, mine] };

  const out = await hook.handlePreStep({ agent, messages: claimed, step: 3 }, async () => decision);
  check('没有插入第二条', out.messages.length === decision.messages.length, String(out.messages.length));
}

/* ------------------------------------------------------- reject / 空记忆库 */
section('边界：reject 决策、空记忆库、加载失败');
{
  // reject → 只走 inbox
  const entries = { current: [entry('a', 'h1')] };
  {
    const hook = makeHook(entries);
    const agent = fakeAgent();
    const decision = { kind: 'reject', messages: [] };
    const out = await hook.handlePreStep({ agent, messages: [], step: 2 }, async () => decision);
    check('reject 时 decision 不变', out === decision);
    check('reject 时消息仍进 inbox', agent.inbox.nextStep.length === 1, String(agent.inbox.nextStep.length));
  }

  // 记忆库为空 → 清掉排队，不注入
  {
    const hook = makeHook({ current: [] });
    const agent = fakeAgent();
    agent.inbox.nextStep.push(fakeCreateMessage('陈旧', [{ id: 'x', hash: 'h' }]));
    const decision = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
    const out = await hook.handlePreStep({ agent, messages: [], step: 2 }, async () => decision);
    check('空记忆库不注入', out.messages.length === 1);
    check('空记忆库清掉陈旧排队', agent.inbox.nextStep.length === 0);
  }

  // 加载失败 → 记日志 + 放行
  {
    const warned = [];
    const hook = createMemoryHook({
      loadPayload: async () => {
        throw new Error('磁盘炸了');
      },
      createMessage: fakeCreateMessage,
      logger: { warn: (...a) => warned.push(a[0]) },
    });
    const agent = fakeAgent();
    const decision = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
    const out = await hook.handlePreStep({ agent, messages: [], step: 2 }, async () => decision);
    check('加载失败时 decision 原样返回', out === decision);
    check('加载失败被记录', warned.length === 1, JSON.stringify(warned));
  }
}

/* ----------------------------------------------------------- 会话恢复场景 */
section('会话恢复 / 回放：状态从侧车恢复');
{
  const entries = { current: [entry('a', 'h1')] };
  const states = new Map();
  seedState(states, { a: 'h1' });                 // 侧车：这个会话上一轮已经注入过 a
  const hook = makeHook(entries, { states });
  const agent = fakeAgent();
  // 表面上仍留着我们发过的消息（用来认"自己人"），但状态以侧车为准
  agent.session.surface = { nodes: [1, 2] };
  agent.session.eventAt = (seq) =>
    seq === 1 ? { type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } } : { type: 'user/message', data: fakeCreateMessage('之前注入过的全量') };

  const decision = { kind: 'ok', messages: [{ id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }] };
  const out = await hook.handlePreStep({ agent, messages: [], step: 5 }, async () => decision);
  check('恢复后（侧车有状态）不重复注入', out.messages.length === 1, String(out.messages.length));
  check('恢复时 decision 原样返回', out === decision);

  // 侧车里的状态是旧的 → 应该只推差异
  const agent2 = fakeAgent();
  const states2 = new Map();
  seedState(states2, { a: 'STALE' });
  const entries2 = { current: [entry('a', 'h1')] };
  const hook2 = makeHook(entries2, { states: states2 });
  const d2 = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
  const out2 = await hook2.handlePreStep({ agent: agent2, messages: [], step: 5 }, async () => d2);
  check('侧车状态陈旧 → 推差异而不是全量', out2.messages.length === 2 && /已更新：/.test(out2.messages[1].content[0].text), out2.messages.map((m) => m.content[0].text.slice(0, 20)).join(' | '));
}

/* --------------------------------------------------------- 到期复核提醒 */
section('到期复核（verify_when）：会话内提醒一次，且绝不污染差分状态');
{
  const steady = fakeCreateMessage('全量');
  const userTurn = { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] };

  // ① 一条已到期的条目 → 零注入的那一轮发出 due 提醒
  {
    // 记忆没变化（previous 与当前一致）→ plan 是 none，正好是到期提醒该出场的时机
    const entries = { current: [entry('a', 'h1', { date: '2026-01-01', verifyWhen: '2026-01-10', line: '该复核的结论' })] };
    const states = new Map();
    seedState(states, { a: 'h1' });               // 提醒只在"零注入"的那一轮出场
    const hook = makeHook(entries, { today: () => '2026-03-01', states });
    const agent = fakeAgent();
    const claimed = [userTurn, steady];
    const decision = { kind: 'ok', messages: [...claimed] };

    const out = await hook.handlePreStep({ agent, messages: claimed, step: 2 }, async () => decision);
    check('零注入的那一轮插入了到期提醒', out.messages.length === decision.messages.length + 1, String(out.messages.length));
    const dueMsg = out.messages.find((m) => m !== steady && /已超期/.test(m.content?.[0]?.text ?? ''));
    check('提醒消息按文案能认出来', !!dueMsg, JSON.stringify(out.messages.map((m) => m.content[0].text.slice(0, 24))));
    // 关键回归：提醒的 source 必须是 v4 的**生产者自有 kind**（非空、≠'plugin'），不带任何状态
    check('提醒的 source 是生产者自有 kind', dueMsg && dueMsg.source.kind === `plugin:${MEMORY_PLUGIN_ID}` && Object.keys(dueMsg.source).length === 1, JSON.stringify(dueMsg?.source));
    check('提醒文案含结论正文', !!dueMsg && dueMsg.content[0].text.includes('该复核的结论'), dueMsg?.content[0].text.slice(0, 120));
    check('提醒文案含「已超期」', !!dueMsg && /已超期 \d+ 天/.test(dueMsg.content[0].text), dueMsg?.content[0].text.slice(0, 200));
    check('提醒插在已领取消息之后', out.messages.indexOf(dueMsg) === decision.messages.length, String(out.messages.indexOf(dueMsg)));

    // ② 下一步：会话里已经能看到这条提醒 → 不再重复
    const visible = [...out.messages];
    const d2 = { kind: 'ok', messages: [...visible] };
    const out2 = await hook.handlePreStep({ agent, messages: visible, step: 3 }, async () => d2);
    check('同一会话不重复提醒', out2.messages.length === d2.messages.length, String(out2.messages.length));
    check('不重复时 decision 原样返回', out2 === d2);

    // ③ 关键回归：提醒之后差分状态没被清零（下一轮不能全量重灌）
    const d3 = { kind: 'ok', messages: [...visible] };
    const out3 = await hook.handlePreStep({ agent, messages: visible, step: 4 }, async () => d3);
    check('提醒之后不触发全量重灌', out3 === d3, `len=${out3.messages.length}`);
  }

  // 会话恢复 / 回放：提醒已落在会话表面上 → 从可见消息里认出来，不再提醒
  {
    const entries = { current: [entry('a', 'h1', { date: '2026-01-01', verifyWhen: '2026-01-10', line: '该复核的结论' })] };
    const states = new Map();
    seedState(states, { a: 'h1' }, { dueNotified: true });   // 侧车：这个会话已经提醒过了
    const hook = makeHook(entries, { today: () => '2026-03-01', states });
    const agent = fakeAgent();
    agent.session.surface = { nodes: [1] };
    agent.session.eventAt = (s) => (s === 1 ? { type: 'user/message', data: userTurn } : undefined);

    const decision = { kind: 'ok', messages: [fakeCreateMessage('全量')] };
    const out = await hook.handlePreStep({ agent, messages: [], step: 6 }, async () => decision);
    check('会话恢复场景：侧车记着提醒过 → 不重复', out === decision, String(out.messages.length));
  }

  // ④ 没有到期条目 → 什么都不注入
  {
    const entries = { current: [entry('a', 'h1', { date: '2026-01-01', verifyWhen: '2099-01-01' })] };
    const states = new Map();
    seedState(states, { a: 'h1' });               // 零注入的前提：状态已是最新
    const hook = makeHook(entries, { today: () => '2026-03-01', states });
    const agent = fakeAgent();
    const claimed = [userTurn, steady];
    const decision = { kind: 'ok', messages: [...claimed] };
    const out = await hook.handlePreStep({ agent, messages: claimed, step: 2 }, async () => decision);
    check('未到期的 verify_when 不提醒', out === decision, String(out.messages.length));
  }

  // 没写 verify_when 的条目当然也不提醒
  {
    const entries = { current: [entry('a', 'h1')] };
    const states = new Map();
    seedState(states, { a: 'h1' });
    const hook = makeHook(entries, { today: () => '2026-03-01', states });
    const agent = fakeAgent();
    const claimed = [userTurn, steady];
    const decision = { kind: 'ok', messages: [...claimed] };
    const out = await hook.handlePreStep({ agent, messages: claimed, step: 2 }, async () => decision);
    check('没写 verify_when 的条目不提醒', out === decision);
  }

  // 回归：verify_when 写成**人话**（算不出日期）时绝不触发提醒。
  // 否则一条 `verify_when: 等换机器时` 会让每个会话都弹一次、而且用户怎么改都消不掉。
  {
    const entries = { current: [entry('a', 'h1', { date: '2026-01-01', verifyWhen: '等换机器时', line: '等换机器再说' })] };
    const states = new Map();
    seedState(states, { a: 'h1' });
    const hook = makeHook(entries, { today: () => '2026-03-01', states });
    const agent = fakeAgent();
    const claimed = [userTurn, steady];
    const decision = { kind: 'ok', messages: [...claimed] };
    const out = await hook.handlePreStep({ agent, messages: claimed, step: 2 }, async () => decision);
    check('verify_when 是人话（算不出日期）时不触发到期提醒', out === decision, String(out.messages.length));
    check('人话写法不误判成"已到期"', !out.messages.some((m) => /已超期|还有 \d+ 天/.test(m.content?.[0]?.text ?? '')), JSON.stringify(out.messages.map((m) => m.content[0].text.slice(0, 20))));
    // 就算真的走到了渲染那一步，空列表也必须渲染成空串（不注入空消息）
    check('renderDue 对空列表返回空串', renderDue([]) === '');
  }

  // ⑤ 本轮本来就要注入 baseline/delta → 到期提醒不抢那条消息
  {
    const entries = { current: [entry('a', 'h1', { date: '2026-01-01', verifyWhen: '2026-01-10' }), entry('b', 'h2', { date: '2026-01-01', verifyWhen: '2026-01-10' })] };
    const states = new Map();
    seedState(states, { a: 'h1' });               // 上一轮只有 a → 这一轮是 delta
    const hook = makeHook(entries, { today: () => '2026-03-01', states });
    const agent = fakeAgent();
    const claimed = [userTurn, fakeCreateMessage('旧的全量')];
    const decision = { kind: 'ok', messages: [...claimed] };
    const out = await hook.handlePreStep({ agent, messages: claimed, step: 2 }, async () => decision);
    const added = out.messages.filter((m) => isMemoryMessage(m) && m !== claimed[1]);
    check('desired 不为 null 时只注入 delta', out.messages.length === decision.messages.length + 1, String(out.messages.length));
    check('这一轮注入的是 delta 而不是 due', added.length === 1 && /新增：/.test(added[0].content[0].text), JSON.stringify(added.map((m) => m.content[0].text.slice(0, 24))));
    check('delta 没被 due 顶掉', /新增：/.test(added[0].content[0].text), added[0]?.content[0].text.slice(0, 80));
  }

  // ⑥ 空记忆库 / 加载失败 → 到期提醒这条路也不能把会话拖下水
  {
    const hook = makeHook({ current: [] }, { today: () => '2026-03-01' });
    const agent = fakeAgent();
    const decision = { kind: 'ok', messages: [userTurn] };
    const out = await hook.handlePreStep({ agent, messages: [], step: 2 }, async () => decision);
    check('空记忆库不提醒', out === decision);
  }

  // ⑦ dueWithin：提前 N 天提醒 —— "还没超期但快了"恰恰是提醒最有用的时候
  {
    const soon = { current: [entry('a', 'h1', { date: '2026-01-01', verifyWhen: '2026-03-05', line: '三天后该复核' })] };
    const claimed = [userTurn, steady];
    const decision = { kind: 'ok', messages: [...claimed] };

    const strictStates = new Map(); seedState(strictStates, { a: 'h1' });
    const strict = makeHook(soon, { today: () => '2026-03-01', states: strictStates });
    const outStrict = await strict.handlePreStep({ agent: fakeAgent(), messages: claimed, step: 2 }, async () => decision);
    check('dueWithin 默认 0：还有 4 天才到期 → 不提醒', outStrict === decision, String(outStrict.messages.length));

    const earlyStates = new Map(); seedState(earlyStates, { a: 'h1' });
    const early = makeHook(soon, { today: () => '2026-03-01', dueWithin: 7, states: earlyStates });
    const outEarly = await early.handlePreStep({ agent: fakeAgent(), messages: claimed, step: 2 }, async () => decision);
    const earlyMsg = outEarly.messages.find((m) => m !== steady && /还有 \d+ 天/.test(m.content?.[0]?.text ?? ''));
    check('dueWithin=7：还没到期也提醒', !!earlyMsg, JSON.stringify(outEarly.messages.map((m) => m.content[0].text.slice(0, 24))));
    check('还没到期时文案说「还有 N 天」', !!earlyMsg && /还有 \d+ 天/.test(earlyMsg.content[0].text), earlyMsg?.content[0].text.slice(0, 160));
    check('提前提醒的 source 同样是生产者自有 kind', !!earlyMsg && earlyMsg.source.kind === `plugin:${MEMORY_PLUGIN_ID}` && Object.keys(earlyMsg.source).length === 1, JSON.stringify(earlyMsg?.source));
  }
}

/* ------------------------------------------------------- 蒸馏提醒（M3 第三块） */
section('会话结束蒸馏钩子：长会话里提醒一次，且不污染差分状态');
{
  const entries = { current: [entry('a', 'h1')] };
  const agent = fakeAgent();
  const seen = fakeCreateMessage('已注入');
  const claimed = [{ id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }];
  const seed = () => { const s = new Map(); seedState(s, { a: 'h1' }); return s; };

  // 轮次还没到 → 不提醒
  const hook1 = makeHook(entries, { nudgeAfterTurns: 4, states: seed() });
  const d1 = { kind: 'ok', messages: [...claimed, seen] };
  const o1 = await hook1.handlePreStep({ agent, messages: claimed, step: 2 }, async () => d1);
  check('轮次未到时不安慰/不提醒', o1.messages.length === d1.messages.length, String(o1.messages.length));

  // 轮次到了 → 提醒一次
  const hook2 = makeHook(entries, { nudgeAfterTurns: 4, states: seed() });
  const d2 = { kind: 'ok', messages: [...claimed, seen] };
  const o2 = await hook2.handlePreStep({ agent, messages: claimed, step: 5 }, async () => d2);
  check('长会话触发蒸馏提醒', o2.messages.length === d2.messages.length + 1, String(o2.messages.length));
  const nudge = o2.messages.find((m) => m !== seen && /memory_write/.test(m.content?.[0]?.text ?? ''));
  check('提醒消息按文案能认出来', !!nudge, JSON.stringify(o2.messages.map((m) => m.content[0].text.slice(0, 20))));
  check('提醒的 source 是生产者自有 kind', !!nudge && nudge.source.kind === `plugin:${MEMORY_PLUGIN_ID}` && Object.keys(nudge.source).length === 1, JSON.stringify(nudge?.source));
  check('提醒文案提到 memory_write', !!nudge && /memory_write/.test(nudge.content[0].text));

  // 同会话再触发 → 不再提醒
  const claimed2 = [...o2.messages];
  const d3 = { kind: 'ok', messages: [...claimed2] };
  const o3 = await hook2.handlePreStep({ agent, messages: claimed2, step: 7 }, async () => d3);
  check('同一会话只提醒一次', o3.messages.length === d3.messages.length, String(o3.messages.length));

  // 关键回归：提醒之后，下一轮仍能正确算差分（不能因为提醒而全量重灌）
  const agent2 = fakeAgent();
  const hook3 = makeHook(entries, { nudgeAfterTurns: 4, states: seed() });
  const stateMsg = fakeCreateMessage('全量');
  const c = [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }];
  const dNudge = { kind: 'ok', messages: [...c, stateMsg] };
  const outNudge = await hook3.handlePreStep({ agent: agent2, messages: c, step: 6 }, async () => dNudge);
  check('提醒确实插进来了', outNudge.messages.some((m) => /memory_write/.test(m.content?.[0]?.text ?? '')));
  const afterNudge = [...outNudge.messages];
  const dNext = { kind: 'ok', messages: [...afterNudge] };
  const outNext = await hook3.handlePreStep({ agent: agent2, messages: afterNudge, step: 7 }, async () => dNext);
  check('提醒之后下一轮不重复注入（差分状态未被提醒污染）', outNext === dNext, `len=${outNext.messages.length}`);
}

/* ----------------------------------------------------------- 幂等与工具函数 */
section('工具函数');
{
  check('isMemoryMessage 识别自己', isMemoryMessage({ source: memorySource() }));
  check('isMemoryMessage 认得迁移读回后的形态', isMemoryMessage({ source: { kind: `plugin:${MEMORY_PLUGIN_ID}` } }));
  check('isMemoryMessage 不误判别的插件', !isMemoryMessage({ source: { kind: 'agent-instructions' } }));
  check('isMemoryMessage 不误判用户消息', !isMemoryMessage({ source: { kind: 'user' } }));
  check('isMemoryMessage 容忍 null', !isMemoryMessage(null));

  const a = fakeCreateMessage('same');
  const b = fakeCreateMessage('same');
  const c = fakeCreateMessage('别的正文');
  check('同内容 → 等价', sameMemoryPayload(a, b));
  check('正文不同 → 不等价', !sameMemoryPayload(a, c));
  check('null 安全', !sameMemoryPayload(a, null));

  let threw = false;
  try {
    createMemoryHook({ createMessage: fakeCreateMessage });
  } catch {
    threw = true;
  }
  check('缺少 loadPayload 时构造报错', threw);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
