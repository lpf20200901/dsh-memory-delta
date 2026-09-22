/**
 * `verify_when`（复核时机）的**纯逻辑** —— 不碰文件系统、不依赖 DSH，可以独立测试。
 *
 * 背景：`verify_when` 曾经是个**死字段** —— `mem new/set --verify-when` 能写进 frontmatter，
 * 但没有任何地方读它。这里把它变成"到点了主动提醒"的能力：条目自己说"什么时候该复核"，
 * 到点后由 `mem due`（人看）/ hook 的会话内提醒（模型看）把这件事重新推到台前。
 *
 * 两种写法都支持：
 *   · 绝对日期 `2026-03-01`
 *   · 相对写法（相对**条目自己的 date**）`3个月后` / `2周后` / `立即`… —— 写的时候不知道
 *     具体哪天，只知道"过一阵子要回头看"，这才是人写记忆时的真实状态。
 *
 * ⚠️ **日期算术一律用 UTC**（`Date.UTC` / `getUTC*`）：本地时区会把"超期 1 天"算歪
 * （`new Date('2026-03-01')` 在不同时区解析出的毫秒数不同），而 due / overdueDays 是要
 * 拿来做判断的。口径统一成 UTC 之后，同一个输入在任何机器上结果都一样。
 */

const DAY_MS = 86400000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 相对写法的数字部分：支持阿拉伯数字与常见中文数字（"三个月后"很常见）。 */
const NUM = '(\\d+|[一二两三四五六七八九十]+)';
const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/** 相对写法的单位模式，顺序即 `unit` 的序号：0 天 / 1 周 / 2 月 / 3 年。 */
const UNIT_PATTERNS = [
  new RegExp(`^${NUM}\\s*(?:天|日)后$`),
  new RegExp(`^${NUM}\\s*(?:周|星期|礼拜)后$`),
  new RegExp(`^${NUM}\\s*个?月后$`),
  new RegExp(`^${NUM}\\s*年后$`),
];

/** 解析数字部分：阿拉伯数字直接用，中文数字查表（"十" → 10、"十二" → 12、"两" → 2）。 */
function toNumber(raw) {
  if (/^\d+$/.test(raw)) return Number(raw);
  const s = raw.replace(/两/g, '二');
  if (s === '十') return 10;
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  return CN_DIGITS[s] ?? null;
}

/** `YYYY-MM-DD` → 该日 UTC 零点的毫秒数；不是合法日期返回 null。 */
function parseIsoDate(value) {
  const m = ISO_DATE.exec(String(value ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const stamp = Date.UTC(y, mo - 1, d);
  // Date.UTC 会把 2026-13-01 这种"溢出"日期顺延，回读核实一次才算合法
  const back = new Date(stamp);
  if (back.getUTCFullYear() !== y) return null;
  if (back.getUTCMonth() !== mo - 1) return null;
  if (back.getUTCDate() !== d) return null;
  return stamp;
}

/** UTC 毫秒数 → `YYYY-MM-DD`。 */
function isoOf(stamp) {
  return new Date(stamp).toISOString().slice(0, 10);
}

/**
 * 解析 `verify_when`。
 *
 * @param {*} value 条目里写的 verify_when
 * @param {string} [fromDate] 相对写法的基准日（**条目自己的 date**，`YYYY-MM-DD`）
 * @returns {{due: string|null, kind: 'date'|'relative'|'unparsed'}}
 *   · 空值 → `{due: null, kind: 'unparsed'}`
 *   · 已经是 `YYYY-MM-DD` → 原样返回，`kind: 'date'`
 *   · 相对写法 → 算出来，`kind: 'relative'`
 *   · 其它散文（"等换机器时"）→ `unparsed`。**这是正常情况，不是错误** —— 复核时机本来就
 *     允许写成只有人看得懂的话，只是这种条目不会被主动提醒（没有可判断的信号）。
 */
export function parseVerifyWhen(value, fromDate) {
  const text = String(value ?? '').trim();
  if (!text) return { due: null, kind: 'unparsed' };

  const asDate = parseIsoDate(text);
  if (asDate !== null) return { due: isoOf(asDate), kind: 'date' };

  const base = parseIsoDate(fromDate);
  if (base === null) return { due: null, kind: 'unparsed' }; // 没有基准日 → 相对写法无法计算

  if (/^(?:立即|马上|现在)$/.test(text)) return { due: isoOf(base), kind: 'relative' };

  for (let i = 0; i < UNIT_PATTERNS.length; i += 1) {
    const m = UNIT_PATTERNS[i].exec(text);
    if (!m) continue;
    const n = toNumber(m[1]);
    if (n === null || n < 0) continue;
    const at = new Date(base);
    if (i === 0) at.setUTCDate(at.getUTCDate() + n);
    else if (i === 1) at.setUTCDate(at.getUTCDate() + n * 7);
    // 月份用 setUTCMonth 加，**不要用 30 天近似**：近似会给出肉眼可见的错误日期。
    // 注意 1 月 31 日加 1 个月会"溢出"到 3 月 3 日（setUTCMonth 的顺延语义），
    // 这是可复现的确定行为，比"近似 30 天"更可信。
    else if (i === 2) at.setUTCMonth(at.getUTCMonth() + n);
    else at.setUTCFullYear(at.getUTCFullYear() + n);
    return { due: isoOf(at.getTime()), kind: 'relative' };
  }

  return { due: null, kind: 'unparsed' };
}

/**
 * 挑出**到期**的条目。
 *
 * @param {Array<{id: string, line: string, date?: string, verifyWhen?: string}>} entries
 * @param {string} today `YYYY-MM-DD`（调用方注入，便于测试）
 * @param {{within?: number, limit?: number}} [opts] within: 提前多少天算"快到期"；0 只看已到期
 * @returns {Array<{id, line, verifyWhen, due, overdueDays, unparsed}>}
 *   只有**设了 verifyWhen 且能算出 due** 的条目才会出现 —— 散文写法（"等换机器时"）不算到期：
 *   它没有 due，也就没有"到点"这个信号，硬提醒的话会在**每个会话**里都弹一次且永远消不掉。
 *   排序：最超期的在前（`overdueDays` 大的先），同分按 id。
 *   `overdueDays = today - due`：正数 = 已超期 N 天，0 = 今天到期，负数 = 还有 N 天。
 *   `unparsed` 恒为 false —— 留着这个字段是为了让调用方不必再判一次。
 */
export function collectDue(entries, today, { within = 0, limit } = {}) {
  const base = parseIsoDate(today);
  const out = [];
  if (base === null) return out;
  const span = Number.isFinite(Number(within)) ? Number(within) : 0;
  // 到期判据照规格直写成"due <= today + within 天"：算出一个**截止日期**再比字符串。
  // ISO 日期的字典序就是时间序，比毫秒数减法更不容易写错，也更好读。
  const cutoffIso = isoOf(base + span * DAY_MS);

  for (const e of entries ?? []) {
    const raw = e?.verifyWhen;
    if (raw === null || raw === undefined || String(raw).trim() === '') continue; // 没写就不管
    const parsed = parseVerifyWhen(raw, e.date);
    if (parsed.due === null) continue; // 散文写法：没有 due 就没有"到点"这个信号
    if (parsed.due > cutoffIso) continue; // 还没到期（within 内的"快到期"会留下）
    const dueStamp = parseIsoDate(parsed.due);
    const overdueDays = dueStamp === null ? 0 : Math.round((base - dueStamp) / DAY_MS);
    out.push({ id: e.id, line: e.line, verifyWhen: raw, due: parsed.due, overdueDays, unparsed: false });
  }

  out.sort((a, b) => b.overdueDays - a.overdueDays || String(a.id).localeCompare(String(b.id)));
  if (limit === undefined || limit === null) return out;
  const n = Number(limit);
  return Number.isFinite(n) && n >= 0 ? out.slice(0, n) : out;
}

/** 一条到期条目的说明后缀：`已超期 N 天` / `今天到期` / `还有 N 天` / `已到期`。 */
export function duePhrase(overdueDays) {
  if (overdueDays === null || overdueDays === undefined) return '已到期';
  if (overdueDays > 0) return `已超期 ${overdueDays} 天`;
  if (overdueDays < 0) return `还有 ${-overdueDays} 天`;
  return '今天到期';
}

const clip = (text, cap = 140) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
};

/**
 * 渲染注入用的到期提醒。
 *
 * 风格照 `hook.mjs` 的 `NUDGE_TEXT`：`<system-reminder>` 包裹、中文、给模型看的祈使句、
 * 最后一条是"不用管"的退出口。**文本要短** —— 这是注入内容，每个字都有字节成本。
 *
 * @param {Array} list collectDue 的结果
 * @param {{max?: number}} [opts] 最多列几条（超出的只报个数，不能靠提醒把预算吃光）
 * @returns {string} 空列表返回 `''` —— 调用方据此判断"不要注入"。
 */
export function renderDue(list, { max = 5 } = {}) {
  // 只有"写了 verify_when"的才进提醒
  const items = (list ?? []).filter((x) => x && x.verifyWhen);
  if (!items.length) return '';
  const cap = Number.isFinite(Number(max)) ? Math.max(0, Number(max)) : 5;
  const shown = items.slice(0, cap);
  const parts = [
    '<system-reminder>',
    'dsh-memory-delta 提醒：下面这些记忆到了当初约定的复核期（`mem due` 看全量）。',
    '它们的结论可能已经过时 —— 请逐条判断，必要时用 memory_search 查细节：',
  ];
  for (const d of shown) parts.push(`- ${clip(d.line)} —— verify_when: ${d.verifyWhen}（${duePhrase(d.overdueDays)}）`);
  if (items.length > shown.length) parts.push(`（另有 ${items.length - shown.length} 条也到期了）`);
  parts.push(
    // ⚠️ 这里必须写清"**谁**来动手"：提醒是发给模型的，而 promote/supersede/set 都是**人的动作**
    // （见插件的 skill：模型只能写收件箱）。原文写成"用 mem supersede …"会让模型以为自己该去跑
    // 这些命令 —— 那要么越界改常驻层、要么一脸问号。模型能做的只有一件事：把新结论写进候选。
    '不再成立的：把新结论用 memory_write 写成候选，**提醒用户**用 `mem supersede <旧id> <新id>` 换掉或 `mem set <id> --status expired`；',
    '仍然成立的：**提醒用户**用 `mem set <id> --verify-when "…"` 往后推（改常驻条目是用户的动作，你不做）。',
    '都处理过就忽略本条。',
    '</system-reminder>',
  );
  return parts.join('\n');
}
