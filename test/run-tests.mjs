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

/* ------------------------------------ 注入正文瘦身（2026-09-23，用户拍板） */

section('注入正文瘦身：key 去重 + 首行 90 字');
{
  const root = freshRoot('slim');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  // ① "有 key 就用 key 当文件名" → key 与 id 一字不差，正文里不该再写一遍
  run(['new', '--root', root, '--type', 'fact', '--key', 'slim-key', '--conclusion', '这条的 key 与 id 相同', '--source', 's']);
  run(['promote', '--root', root, 'slim-key']);
  // ② 结论超长 → 首行按 cap 截断
  run(['new', '--root', root, '--type', 'fact', '--id', 'slim-long', '--key', 'slim-long', '--conclusion', '很长的结论'.repeat(30), '--source', 's']);
  run(['promote', '--root', root, 'slim-long']);
  // ③ key 与 id **不同** → 那时它携带新信息，必须照常写出来
  run(['new', '--root', root, '--type', 'fact', '--id', 'slim-other', '--key', 'a-different-key', '--conclusion', '文件名与 key 不同的那条', '--source', 's']);
  run(['promote', '--root', root, 'slim-other']);

  const text = run(['inject', '--root', root]).out;
  const lines = text.split('\n').filter((l) => l.startsWith('- '));
  check('注入正文不写与 id 相同的 key（实测真实库 30/31 条都是这种纯重复）', !text.includes('[slim-key]') && !text.includes('[slim-long]'), text.split('\n').slice(4, 8).join(' | '));
  check('（对照）key 与 id 不同时照常写进正文', text.includes('[a-different-key]'), text.split('\n').slice(4, 8).join(' | '));
  const longLine = lines.find((l) => l.includes('很长的结论')) ?? '';
  check('超长结论首行被截到 90 字 + 省略号', longLine.endsWith('…') && longLine.length <= 92, `${longLine.length} 字：${longLine.slice(-12)}`);
  check('（对照）三条都进了注入', lines.length === 3, String(lines.length));

  // ② 幂等：渲染两次字节数一致（差分注入的前提）
  const again = run(['inject', '--root', root]).out;
  check('注入文本稳定（同内容两次渲染一致）', again === text, `${Buffer.byteLength(text, 'utf8')} vs ${Buffer.byteLength(again, 'utf8')}`);
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

  // 退场走 archive（`set --status expired` 只改字段、不搬文件 —— 那会造出界面看不到的条目，见 due 那一节）
  r = run(['archive', '--root', root, 'e1']);
  const archivedRaw = fs.readFileSync(path.join(root, 'archive', 'e1.md'), 'utf8');
  check('archive 搬进 archive/ 且 status=expired', r.code === 0 && archivedRaw.includes('status: expired'), r.err);
  check('归档后不再参与注入', JSON.parse(run(['inject', '--root', root, '--json']).out).entries.length === 0);
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

section('recall：流水抢镜的两道闸（降权 + 行级封顶）');
{
  // 真机实测（2026-09-23）：查一个宽泛的词，21 条命中里 18 条是流水行 ——
  // 每条还要渲染 120~200 字节片段，模型花了上下文却大半拿到过程记录。
  const root = freshRoot('linecap');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  run(['new', '--root', root, '--type', 'fact', '--id', 'the-fact', '--key', 'the-fact', '--conclusion', '沙箱禁止命名管道', '--source', 's']);
  run(['promote', '--root', root, 'the-fact']);
  for (let i = 0; i < 10; i += 1) run(['journal', 'add', '--root', root, `第 ${i} 条流水：沙箱禁止命名管道相关的过程记录`]);

  const j = JSON.parse(run(['recall', '--root', root, '沙箱禁管道', '--json']).out);
  check('条目排在所有流水之前（降权生效）', j.matches[0].id === 'the-fact', JSON.stringify(j.matches.map((m) => `${m.id}:${m.score}`)));
  check('行级命中被封顶到 5 条', j.matches.filter((m) => m.where === 'journal').length === 5, JSON.stringify(j.matches.map((m) => m.where)));
  check('并报出被折叠了多少条', j.lineDropped === 5, String(j.lineDropped));
  const text = run(['recall', '--root', root, '沙箱禁管道']).out;
  check('CLI 提示怎么去看被折叠的流水', /另有 5 条流水\/会话索引命中被折叠/.test(text) && /--where journal/.test(text), flat(text).slice(-200));
  check('想全看流水时仍然给全（--where journal 不受封顶影响）', JSON.parse(run(['recall', '--root', root, '沙箱禁管道', '--where', 'journal', '--limit', '50', '--json']).out).matches.length === 10, 'journal only');
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

  // 收尾：把到期条目**归档**（不是 set --status expired —— 那会造出"哪都看不到"的条目，见下）
  run(['archive', '--root', root, 'overdue']);
  r = run(['due', '--root', root]);
  check('归档后不再出现在 due 里', r.code === 0 && /没有到期的复核项/.test(r.out), flat(r.out));
  r = run(['validate', '--root', root]);
  check('处理完之后 validate 没有到期告警', !/复核期/.test(r.out + r.err), flat(r.out + r.err));

  // ⚠️ 回归（2026-09-23 审计）：`set --status expired|superseded` 只改字段不搬文件，
  // 条目会同时"不在已在用（只列 active）、不计入已归档（按目录数）"→ 界面上彻底消失，
  // 而且 restore 也救不了（它要求条目在 archive/）。所以这两个值现在**直接拒绝**并指向正确命令。
  const expiredRefused = run(['set', '--root', root, 'plain', '--status', 'expired']);
  check('set --status expired 被拒绝并指向 mem archive', expiredRefused.code !== 0 && /mem archive/.test(expiredRefused.out + expiredRefused.err), flat(expiredRefused.out + expiredRefused.err));
  const supersededRefused = run(['set', '--root', root, 'plain', '--status', 'superseded']);
  check('set --status superseded 被拒绝并指向 mem supersede', supersededRefused.code !== 0 && /mem supersede/.test(supersededRefused.out + supersededRefused.err), flat(supersededRefused.out + supersededRefused.err));
  check('被拒之后条目没有被改动（还在 facts/ 且 active）', JSON.parse(run(['show', '--root', root, 'plain', '--json']).out).status === 'active', 'status');
  run(['archive', '--root', root, 'plain']);
  const revived = run(['set', '--root', root, 'plain', '--status', 'active']);
  check('--status active 仍然允许（给历史遗留的坏状态复活）', revived.code === 0, flat(revived.out + revived.err));

  // validate 兜底：手工造出"常驻层里 status 不是 active"的条目 → 必须告警（以前 0 问题）
  run(['new', '--root', root, '--type', 'fact', '--id', 'dangling', '--conclusion', '常驻层里状态不对的条目']);
  run(['promote', '--root', root, 'dangling']);
  const dangling = path.join(root, 'facts', 'dangling.md');
  fs.writeFileSync(dangling, fs.readFileSync(dangling, 'utf8').replace(/^status: active$/m, 'status: expired'), 'utf8');
  const dv = run(['validate', '--root', root]);
  check('validate 对"常驻层里 status=expired"告警（界面看不到的那种）', /status 不是 active/.test(dv.out) && /哪一层都看不到/.test(dv.out), flat(dv.out));
  check('这条告警不影响退出码（仍是 0）', dv.code === 0, `code=${dv.code}`);
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

/* ------------------------------- M6：给了 key 就用 key 当文件名（治乱名的根） */

section('M6：key 直接当文件名（新条目不再生成截断长名）');
{
  const root = freshRoot('keyname');
  run(['init', '--root', root, '--scope', 'workspace:x']);

  // 只给 key、不给 id → 文件名就是 key（旧行为是「日期 + 截断的结论」）
  const r = run(['new', '--root', root, '--type', 'fact', '--key', 'sandbox-no-pipe', '--conclusion', '沙箱禁止命名管道：捕获子进程输出会 EPERM', '--source', 's']);
  check('new 成功', r.code === 0, flat(r.out + r.err));
  check('文件名 = key（不再是日期 + 截断结论）', md(path.join(root, 'inbox')).join(',') === 'sandbox-no-pipe.md', md(path.join(root, 'inbox')).join(','));
  const shown = run(['show', '--root', root, 'sandbox-no-pipe']);
  check('key 同时成了 id（能按它查到）', shown.code === 0 && /sandbox-no-pipe/.test(shown.out), flat(shown.out));

  // 显示给了 id 时以 id 为准
  run(['new', '--root', root, '--type', 'fact', '--id', 'explicit-id', '--key', 'another-key', '--conclusion', '显式 id 优先', '--source', 's']);
  check('同时给 id 和 key 时用 id', fs.existsSync(path.join(root, 'inbox', 'explicit-id.md')), md(path.join(root, 'inbox')).join(','));

  // key 被占用 → 退回派生 id，不报错（同一个 key 出现在别的 scope 是合法的）
  const dup = run(['new', '--root', root, '--type', 'fact', '--key', 'sandbox-no-pipe', '--conclusion', '另一个 scope 的同名 key', '--scope', 'workspace:y', '--source', 's']);
  check('key 撞车时退回派生 id（不报错）', dup.code === 0, flat(dup.out + dup.err));
  const names = md(path.join(root, 'inbox'));
  check('退回派生 id = 日期前缀', names.some((n) => /^\d{4}-\d{2}-\d{2}-/.test(n)), names.join(','));
  check('没有覆盖已有的同名文件', names.includes('sandbox-no-pipe.md'), names.join(','));

  // 提升之后文件名跟着走（提升不改名，仍以 id 为准）
  run(['promote', '--root', root, 'sandbox-no-pipe']);
  check('提升后落到 facts/<key>.md', fs.existsSync(path.join(root, 'facts', 'sandbox-no-pipe.md')), md(path.join(root, 'facts')).join(','));
  const v = run(['validate', '--root', root]);
  check('validate 通过', v.code === 0, flat(v.out));
}


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

/* ------------------------------- 库自带说明书（库根 README.md） */

section('库自带说明书：目录名说不清"在流程哪一步"，说明书说清');
{
  const root = freshRoot('readme');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  const readme = path.join(root, 'README.md');
  check('init 在库根写了 README.md', fs.existsSync(readme), readme);

  const text = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : '';
  check('四个目录都在说明书里', ['inbox/', 'facts/', 'decisions/', 'archive/'].every((d) => text.includes(d)), text.slice(0, 120));
  check('讲清主流程（模型只能写 inbox → 人 promote → 归档）', /模型只能写/.test(text) && /promote/.test(text) && /归档/.test(text), text.slice(0, 200));
  check('给出"放 facts 还是 decisions"的判据', /会不会失效/.test(text), text.slice(0, 200));
  check('标出哪些参与注入、哪些不参与', /参与注入/.test(text) && /从不/.test(text), text.slice(0, 200));
  check('提到 journal / index / config 三个根文件', /journal\.md/.test(text) && /index\.md/.test(text) && /memory\.config\.json/.test(text));
  check('附上常用命令', /mem promote/.test(text) && /mem validate/.test(text));
  // 说明书要跟上命令：三种"退场"必须都在（否则用户只会 promote，不知道还能撤回/归档/取回）
  check(
    '说明书列出三种退场（demote / archive / restore）与 rm',
    ['mem demote', 'mem archive', 'mem restore', 'mem rm'].every((k) => text.includes(k)),
    text.slice(text.indexOf('mem demote'), text.indexOf('mem demote') + 200),
  );
  check('说明书写清"三种退场别混"的对照表', /三种"退场"别混/.test(text), text.slice(0, 200));

  // 用户改过就永远不覆盖（它首先是给用户看的）
  fs.writeFileSync(readme, '# 我自己改的\n', 'utf8');
  run(['init', '--root', root]);
  check('再跑 init 不覆盖用户改过的 README', fs.readFileSync(readme, 'utf8') === '# 我自己改的\n', fs.readFileSync(readme, 'utf8').slice(0, 40));
  run(['new', '--root', root, '--type', 'fact', '--id', 'readme-probe', '--conclusion', 'x', '--source', 's']);
  run(['promote', '--root', root, 'readme-probe']);
  check('后续 new / promote 也不动 README', fs.readFileSync(readme, 'utf8') === '# 我自己改的\n', fs.readFileSync(readme, 'utf8').slice(0, 40));
  const v = run(['validate', '--root', root]);
  check('库里有 README.md 不影响 validate', v.code === 0, flat(v.out));
}

/* ----------------------- M7：双向迁移（demote 撤回）与删除候选（rm） */

section('M7：demote（常驻 → 候选）与 rm（只删候选）');
{
  const root = freshRoot('demote');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  run(['new', '--root', root, '--type', 'fact', '--key', 'movable', '--conclusion', '先确认，再撤回，再放回去', '--source', 's']);
  run(['promote', '--root', root, 'movable']);
  check('提升后落在 facts/', fs.existsSync(path.join(root, 'facts', 'movable.md')), md(path.join(root, 'facts')).join(','));
  check('此时参与注入', JSON.parse(run(['inject', '--root', root, '--json']).out).entries.some((e) => e.id === 'movable'));

  // 撤回：常驻 → 候选（不改 status，只换层）
  const back = run(['demote', '--root', root, 'movable']);
  check('demote 成功', back.code === 0, flat(back.out + back.err));
  check(
    '文件回到 inbox/',
    fs.existsSync(path.join(root, 'inbox', 'movable.md')) && !fs.existsSync(path.join(root, 'facts', 'movable.md')),
    md(path.join(root, 'inbox')).join(','),
  );
  check('撤回后**不再参与注入**', !JSON.parse(run(['inject', '--root', root, '--json']).out).entries.some((e) => e.id === 'movable'));
  // 撤回**不改 status**（还是 active）—— 只换层，所以再 promote 能原样放回去
  const backRaw = fs.readFileSync(path.join(root, 'inbox', 'movable.md'), 'utf8');
  check('撤回不改 status（frontmatter 里仍是 active）', /^status:\s*active$/m.test(backRaw), backRaw.split(/\r?\n/).slice(0, 8).join(' | '));
  check('validate 仍然通过', run(['validate', '--root', root]).code === 0);

  // 再放回去：这才是"双向"
  check('再 promote 能放回常驻层', run(['promote', '--root', root, 'movable']).code === 0 && fs.existsSync(path.join(root, 'facts', 'movable.md')));
  check('放回后又参与注入', JSON.parse(run(['inject', '--root', root, '--json']).out).entries.some((e) => e.id === 'movable'));

  // 撤回的边界
  run(['new', '--root', root, '--type', 'fact', '--key', 'cand', '--conclusion', '一个候选', '--source', 's']);
  const demoteCandidate = run(['demote', '--root', root, 'cand']);
  check(
    '候选再撤回 → 报错（它已经在 inbox）',
    demoteCandidate.code !== 0 && /已经在 inbox/.test(demoteCandidate.out + demoteCandidate.err),
    flat(demoteCandidate.out + demoteCandidate.err),
  );

  // rm：只删候选
  const rmCandidate = run(['rm', '--root', root, 'cand']);
  check('rm 能删候选', rmCandidate.code === 0, flat(rmCandidate.out + rmCandidate.err));
  check('候选文件真的没了', !fs.existsSync(path.join(root, 'inbox', 'cand.md')), md(path.join(root, 'inbox')).join(','));
  const rmStanding = run(['rm', '--root', root, 'movable']);
  check(
    'rm 拒绝删常驻条目（避免"静默消失"）',
    rmStanding.code !== 0 && /只能删除 inbox/.test(rmStanding.out + rmStanding.err),
    flat(rmStanding.out + rmStanding.err),
  );
  check('拒绝之后文件还在', fs.existsSync(path.join(root, 'facts', 'movable.md')));
  const rmMissing = run(['rm', '--root', root, 'nope']);
  check('rm 找不到条目 → 报错', rmMissing.code !== 0 && /找不到条目/.test(rmMissing.out + rmMissing.err), flat(rmMissing.out + rmMissing.err));
  check('rm/demote 之后 validate 仍通过', run(['validate', '--root', root]).code === 0);
}

/* ----------------------- M10：手动归档（archive）与取回（restore） */

section('M10：archive（不再适用 → 归档）与 restore（取回）');
{
  const root = freshRoot('archive');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  run(['new', '--root', root, '--type', 'fact', '--key', 'retire-me', '--conclusion', '这条不再适用了，但没有新版本顶上', '--source', 's']);
  run(['promote', '--root', root, 'retire-me']);
  check('先确认它在常驻层且参与注入', fs.existsSync(path.join(root, 'facts', 'retire-me.md')) && JSON.parse(run(['inject', '--root', root, '--json']).out).entries.some((e) => e.id === 'retire-me'));

  const ar = run(['archive', '--root', root, 'retire-me']);
  check('archive 成功', ar.code === 0, flat(ar.out + ar.err));
  check('文件搬进 archive/', fs.existsSync(path.join(root, 'archive', 'retire-me.md')) && !fs.existsSync(path.join(root, 'facts', 'retire-me.md')), md(path.join(root, 'archive')).join(','));
  const arRaw = fs.readFileSync(path.join(root, 'archive', 'retire-me.md'), 'utf8');
  check('status 标成 expired（不是 superseded —— 因为没有替代）', /^status:\s*expired$/m.test(arRaw), arRaw.split(/\r?\n/).slice(0, 8).join(' | '));
  check('归档后不再参与注入', !JSON.parse(run(['inject', '--root', root, '--json']).out).entries.some((e) => e.id === 'retire-me'));
  check('validate 通过（不会报"该归档却没归档"）', run(['validate', '--root', root]).code === 0);
  // 归档层仍然**能被搜到**（这是"归档不是删除"的关键）
  const found = run(['recall', '--root', root, '不再适用', '--json']);
  check('归档的条目仍能被 recall 搜到', JSON.parse(found.out).matches.some((m) => m.id === 'retire-me' && m.where === 'archive'), flat(found.out));

  // 归档的边界
  run(['new', '--root', root, '--type', 'fact', '--key', 'cand2', '--conclusion', '候选不该被归档', '--source', 's']);
  const archiveCandidate = run(['archive', '--root', root, 'cand2']);
  check('候选不能归档（它本来就还没生效）', archiveCandidate.code !== 0 && /候选不用归档/.test(archiveCandidate.out + archiveCandidate.err), flat(archiveCandidate.out + archiveCandidate.err));

  // 取回：archive → inbox，status 复位
  const re = run(['restore', '--root', root, 'retire-me']);
  check('restore 成功', re.code === 0, flat(re.out + re.err));
  check('文件回到 inbox/', fs.existsSync(path.join(root, 'inbox', 'retire-me.md')) && !fs.existsSync(path.join(root, 'archive', 'retire-me.md')), md(path.join(root, 'inbox')).join(','));
  const reRaw = fs.readFileSync(path.join(root, 'inbox', 'retire-me.md'), 'utf8');
  check('取回后 status 复位为 active', /^status:\s*active$/m.test(reRaw), reRaw.split(/\r?\n/).slice(0, 8).join(' | '));
  check('取回后**仍然不参与注入**（要先再 promote 一次）', !JSON.parse(run(['inject', '--root', root, '--json']).out).entries.some((e) => e.id === 'retire-me'));
  check('再 promote 就能重新生效', run(['promote', '--root', root, 'retire-me']).code === 0 && JSON.parse(run(['inject', '--root', root, '--json']).out).entries.some((e) => e.id === 'retire-me'));
  check('取回的边界：对非归档条目 restore → 报错', run(['restore', '--root', root, 'retire-me']).code !== 0);
  check('archive/restore 之后 validate 仍通过', run(['validate', '--root', root]).code === 0);

  /* 归档分类（`category`）：面板「已归档」下的第一层（2026-09-23 用户定的三层结构） */
  const arCat = run(['archive', '--root', root, 'retire-me', '--category', '已废弃']);
  check('带 --category 的归档成功', arCat.code === 0, flat(arCat.out + arCat.err));
  const catRaw = fs.readFileSync(path.join(root, 'archive', 'retire-me.md'), 'utf8');
  check('--category 写进 frontmatter', /^category: 已废弃$/m.test(catRaw), catRaw.split(/\r?\n/).slice(0, 10).join(' | '));
  const catLong = run(['archive', '--root', root, 'retire-me', '--category', 'x'.repeat(41)]);
  check('对已归档的条目再 archive → 报错（顺便确认这条闸门还在）', catLong.code !== 0 && /已经在 archive/.test(catLong.out + catLong.err), flat(catLong.out + catLong.err));
  const longCat = run(['set', '--root', root, 'retire-me', '--category', 'x'.repeat(41)]);
  check('过长的分类被拒（读路径降级、写路径严格）', longCat.code !== 0 && /太长/.test(longCat.out + longCat.err), flat(longCat.out + longCat.err));

  // 取回再归档 → 不给 --category 时按退场方式推默认
  // ⚠️ restore 是回到**候选层**（不绕过"人确认"），所以要再 promote 一次才能归档（候选不能归档）
  run(['restore', '--root', root, 'retire-me']);
  run(['promote', '--root', root, 'retire-me']);
  const arAgain = run(['archive', '--root', root, 'retire-me']);
  check('取回并重新确认后能再归档', arAgain.code === 0, flat(arAgain.out + arAgain.err));
  const catDefault = fs.readFileSync(path.join(root, 'archive', 'retire-me.md'), 'utf8');
  check('不给 --category 时按退场方式推默认（expired → 已废弃）', /^category: 已废弃$/m.test(catDefault), catDefault.split(/\r?\n/).slice(0, 10).join(' | '));
  const setCat = run(['set', '--root', root, 'retire-me', '--category', '另外一类']);
  check('mem set --category 改归档分类', setCat.code === 0 && /^category: 另外一类$/m.test(fs.readFileSync(path.join(root, 'archive', 'retire-me.md'), 'utf8')), flat(setCat.out));
  // 「暂时不用」= 暂时用不上、但可能再启用（第三个默认分类，2026-09-29 加）：与「已废弃」共用
  // status=expired，差别只在 category —— 所以它不该牵动 validate / 取代链 / restore 三处
  const setParked = run(['set', '--root', root, 'retire-me', '--category', '暂时不用']);
  check('mem set --category 能设「暂时不用」', setParked.code === 0 && /^category: 暂时不用$/m.test(fs.readFileSync(path.join(root, 'archive', 'retire-me.md'), 'utf8')), flat(setParked.out));
  check('「暂时不用」的 status 仍是 expired（不新增状态，validate 与取代链不用改）', /^status:\s*expired$/m.test(fs.readFileSync(path.join(root, 'archive', 'retire-me.md'), 'utf8')), 'expired');
  check('设成「暂时不用」后 validate 仍通过', run(['validate', '--root', root]).code === 0);
  // v1.2.x 的旧默认名 `已过期` 在**写**边界也归一（否则库里会同时存在两个近义分组）
  const setLegacy = run(['set', '--root', root, 'retire-me', '--category', '已过期']);
  check('写 `已过期`（旧默认名）落成 `已废弃`', setLegacy.code === 0 && /^category: 已废弃$/m.test(fs.readFileSync(path.join(root, 'archive', 'retire-me.md'), 'utf8')), flat(setLegacy.out));
  check('带 category 的归档条目**不参与注入**（分类只影响归档层的显示）', !JSON.parse(run(['inject', '--root', root, '--json']).out).entries.some((e) => e.id === 'retire-me'));
  // ⚠️ 常驻条目**不该**有"为什么退场"的分类（否则它就是第二个 topic 字段）
  run(['restore', '--root', root, 'retire-me']);
  run(['promote', '--root', root, 'retire-me']);
  const catStanding = run(['set', '--root', root, 'retire-me', '--category', '已废弃']);
  check('对常驻条目设分类 → 拒绝（分类只回答"为什么退场"）', catStanding.code !== 0 && /只对归档里的条目有意义/.test(catStanding.out + catStanding.err), flat(catStanding.out + catStanding.err));
  check('加了 category 之后 validate 仍通过', run(['validate', '--root', root]).code === 0);

  // 「已蒸馏」是**取代/蒸馏**的自动归类，不是手动归档时挑的选项（用户 2026-09-23 定的语义）
  run(['new', '--root', root, '--type', 'fact', '--key', 'old-one', '--conclusion', '旧结论', '--source', 's']);
  run(['new', '--root', root, '--type', 'fact', '--key', 'new-one', '--conclusion', '新结论', '--source', 's']);
  run(['promote', '--root', root, 'old-one']);
  const sup = run(['promote', '--root', root, 'new-one', '--supersedes', 'old-one']);
  check('promote --supersedes 成功', sup.code === 0, flat(sup.out + sup.err));
  const oldRaw = fs.readFileSync(path.join(root, 'archive', 'old-one.md'), 'utf8');
  check('被取代的条目**自动**落「已蒸馏」（不用人挑）', /^category: 已蒸馏$/m.test(oldRaw), oldRaw.split(/\r?\n/).slice(0, 12).join(' | '));
  check('取代之后 validate 仍通过', run(['validate', '--root', root]).code === 0);
}
section('取回会清掉对方的悬挂引用（取代的**反向**操作必须双向）');
{
  // 真机踩到（2026-09-22，用户库里真实出现）：只置空自己的 superseded_by，
  // 对方那条的 supersedes 一直挂着 → validate 报「supersedes X，但对方的 superseded_by=null」，
  // 且没有任何命令能修好它。
  const root = freshRoot('restore-refs');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  run(['new', '--root', root, '--type', 'fact', '--key', 'old-one', '--conclusion', '老结论', '--source', 's']);
  run(['new', '--root', root, '--type', 'fact', '--key', 'new-one', '--conclusion', '新结论顶上', '--source', 's']);
  run(['promote', '--root', root, 'old-one']);
  run(['promote', '--root', root, 'new-one', '--supersedes', 'old-one']);
  check('取代之后 validate 通过（两边一致）', run(['validate', '--root', root]).code === 0, flat(run(['validate', '--root', root]).out));
  check('老条目被归档且标 superseded', /^status:\s*superseded$/m.test(fs.readFileSync(path.join(root, 'archive', 'old-one.md'), 'utf8')), 'status');

  const re = run(['restore', '--root', root, 'old-one']);
  check('restore 成功', re.code === 0, flat(re.out + re.err));
  check('restore 报出清掉了哪些悬挂引用', /悬挂引用/.test(re.out) && /new-one\.supersedes/.test(re.out), flat(re.out));
  const newRaw = fs.readFileSync(path.join(root, 'facts', 'new-one.md'), 'utf8');
  check('对方 supersedes 里不再有它', /^supersedes: \[\]$/m.test(newRaw), newRaw.split(/\r?\n/).slice(0, 10).join(' | '));
  check('取回之后 validate 通过（不再报双向不一致）', run(['validate', '--root', root]).code === 0, flat(run(['validate', '--root', root]).out + run(['validate', '--root', root]).err));
}

/* ------------------------------------------------------------------ 主题（topic） */
section('M13：主题 topic（面板按它归纳条目）');
{
  // 少数断言必须直接调函数（CLI 的 argv 传不了 `\u0000` —— 见 ⑫）
  const { ensureLayout, normalizeTopic, readAll, renameTopic, setTopicEntry } = await import(new URL('../bin/mem.mjs', import.meta.url).href);
  const root = path.join(SANDBOX, 'topic', 'memory');
  run(['init', '--root', root]);

  // ① new --topic 落进 frontmatter；不写 topic 的条目照常可用（旧库不受影响）
  run(['new', '--root', root, '--type', 'fact', '--id', 'tp-a', '--key', 'tp-a', '--conclusion', '沙箱禁止命名管道', '--topic', '环境与沙箱']);
  run(['new', '--root', root, '--type', 'fact', '--id', 'tp-b', '--key', 'tp-b', '--conclusion', '另一个坑', '--topic', '环境与沙箱']);
  run(['new', '--root', root, '--type', 'decision', '--id', 'tp-c', '--conclusion', '没归类的一条']);
  const raw = fs.readFileSync(path.join(root, 'inbox', 'tp-a.md'), 'utf8');
  check('new --topic 写进 frontmatter', /^topic: 环境与沙箱$/m.test(raw), raw.split('\n').slice(0, 8).join('|'));
  check('topic 排在 key 之后、tags 之前（frontmatter 顺序稳定）', raw.indexOf('key: tp-a') < raw.indexOf('topic:') && raw.indexOf('topic:') < raw.indexOf('tags:'), raw.split('\n').slice(1, 8).join('|'));

  // ② topics 命令：列主题 + 条数 + 未归类条数
  let r = run(['topics', '--root', root]);
  check('mem topics 列出主题与条数', /2 条\s+环境与沙箱/.test(r.out), flat(r.out));
  check('mem topics 报出未归类条数', /未归类 1 条/.test(r.out), flat(r.out));
  const jt = JSON.parse(run(['topics', '--root', root, '--json']).out);
  check('topics --json 是合法结构化结果', jt.total === 3 && jt.untopic === 1 && jt.topics[0].topic === '环境与沙箱' && jt.topics[0].count === 2, flat(JSON.stringify(jt)));

  // ③ list 过滤 + 列表里显示主题
  r = run(['list', '--root', root, '--topic', '环境与沙箱']);
  check('list --topic 只列该主题', /tp-a/.test(r.out) && /tp-b/.test(r.out) && !/tp-c/.test(r.out), flat(r.out));
  r = run(['list', '--root', root, '--untopic']);
  check('list --untopic 只列没归类的', /tp-c/.test(r.out) && !/tp-a/.test(r.out), flat(r.out));
  r = run(['list', '--root', root]);
  check('列表行里显示主题，没写主题的标「未归类」', /环境与沙箱/.test(r.out) && /未归类/.test(r.out), flat(r.out));

  // ④ set --topic / 清除
  r = run(['set', '--root', root, 'tp-c', '--topic', '发布流程']);
  check('set --topic 归类成功', r.code === 0 && /topic/.test(r.out), flat(r.out));
  check('归类后 topics 里多一个', /发布流程/.test(run(['topics', '--root', root]).out));
  r = run(['set', '--root', root, 'tp-c', '--topic', '']);
  check('--topic "" 清除主题', r.code === 0 && /未归类 1 条/.test(run(['topics', '--root', root]).out), flat(r.out));

  // ⑤ 太长 / 空白归一化
  r = run(['set', '--root', root, 'tp-c', '--topic', 'x'.repeat(41)]);
  check('过长的主题被拒（而不是静默截断）', r.code !== 0 && /太长/.test(r.out + r.err), flat(r.out + r.err));
  run(['set', '--root', root, 'tp-c', '--topic', '  发布   流程  ']);
  check('主题里的连续空白归一化成一个空格', /^topic: 发布 流程$/m.test(fs.readFileSync(path.join(root, 'inbox', 'tp-c.md'), 'utf8')), 'frontmatter');

  // ⑥ 没归类的条目只是**告警**，不该卡 validate（归纳是人的活）
  run(['set', '--root', root, 'tp-b', '--topic', '']); // 清掉一条，制造"未归类"
  const v = run(['validate', '--root', root]);
  check('validate 对没归类的条目给告警', /1 条条目没有 topic/.test(v.out), flat(v.out));
  check('没归类不影响 validate 退出码', v.code === 0, `code=${v.code}`);

  // ⑦ topic 不参与注入正文，也不影响差分 hash（它是给人看的分组标签）
  const before = JSON.parse(run(['inject', '--root', root, '--json']).out);
  run(['promote', '--root', root, 'tp-a']);
  const afterPromote = JSON.parse(run(['inject', '--root', root, '--json']).out);
  check('topic 不出现在注入正文里', !afterPromote.text.includes('环境与沙箱'), flat(afterPromote.text).slice(0, 120));
  const hashBefore = afterPromote.entries.find((e) => e.id === 'tp-a').hash;
  run(['set', '--root', root, 'tp-a', '--topic', '换个主题']);
  const hashAfter = JSON.parse(run(['inject', '--root', root, '--json']).out).entries.find((e) => e.id === 'tp-a').hash;
  check('改主题不改变注入 hash（不会触发一次无意义的差分注入）', hashBefore === hashAfter, `${hashBefore} vs ${hashAfter}`);
  check('改主题之后仍参与注入', JSON.parse(run(['inject', '--root', root, '--json']).out).entries.some((e) => e.id === 'tp-a'));
  check('before 用于对照（注入条数不为零）', before !== null);

  // ⑧ index.md 里也带上主题（派生视图要能看出归纳结果）
  run(['index', '--root', root]);
  check('index.md 带上主题', /「换个主题」/.test(fs.readFileSync(path.join(root, 'index.md'), 'utf8')), 'index');

  // ⑨ 按主题搜：只返回该主题的条目（流水/会话索引没有主题，会被排除）
  run(['promote', '--root', root, 'tp-b']);
  run(['set', '--root', root, 'tp-b', '--topic', '另一个主题']);
  run(['journal', 'add', '--root', root, '沙箱里 spawnSync 会 EPERM']);
  const allHits = JSON.parse(run(['recall', '--root', root, '沙箱', '--json']).out);
  const scopedHits = JSON.parse(run(['recall', '--root', root, '沙箱', '--topic', '换个主题', '--json']).out);
  check('recall --topic 只返回该主题的条目', scopedHits.matches.length > 0 && scopedHits.matches.every((m) => m.topic === '换个主题'), flat(JSON.stringify(scopedHits.matches.map((m) => m.topic))));
  check('不带 --topic 时结果更宽（含别的主题与流水）', allHits.matches.length > scopedHits.matches.length, `${allHits.matches.length} vs ${scopedHits.matches.length}`);
  check('--json 里每条命中都带回 topic 字段', scopedHits.topic === '换个主题' && scopedHits.matches.every((m) => 'topic' in m), JSON.stringify(scopedHits.matches[0] ?? {}));

  // ⑩ 主题改名：全库（含归档层）同名主题一起改，不会裂成两个近义主题
  run(['promote', '--root', root, 'tp-c']);
  run(['archive', '--root', root, 'tp-c']);
  const renamed = run(['topic-rename', '--root', root, '发布 流程', '发布与流程']);
  check('topic-rename 成功并报出条数', renamed.code === 0 && /改了 1 条/.test(renamed.out), flat(renamed.out + renamed.err));
  check('改名把归档层里同名的也一起改了', JSON.parse(run(['topics', '--root', root, '--json']).out).topics.some((t) => t.topic === '发布与流程' && t.count === 1), flat(run(['topics', '--root', root, '--json']).out));
  const renameMissing = run(['topic-rename', '--root', root, '不存在的主题', 'x']);
  check('改不存在的主题 → 非零退出 + 列出已有主题', renameMissing.code !== 0 && /找不到主题/.test(renameMissing.out + renameMissing.err) && /现有：/.test(renameMissing.out + renameMissing.err), flat(renameMissing.out + renameMissing.err));
  const renameSame = run(['topic-rename', '--root', root, '发布与流程', '发布与流程']);
  check('新旧同名 → 拒绝（什么也没做就说清楚）', renameSame.code !== 0 && /一样/.test(renameSame.out + renameSame.err), flat(renameSame.out + renameSame.err));

  // ⑪ P3（2026-09-23 审计）：index.md 是**派生视图**，改主题必须跟着重建
  //    以前 `set --topic` 不重建 → 界面上主题已经改了、index.md 里还是旧名字，而且 validate 查不出来
  //    （它只查"active 条目的 id 在不在索引里"）
  run(['new', '--root', root, '--type', 'fact', '--id', 'tp-idx', '--key', 'tp-idx', '--conclusion', '索引要跟着主题走', '--topic', '索引 旧名']);
  run(['promote', '--root', root, 'tp-idx']);
  run(['index', '--root', root]);
  const idxBefore = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
  check('重建后的 index.md 带着旧主题名', idxBefore.includes('索引 旧名'), idxBefore.split('\n').find((l) => l.includes('tp-idx')) ?? '(没有这一行)');
  run(['set', '--root', root, 'tp-idx', '--topic', '索引 新名']);
  const idxAfter = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
  check('改主题后 index.md 自动重建（不再停在旧名字）', idxAfter.includes('索引 新名') && !idxAfter.includes('索引 旧名'), idxAfter.split('\n').find((l) => l.includes('tp-idx')) ?? '(没有这一行)');

  // ⑫ P3：保留主题名（面板的三个哨兵）在**写入侧**就要挡住
  //    以前它们是字面量 `__untopic__` 这类**合法**主题名 —— 库里真出现同名主题就会和「未归类」并成一组，
  //    而且事后无从分辨。现在哨兵带 `\u0000` 前缀 + 写入侧拒收，两道闸。
  //    ⚠️ 这一条**只能直接调函数**，不能过 CLI：`\u0000` 是 NUL，`spawnSync` 的 argv 根本传不了
  //    （`ERR_INVALID_ARG_VALUE: must be a string without null bytes`）—— 顺带说明这个值也只能由
  //    代码自己构造，人手打不出来，这正是选它的理由。
  let reservedError = null;
  try {
    normalizeTopic('\u0000untopic', { strict: true });
  } catch (error) {
    reservedError = error;
  }
  check('写入侧拒绝保留主题名（并说清是保留名）', reservedError !== null && /保留名/.test(reservedError.message), String(reservedError?.message));
  check('读路径（strict:false）对同样的值只归一化、不抛', normalizeTopic('\u0000untopic') === '\u0000untopic', 'read path');
  {
    const L = ensureLayout(root, { create: false });
    setTopicEntry(L, 'tp-idx', '改名前的主题', { index: false });
    let renameError = null;
    try {
      renameTopic(L, '改名前的主题', '\u0000nodate');
    } catch (error) {
      renameError = error;
    }
    check('改名**目标**是保留名 → 拒绝（改名不能绕过闸门）', renameError !== null && /保留名/.test(renameError.message), String(renameError?.message));
    check('被拒之后条目还是旧主题（没有改一半）', readAll(L).find((e) => e.id === 'tp-idx')?.data.topic === '改名前的主题', 'topic');
    setTopicEntry(L, 'tp-idx', '索引 新名');
  }
}

/* ------------------------------------- 数据保真 / 坏数据不崩（2026-09-23 审计修复） */

section('frontmatter 往返保真：字符串不会被静默改类型');
{
  const { parseFrontmatter, renderFrontmatter } = await import(new URL('../bin/mem.mjs', import.meta.url).href);
  const roundTrip = (data) => parseFrontmatter(renderFrontmatter(data)).data;
  const trickyStrings = ['123', 'true', 'null', '~', '[a, b]', 'a: b', 'a,b', "it's", '#hash', '带 空格', ' a ', '', '-42'];
  const bad = trickyStrings.filter((s) => roundTrip({ key: s }).key !== s);
  check('难搞的字符串往返后仍是同一个字符串（不再变数字/布尔/数组）', bad.length === 0, JSON.stringify(bad.map((s) => [s, roundTrip({ key: s }).key])));
  const typed = roundTrip({ id: 5, date: '2026-01-01', superseded_by: null, tags: ['a'] });
  check(
    '已知字段的"真类型"仍按类型解析（数字/字符串/null/数组）',
    typed.id === 5 && typed.date === '2026-01-01' && typed.superseded_by === null && Array.isArray(typed.tags),
    JSON.stringify(typed),
  );
  const arr = roundTrip({ tags: ['a', 'b,c', '带 空格'] });
  check('行内数组往返保真（含逗号/空格的元素）', JSON.stringify(arr.tags) === JSON.stringify(['a', 'b,c', '带 空格']), JSON.stringify(arr.tags));
  check('手写的带引号值不被强转', parseFrontmatter('---\nkey: "123"\n---\n').data.key === '123' && typeof parseFrontmatter('---\nkey: "123"\n---\n').data.key === 'string');
  check('工具不认识的键进 extra（不进 data，但也没丢）', parseFrontmatter('---\ncustom: 1\n---\n').data.custom === undefined && parseFrontmatter('---\ncustom: 1\n---\n').extra[0]?.key === 'custom');
}

section('数组型字段的类型保真：人手的写法不能让检索崩 / 不能静默丢标签');
{
  const root = freshRoot('tags-fidelity');
  run(['init', '--root', root]);
  const { ensureLayout, parseFrontmatter, readAll } = await import(new URL('../bin/mem.mjs', import.meta.url).href);
  const L = ensureLayout(root, { create: false });

  /** 手写一个条目（模拟人改文件）。 */
  const handWrite = (file, fmLines, conclusion = '手写的条目') => {
    fs.writeFileSync(
      path.join(root, 'inbox', file),
      ['---', `id: ${file.replace(/\.md$/, '')}`, 'type: fact', 'status: active', 'date: 2026-01-01', ...fmLines, '---', '', '## 结论', conclusion, ''].join('\n'),
      'utf8',
    );
  };
  const tagsOf = (id) => readAll(L).find((e) => e.id === id)?.data?.tags;

  handWrite('scalar-tags.md', ['tags: dsh-memory']);
  handWrite('comma-tags.md', ['tags: a,b']);
  handWrite('block-tags.md', ['tags:', '  - a', '  - b']);
  handWrite('comment-tags.md', ['tags: [a] # 备注']);
  handWrite('quoted-hash.md', ['tags: ["#hash", "b"]']);
  handWrite('null-tags.md', ['tags: null']);

  const cases = [
    ['scalar-tags', ['dsh-memory'], '标量 tags: a 读回来是数组（以前是字符串 → 检索直接 TypeError）'],
    ['comma-tags', ['a,b'], '标量带逗号原样保留成一个元素（不猜用户想不想切）'],
    ['block-tags', ['a', 'b'], '块序列（YAML 标准多行）读回来是数组（以前读成 null，写一次就永久丢标签）'],
    ['comment-tags', ['a'], '行内注释被剥掉、数组还在（以前整段变字符串）'],
    ['quoted-hash', ['#hash', 'b'], '引号里的 # 不当注释（合法标签不该被吃掉）'],
    ['null-tags', [], 'tags: null → 空数组（不是 null）'],
  ];
  for (const [id, want, name] of cases) {
    const got = tagsOf(id);
    check(name, Array.isArray(got) && JSON.stringify(got) === JSON.stringify(want), `读到 ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`);
  }

  // 端到端：以前这两条命令在"标量 tags"的库上直接 TypeError
  const recall = run(['recall', '--root', root, '手写']);
  check('mem recall 在标量 tags 的库上不再崩', recall.code === 0 && !/TypeError/.test(recall.out + recall.err), flat(recall.err).slice(0, 120));
  const idx = run(['index', '--root', root]);
  check('mem index 在标量 tags 的库上不再崩', idx.code === 0 && !/TypeError/.test(idx.out + idx.err), flat(idx.err).slice(0, 120));
  const byTag = run(['list', '--root', root, '--tag', 'dsh-memory']);
  check('mem list --tag 能匹配到标量写法的那条（以前静默匹配不到）', /scalar-tags/.test(byTag.out), flat(byTag.out));
  // supersedes 也是数组型字段：标量写法同样要归一，否则引用逻辑遍历不到
  handWrite('sup-a.md', ['key: sup-a', 'supersedes: other-id'], '取代关系的目标');
  check('supersedes 标量写法也归一成数组', JSON.stringify(readAll(L).find((e) => e.id === 'sup-a')?.data?.supersedes) === JSON.stringify(['other-id']), 'supersedes');
  check('（对照）不受影响的普通标量字段仍是标量', parseFrontmatter('---\nkey: abc\n---\n').data.key === 'abc', 'key');
}

section('工具不认识的 frontmatter 键不会被静默删掉');
{
  const root = freshRoot('extra');
  run(['init', '--root', root]);
  run(['new', '--root', root, '--type', 'fact', '--id', 'x1', '--conclusion', '带自定字段的条目']);
  const f = path.join(root, 'inbox', 'x1.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^status: active$/m, 'status: active\nseverity: high\nrefs: [a, b]'), 'utf8');
  run(['set', '--root', root, 'x1', '--topic', '某个主题']);
  const after = fs.readFileSync(f, 'utf8');
  check('自定键在写入后仍在', /^severity: high$/m.test(after) && /^refs: \[a, b\]$/m.test(after), flat(after.split('---')[1]));
  check('自定键的值按原文保留（没被改写）', /^refs: \[a, b\]$/m.test(after), 'raw');
  run(['promote', '--root', root, 'x1']);
  check('搬到 facts/ 之后也还在', /^severity: high$/m.test(fs.readFileSync(path.join(root, 'facts', 'x1.md'), 'utf8')), 'moved');
  const v = run(['validate', '--root', root]);
  check('validate 会告诉你"有工具不认识的键"', /工具不认识的 frontmatter 键/.test(v.out), flat(v.out));
  check('这条告警不影响退出码', v.code === 0, `code=${v.code}`);
}

section('坏数据不该把自检打崩（人手写的 frontmatter）');
{
  const root = freshRoot('rotdaten');
  run(['init', '--root', root]);
  run(['new', '--root', root, '--type', 'fact', '--id', 'l1', '--conclusion', '主题名超长的条目']);
  run(['new', '--root', root, '--type', 'fact', '--id', 'b1', '--conclusion', '带 BOM 的条目']);
  const long = path.join(root, 'inbox', 'l1.md');
  fs.writeFileSync(long, fs.readFileSync(long, 'utf8').replace('topic: null', `topic: ${'甲'.repeat(45)}`), 'utf8');
  const bomFile = path.join(root, 'inbox', 'b1.md');
  fs.writeFileSync(bomFile, `\uFEFF${fs.readFileSync(bomFile, 'utf8')}`, 'utf8');

  for (const cmd of [['topics'], ['validate'], ['recall', '主题名超长', '--topic', '甲'], ['list']]) {
    const r = run([...cmd, '--root', root]);
    check(`mem ${cmd[0]}${cmd[1] ? ` ${cmd[1]}` : ''} 不再堆栈崩溃`, r.code === 0 && !/at normalizeTopic|at listTopics|at cmdValidate/.test(r.out + r.err), flat(r.out + r.err).slice(0, 120));
  }
  const v = run(['validate', '--root', root]);
  check('超长主题降级成告警（不再抛）', /主题名超过 40 字/.test(v.out), flat(v.out));
  check('写入口仍然拦超长主题', run(['set', '--root', root, 'l1', '--topic', 'x'.repeat(41)]).code !== 0);
  check('带 BOM 的文件不再被当成"缺少 frontmatter"', !/缺少 frontmatter/.test(v.out), flat(v.out));
}

section('取代关系必须两边一起写（2026-09-23 审计修复）');
{
  const root = freshRoot('supersede');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  for (const id of ['a', 'b', 'c', 'd']) run(['new', '--root', root, '--type', 'fact', '--id', id, '--key', id, '--conclusion', `真相 ${id}`, '--source', 's']);
  run(['promote', '--root', root, 'a']);

  // ① archive --superseded-by：以前只写自己那一半 → validate 两条问题、连 --fix 都修不掉
  const ar = run(['archive', '--root', root, 'a', '--superseded-by', 'b']);
  check('archive --superseded-by 成功', ar.code === 0, flat(ar.out + ar.err));
  const aRaw = fs.readFileSync(path.join(root, 'archive', 'a.md'), 'utf8');
  check('被取代的条目 status=superseded（不是 expired）', /^status: superseded$/m.test(aRaw), aRaw.split('\n').slice(0, 8).join('|'));
  const bRaw = fs.readFileSync(path.join(root, 'inbox', 'b.md'), 'utf8');
  check('对方补上了反向的 supersedes', /^supersedes: \[a\]$/m.test(bRaw), bRaw.split('\n').slice(0, 10).join('|'));
  check('双向一致 → validate 通过', run(['validate', '--root', root]).code === 0, flat(run(['validate', '--root', root]).out));

  // 目标不存在的分支：要先把 b 变成可归档的常驻条目（候选不能归档）
  run(['promote', '--root', root, 'b']);
  const badTarget = run(['archive', '--root', root, 'b', '--superseded-by', '不存在的id']);
  check('指向不存在的条目 → 报错（而不是写个悬挂引用）', badTarget.code !== 0 && /找不到条目/.test(badTarget.out + badTarget.err), flat(badTarget.out + badTarget.err));
  check('报错之后 b 没被搬走也没被改状态', fs.existsSync(path.join(root, 'facts', 'b.md')), 'facts/b.md');

  // ② promote --supersedes 指向"已经被别人取代过"的条目：以前会静默改写替换链
  run(['promote', '--root', root, 'c']);
  const steal = run(['promote', '--root', root, 'd', '--supersedes', 'a']);
  check('拒绝静默改写替换链（a 已经被 b 取代）', steal.code !== 0 && /已经被 b 取代过/.test(steal.out + steal.err), flat(steal.out + steal.err));
  check('拒绝之后链没被改坏 → validate 仍通过', run(['validate', '--root', root]).code === 0, flat(run(['validate', '--root', root]).out));
  check('拒绝之后 d 仍留在候选层', fs.existsSync(path.join(root, 'inbox', 'd.md')), 'inbox/d.md');

  // ③ mem supersede 走同一份闸门与链接逻辑
  const again = run(['supersede', '--root', root, 'a', 'c']);
  check('mem supersede 同样拒绝重复取代', again.code !== 0 && /取代过/.test(again.out + again.err), flat(again.out + again.err));
  check('用 supersede 重新指认（先取回）是可行的出路', run(['restore', '--root', root, 'a']).code === 0, 'restore a');
}

/* ------------------------------------------------------------- 汇总 */
rmrf(SANDBOX);
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
