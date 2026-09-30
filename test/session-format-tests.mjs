#!/usr/bin/env node
/**
 * 会话格式契约测试 —— 拿 **DSH 内核自己的准入函数** 验证我们写出去的消息来源形态。
 *
 * 为什么单独立一套：本项目两次 P0 事故都出在"写进别人持久化格式的字段"上，而**自家桩模块
 * 永远发现不了**这类问题（桩里没有内核的规则）：
 *   ① 2026-09-30 之前写 `{kind:'memory'}` → v2→v3 迁移只认 15 种来源，遇到它就拒绝**整次**迁移，
 *      含该记录的会话**永久打不开**（本机 14 条中招）；
 *   ② 改成 v3 时代的插件包装 `{kind:'plugin', plugin:…}` → v4 起规则反过来（`kind` 必须是
 *      生产者自有 kind、且不能是 `plugin`），编码器每次写日志都抛，**每个会话第一轮就失败**。
 *
 * 同一字段在两代格式里要求**正好相反** —— 所以必须钉在内核的真实实现上。
 * 内核模块找不到时打印 SKIP 并以 0 退出（CI / 别的机器上没有 DSH 安装是正常的）。
 *
 * 跑：node test/session-format-tests.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MEMORY_PLUGIN_ID, isMemorySource, memorySource } from '../src/planner.mjs';

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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 静态护栏只看**代码**：注释里会正当地引用那些退役写法（说明为什么不能用），
 * 不剥注释就会把注释当违规。行注释剥法避开 `https://` 这种（`//` 前是冒号的不算）。
 */
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ------------------------------------------------ 找内核的会话格式模块 */

const MODULE = ['@deepseek-ai', 'dsh-session-format-v3-to-v4', 'lib', 'index.js'];
const candidates = [
  process.env.DSH_SESSION_FORMAT_DIR,
  process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', ...MODULE),
  process.env.APPDATA && path.join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'web', 'node_modules', ...MODULE),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'dsh-desktop', 'resources', 'app.asar.unpacked', 'node_modules', ...MODULE),
  'D:/ai/dsh/DSH Desktop/resources/app.asar.unpacked/node_modules/' + MODULE.join('/'),
].filter(Boolean);

const kernelPath = candidates.find((p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
});

if (!kernelPath) {
  console.log('SKIP  找不到 DSH 内核的会话格式模块（@deepseek-ai/dsh-session-format-v3-to-v4）');
  console.log('      可用 DSH_SESSION_FORMAT_DIR=<…/lib/index.js> 显式指定；跳过不算失败。');
  console.log('\n0 通过 / 0 失败（跳过）');
  process.exit(0);
}

const kernel = await import(pathToFileURL(kernelPath).href);
const { assertV4RowAdmission } = kernel;
console.log(`内核模块：${kernelPath}`);

check('内核导出了 assertV4RowAdmission（v4 行准入）', typeof assertV4RowAdmission === 'function');

/** 造一条最小可用的 user/message 行（内容与来源是唯一相关的两块）。 */
const userRow = (source) => ({
  type: 'user/message',
  seq: 1,
  data: {
    id: 'm1',
    role: 'user',
    source,
    content: [{ type: 'text', text: 'hi' }],
  },
});

const admissionError = (row) => {
  try { assertV4RowAdmission(row, new Set()); return null; } catch (error) { return error; }
};

/* ------------------------------------------------- ① 现行形态必须过 v4 准入 */

section('现行写入形态 vs v4 行准入（内核自己的函数）');
{
  const written = memorySource();
  check('memorySource() 是 plugin:<包名> 形态', written.kind === `plugin:${MEMORY_PLUGIN_ID}`, JSON.stringify(written));
  check('v4 行准入放行（真实写入路径不抛）', admissionError(userRow(written)) === null,
    String(admissionError(userRow(written))?.message ?? ''));
}

/* --------------------------------- ② 两个退役形态必须被内核拒（防止再改回去） */

section('退役形态必须被内核拒（回归护栏）');
{
  const wrapper = { kind: 'plugin', plugin: MEMORY_PLUGIN_ID };
  const err = admissionError(userRow(wrapper));
  check('v4 准入拒绝 v3 时代的 plugin 包装', err !== null);
  check('拒绝理由就是"生产者自有 kind"那条', /producer-owned source kind/.test(String(err?.message ?? '')), String(err?.message ?? ''));

  // 自定义 kind（'memory'）在 v4 行准入这一层**不**被拒（那一层只盯 plugin 包装），
  // 它是被 v2→v3 的来源白名单拒的 —— 两代规则合起来才是完整的合同，别只测一半。
  check("历史遗留 kind:'memory' 不再被写出去（构造点只剩 memorySource()）",
    !/kind:\s*['"]memory['"]/.test(stripComments(fs.readFileSync(path.join(root, 'src', 'planner.mjs'), 'utf8'))));
}

/* --------------------------------------------- ③ 读回形态：四种历史 + 不误判 */

section('读回形态（老会话日志里的都要认）');
{
  check('写入形态认得出', isMemorySource(memorySource()));
  check('迁移抬升后的形态认得出', isMemorySource({ kind: `plugin:${MEMORY_PLUGIN_ID}` }));
  check('裸包名（上游同名白名单）认得出', isMemorySource({ kind: MEMORY_PLUGIN_ID }));
  check("更早的 kind:'memory' 认得出", isMemorySource({ kind: 'memory' }));
  check('v3 时代的 plugin 包装认得出（读老日志用）', isMemorySource({ kind: 'plugin', plugin: MEMORY_PLUGIN_ID }));
  check('不误判别的插件', !isMemorySource({ kind: 'plugin', plugin: 'someone-else' }));
  check('不误判别的 kind', !isMemorySource({ kind: 'agent-instructions' }));
  check('容忍 null / 非对象', !isMemorySource(null) && !isMemorySource('memory'));
}

/* ------------------------------------------- ④ 静态护栏：来源只能有一个构造点 */

section('静态护栏：src/ 与 client/ 里不许手写来源 kind');
{
  const files = [
    ...fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => path.join('src', f)),
    path.join('client', 'client.js'),
  ];
  const offenders = [];
  for (const rel of files) {
    const text = stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));
    // 只抓**对象字面量**：`kind: 'plugin'` / `kind: "memory"`（比较写法 `kind === 'plugin'` 是读路径，合法）
    if (/kind:\s*['"](?:plugin|memory)['"]/.test(text)) offenders.push(rel);
  }
  check('没有手写的 kind 字面量（唯一构造点 = planner.mjs 的 memorySource()）', offenders.length === 0, offenders.join(', '));

  const plugin = fs.readFileSync(path.join(root, 'src', 'plugin.mjs'), 'utf8');
  check('插件注入消息走 memorySource()', /source:\s*memorySource\(\)/.test(plugin));
  check('插件里不再残留旧常量 MEMORY_SOURCE_KIND', !plugin.includes('MEMORY_SOURCE_KIND'));
}

/* ------------------------------------------------------------- 汇总 */

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
