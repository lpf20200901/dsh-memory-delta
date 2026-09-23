/**
 * 记忆插件的**决策逻辑** —— 所有 DSH 依赖都通过参数注入，因此可以在没有 DSH 的环境里
 * 用假的 agent / decision 完整测试（见 test/hook-tests.mjs）。
 *
 * 上游 `dsh-agent-instructions` 的 pre-step 手法（读它的源码得到的合约）：
 *   1. `const decision = await next()`              先让下游算完这一步
 *   2. 自己要注入的消息要么塞进 `agent.inbox.nextStep`（本步还没正式开始）
 *      要么 splice 进 `decision.messages` 里最后一条"已领取"消息之后
 *   3. 已经排队过的同类消息要先 `agent.inbox.remove(id)`，避免重复
 * 我们照这个合约做，但内容换成**差分**的（见 planner.mjs）。
 */

import { collectDue, renderDue } from './due.mjs';
import { MEMORY_SOURCE_KIND, planInjection, previousStateFrom, sourceEntries } from './planner.mjs';

/** 判断一条消息是不是我们自己发的。 */
export function isMemoryMessage(message) {
  const src = message?.source;
  return !!src && typeof src === 'object' && src.kind === MEMORY_SOURCE_KIND;
}

/** 两条记忆消息是否等价（用于去重，避免同一内容排队两次）。 */
export function sameMemoryPayload(a, b) {
  if (!a || !b) return false;
  if (a.content?.[0]?.text !== b.content?.[0]?.text) return false;
  const sa = JSON.stringify(a.source?.entries ?? []);
  const sb = JSON.stringify(b.source?.entries ?? []);
  return sa === sb;
}

/**
 * 蒸馏提醒的文案。这不是"注入记忆"，而是**提醒模型把结论落到 inbox** ——
 * 会话结束时结论最容易蒸发，而记忆库只有真的被写才会变好。
 */
export const NUDGE_TEXT = [
  '<system-reminder>',
  'dsh-memory-delta 提醒：如果这次会话产生了值得长期留存的结论 —— 用户的偏好/禁忌、定下来的约定、',
  '踩到的坑、项目状态变化 —— 用 memory_write 工具写进收件箱（一条一个结论，写结论不写过程）。',
  '它会先进 inbox，确认后才成为常驻事实；不需要重新交代上下文。',
  '没有值得留存的就忽略本条。',
  '</system-reminder>',
].join('\n');

/**
 * 收集"模型真的见过"的消息，用来恢复上一轮状态。
 *
 * ⚠️ 这里**不能**把 `agent.inbox.nextStep` 里排队的消息算进去 —— 它们还没进上下文。
 * 用陈旧状态去算差分会导致"本来没变化却又注入一次"（实测被 hook 测试抓到的 bug）。
 * 三个来源按**由旧到新**排列，`previousStateFrom` 取最后一条命中的：
 *   1. 会话表面上已落盘的消息（会话恢复 / 回放场景）
 *   2. 本步已领取的消息
 *   3. 本步 decision 里即将进入的消息（含我们刚插进去的）
 *
 * 注意：`previousStateFrom` 只认带 `entries` 数组的消息 —— 蒸馏提醒那种"不带状态"的
 * 记忆消息会被自动跳过，否则提醒会把差分状态清零、导致下一轮又全量重灌。
 */
export function collectVisibleMessages(agent, messages, decision) {
  const out = [];
  const nodes = agent?.session?.surface?.nodes;
  if (Array.isArray(nodes) && typeof agent.session.eventAt === 'function') {
    for (const seq of nodes) {
      const event = agent.session.eventAt(seq);
      if (event?.type === 'user/message' && event.data) out.push(event.data);
    }
  }
  if (Array.isArray(messages)) out.push(...messages);
  if (Array.isArray(decision?.messages)) out.push(...decision.messages);
  return out;
}

export function createMemoryHook({
  loadPayload,
  createMessage,
  logger = console,
  nudgeAfterTurns = 4,
  today = () => new Date().toISOString().slice(0, 10),
  dueWithin = 0,
}) {
  if (typeof loadPayload !== 'function') throw new Error('createMemoryHook: loadPayload 必填');
  if (typeof createMessage !== 'function') throw new Error('createMemoryHook: createMessage 必填');

  /** 每个会话只提醒一次蒸馏。 */
  const nudged = new WeakSet();

  /** 每个会话只提醒一次"到期复核"（会话恢复 / 回放时靠消息里的 form='due' 兜底）。 */
  const dueNotified = new WeakSet();

  /**
   * 本会话是否已经发过到期提醒。
   * 两条通道都要查：WeakSet 管同进程内的重复，`collectVisibleMessages` 管会话恢复之后
   * 从历史消息里认出"这条提醒我上辈子发过"。
   */
  function alreadyNotifiedDue(agent, messages, decision) {
    if (agent?.session && dueNotified.has(agent.session)) return true;
    return collectVisibleMessages(agent, messages, decision).some((message) => message?.source?.form === 'due');
  }

  /**
   * 算这一轮要不要注入、注入什么。
   * @returns {{plan: object|null, desired: object|null, entries: Array, due: Array}}
   *   返回 `entries` / `due` 是为了让 handlePreStep 在**零注入**的那一轮也能判断到期复核
   *   （那时没有任何消息要发，但可能有记忆该提醒了）。
   */
  async function planFor(agent, messages, decision) {
    // ⚠️ 缺 cwd 时**不要**兜 `process.cwd()`（插件进程的 cwd 是 harness 的启动目录）：
    // 那会把**别的工作区**的记忆注入到这个会话里。拿不到就是拿不到 —— 交给 openStore 判空，
    // 结果是不注入（插件配了固定 root 时不受影响）。
    const cwd = agent?.session?.header?.cwd ?? null;
    const payload = await loadPayload(cwd);
    if (!payload || !Array.isArray(payload.entries) || payload.entries.length === 0) {
      // 记忆库为空或不可用 —— 不但不该注入，还应该把之前排队的清掉
      // ⚠️ 每条 return 都必须带全 {plan, desired, entries, due} 四个字段：
      // 少一个就会让 handlePreStep 的取值变成 undefined（曾表现为"没建 memory/ 的工作区
      // 每一步都打一条加载失败告警"，因为 TypeError 被外层 catch 当成加载失败吃掉了）。
      return { plan: null, desired: null, entries: [], due: [] };
    }
    // 到期复核项：即使这一轮"记忆没变化、零注入"，也可能有该复核的记忆要提醒。
    // 只认**真算出了日期**的条目：`verify_when` 写成人话（"等换机器时"）的不算 ——
    // 否则那条提醒会在每个会话里永远弹一次，而且用户怎么改都消不掉。
    const due = collectDue(payload.entries, today(), { within: dueWithin }).filter((d) => !d.unparsed);
    const previous = previousStateFrom(collectVisibleMessages(agent, messages, decision));
    const plan = planInjection(payload.entries, previous);
    if (plan.mode === 'none' || !plan.text) return { plan, desired: null, entries: payload.entries, due };
    return { plan, desired: createMessage(plan.text, sourceEntries(plan.state), plan.mode), entries: payload.entries, due };
  }

  return {
    /** 供测试与日志用：只算不做。 */
    planFor,

    /**
     * 接在 `agent/pre-step` 上。
     * @param {{agent: object, messages: Array, step: number}} input
     * @param {Function} next 下游 handler，必须调用
     */
    async handlePreStep({ agent, messages, step, signal }, next) {
      const decision = await next();
      let desired = null;
      let plan = null;
      let due = [];
      try {
        // 防御式取值：planFor 的**每条** return 路径都必须带 `due`，但这里不赌它 ——
        // 早退分支漏一个字段曾导致 `due` 被解构成 undefined、`due.length` 抛 TypeError，
        // 被下面的 catch 吃掉后表现成"每一步都打一条加载失败告警"（噪音 + 跳过排队清理）。
        const result = (await planFor(agent, messages, decision)) ?? {};
        plan = result.plan ?? null;
        desired = result.desired ?? null;
        due = Array.isArray(result.due) ? result.due : [];
        // 记忆已是最新、但会话跑了不少轮 —— 给一次蒸馏提醒（每个会话只给一次）
        if (desired === null && Number.isFinite(nudgeAfterTurns) && step >= nudgeAfterTurns && agent?.session && !nudged.has(agent.session)) {
          nudged.add(agent.session);
          // 不带 entries：它不携带状态，不会影响下一轮的差分判断
          desired = createMessage(NUDGE_TEXT, null, 'nudge');
        }
        // 到期复核：**只在本来不注入任何记忆时**才提醒 —— 抢 baseline/delta 那条消息
        // 会把"记忆变化"这件事挤掉，那才是更该让模型看到的东西。
        // 一个会话只提醒一次：既不重复骚扰，也避免把注入预算花在同一句话上。
        if (desired === null && due.length > 0 && !alreadyNotifiedDue(agent, messages, decision)) {
          const text = renderDue(due);
          // renderDue 对空列表返回 '' —— 绝不注入空消息
          if (text) {
            if (agent?.session) dueNotified.add(agent.session);
            // ⚠️ 第二个参数（entries）**必须是 null**，第三个参数是 form：
            // 提醒一旦携带 entries，就会被 previousStateFrom 当成"上一轮状态"、把差分基线清零，
            // 下一轮又会全量重灌（这个坑 nudge 踩过，别再重演）。
            desired = createMessage(text, null, 'due');
          }
        }
      } catch (error) {
        // 记忆库坏了绝不能拖垮会话 —— 记一笔，然后放行
        logger?.warn?.('memory: 加载记忆失败，本轮不注入: %o', error);
        return decision;
      }

      const pending = (agent?.inbox?.nextStep ?? []).filter(isMemoryMessage);

      // 没有要注入的：把之前排队的清掉（否则会一直挂在那儿）
      if (desired === null) {
        for (const message of pending) agent.inbox.remove(message.id);
        return decision;
      }

      // 本步还没正式开始：只排队，不动 decision
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
        const reusable = pending.find((message) => sameMemoryPayload(message, desired));
        if (reusable !== undefined) {
          for (const message of pending) if (message !== reusable) agent.inbox.remove(message.id);
          return decision;
        }
        const first = pending[0];
        if (first === undefined) agent.inbox.prepend('next-step', desired);
        else agent.inbox.replace(first.id, desired);
        for (const message of pending.slice(1)) agent.inbox.remove(message.id);
        return decision;
      }

      // 正常路径：清掉排队，把消息插到最后一条"已领取"消息之后
      for (const message of pending) agent.inbox.remove(message.id);
      if (decision.messages.some((message) => sameMemoryPayload(message, desired))) {
        // 已经进过这一步了（比如 pre-step 被调用多次），不重复插
        return decision;
      }
      const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
      const at = lastClaimedIndex < 0 ? decision.messages.length : lastClaimedIndex + 1;
      return { ...decision, messages: decision.messages.toSpliced(at, 0, desired) };
    },
  };
}
