#!/usr/bin/env node
/**
 * 检索模块（src/search.mjs）的单元测试 —— 纯逻辑，不碰文件系统、不依赖 DSH。
 * 跑：node test/search-tests.mjs
 *
 * 重点覆盖三件"以前做不到"的事：
 *   1. 中文连写能命中（"沙箱禁管道" → 沙箱/箱禁/禁管/管道 四个 bigram）
 *   2. 命中有**顺序**（结构字段 > 结论 > 正文，整串短语再加成）
 *   3. 命中片段落到"最该看的那一行"，而不是正文第一行
 */

import {
  FIELD_WEIGHTS,
  SNIPPET_WIDTH,
  bestSnippet,
  findMatches,
  rankDocs,
  scoreDoc,
  tokenWeight,
  tokenizeQuery,
} from '../src/search.mjs';

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const doc = (extra) => ({ id: 'd', conclusion: '', text: '', ...extra });

/* ------------------------------------------------------------------ 分词 */

section('分词：ASCII / 中文 bigram / 标点 / 虚词');
{
  check('ASCII 小写化', eq(tokenizeQuery('rmSync'), ['rmsync']));
  check('下划线保留（标识符要能整串搜）', eq(tokenizeQuery('verify_when'), ['verify_when']));
  check('点号保留（cordis.patch.yml）', eq(tokenizeQuery('cordis.patch.yml'), ['cordis.patch.yml']));
  check('空查询 → 空数组', eq(tokenizeQuery('   '), []));

  check('中文连写切 bigram', eq(tokenizeQuery('沙箱禁管道'), ['沙箱', '箱禁', '禁管', '管道']));
  check('中文两字就是一个 bigram', eq(tokenizeQuery('管道'), ['管道']));
  check('单字中文保留（不是虚词）', eq(tokenizeQuery('坑'), ['坑']));
  check('虚词单字被丢掉', eq(tokenizeQuery('给 DSH 装本地插件'), ['dsh', '装本', '本地', '地插', '插件']));
  check('全是虚词时退化为整串（等于老的子串匹配）', eq(tokenizeQuery('的'), ['的']));
  check('空白分词', eq(tokenizeQuery('沙箱 管道'), ['沙箱', '管道']));
  check('中文标点也分词', eq(tokenizeQuery('沙箱，管道'), ['沙箱', '管道']));
  check('中英混排（无空格）', eq(tokenizeQuery('沙箱dsh'), ['沙箱', 'dsh']));
  check('重复 bigram 去重', eq(tokenizeQuery('沙箱沙箱'), ['沙箱', '箱沙']));
  check('无关字符被忽略', eq(tokenizeQuery('!!!'), []));

  check('token 权重随长度递增', tokenWeight('管') < tokenWeight('管道') && tokenWeight('管道') < tokenWeight('沙箱禁') && tokenWeight('沙箱禁') <= tokenWeight('cordis.patch'));
}

/* ------------------------------------------------------------- 命中定位 */

section('findMatches：位置、大小写、不重叠');
{
  const text = 'DSH 沙箱禁止命名管道';
  const m = findMatches(text, ['沙箱', '管道']);
  check('两个 token 都找到', m.length === 2, JSON.stringify(m));
  check('位置正确', text.slice(m[0].start, m[0].end) === '沙箱' && text.slice(m[1].start, m[1].end) === '管道', JSON.stringify(m));
  check('按位置排序', m[0].start < m[1].start);
  check('大小写不敏感', findMatches('RmSync', ['rmsync']).length === 1);

  const overlap = findMatches('沙箱', ['沙箱', '箱']);
  check('重叠命中只留一个（不重复标记）', overlap.length === 1 && overlap[0].token === '沙箱', JSON.stringify(overlap));
  check('没命中就是空数组', eq(findMatches('abc', ['zz']), []));
}

/* ------------------------------------------------------------------ 打分 */

section('scoreDoc：结构字段 > 结论 > 正文');
{
  const tokens = tokenizeQuery('sandbox');
  const byKey = scoreDoc(doc({ key: 'sandbox-no-pipe', text: '无关' }), tokens);
  const byBody = scoreDoc(doc({ text: 'sandbox 只是正文里提了一次' }), tokens);
  check('key 命中比正文命中值钱', byKey.score > byBody.score, `${byKey.score} vs ${byBody.score}`);
  check('tags 命中也在结构层', scoreDoc(doc({ tags: ['sandbox'] }), tokens).score >= FIELD_WEIGHTS.tags * 1.5);

  const t2 = tokenizeQuery('管道');
  const inConclusion = scoreDoc(doc({ conclusion: '沙箱禁管道', text: '沙箱禁管道\n\n## 理由\n别的' }), t2);
  const inBodyOnly = scoreDoc(doc({ conclusion: '无关结论', text: '无关结论\n\n## 理由\n管道' }), t2);
  check('结论命中 > 正文命中', inConclusion.score > inBodyOnly.score, `${inConclusion.score} vs ${inBodyOnly.score}`);
  check('结论行不会被重复计分（正文里已挖掉）', inConclusion.score === FIELD_WEIGHTS.conclusion, String(inConclusion.score));

  const repeated = scoreDoc(doc({ text: '坑 '.repeat(20) }), tokenizeQuery('坑'));
  check('同一 token 在正文里最多计 3 次（防刷词）', repeated.score === 1 * FIELD_WEIGHTS.body * 0.5 * 3, String(repeated.score));

  const phrase = scoreDoc(doc({ text: '沙箱禁止命名管道' }), tokenizeQuery('沙箱禁止'), { phrase: '沙箱禁止' });
  const scattered = scoreDoc(doc({ text: '沙箱与禁止是两回事' }), tokenizeQuery('沙箱禁止'), { phrase: '沙箱禁止' });
  check('整串短语命中加成', phrase.score > scattered.score, `${phrase.score} vs ${scattered.score}`);
  check('matched 里列出命中的 token', phrase.matched.includes('沙箱') && phrase.matched.includes('禁止'), JSON.stringify(phrase.matched));
  check('完全不相干 → 0 分', scoreDoc(doc({ text: '无关' }), tokenizeQuery('管道')).score === 0);
}

/* ------------------------------------------------------------------ 片段 */

section('bestSnippet：挑最该看的那一行');
{
  const d = doc({
    conclusion: '沙箱禁管道',
    text: [
      '沙箱禁管道',
      '',
      '## 理由',
      '因为命名管道在沙箱里会 EPERM，所以要用别的方式。',
      '真正讲管道的地方在这里，另一处也提到管道。',
    ].join('\n'),
  });
  const s = bestSnippet(d, tokenizeQuery('管道'));
  check('选中命中最多的那一行', s.line.includes('真正讲管道'), s.line);
  check('片段非空且带 matched', s.snippet.length > 0 && s.matched.includes('管道'), JSON.stringify(s.matched));

  check('跳过标题行与 frontmatter', !bestSnippet(doc({ text: '## 标题\nid: x\n管道在这' }), tokenizeQuery('管道')).line.startsWith('##'));

  const long = doc({ text: `${'前'.repeat(300)}管道${'后'.repeat(300)}` });
  const cut = bestSnippet(long, tokenizeQuery('管道'));
  check(`超长行开窗到 ${SNIPPET_WIDTH} 字左右`, cut.snippet.length <= SNIPPET_WIDTH + 2, String(cut.snippet.length));
  check('开窗保留命中词', cut.snippet.includes('管道'), cut.snippet.slice(0, 40));
  check('两侧都有省略号提示', cut.snippet.startsWith('…') && cut.snippet.endsWith('…'), `${cut.snippet.slice(0, 12)} … ${cut.snippet.slice(-12)}`);
}

/* ------------------------------------------------------------- 排序与过滤 */

section('rankDocs：排序、阈值过滤、稳定');
{
  // 用英文查询来验「结构字段更值钱」—— 中文查询永远命中不了 [a-z0-9._-] 的 key
  const keyDocs = [
    doc({ id: 'body-mention', text: '顺便提一句 sandbox' }),
    doc({ id: 'key-hit', key: 'sandbox-no-pipe', conclusion: '沙箱相关', text: '沙箱相关' }),
    doc({ id: 'irrelevant', text: '完全无关的内容' }),
  ];
  const keyHits = rankDocs(keyDocs, 'sandbox');
  check('key 命中排在纯正文命中前面', keyHits[0].id === 'key-hit', keyHits.map((h) => `${h.id}:${h.score.toFixed(1)}`).join(' '));
  check('不相关的被过滤掉', !keyHits.some((h) => h.id === 'irrelevant'), keyHits.map((h) => h.id).join(','));

  // 中文查询：命中的 token 数决定谁靠前
  const zhDocs = [
    doc({ id: 'one-bigram', text: '只说沙箱' }),
    doc({ id: 'two-bigrams', text: '沙箱里不能用管道' }),
    doc({ id: 'three-bigrams', conclusion: '沙箱禁止命名管道', text: '沙箱禁止命名管道' }),
  ];
  const zhHits = rankDocs(zhDocs, '沙箱禁管道');
  check('命中的 token 越多分越高', zhHits[0].id === 'three-bigrams', zhHits.map((h) => `${h.id}:${h.score.toFixed(1)}`).join(' '));
  check('只中一个 bigram 的（不足一半）被挡掉', !zhHits.some((h) => h.id === 'one-bigram'), zhHits.map((h) => h.id).join(','));
  check('每条都带 score/matched/snippet/line', zhHits.every((h) => typeof h.score === 'number' && Array.isArray(h.matched) && typeof h.snippet === 'string' && typeof h.line === 'string'));

  check('limit 生效', rankDocs(zhDocs, '沙箱禁管道', { limit: 1 }).length === 1);
  check('空查询 → 空结果', eq(rankDocs(zhDocs, '  '), []));

  // 阈值：4 个 bigram 的查询只中 1 个 → 当成噪声丢掉；中一半则保留
  const noisy = [doc({ id: 'weak', text: '这里只出现"管道"一个词' })];
  check('命中不足一半的文档被过滤', rankDocs(noisy, '沙箱禁止命名管道').length === 0, JSON.stringify(rankDocs(noisy, '沙箱禁止命名管道').map((h) => h.score)));
  check('命中一半就保留', rankDocs([doc({ id: 'half', text: '沙箱与管道' })], '沙箱管道').length === 1);

  // 同分时：新的在前，然后按 id —— 结果必须可复现
  const tie = [doc({ id: 'b', conclusion: '管道', date: '2026-01-01' }), doc({ id: 'a', conclusion: '管道', date: '2026-09-01' })];
  const first = rankDocs(tie, '管道').map((h) => h.id);
  check('同分时新条目优先', first[0] === 'a', first.join(','));
  check('排序可复现（跑两次一致）', eq(rankDocs(tie, '管道').map((h) => h.id), first));
}

/* --------------------------------------------------------- 层级权重（行级层降权） */

section('层级权重：流水/会话索引降权，不再把结论条目挤下去');
{
  const entry = doc({ id: 'e', where: 'facts', conclusion: '沙箱禁止命名管道', text: '沙箱禁止命名管道' });
  const line = doc({ id: 'j', where: 'journal', conclusion: '沙箱禁止命名管道', text: '沙箱禁止命名管道' });
  const hits = rankDocs([line, entry], '沙箱禁管道');
  check('同样内容：条目排在流水前面', hits[0].id === 'e', hits.map((h) => `${h.id}:${h.score}`).join(' '));
  check('流水正好降一半', Math.abs(hits.find((h) => h.id === 'j').score * 2 - hits.find((h) => h.id === 'e').score) < 1e-9, hits.map((h) => `${h.id}:${h.score}`).join(' '));
  const sessions = rankDocs([doc({ id: 's', where: 'sessions', text: '沙箱禁止命名管道' })], '沙箱禁管道');
  check('会话索引同样降权（3 分 → 1.5 分）', sessions[0].score === 1.5, String(sessions[0].score));
  const facts = rankDocs([doc({ id: 'f', where: 'facts', text: '沙箱禁止命名管道' })], '沙箱禁管道');
  check('条目层不受影响（权重 1，3 分）', facts[0].score === 3, String(facts[0].score));
}

/* --------------------------------------------------------- 真实中文场景 */

section('真实场景：老问题在新实现下能搜到');
{
  const store = [
    doc({
      id: 'sandbox-no-pipe',
      key: 'sandbox-no-pipe',
      tags: ['dsh', 'sandbox', 'node'],
      conclusion: 'DSH 沙箱禁止命名管道：node 用 spawnSync 捕获子进程输出会 EPERM，要重定向到文件',
      text: 'DSH 沙箱禁止命名管道：node 用 spawnSync 捕获子进程输出会 EPERM，要重定向到文件\n\n## 理由\n实测 stdio:pipe 直接 EPERM。',
    }),
    doc({
      id: 'node-rm-nonascii',
      key: 'node-rm-nonascii',
      conclusion: '路径含非 ASCII 字符时 Node 的 fs.rmSync 会静默失败，必须用 unlinkSync',
      text: '路径含非 ASCII 字符时 Node 的 fs.rmSync 会静默失败，必须用 unlinkSync',
    }),
  ];

  check('中文连写查询命中（老实现必然落空）', rankDocs(store, '沙箱禁管道')[0].id === 'sandbox-no-pipe');
  check('拆成词也命中', rankDocs(store, '沙箱 管道')[0].id === 'sandbox-no-pipe');
  check('英文标识符命中', rankDocs(store, 'rmsync')[0].id === 'node-rm-nonascii');
  check('混排查询命中', rankDocs(store, 'node 命名管道')[0].id === 'sandbox-no-pipe');
  check('错误关键词不命中', rankDocs(store, '数据库迁移').length === 0);
}

/* ------------------------------------------------------------- 汇总 */
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
