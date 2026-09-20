#!/usr/bin/env node
/**
 * dsh-memory-delta 测试 —— 零依赖，直接 `node test/run-tests.mjs`
 *
 * 两处沙箱坑都固化在这里了（详见每处的注释）：
 *   1. 「非 ASCII 路径」那组是**回归测试**：路径含非 ASCII 字符时 `fs.rmSync` 会静默失败
 *      甚至崩进程（0xC0000409），所以 CLI 用 `unlinkSync`；测试自己也用 `unlinkSync`。
 *   2. `run()` 不用管道捕获子进程输出：DSH 沙箱禁止命名管道，`spawnSync` 默认
 *      `stdio:'pipe'` 会 EPERM。改成重定向到文件。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem.mjs');
const SANDBOX = process.env.MEM_TEST_SANDBOX || path.join(HERE, '..', `.test-sandbox-${process.pid}`);

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

/**
 * 递归删除 —— 故意不用 `fs.rmSync`。
 * 实测（Node 24 + DSH 沙箱）：路径含非 ASCII 字符时 rmSync 会静默失败，配 recursive
 * 时甚至会直接把进程打死（0xC0000409）。`unlinkSync` + `rmdirSync` 则稳定可用。
 */
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(p)) rmrf(path.join(p, entry));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

/** 跑一次 CLI。输出重定向到文件而不是管道（沙箱禁止命名管道 → EPERM）。 */
function run(args) {
  const outFile = path.join(SANDBOX, '.last-out.txt');
  const errFile = path.join(SANDBOX, '.last-err.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const r = spawnSync(process.execPath, [MEM, ...args], {
    stdio: ['ignore', outFd, errFd],
    env: { ...process.env, NO_COLOR: '1' },
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const out = fs.readFileSync(outFile, 'utf8');
  const err = fs.readFileSync(errFile, 'utf8');
  if (r.error) throw new Error(`无法启动 CLI：${r.error.code} ${r.error.message}`);
  return { code: r.status, out, err };
}

function freshRoot(label) {
  const root = path.join(SANDBOX, label);
  rmrf(root);
  return root;
}

function md(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
}

const section = (t) => console.log(`\n${t}`);
const flat = (s, n = 220) => s.replace(/\s+/g, ' ').trim().slice(0, n);

rmrf(SANDBOX);
fs.mkdirSync(SANDBOX, { recursive: true });

/* ------------------------------------------------------------ 基础流程 */
section('基础流程（ASCII 路径）');
{
  const root = freshRoot('basic');

  let r = run(['init', '--root', root]);
  check('init 成功', r.code === 0, r.err);
  check('init 建出四个目录', ['facts', 'decisions', 'inbox', 'archive'].every((d) => fs.existsSync(path.join(root, d))));
  check('init 生成 config 与 journal', fs.existsSync(path.join(root, 'memory.config.json')) && fs.existsSync(path.join(root, 'journal.md')));

  r = run(['new', '--root', root, '--type', 'fact', '--conclusion', '结论一', '--reason', '理由一', '--tags', 'a,b', '--source', 's1']);
  check('new 成功', r.code === 0, r.err);
  check('new 落在 inbox', md(path.join(root, 'inbox')).length === 1);

  const idA = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  const raw = fs.readFileSync(path.join(root, 'inbox', `${idA}.md`), 'utf8');
  check('frontmatter 含 id/type/status', /^---\n/.test(raw) && raw.includes(`id: ${idA}`) && raw.includes('type: fact') && raw.includes('status: active'));
  check('tags 解析为数组', raw.includes('tags: [a, b]'));

  r = run(['promote', '--root', root, idA]);
  check('promote 成功', r.code === 0, r.err);
  check('promote 后 inbox 为空（没有幽灵重复）', md(path.join(root, 'inbox')).length === 0, `inbox 仍有 ${md(path.join(root, 'inbox')).join(',')}`);
  check('promote 后 facts 有 1 条', md(path.join(root, 'facts')).length === 1);

  run(['new', '--root', root, '--type', 'fact', '--conclusion', '结论二', '--tags', 'a,b', '--source', 's2']);
  const idB = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  r = run(['promote', '--root', root, idB, '--supersedes', idA]);
  check('promote --supersedes 成功', r.code === 0, r.err);
  check('旧条目已归档', md(path.join(root, 'archive')).some((f) => f.startsWith(idA)));
  check('旧条目不在 facts', !md(path.join(root, 'facts')).some((f) => f.startsWith(idA)));

  const newRaw = fs.readFileSync(path.join(root, 'facts', `${idB}.md`), 'utf8');
  const oldRaw = fs.readFileSync(path.join(root, 'archive', `${idA}.md`), 'utf8');
  check('新条目记录了 supersedes', newRaw.includes(`supersedes: [${idA}]`), flat(newRaw.split('---')[1]));
  check('旧条目被标 superseded', oldRaw.includes('status: superseded'), flat(oldRaw.split('---')[1]));
  check('旧条目记录了 superseded_by', oldRaw.includes(`superseded_by: ${idB}`), flat(oldRaw.split('---')[1]));

  run(['index', '--root', root]);
  r = run(['inject', '--root', root]);
  // 注入正文里只有结论（id 不占预算，它随 source.entries 走结构化通道）
  check('inject 只含 active（被取代的不出现）', r.out.includes('结论二') && !r.out.includes('结论一'), flat(r.out));
  check('inject 正文不写 id（省预算）', !r.out.includes('<!--') && !r.out.includes(idB), flat(r.out));
  check('inject 与 validate 用同一套渲染（字节数才对得上）', r.out.includes('dsh-memory-delta 记录的项目长期记忆'), flat(r.out).slice(0, 80));
  const payable = JSON.parse(run(['inject', '--root', root, '--json']).out);
  check('--json 的 text 与 CLI 输出同源', payable.text.includes('结论二') && Buffer.byteLength(payable.text, 'utf8') === payable.bytes, `${payable.bytes}`);

  r = run(['validate', '--root', root]);
  const valOut = r.out + r.err;
  check('validate 通过', r.code === 0 && (/全部通过/.test(valOut) || /0 个问题/.test(valOut)), flat(valOut));

  r = run(['recall', '--root', root, '结论二']);
  check('recall 命中条目', r.code === 0 && r.out.includes(idB), flat(r.out));

  r = run(['journal', 'add', '--root', root, '流水一行']);
  check('journal add 成功', r.code === 0 && fs.readFileSync(path.join(root, 'journal.md'), 'utf8').includes('流水一行'), r.err);
}

/* ----------------------------------------- 回归：路径含非 ASCII 字符 */
section('回归测试：路径含非 ASCII（中文）');
{
  const root = freshRoot('中文路径的仓库');
  let r = run(['init', '--root', root]);
  check('非 ASCII 路径 init 成功', r.code === 0, r.err);
  run(['new', '--root', root, '--type', 'fact', '--conclusion', '中文路径下的条目', '--source', 's']);
  const id = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  r = run(['promote', '--root', root, id]);
  check('非 ASCII 路径 promote 成功', r.code === 0, r.err);
  check('非 ASCII 路径 inbox 已清空', md(path.join(root, 'inbox')).length === 0, `残留 ${md(path.join(root, 'inbox')).join(',')}`);
  check('非 ASCII 路径 facts 有条目', md(path.join(root, 'facts')).length === 1);

  // 中文条目名 + 后续 supersede，覆盖"改完再写盘"的路径
  run(['new', '--root', root, '--type', 'fact', '--conclusion', '中文条目二', '--source', 's2']);
  const id2 = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  r = run(['promote', '--root', root, id2, '--supersedes', id]);
  check('非 ASCII 路径下 supersede 成功', r.code === 0, r.err);
  check('非 ASCII 路径下旧条目已归档', md(path.join(root, 'archive')).some((f) => f.startsWith(id)));
}

/* --------------------------------------------------------- validate 抓错 */
section('validate 能抓到的问题');
{
  const root = freshRoot('bad');
  run(['init', '--root', root]);
  run(['new', '--root', root, '--type', 'fact', '--conclusion', '正常条目', '--source', 's']);
  const goodId = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');

  fs.writeFileSync(
    path.join(root, 'facts', 'broken.md'),
    ['---', 'id: broken', 'type: fact', 'scope: workspace:x', 'status: active', 'date: 2026-01-01', 'superseded_by: 不存在的东西', '---', '', '## 结论', '坏的', ''].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'facts', 'nofields.md'), ['---', 'id: nofields', '---', '', '## 结论', '缺字段', ''].join('\n'), 'utf8');
  // 文件名与 frontmatter 里的 id 故意不一致
  fs.writeFileSync(
    path.join(root, 'facts', 'mismatch.md'),
    ['---', 'id: 完全不同的id', 'type: fact', 'scope: workspace:x', 'status: active', 'date: 2026-01-01', '---', '', '## 结论', '文件名与 id 不一致', ''].join('\n'),
    'utf8',
  );

  const r = run(['validate', '--root', root]);
  const all = r.out + r.err;
  check('validate 报出问题（退出码 1）', r.code === 1, `code=${r.code}`);
  check('抓到 superseded_by 悬空引用', /superseded_by 指向不存在/.test(all), flat(all));
  check('抓到缺必填字段', /缺少必填字段/.test(all), flat(all));
  check('抓到 id 与文件名不一致', /id 与文件名不一致/.test(all), flat(all));

  rmrf(path.join(root, 'facts', 'broken.md'));
  rmrf(path.join(root, 'facts', 'nofields.md'));
  rmrf(path.join(root, 'facts', 'mismatch.md'));
  run(['promote', '--root', root, goodId]);
  run(['index', '--root', root]);
  const r2 = run(['validate', '--root', root]);
  check('修好后 validate 通过', r2.code === 0, flat(r2.out + r2.err));
}

/* --------------------------------------------------------- 注入预算 */
section('注入预算');
{
  const root = freshRoot('budget');
  run(['init', '--root', root]);
  for (let i = 0; i < 5; i += 1) {
    run(['new', '--root', root, '--type', 'fact', '--conclusion', `第 ${i} 条比较长的结论，用来撑大注入体积`, '--source', 's']);
    const id = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
    run(['promote', '--root', root, id]);
  }
  const r = run(['inject', '--root', root, '--budget', '50']);
  check('超预算时 inject 报错', r.code === 1, `code=${r.code}`);
  check('超预算信息含用量', /\d+ \/ 50 字节/.test(r.out + r.err), flat(r.out + r.err));
}

/* ------------------------------------------------- M2：语义键 key */
section('M2：语义键 key 与「一个 key 一个真相」');
{
  const root = freshRoot('key');
  run(['init', '--root', root, '--scope', 'workspace:x']);

  let r = run(['new', '--root', root, '--type', 'fact', '--id', 'budget-50', '--key', 'inject-budget', '--conclusion', '预算 50 字节', '--source', 's']);
  check('new --id 使用显式短 id', r.code === 0 && md(path.join(root, 'inbox'))[0] === 'budget-50.md', r.err);

  r = run(['new', '--root', root, '--type', 'fact', '--id', 'bad key!', '--conclusion', 'x', '--source', 's']);
  check('非法 id 被拒绝', r.code === 1, flat(r.err + r.out));

  r = run(['new', '--root', root, '--type', 'fact', '--id', 'k1', '--key', 'Bad Key!', '--conclusion', 'x', '--source', 's']);
  check('非法 key 被拒绝', r.code === 1 && /key 只允许/.test(r.err + r.out), flat(r.err + r.out));

  r = run(['promote', '--root', root, 'budget-50']);
  check('带 key 首次 promote 成功', r.code === 0, r.err);

  run(['new', '--root', root, '--type', 'fact', '--id', 'budget-100', '--key', 'inject-budget', '--conclusion', '预算 100 字节', '--source', 's2']);
  r = run(['promote', '--root', root, 'budget-100']);
  check('同 key 已有 active 时 promote 被拒绝', r.code === 1 && /一个 key 只能有一个真相/.test(r.err + r.out), flat(r.err + r.out));
  check('被拒绝后条目仍留在 inbox', md(path.join(root, 'inbox')).includes('budget-100.md'));

  r = run(['promote', '--root', root, 'budget-100', '--supersedes', 'budget-50']);
  check('显式 --supersedes 后放行', r.code === 0, r.err);

  run(['index', '--root', root]);
  r = run(['validate', '--root', root]);
  check('取代后 validate 无问题', r.code === 0, flat(r.out + r.err));

  // 手工造同 key 冲突 → validate 必须当**问题**报，而不是告警
  fs.writeFileSync(
    path.join(root, 'facts', 'budget-999.md'),
    ['---', 'id: budget-999', 'type: fact', 'scope: workspace:x', 'key: inject-budget', 'status: active', 'date: 2026-01-01', '---', '', '## 结论', '另一个预算结论', ''].join('\n'),
    'utf8',
  );
  r = run(['validate', '--root', root]);
  check('validate 把同 key 冲突当问题报出', r.code === 1 && /冲突：同一个 key/.test(r.out + r.err), flat(r.out + r.err));
  rmrf(path.join(root, 'facts', 'budget-999.md'));
}

/* --------------------------------------- M2：id 派生 / 差分载荷 / --fix */
section('M2：id 派生 / inject --json 差分载荷 / validate --fix');
{
  const root = freshRoot('m2');
  run(['init', '--root', root, '--scope', 'workspace:x']);

  const longConclusion = '这是一个很长很长的中文结论用来验证派生 id 不会变成一大串';
  run(['new', '--root', root, '--type', 'fact', '--conclusion', longConclusion, '--source', 's']);
  const derived = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  const slugPart = derived.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  check('派生 id 的 slug 部分 ≤ 20 字符', slugPart.length <= 20, `实际 ${slugPart.length}：${slugPart}`);

  const r = run(['new', '--root', root, '--type', 'fact', '--conclusion', longConclusion, '--source', 's']);
  check('派生 id 撞车时自动加序号（不失败）', r.code === 0 && md(path.join(root, 'inbox')).length === 2, r.err);

  for (const f of md(path.join(root, 'inbox'))) run(['promote', '--root', root, f.replace(/\.md$/, '')]);
  run(['index', '--root', root]);

  const j = run(['inject', '--root', root, '--json']);
  let payload = null;
  try {
    payload = JSON.parse(j.out);
  } catch {
    /* 下面断言会报出来 */
  }
  check('inject --json 是合法 JSON', payload !== null, flat(j.out));
  check('载荷含 version/bytes/budget/entries', !!payload && payload.version === 1 && typeof payload.bytes === 'number' && Array.isArray(payload.entries), flat(j.out));
  check('每条带 12 位 hash', !!payload && payload.entries.length === 2 && payload.entries.every((e) => /^[0-9a-f]{12}$/.test(e.hash)), flat(j.out));

  const h1 = payload.entries[0].hash;
  const j2 = JSON.parse(run(['inject', '--root', root, '--json']).out);
  check('同内容 hash 稳定（差分的前提）', j2.entries[0].hash === h1);

  const someId = payload.entries[0].id;
  const otherId = payload.entries[1].id;
  const file = path.join(root, 'facts', `${someId}.md`);
  const txt = fs
    .readFileSync(file, 'utf8')
    .replace('status: active', 'status: superseded')
    .replace('superseded_by: null', `superseded_by: ${otherId}`);
  fs.writeFileSync(file, txt, 'utf8');
  const fx = run(['validate', '--root', root, '--fix']);
  check('--fix 归档漏归档的 superseded', md(path.join(root, 'archive')).includes(`${someId}.md`), flat(fx.out + fx.err));
  check('--fix 重建了 index', fs.readFileSync(path.join(root, 'index.md'), 'utf8').includes(otherId));
  check('--fix 不做语义修改（双向不一致仍报问题）', fx.code === 1, `code=${fx.code}`);
}

/* --------------------------------------------------------- M2：mem set */
section('M2：mem set 修改已有条目');
{
  const root = freshRoot('set');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  run(['new', '--root', root, '--type', 'fact', '--id', 'e1', '--conclusion', '原始结论', '--tags', 'a', '--source', 's']);
  run(['promote', '--root', root, 'e1']);
  const fileOf = () => fs.readFileSync(path.join(root, 'facts', 'e1.md'), 'utf8');

  let r = run(['set', '--root', root, 'e1', '--key', 'my-key', '--tags', 'a,b', '--verify-when', '半年后']);
  check('set 成功', r.code === 0, r.err);
  check('key 已写入', fileOf().includes('key: my-key'), flat(fileOf().split('---')[1]));
  check('tags 已更新', fileOf().includes('tags: [a, b]'));
  check('verify_when 已写入', fileOf().includes('verify_when: 半年后'));

  r = run(['set', '--root', root, 'e1', '--conclusion', '改过的结论']);
  check('set 替换结论正文', r.code === 0 && fileOf().includes('改过的结论'), r.err);
  check('理由小节保留', fileOf().includes('## 理由'));

  const before = JSON.parse(run(['inject', '--root', root, '--json']).out).entries[0].hash;
  run(['set', '--root', root, 'e1', '--conclusion', '再改一次']);
  const after = JSON.parse(run(['inject', '--root', root, '--json']).out).entries[0].hash;
  check('结论变化 → hash 变化（差分能感知）', before !== after);

  r = run(['set', '--root', root, 'e1']);
  check('无改动时报错', r.code === 1, flat(r.err + r.out));

  r = run(['set', '--root', root, '不存在', '--key', 'x']);
  check('改不存在的条目报错', r.code === 1 && /找不到条目/.test(r.err + r.out), flat(r.err + r.out));

  r = run(['set', '--root', root, 'e1', '--status', 'expired']);
  check('set --status expired', r.code === 0 && fileOf().includes('status: expired'), r.err);
  check('expired 条目不再参与注入', JSON.parse(run(['inject', '--root', root, '--json']).out).entries.length === 0);
}

/* --------------------------------------------------------------- 检索排序 */
section('recall：相关度排序 / 中文 bigram / 分层过滤');
{
  const root = freshRoot('search');
  run(['init', '--root', root, '--scope', 'workspace:x']);

  // 结论里带关键词的（强命中）
  run(['new', '--root', root, '--type', 'fact', '--id', 'pipe-fact', '--key', 'no-pipe', '--conclusion', '沙箱禁止命名管道，要重定向到文件', '--source', 's']);
  run(['promote', '--root', root, 'pipe-fact']);
  // 只在理由里提一句的（弱命中：命中数够过阈值，但分数远低于结论命中）
  run(['new', '--root', root, '--type', 'fact', '--id', 'weak-fact', '--conclusion', '另一个无关结论', '--reason', '顺便提一句沙箱与管道', '--source', 's']);
  run(['promote', '--root', root, 'weak-fact']);
  run(['journal', 'add', '--root', root, '今天又踩了一次管道的坑，记一笔']);
  run(['index', '--root', root]);

  const r = run(['recall', '--root', root, '沙箱禁管道']);
  check('中文连写能命中（老实现必然落空）', r.code === 0 && r.out.includes('pipe-fact'), flat(r.out));
  const ordered = JSON.parse(run(['recall', '--root', root, '沙箱禁管道', '--json']).out);
  check('结论命中排在理由命中前面', ordered.matches.length === 2 && ordered.matches[0].id === 'pipe-fact', JSON.stringify(ordered.matches.map((m) => `${m.id}:${m.score}`)));
  check('分数确实拉开了', ordered.matches[0].score > ordered.matches[1].score, JSON.stringify(ordered.matches.map((m) => m.score)));
  check('结果带命中片段与分数', /score \d/.test(r.out), flat(r.out));
  check('流水行也能被检索到', run(['recall', '--root', root, '管道的坑']).out.includes('journal:'), flat(run(['recall', '--root', root, '管道的坑']).out));

  const only = run(['recall', '--root', root, '管道', '--where', 'facts']);
  check('--where facts 排除流水层', !only.out.includes('journal:'), flat(only.out));
  check('--where index 能单独搜派生索引', run(['recall', '--root', root, '管道', '--where', 'index']).out.includes('index:'), '');

  const j = JSON.parse(run(['recall', '--root', root, '沙箱禁管道', '--json']).out);
  check('--json 是合法结构化结果', j.query === '沙箱禁管道' && Array.isArray(j.matches) && j.matches[0].id === 'pipe-fact', flat(JSON.stringify(j).slice(0, 160)));
  check('--json 每条带 score/matched/snippet', typeof j.matches[0].score === 'number' && Array.isArray(j.matches[0].matched) && !!j.matches[0].snippet, JSON.stringify(j.matches[0]).slice(0, 160));

  const none = run(['recall', '--root', root, '数据库迁移方案']);
  check('搜不到时不硬凑结果', /没有匹配/.test(none.out), flat(none.out));
}

/* --------------------------------------- M3：verify_when 到期复核（mem due） */
section('M3：verify_when 到期复核与 mem due');
{
  const root = freshRoot('due');
  run(['init', '--root', root, '--scope', 'workspace:x']);

  // 空态：没有到期项不算失败（退出码 0），脚本可以直接串起来
  let r = run(['due', '--root', root]);
  check('没有条目时 due 不报错（退出码 0）', r.code === 0, `code=${r.code} ${flat(r.err)}`);
  check('空态提示「没有到期的复核项」', /没有到期的复核项/.test(r.out), flat(r.out));
  const empty = JSON.parse(run(['due', '--root', root, '--json']).out);
  check('空态 --json 合法且 total=0', empty.total === 0 && Array.isArray(empty.due) && /^\d{4}-\d{2}-\d{2}$/.test(empty.today), flat(JSON.stringify(empty)));

  run(['index', '--root', root]);
  r = run(['validate', '--root', root]);
  check('没有到期项时 validate 不报到期告警', !/复核期/.test(r.out + r.err), flat(r.out + r.err));

  // 一条正常条目 + 一条已超期的（2000-01-01，怎么跑都过期）+ 一条未来的
  run(['new', '--root', root, '--type', 'fact', '--id', 'plain', '--conclusion', '没写复核时机的条目', '--source', 's']);
  run(['promote', '--root', root, 'plain']);
  run(['new', '--root', root, '--type', 'fact', '--id', 'overdue', '--conclusion', '早就该复核的条目', '--source', 's']);
  run(['promote', '--root', root, 'overdue']);
  run(['new', '--root', root, '--type', 'fact', '--id', 'future', '--conclusion', '以后才需要复核的条目', '--source', 's']);
  run(['promote', '--root', root, 'future']);

  r = run(['set', '--root', root, 'overdue', '--verify-when', '2000-01-01']);
  check('set --verify-when 成功', r.code === 0, r.err);
  r = run(['set', '--root', root, 'future', '--verify-when', '2099-01-01']);
  check('set 未来的 verify_when 成功', r.code === 0, r.err);

  r = run(['due', '--root', root]);
  check('due 列出已到期条目', r.code === 0 && r.out.includes('overdue'), flat(r.out));
  check('due 不列未来的条目', !r.out.includes('future'), flat(r.out));
  check('due 不列没写 verify_when 的条目', !r.out.includes('plain'), flat(r.out));
  check('due 显示超期天数', /已超期 \d+ 天/.test(r.out), flat(r.out));
  check('due 显示 verify_when 原值', /verify_when: 2000-01-01/.test(r.out), flat(r.out));
  check('due 显示结论正文', /早就该复核的条目/.test(r.out), flat(r.out));

  const j = JSON.parse(run(['due', '--root', root, '--json']).out);
  check('due --json 是合法 JSON', j.total === 1 && j.due[0].id === 'overdue', flat(JSON.stringify(j)));
  check('due --json 带 overdueDays / verifyWhen / due / line', typeof j.due[0].overdueDays === 'number' && j.due[0].verifyWhen === '2000-01-01' && j.due[0].due === '2000-01-01' && !!j.due[0].line, flat(JSON.stringify(j.due[0])));
  check('due --json 的 overdueDays 是正数（已超期）', j.due[0].overdueDays > 0, String(j.due[0].overdueDays));

  // --within 生效：36500 天足够把 2099 那条也圈进来
  const wide = JSON.parse(run(['due', '--root', root, '--within', '36500', '--json']).out);
  check('--within 生效（把未来的条目也算进来）', wide.total === 2 && wide.due.some((d) => d.id === 'future'), flat(JSON.stringify(wide.due.map((d) => d.id))));
  check('--within 时未到期条目 overdueDays 为负', wide.due.find((d) => d.id === 'future').overdueDays < 0, String(wide.due.find((d) => d.id === 'future').overdueDays));
  check('--within 只影响过滤、不改排序（超期的仍在最前）', wide.due[0].id === 'overdue', flat(JSON.stringify(wide.due.map((d) => d.id))));
  const narrow = JSON.parse(run(['due', '--root', root, '--within', '1', '--json']).out);
  check('--within 1 仍只看到已超期的那条', narrow.total === 1, flat(JSON.stringify(narrow.due.map((d) => d.id))));

  // 相对写法：以**条目自己的 date** 为基准（条目就是今天建的，所以 3 个月后 ≈ today + 3 个月）
  r = run(['set', '--root', root, 'future', '--verify-when', '3个月后']);
  check('set 支持相对写法（3个月后）', r.code === 0, r.err);
  const rel = JSON.parse(run(['due', '--root', root, '--within', '36500', '--json']).out);
  const relFuture = rel.due.find((d) => d.id === 'future');
  check('相对写法把原值带出来、同时给出算好的 due', relFuture.verifyWhen === '3个月后' && /^\d{4}-\d{2}-\d{2}$/.test(String(relFuture.due)), flat(JSON.stringify(relFuture)));
  check('相对写法算出的 due 晚于今天（条目刚建）', relFuture.due > rel.today, `${relFuture.due} vs ${rel.today}`);

  // validate：到期当**告警**报，绝不影响退出码
  r = run(['validate', '--root', root]);
  check('validate 报出到期告警', /1 条记忆到了 verify_when 复核期/.test(r.out + r.err), flat(r.out + r.err));
  check('到期告警不影响 validate 退出码（仍是 0）', r.code === 0, `code=${r.code} ${flat(r.out + r.err)}`);
  check('告警提示跑 mem due', /跑 mem due 看明细/.test(r.out + r.err), flat(r.out + r.err));

  // 收尾：把到期条目标 expired 后，due 与告警都该干净
  run(['set', '--root', root, 'overdue', '--status', 'expired']);
  r = run(['due', '--root', root]);
  check('expired 条目不再出现在 due 里', r.code === 0 && /没有到期的复核项/.test(r.out), flat(r.out));
  r = run(['validate', '--root', root]);
  check('处理完之后 validate 没有到期告警', !/复核期/.test(r.out + r.err), flat(r.out + r.err));
}

/* --------------------------------------- 注入载荷带上 date / verifyWhen */
section('注入载荷：每条带 date 与 verifyWhen（只增不改）');
{
  const root = freshRoot('payload');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  run(['new', '--root', root, '--type', 'fact', '--id', 'p1', '--conclusion', '带复核时机的条目', '--source', 's']);
  run(['promote', '--root', root, 'p1']);
  run(['set', '--root', root, 'p1', '--verify-when', '3个月后']);
  run(['new', '--root', root, '--type', 'decision', '--id', 'p2', '--conclusion', '不带复核时机的条目', '--source', 's']);
  run(['promote', '--root', root, 'p2']);
  run(['index', '--root', root]);

  const payload = JSON.parse(run(['inject', '--root', root, '--json']).out);
  check('载荷仍是 2 条', payload.entries.length === 2, String(payload.entries.length));
  check('每条都带 date 字段', payload.entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(String(e.date))), flat(JSON.stringify(payload.entries.map((e) => e.date))));
  check('每条都带 verifyWhen 键（没写的为 null）', payload.entries.every((e) => 'verifyWhen' in e), flat(JSON.stringify(payload.entries.map((e) => e.verifyWhen))));
  check('写了 verify_when 的原样带出', payload.entries.find((e) => e.id === 'p1').verifyWhen === '3个月后', flat(JSON.stringify(payload.entries.find((e) => e.id === 'p1'))));
  check('没写 verify_when 的是 null', payload.entries.find((e) => e.id === 'p2').verifyWhen === null, flat(JSON.stringify(payload.entries.find((e) => e.id === 'p2'))));
  check('原有字段一个都没少（id/type/scope/key/tags/status/where/hash/line）',
    payload.entries.every((e) => ['id', 'type', 'scope', 'key', 'tags', 'status', 'where', 'hash', 'line'].every((k) => k in e)),
    flat(JSON.stringify(Object.keys(payload.entries[0]))));
  check('hash 仍是 12 位（差分不受新字段影响）', payload.entries.every((e) => /^[0-9a-f]{12}$/.test(e.hash)), flat(JSON.stringify(payload.entries.map((e) => e.hash))));
  // 面板要"点一下打开这条记忆"，所以每条必须带**绝对路径**
  check('每条带绝对 file 路径（侧边栏点条目要打开它）', payload.entries.every((e) => typeof e.file === 'string' && path.isAbsolute(e.file) && e.file.endsWith('.md')), flat(JSON.stringify(payload.entries.map((e) => e.file))));
  check('file 指向真实存在的文件', payload.entries.every((e) => fs.existsSync(e.file)), flat(JSON.stringify(payload.entries.map((e) => e.file))));
}

/* --------------------------------------------- M6：mem rename（安全改名） */

section('M6：mem rename —— id / 文件名 / 引用一起改');
{
  const root = freshRoot('rename');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  // 不给 key → 派生 id 是"日期 + 截断的结论"，正是界面上那些难看文件名的来源
  run(['new', '--root', root, '--type', 'fact', '--conclusion', '这条结论很长很长很长很长很长很长很长', '--source', 's']);
  const derived = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  check('不给 key 时派生的 id 是日期 + 截断结论', /^\d{4}-\d{2}-\d{2}-/.test(derived), derived);
  run(['promote', '--root', root, derived]);

  const r1 = run(['rename', '--root', root, derived, 'sandbox-no-pipe']);
  check('rename 成功', r1.code === 0, flat(r1.out + r1.err));
  check('文件真的改名了（facts/ 下只剩新名字）', md(path.join(root, 'facts')).join(',') === 'sandbox-no-pipe.md', md(path.join(root, 'facts')).join(','));
  check('inbox 里没有残留', md(path.join(root, 'inbox')).length === 0, md(path.join(root, 'inbox')).join(','));

  const shown = run(['show', '--root', root, 'sandbox-no-pipe']);
  check('新 id 能查到', shown.code === 0 && shown.out.includes('sandbox-no-pipe'), flat(shown.out));
  const payload = JSON.parse(run(['inject', '--root', root, '--json']).out);
  check('frontmatter 的 id 也改了（注入载荷里是新 id）', payload.entries.some((e) => e.id === 'sandbox-no-pipe'), flat(JSON.stringify(payload.entries.map((e) => e.id))));
  const v1 = run(['validate', '--root', root]);
  check('validate 通过（id 与文件名一致）', v1.code === 0 && !/不一致/.test(v1.out), flat(v1.out));

  // 旧 id 已经不存在了
  const gone = run(['show', '--root', root, derived]);
  check('旧 id 查不到了', gone.code !== 0, flat(gone.out + gone.err));

  // 冲突与非法输入
  run(['new', '--root', root, '--type', 'fact', '--conclusion', '另一条', '--id', 'other', '--source', 's']);
  run(['promote', '--root', root, 'other']);
  const clash = run(['rename', '--root', root, 'other', 'sandbox-no-pipe']);
  check('目标 id 已存在 → 报错拒绝', clash.code !== 0 && /已被占用/.test(clash.out + clash.err), flat(clash.out + clash.err));
  const illegal = run(['rename', '--root', root, 'other', '有 空格']);
  check('非法字符 → 报错拒绝', illegal.code !== 0 && /非法字符/.test(illegal.out + illegal.err), flat(illegal.out + illegal.err));
  const same = run(['rename', '--root', root, 'other', 'other']);
  check('新旧同名 → 报错拒绝', same.code !== 0, flat(same.out + same.err));
  const missing = run(['rename', '--root', root, 'nope', 'x']);
  check('找不到条目 → 报错拒绝', missing.code !== 0 && /找不到条目/.test(missing.out + missing.err), flat(missing.out + missing.err));

  // 引用同步：B 取代 A，之后把 A 改名，B 的 supersedes 必须跟着改
  run(['new', '--root', root, '--type', 'fact', '--id', 'old-one', '--key', 'k1', '--conclusion', '旧结论', '--source', 's']);
  run(['promote', '--root', root, 'old-one']);
  run(['new', '--root', root, '--type', 'fact', '--id', 'new-one', '--key', 'k1', '--conclusion', '新结论', '--source', 's']);
  run(['promote', '--root', root, 'new-one', '--supersedes', 'old-one']);
  const r2 = run(['rename', '--root', root, 'old-one', 'old-renamed']);
  check('归档条目也能改名', r2.code === 0, flat(r2.out + r2.err));
  check('顺带更新了引用它的条目', /顺带更新了引用/.test(r2.out), flat(r2.out));
  const newOne = run(['show', '--root', root, 'new-one']);
  check('新结论里的 supersedes 指向改名后的 id', newOne.out.includes('old-renamed') && !newOne.out.includes('old-one'), flat(newOne.out));
  const archived = run(['show', '--root', root, 'old-renamed']);
  check('归档条目的 superseded_by 也同步了', archived.out.includes('new-one'), flat(archived.out));
  const v2 = run(['validate', '--root', root]);
  check('改名 + 引用同步之后 validate 依然通过', v2.code === 0, flat(v2.out));
}

/* ------------------------------------------------------------- 汇总 */
rmrf(SANDBOX);
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
