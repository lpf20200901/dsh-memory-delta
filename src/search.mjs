/**
 * 检索排序 —— **纯逻辑，不碰文件系统、不依赖 DSH**，可以独立测试。
 *
 * 之前 `memory_search` / `mem recall` 就是一句 `hay.includes(needle)`：要么命中要么不命中，
 * 命中多的时候**没法排序**（谁更相关说不出来），而且中文连写时"沙箱 管道"这种查询必然落空。
 *
 * 这里做三件事：
 *   1. **分词**：ASCII 按词切；中文连写切成 bigram（"沙箱禁管道" → 沙箱/箱禁/禁管/管道），
 *      这样带空格或字面不连续的查询也能命中。
 *   2. **打分**：结构字段（id/key/tags）比正文值钱，结论行比正文值钱；整串短语再给加成。
 *   3. **片段**：命中最多 token 的那一行 + 窗口截取，让人（和模型）一眼看到"命中在说什么"。
 *
 * 刻意不做：向量检索、同义词表、相关度学习的复杂机制（用户明确判定过度设计）。
 */

/** 拼进正则前要转义的字符。 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 中日韩统一表意文字（含扩展 A）+ 假名 + 谚文 —— 这些文字之间不加空格，必须切 bigram。 */
const CJK_CLASS = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af';
const CJK_RE = new RegExp(`[${CJK_CLASS}]`);
const CJK_RUN_RE = new RegExp(`[${CJK_CLASS}]+`, 'g');
const WORD_RUN_RE = /[a-z0-9][a-z0-9_.-]*/g;

/** 查询里的标点/空白：只用来切分，本身不参与匹配（`_ . -` 保留，方便搜 verify_when 这种标识符）。 */
const SEPARATOR_RE = /[^\p{L}\p{N}_.\-]+/gu;

/** 单字虚词：切出来只会制造噪声（"的"命中一切），直接丢掉。 */
const STOPWORDS = new Set(
  ('的 了 是 在 和 与 就 都 也 不 有 一 个 我 你 他 它 她 吗 呢 吧 把 被 给 从 到 对 为 以 及 或 而 但 又 等 中 上 下 里 外 这 那 会 能 要 会 之 其 于 而').split(/\s+/),
);

/* ------------------------------------------------------------------ 分词 */

/**
 * 把查询切成检索单元。
 *
 * @param {string} query
 * @returns {string[]} 去重后的小写 token；查询全是虚词时退化成整串（等于老的子串匹配）
 */
export function tokenizeQuery(query) {
  const raw = String(query ?? '').toLowerCase().trim();
  if (!raw) return [];

  const tokens = [];
  const push = (t) => {
    if (t && !tokens.includes(t)) tokens.push(t);
  };

  for (const segment of raw.split(SEPARATOR_RE)) {
    if (!segment) continue;

    // 先取出中文连写段（切 bigram），剩下的交给 ASCII 词规则
    const cjkRuns = segment.match(CJK_RUN_RE) ?? [];
    for (const run of cjkRuns) {
      if (run.length === 1) {
        if (!STOPWORDS.has(run)) push(run);
        continue;
      }
      for (let i = 0; i + 2 <= run.length; i += 1) push(run.slice(i, i + 2));
    }

    const ascii = segment.replace(CJK_RUN_RE, ' ');
    for (const word of ascii.match(WORD_RUN_RE) ?? []) push(word);
  }

  // 全是虚词（例如只查"的"）→ 退回子串匹配，别让用户以为搜不到就是没有。
  // 但纯标点（"!!!"）不算查询，直接当空。
  if (tokens.length) return tokens;
  return /[\p{L}\p{N}]/u.test(raw) ? [raw] : [];
}

/** token 的"含金量"：越长越具体。单字最弱，5 字以上最强。 */
export function tokenWeight(token) {
  const n = String(token).length;
  if (n >= 5) return 2;
  if (n >= 3) return 1.5;
  if (n === 2) return 1;
  return 0.5;
}

/**
 * 在文本里找出各 token 的出现位置（大小写不敏感、不重叠、按位置排序）。
 * 给 CLI 上色用；也用于判断"命中在哪"。
 *
 * @returns {Array<{token: string, start: number, end: number}>}
 */
export function findMatches(text, tokens) {
  const hay = String(text ?? '').toLowerCase();
  const spans = [];
  for (const token of tokens) {
    if (!token) continue;
    const re = new RegExp(escapeRe(token), 'g');
    let m;
    while ((m = re.exec(hay)) !== null) {
      spans.push({ token, start: m.index, end: m.index + token.length });
      if (m.index === re.lastIndex) re.lastIndex += 1; // 空匹配保护
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let cursor = -1;
  for (const s of spans) {
    if (s.start >= cursor) {
      out.push(s);
      cursor = s.end;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 打分 */

/** 字段权重：结构化字段比正文值钱，结论行比正文值钱。 */
export const FIELD_WEIGHTS = { key: 6, tags: 4, conclusion: 3, body: 1 };

/**
 * **层级权重**：行级层（流水 / 会话索引 / 派生索引）整体降权。
 *
 * 为什么：那些层是**逐行**当文档的，一行又长又杂，能同时命中好几个 token ——
 * 于是查一个宽泛的词时，它们会把真正的结论条目挤下去。
 * 真机实测（2026-09-23）：查「记忆」返回 21 条命中，其中 **18 条是流水行**，
 * 每条还要渲染 120~200 字节的片段 —— 模型花了上下文，拿到的却大半是过程记录。
 *
 * 只降权、**不隐藏**（`mem recall` / `--where journal` 照样搜得到）。
 */
export const LAYER_WEIGHT = { journal: 0.5, sessions: 0.5, index: 0.5 };

/** 有条目命中时，行级层最多展开这么多条（其余折叠成一条计数）—— 见 `searchLibrary`。 */
export const MAX_LINE_HITS = 5;

/** 同一个字段里同一个 token 重复出现最多数这么多次（防止长篇正文靠刷词霸榜）。 */
const MAX_OCCURRENCES = 3;

/** 整串短语命中加成（比零散 token 更有说服力）。 */
const PHRASE_BONUS = { conclusion: 8, body: 4 };

const countOccurrences = (hay, token) => {
  if (!hay || !token) return 0;
  let n = 0;
  let i = hay.indexOf(token);
  while (i !== -1 && n < MAX_OCCURRENCES) {
    n += 1;
    i = hay.indexOf(token, i + token.length);
  }
  return n;
};

/**
 * 给一条文档打分。
 *
 * @param {{id?: string, key?: string|null, tags?: string[], conclusion?: string, text?: string}} doc
 * @param {string[]} tokens tokenizeQuery 的结果
 * @param {{phrase?: string}} [opts] phrase 为归一化后的整串查询（给短语加成用）
 * @returns {{score: number, matched: string[]}}
 */
export function scoreDoc(doc, tokens, opts = {}) {
  const key = String(doc.key ?? '').toLowerCase();
  const id = String(doc.id ?? '').toLowerCase();
  // ⚠️ 这里**故意再兜一次**：`searchLibrary` 是给外部用的，调用方可能自己拼 doc
  // （测试夹具、别处的集成）。读边界（`coerceField`）已经保证从磁盘读出来的 tags 是数组，
  // 但直接传进来的不是 —— 一个标量就会让整条检索 TypeError（2026-09-23 实测）。
  const tags = (Array.isArray(doc.tags) ? doc.tags : doc.tags ? [doc.tags] : []).join(' ').toLowerCase();
  const conclusion = String(doc.conclusion ?? '').toLowerCase();
  // 正文里挖掉结论行 —— 否则结论里的命中会被算两遍（结论权重更高，语义就糊了）
  let body = String(doc.text ?? '').toLowerCase();
  if (conclusion) {
    const at = body.indexOf(conclusion);
    if (at !== -1) body = body.slice(0, at) + body.slice(at + conclusion.length);
  }

  let score = 0;
  const matched = [];
  for (const token of tokens) {
    const w = tokenWeight(token);
    const structural = countOccurrences(key, token) + countOccurrences(id, token);
    const inTags = countOccurrences(tags, token);
    const inConclusion = countOccurrences(conclusion, token);
    const inBody = countOccurrences(body, token);

    const gained =
      w *
      (structural * FIELD_WEIGHTS.key + inTags * FIELD_WEIGHTS.tags + inConclusion * FIELD_WEIGHTS.conclusion + inBody * FIELD_WEIGHTS.body);

    if (gained > 0) {
      matched.push(token);
      score += gained;
    }
  }

  const phrase = String(opts.phrase ?? '').toLowerCase();
  if (phrase) {
    if (conclusion.includes(phrase)) score += PHRASE_BONUS.conclusion;
    if (body.includes(phrase)) score += PHRASE_BONUS.body;
  }

  return { score, matched };
}

/* ------------------------------------------------------------------ 片段 */

/** 片段窗口宽度（字符数）。 */
export const SNIPPET_WIDTH = 160;

/**
 * 挑出最该给人看的那一行，并在命中位置附近开窗。
 *
 * @returns {{line: string, snippet: string, matched: string[]}}
 */
export function bestSnippet(doc, tokens, { width = SNIPPET_WIDTH } = {}) {
  const raw = String(doc.text ?? doc.conclusion ?? '');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('---') && !/^[a-z_]+:\s/i.test(l));

  let best = { line: '', matches: [], score: -1 };
  for (const line of lines) {
    const matches = findMatches(line, tokens);
    // 命中种类优先、其次命中次数、再其次靠前
    const kinds = new Set(matches.map((m) => m.token)).size;
    const score = kinds * 100 + matches.length;
    if (score > best.score) best = { line, matches, score };
  }

  if (!best.line) best = { line: String(doc.conclusion ?? '').trim(), matches: findMatches(String(doc.conclusion ?? ''), tokens), score: 0 };
  if (!best.line) return { line: '', snippet: '', matched: [] };

  const line = best.line;
  let snippet = line;
  if (line.length > width) {
    const first = best.matches.length ? best.matches[0].start : 0;
    let start = Math.max(0, first - Math.floor(width / 3));
    let end = Math.min(line.length, start + width);
    if (end === line.length) start = Math.max(0, end - width);
    snippet = `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
  }

  return { line, snippet, matched: [...new Set(best.matches.map((m) => m.token))] };
}

/* ------------------------------------------------------------------ 排序 */

/**
 * 检索 + 排序。
 *
 * 过滤规则：至少要命中一半的 token（至少 1 个）—— 这样"两个关键词只中一个"仍能作为
 * 弱命中返回，但"只中一个 bigram 的无关文档"会被挡掉。
 *
 * @param {Array<object>} docs 每条至少含 {id, text}；可有 key/tags/conclusion/where/date
 * @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {Array<object>} 每条 = 原文档 + {score, matched, snippet, line}
 */
export function rankDocs(docs, query, { limit } = {}) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) return [];
  const phrase = String(query ?? '').toLowerCase().trim();
  const need = Math.max(1, Math.ceil(tokens.length / 2));

  const scored = [];
  for (const doc of docs) {
    const { score, matched } = scoreDoc(doc, tokens, { phrase });
    if (score <= 0 || matched.length < need) continue;
    const snip = bestSnippet(doc, tokens);
    // 行级层（流水/会话索引）整体降权 —— 见 LAYER_WEIGHT 的说明
    const weighted = score * (LAYER_WEIGHT[doc.where] ?? 1);
    scored.push({ ...doc, score: weighted, matched, snippet: snip.snippet, line: snip.line || String(doc.conclusion ?? '').trim() });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.matched.length - a.matched.length ||
      String(b.date ?? '').localeCompare(String(a.date ?? '')) || // 新条目优先
      String(a.id ?? '').localeCompare(String(b.id ?? '')), // 稳定收尾，保证结果可复现
  );

  return Number.isFinite(limit) ? scored.slice(0, Number(limit)) : scored;
}
