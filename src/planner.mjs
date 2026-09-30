/**
 * 差分注入的**纯逻辑** —— 不依赖 DSH、不碰文件系统，可以独立测试。
 *
 * 这是 dsh-memory-delta 相对上游 `dsh-agent-instructions` 的核心增量：
 * 上游插件没有差分 —— 文件一变就把整篇重新注入（实测一个会话里改 15 次一个 8.5 KB 的文件
 * 就白烧约 58k tokens）。这里改成：记住上一轮注入的每条 hash，下一轮**只注入变化块**；
 * 完全没变化时**一个字都不注入**。
 *
 * 状态从哪来：2026-09-30 起放**侧车文件**
 * （`$DSH_HOME/storages/dsh-memory-delta/inject-state/<sessionId>.json`，见 src/plugin.mjs 的
 * loadState/saveState）。此前把 `{id → hash}` 塞在消息的 `source` 里 —— 那会被 DSH 会话格式的
 * v0 白名单 / v2→v3 来源表拒绝，让整条会话永久读不出来，已废弃。
 * 落盘时机同样讲究：只有消息**真的进了上下文**才记账（见 src/hook.mjs 的可见性判断），
 * 否则"排队后又被清掉"会让状态虚增，模型永久少看一批记忆。
 */

/**
 * 插件身份：写进消息 `source.plugin` 的值（= 包名，见 cordis.patch.yml 的 name）。
 */
export const MEMORY_PLUGIN_ID = 'dsh-memory-delta';

/**
 * 自己发的消息长什么样 —— 历史上一共有四种形态，**全都要认**（老会话日志里都还在）。
 *
 * ⚠️ source 的形状被 DSH 会话格式**逐代收紧过两次**，两次都是"整条会话读不出来/跑不起来"级别的事故：
 *
 * ① v3 及以前：**唯一合法**写法是插件包装 `{kind:'plugin', plugin:'<包名>'}`
 *    （v0 白名单只允许 `kind, plugin[, form, sections, summary]`；
 *    见 `@deepseek-ai/dsh-session-format-v0-to-v1` 的 `pluginSourceValue`）。
 *    所以 `kind:'memory'` 会被 v2→v3 拒、往 source 里塞 `entries` 会被 v0→v1 拒 ——
 *    2026-09-30 实测：本机 14 条会话因此**永久打不开**（源日志按设计保持原样，修不回来）。
 *    差分状态从那以后改放 inject-state 侧车（见 src/plugin.mjs）。
 *
 * ② **v4 起（DSH 0.1.7）规则反过来了**：`kind` 必须是**生产者自有 kind** ——
 *    非空字符串，且**不能是 `plugin`**。
 *    （`@deepseek-ai/dsh-session-format-v3-to-v4` 的 `source()`；README：「其他任何插件名 → `plugin:` 后接完整原始名称」。）
 *    这时还写 `{kind:'plugin', ...}` → **编码器当场抛**
 *    `format v4 message requires a producer-owned source kind`：会话日志一个字都写不进去，
 *    界面上表现为**每个会话第一轮就「本轮运行失败」**（社区版 DSH Desktop 0.10.0 / 内核 0.1.7-rc.2 实测，
 *    新会话文件只剩 196 字节表头）。复现脚本：`.dbg/repro-v4-source.mjs`。
 *
 * 结论：**写 `{kind:'plugin:dsh-memory-delta'}`** —— 正好等于 v4 迁移给本插件分配的 kind，
 * 写出去和读回来是同一个形态。另外三种（`plugin` 包装、裸包名、`memory`）只为读老日志保留。
 *
 * @param {unknown} src 消息的 `source`
 * @returns {boolean} 是不是我们发的
 */
export function isMemorySource(src) {
  if (!src || typeof src !== 'object') return false;
  if (src.kind === `plugin:${MEMORY_PLUGIN_ID}`) return true;        // 现行写入形态（= 迁移抬升后的形态）
  if (src.kind === 'plugin') return src.plugin === MEMORY_PLUGIN_ID; // ≤1.3.0 写进日志的插件包装
  if (src.kind === MEMORY_PLUGIN_ID) return true;                    // 上游同名白名单收录时的形态
  return src.kind === 'memory';                                     // 更早的历史遗留（'memory' 自定义 kind）
}

/**
 * 构造写进消息 `source` 的来源标记 —— **唯一构造点**。
 *
 * v4 的准入只看一件事：`kind` 是非空字符串、且 ≠ `plugin`（未知 kind 一律放行，见文件头 ②）。
 * `plugin:<包名>` 是第三方插件的规范形态：v3→v4 迁移把老 `plugin` 包装抬升出来的也正是它，
 * 所以写/读同形 —— 重启后仍认得出自己发过的消息（提醒去重、清理排队都靠这个）。
 *
 * ⚠️ 别改回 `kind:'plugin'`：那会让装了本插件的 DSH ≥ 0.1.7 **每个会话都跑不起来**。
 */
export function memorySource() {
  return { kind: `plugin:${MEMORY_PLUGIN_ID}` };
}

/**
 * 条目集合 → 状态表 { id: hash }（差分基线）。
 * 由 src/plugin.mjs 落到 inject-state 侧车；不再随消息 `source.entries` 走 —— 见文件头。
 */
export function stateOf(entries) {
  const out = {};
  for (const e of entries) out[e.id] = e.hash;
  return out;
}

/** 防止条目正文里的 `</system-reminder>` 提前关掉我们自己的框架（仓库内容不可信）。 */
export function escapeFraming(text) {
  return String(text).replaceAll('</system-reminder>', '<\\/system-reminder>');
}

/** 防止单条超长结论独占预算的展示上限（正文才是给人看的）。 */
export const LINE_CAP = 90;

/**
 * key 在**正文里**显示的上限。
 *
 * ⚠️ 只影响正文 —— 截短是因为一个 43 字的 key 会白占注入预算；正文里那个 `[key]` 只有
 * 在它与 id 不同时才写（见 renderKey），而 id 本身从 v1.3.1 起**不再进上下文**（只做差分元数据）。
 */
export const KEY_CAP = 24;

const clip = (text, cap = LINE_CAP) => {
  const t = String(text ?? '').trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
};

/**
 * 一条记忆的 key 要不要写进正文。
 *
 * 判据：**key 只在它不等于 id 时才写**。这是实测出来的 —— `createEntry` 的规则是
 * "给了 key 就用 key 当文件名"，于是真实库里 31 条常驻有 **30 条的 key 与 id 一字不差**，
 * 而两者对模型是同一个词：写出去就是**第二遍**，
 * 实测占 912 字节 / 注入总量的 15%（其中 879 字节是纯重复）。
 * 只有 key 与 id 不同时（既有语义键、文件名又是另起的）它才携带新信息。
 */
const renderKey = (e) => {
  const k = e.key ? String(e.key) : '';
  if (!k || k === String(e.id)) return '';
  return ` [${clip(k, KEY_CAP)}]`;
};

/**
 * 渲染一条记忆。
 *
 * ⚠️ **故意不写 id**：id 是机器用来做差分的元数据，从 v1.3.1 起只落在侧车状态文件里
 * （不进上下文），把它写进正文纯属白占注入预算 ——
 * 实测它曾占掉**全部注入字节的 40%**（1066 字节里 431 是 id）。
 * 去掉后 3 KB 预算能装的条目从约 17 条升到约 29 条。
 * （同一条道理现在也用在 key 上 —— 见 renderKey。）
 */
const label = (e) => {
  return `- ${escapeFraming(clip(e.line))}${renderKey(e)}`;
};

function groupByType(entries) {
  const facts = entries.filter((e) => e.type === 'fact');
  const decisions = entries.filter((e) => e.type === 'decision');
  const other = entries.filter((e) => e.type !== 'fact' && e.type !== 'decision');
  return { facts, decisions, other };
}

export function renderBaseline(entries) {
  if (!entries.length) return '';
  const { facts, decisions, other } = groupByType(entries);
  const parts = [
    '<system-reminder>',
    '以下是 dsh-memory-delta 记录的项目长期记忆（自动注入）。这些是此前确认过的结论，供参考；',
    '与当前代码或文件冲突时，以实际为准。需要细节时用 memory_search 工具检索。',
    '',
  ];
  if (facts.length) parts.push('### 事实', ...facts.map(label), '');
  if (decisions.length) parts.push('### 决策', ...decisions.map(label), '');
  if (other.length) parts.push('### 其他', ...other.map(label), '');
  parts.push(`共 ${entries.length} 条。`, '</system-reminder>');
  return parts.join('\n');
}

export function renderDelta({ added, changed, removed, unchangedCount = 0 }) {
  const parts = ['<system-reminder>', 'dsh-memory-delta 有更新（只列变化部分）：', ''];
  if (added.length) parts.push('新增：', ...added.map(label), '');
  if (changed.length) parts.push('已更新：', ...changed.map(label), '');
  if (removed.length) {
    parts.push('已失效（已被取代或过期，不要再依据）：', ...removed.map((id) => `- ${id}`), '');
  }
  if (unchangedCount > 0) parts.push(`其余 ${unchangedCount} 条记忆未变化，保持有效。`);
  parts.push('</system-reminder>');
  return parts.join('\n');
}

/**
 * 计算这一轮该注入什么。
 *
 * @param {Array} current  当前 active 条目（来自 store 的 injectPayload().entries）
 * @param {object|null} previous  上一轮注入的状态 { id: hash }；null = 本会话还没注入过
 * @returns {{mode: 'baseline'|'delta'|'none', added: Array, changed: Array, removed: string[], state: object, text: string}}
 */
export function planInjection(current, previous) {
  const state = stateOf(current);
  if (!previous) {
    return { mode: 'baseline', added: current, changed: [], removed: [], state, text: renderBaseline(current) };
  }
  const added = current.filter((e) => !(e.id in previous));
  const changed = current.filter((e) => e.id in previous && previous[e.id] !== e.hash);
  const removed = Object.keys(previous).filter((id) => !(id in state));

  if (!added.length && !changed.length && !removed.length) {
    // 没有任何变化 —— 一个字都不注入。这就是省下来的 token。
    return { mode: 'none', added: [], changed: [], removed: [], state, text: '' };
  }
  const unchangedCount = current.length - added.length - changed.length;
  return { mode: 'delta', added, changed, removed, state, text: renderDelta({ added, changed, removed, unchangedCount }) };
}

/**
 * 侧车状态的数组形式（`{id: hash}` → `[{id, hash}]`）。
 * 只给调试 / CLI / 测试看；注入链路不再把状态写进消息 —— 见文件头。
 */
export function sourceEntries(state) {
  return Object.entries(state).map(([id, hash]) => ({ id, hash }));
}
