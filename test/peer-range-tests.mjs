#!/usr/bin/env node
/**
 * peer 范围契约测试 —— 我们声明的宿主 peer，必须覆盖**声称支持的内核版本**。
 *
 * 两条实测过的语义化版本陷阱（2026-10-01，两次都真机上踩到）：
 *   ① **caret 跨不过 minor**：`^0.1.2-rc.1` = `>=0.1.2-rc.1 <0.2.0-0`，对 `0.2.0-rc.2` 判 false。
 *   ② **预发布版本的 tuple 规则**：一个带预发布的内核版本，只被**同一 `[major,minor,patch]`
 *      且自带预发布标签**的比较器接纳（`includePrerelease: false` 时）。
 *      于是 `>=0.1.2-rc.1 <0.3.0` 在**三种宿主上全部判 false** —— 因为它的 tuple 是 0.1.2，
 *      而宿主是 0.1.7-rc.2 / 0.2.0-rc.2：**范围必须逐条线写、且每条线都带预发布子句**。
 *      （社区版内核强制 `includePrerelease: true`，所以旧写法在那儿能过；官方版 0.2.0 上插件
 *      静默不加载 —— 预检只把 `disabling profile plugin …` 写进 stderr，界面上什么都看不到。）
 *
 * 因此正确形状是：`^0.1.7-rc.1 || ^0.2.0-rc.1`（每条支持线一个带预发布的 caret）。
 *
 * 两层检查：
 *   ① **静态**（永远跑、零依赖）：拒绝"整体单条 `^0.x`"；必须带预发布子句；
 *      **每个 SUPPORTED_HOSTS 的 tuple 都必须在范围里有自己的预发布比较器** ← 静态就能抓住上面两个坑。
 *   ② **语义**（装了 semver 才跑，否则 SKIP）：对每个宿主 × `includePrerelease` **两种模式**跑
 *      `semver.satisfies`（DSH 预检开了它、别的检查器可能没开，我们的声明必须两边都过），
 *      外加 vendor 配对与两条把规则钉住的反向对照。
 *      semver 来源：`DSH_SEMVER_DIR`（含 semver 的 node_modules），否则 `import('semver')`。
 *      本机跑全量：`DSH_SEMVER_DIR=D:\idea2023\ai\.dbg\peercheck\node_modules npm test`
 *
 * 跑：node test/peer-range-tests.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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

/** 声称支持的内核版本 —— 加新线时必须同时把 peer 范围补上该线的预发布比较器。 */
const SUPPORTED_HOSTS = ['0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2'];

/** 两个内核各自配套的 vendor 版本（问 npm 得到：0.1.7-rc.2 与 0.2.0-rc.2 都要 ~4.0.4 / ~3.18.4）。 */
const VENDOR_HOSTS = [
  ['@deepseek-ai/cordis', '4.0.4'],
  ['@deepseek-ai/schemastery', '3.18.4'],
];

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const peers = pkg.peerDependencies ?? {};
const dshPeers = Object.entries(peers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'));

const tupleOf = (host) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(host);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : host;
};
const hasPrereleaseComparatorFor = (range, tuple) =>
  new RegExp(`${tuple.replace(/\./g, '\\.')}-[0-9A-Za-z][0-9A-Za-z.-]*`).test(range);

/* ------------------------------------------------ ① 静态护栏（零依赖，永远跑） */

section('静态护栏：peer 范围的写法');
{
  check('确实声明了 @deepseek-ai/dsh* 的 peer', dshPeers.length > 0, `找到 ${dshPeers.length} 条`);

  // 单条 `^0.x` 跨不过 minor；要覆盖多条线就写成 `||` 并联、每条线一个**带预发布**的 caret。
  const caretOnly = dshPeers.filter(([, range]) => /^\^0\./.test(range.trim()) && !range.includes('||'));
  check(
    '不是"单条 `^0.x`"（caret 跨不过 minor；跨线要用 `||` 并联）',
    caretOnly.length === 0,
    caretOnly.map(([n, r]) => `${n}@${r}`).join(', '),
  );

  const noPrerelease = dshPeers.filter(([, range]) => !/-(?:rc|alpha|beta)\./.test(range));
  check('带预发布子句', noPrerelease.length === 0, noPrerelease.map(([n, r]) => `${n}@${r}`).join(', '));

  // ← 这条静态规则就是 2026-10-01 那次"官方版静默不加载"的直接教训
  const tuples = [...new Set(SUPPORTED_HOSTS.map(tupleOf))];
  const missing = [];
  for (const [name, range] of dshPeers) {
    for (const t of tuples) if (!hasPrereleaseComparatorFor(range, t)) missing.push(`${name}@${range} 缺 ${t}-rc.*`);
  }
  check(`每条支持线（${tuples.join(' / ')}）都有自己的预发布比较器`, missing.length === 0, missing.join('; '));

  const mem = fs.readFileSync(path.join(root, 'bin', 'mem.mjs'), 'utf8');
  const v = /const VERSION = '([^']+)'/.exec(mem);
  check('package.json 版本与 bin/mem.mjs 的 VERSION 一致', !!v && v[1] === pkg.version, `package.json=${pkg.version} mem.mjs=${v ? v[1] : '?'}`);
}

/* --------------------------------------- ② 语义检查（需要 semver，否则 SKIP） */

const require_ = createRequire(import.meta.url);

async function loadSemver() {
  const dir = process.env.DSH_SEMVER_DIR;
  if (dir) {
    for (const p of [path.join(dir, 'semver'), path.join(dir, 'node_modules', 'semver'), dir]) {
      try {
        return require_(p);
      } catch {
        /* 继续试下一个候选 */
      }
    }
  }
  try {
    return (await import('semver')).default;
  } catch {
    return null;
  }
}

const semver = await loadSemver();

if (!semver) {
  console.log('\nSKIP 语义检查：没找到 semver（设 DSH_SEMVER_DIR 指向含 semver 的 node_modules，或在有 semver 的环境跑）');
} else {
  section('语义检查：semver.satisfies(host, range, { includePrerelease }) —— 两种模式都要过');
  for (const mode of [true, false]) {
    for (const host of SUPPORTED_HOSTS) {
      for (const [name, range] of dshPeers) {
        check(
          `includePrerelease=${String(mode).padEnd(5)} ${name} 覆盖 ${host}`,
          semver.satisfies(host, range, { includePrerelease: mode }),
          `${range} 不满足 ${host}`,
        );
      }
    }
  }

  section('vendor 配对与反向对照');
  for (const [name, host] of VENDOR_HOSTS) {
    check(`${name} 覆盖两个内核配套的 ${host}`, semver.satisfies(host, peers[name] ?? '', { includePrerelease: true }), `${peers[name]} 不满足 ${host}`);
  }
  check(
    '反向对照：`^0.1.2-rc.1` 在 includePrerelease=false 下不满足 0.2.0-rc.2（tuple 规则）',
    semver.satisfies('0.2.0-rc.2', '^0.1.2-rc.1', { includePrerelease: false }) === false,
  );
  check(
    '反向对照：`>=0.1.2-rc.1 <0.3.0` 在 includePrerelease=false 下三种宿主全不满足（官方版那次）',
    SUPPORTED_HOSTS.every((h) => semver.satisfies(h, '>=0.1.2-rc.1 <0.3.0', { includePrerelease: false }) === false),
  );
}

/* ------------------------------------------------------------- 汇总 */

console.log(`\n${pass} 通过 / ${fail} 失败${semver ? '' : '（语义检查已 SKIP）'}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
