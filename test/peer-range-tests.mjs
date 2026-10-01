#!/usr/bin/env node
/**
 * peer 范围契约测试 —— 我们声明的宿主 peer，必须覆盖**声称支持的内核版本**。
 *
 * 两条真踩过的语义化版本事实：
 *   ① **caret 跨不过 minor**：`^0.1.2-rc.1` = `>=0.1.2-rc.1 <0.2.0-0`，对 `0.2.0-rc.2` 判 false。
 *   ② **预发布版本的 tuple 规则**：一个带预发布的内核版本，只被**同一 `[major,minor,patch]`
 *      且自带预发布标签**的比较器接纳（`includePrerelease: false` 时）。
 *      于是 `>=0.1.2-rc.1 <0.3.0` 的 tuple 是 0.1.2，在**不认预发布的检查器**下对
 *      0.1.7-rc.2 / 0.2.0-rc.2 全判 false。
 *
 * ⚠️ **但别把这条说成"官方版静默不加载就是 peer 造成的"**（2026-10-01 代码审查纠正的因果）：
 *   DSH 真实的启动期预检**两代内核都用 `{ includePrerelease: true }`**
 *   （0.1.7-rc.2：`@deepseek-ai/dsh-app-boot/lib/index.js:300`；0.2.0-rc.2 从它自己的 `app.asar`
 *   解出来核过，同一行、同一选项），所以旧范围 `>=0.1.2-rc.1 <0.3.0` 在**真预检下两边都能过**。
 *   那次"官方版没加载"后来的结论是**我测错了**（搜了压缩的会话文件），不是 peer 的锅。
 *   改写成逐条线 `^0.1.7-rc.1 || ^0.2.0-rc.1` 属于**防御性收窄**：它排除掉 0.1.6 及更早，
 *   同时在两种 `includePrerelease` 模式下都成立（别的检查器/别的工具可没开预发布开关）。
 *
 * ⚠️ 真正该记住的差别（两条内核线**失败语义不同**，见 docs/design.md）：
 *   · 0.1.7 线把 peer 范围当**建议**：不匹配只写一行 `[desktop] compatibility warning: …`（app-boot:323-332），**插件照常加载**；
 *   · 0.2.x 线上，预检把不匹配升级成**deny** → 整行 `disabled`（stderr 只留 `disabling profile plugin …`）。
 *   所以在 0.2.x 线上 peer 是一道**硬闸门**：将来 0.3.x 内核一到、范围没跟上，我们会**整行静默消失**。
 *   → 发版检查表里要留一条"内核抬 minor 先复核 peer 范围"。
 *
 * 两层检查：
 *   ① **静态**（永远跑、零依赖）：拒绝"整体单条 `^0.x`"；必须带预发布子句；
 *      **每个 SUPPORTED_HOSTS 的 tuple 都必须在范围里有自己的预发布比较器**。
 *   ② **语义**（装了 semver 才跑，否则 SKIP；`DSH_REQUIRE_SEMVER=1` 时 SKIP 变失败）：对每个宿主 ×
 *      `includePrerelease` **两种模式**跑 `semver.satisfies`，外加 vendor 配对、边界、以及上面两条
 *      被纠正过的因果（防复发对照）。
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

  // 每条支持线都要有自己的预发布比较器 —— 静态就能抓住"caret 跨不过 minor"与"tuple 规则"两个坑。
  // ⚠️ 这条是**防御性**护栏，不是"官方版没加载"的病因（那次是我测错，见文件头）。
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
  // ⚠️ 静默 SKIP 是个盲区：零依赖环境里"语义那一半"等于没跑，而测试仍然全绿。
  // 发版自检时要 `DSH_REQUIRE_SEMVER=1`，让"缺 semver"变成一条失败（而不是悄悄跳过）。
  if (process.env.DSH_REQUIRE_SEMVER) {
    check('DSH_REQUIRE_SEMVER=1 时必须装得上 semver（发版自检不允许 SKIP）', false,
      '设 DSH_SEMVER_DIR 指向含 semver 的 node_modules');
  } else {
    console.log('\nSKIP 语义检查：没找到 semver（设 DSH_SEMVER_DIR 指向含 semver 的 node_modules，或在有 semver 的环境跑）');
  }
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

  section('vendor 配对与边界/因果对照');

  for (const [name, host] of VENDOR_HOSTS) {
    check(`${name} 覆盖两个内核配套的 ${host}`, semver.satisfies(host, peers[name] ?? '', { includePrerelease: true }), `${peers[name]} 不满足 ${host}`);
  }

  const ourRange = dshPeers[0]?.[1] ?? '';
  const ok = (host, range = ourRange, includePrerelease = true) => semver.satisfies(host, range, { includePrerelease });
  check('覆盖 0.1.7 正式版（caret 的上界 `<0.2.0-0` 不挡它）', ok('0.1.7') === true);
  check('覆盖 0.1.8 / 0.1.9（同一条 0.1.x 线）', ok('0.1.8') && ok('0.1.9'));
  check('覆盖 0.2.0 正式版与 0.2.5（第二条线内）', ok('0.2.0') && ok('0.2.5'));
  check('排除更早的线：0.1.6 / 0.1.2-rc.1', ok('0.1.6') === false && ok('0.1.2-rc.1') === false);
  check('排除下一条线：0.3.0-rc.1 / 1.0.0', ok('0.3.0-rc.1') === false && ok('1.0.0') === false);
  check('已知的缝：0.2.0-alpha/beta（低于 rc.1 的预发布）不覆盖', ok('0.2.0-alpha') === false && ok('0.2.0-beta') === false);

  // 被纠正的因果，钉在这里防复发：**真预检开了 includePrerelease**，所以旧范围其实能过
  // （说"官方版静默不加载 = peer 的锅"是错的 —— 那次是测错了）。
  check(
    '对照（真相）：`>=0.1.2-rc.1 <0.3.0` 在 includePrerelease=true 下三种宿主全**满足**（所以它不是那次不加载的原因）',
    SUPPORTED_HOSTS.every((h) => semver.satisfies(h, '>=0.1.2-rc.1 <0.3.0', { includePrerelease: true }) === true),
  );
  check(
    '对照：`^0.1.2-rc.1` 在 includePrerelease=false 下不满足 0.2.0-rc.2（tuple 规则，caret 跨不过 minor）',
    semver.satisfies('0.2.0-rc.2', '^0.1.2-rc.1', { includePrerelease: false }) === false,
  );
  check(
    '对照：`>=0.1.2-rc.1 <0.3.0` 在 includePrerelease=false 下三种宿主全不满足（换个没开预发布的检查器就会踩）',
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
