/**
 * 差分注入的**纯逻辑** —— 不依赖 DSH、不碰文件系统，可以独立测试。
 *
 * 这是 dsh-memory-delta 相对上游 `dsh-agent-instructions` 的核心增量：
 * 上游插件没有差分 —— 文件一变就把整篇重新注入（实测一个会话里改 15 次一个 8.5 KB 的文件
 * 就白烧约 58k tokens）。这里改成：记住上一轮注入的每条 hash，下一轮**只注入变化块**；
 * 完全没变化时**一个字都不注入**。
 *
 * 状态从哪来：不存旁路文件，而是从**会话历史里我们自己发过的那条消息**里读
 * （消息的 source 带着上一轮的 {id → hash}）。这样会话恢复 / 回放 / 压缩之后状态依然正确。
 */

export const MEMORY_SOURCE_KIND = 'memory';

/**
 * 条目集合 → 状态表 { id: hash }。
 * @param {Array<{id: string, hash: string}>} entries
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
 * ⚠️ 只影响正文 —— 完整 key 依然随消息的 `source.entries` 结构化带给模型（那是差分的依据，
 * 也是它 `memory_search` 的检索词）。截短只是别让一个 43 字的 key 白占预算。
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
 * 而 id 已经通过 `source.entries` 给到模型：正文里那个 `[key]` 是**第二遍**，
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
 * ⚠️ **故意不写 id**：id 是机器用来做差分的元数据，已经随消息的 `source.entries`
 * 结构化携带（见 sourceEntries），把它再写进正文只会白占注入预算 ——
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
 * 从会话历史里找回上一轮注入的状态。
 * 只认自己发的消息（source.kind === 'memory'），并取**最后一条**（最近的状态）。
 *
 * @param {Array} messages 会话里可见的消息（或本步已领取的消息）
 * @returns {object|null} { id: hash }，找不到返回 null
 */
export function previousStateFrom(messages) {
  let found = null;
  for (const m of messages) {
    const src = m?.source;
    if (!src || typeof src !== 'object') continue;
    if (src.kind !== MEMORY_SOURCE_KIND) continue;
    if (!Array.isArray(src.entries)) continue;
    found = src.entries;
  }
  if (!found) return null;
  const state = {};
  for (const e of found) {
    if (e && typeof e.id === 'string') state[e.id] = String(e.hash ?? '');
  }
  return state;
}

/** 构造要写进消息 source 的状态（供下一轮差分）。 */
export function sourceEntries(state) {
  return Object.entries(state).map(([id, hash]) => ({ id, hash }));
}
