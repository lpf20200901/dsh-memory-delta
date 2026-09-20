#!/usr/bin/env node
/**
 * 客户端半边（`client/client.js`）的单元测试 —— 零依赖、零构建、不需要浏览器。
 *
 * 跑：node test/client-tests.mjs
 *
 * 为什么值得单测一个"就是画个面板"的文件：
 *   · 它是**手写的 client bundle**，不是普通 ES 模块。写成 `import` / `export`
 *     的话浏览器会直接语法报错，而 DSH 里只表现为"页签是空的"，极难查 ——
 *     所以这里把"没有 import/export、能当 classic script 跑"钉成断言。
 *   · 页签的注册入口（`apply` + `inject`）是宿主唯一的契约，字段名写错就静默不出现。
 *   · 组件在**拿不到数据**（fetch 抛错 / ok:false）时必须给出可读的错误行 ——
 *     以前踩过"面板一片空白，用户以为插件没装"的坑。
 *
 * ⚠️ **每个用例都用全新的假 React 物化一次 client.js**：
 *   `window.__ModuleLoader__.load` 给的是 factory，而 factory **闭包住了传进去的那个
 *   `require`** —— 组件的 hooks 因此绑定在"物化时那个 React"上。多个用例共用一次
 *   物化的结果，钩子状态就会互相串（踩过：第二个用例报 `setStateAt is not a function`，
 *   看起来像组件坏了，其实只是测试自己把两套 React 混用了）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = path.join(HERE, '..', 'client', 'client.js');

let pass = 0;
let fail = 0;
const failures = [];
function check(n, c, d = '') {
  if (c) {
    pass += 1;
    console.log(`  ok   ${n}`);
  } else {
    fail += 1;
    failures.push(`${n}${d ? ` — ${d}` : ''}`);
    console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`);
  }
}
const section = (t) => console.log(`\n${t}`);

/* ------------------------------------------------------------ 测试骨架 */

/** 把假的元素树里所有字符串收集起来 —— 断言"某段文案出现在某处"用。 */
function collectStrings(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
    return out;
  }
  if (typeof node === 'object') {
    collectStrings(node.kids, out);
    collectStrings(node.children, out);
    if (node.props) collectStrings(node.props.children, out);
  }
  return out;
}

const allText = (tree) => collectStrings(tree).join('\n');

/** 树里有没有某个元素带有指定 className（确认错误块真的渲染出来了）。 */
function hasClassName(node, className) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((n) => hasClassName(n, className));
  if (node.props && typeof node.props.className === 'string' && node.props.className.includes(className)) return true;
  return hasClassName(node.kids ?? node.children, className);
}

/**
 * 每个 `<summary>` 的直接文本，**相邻拼接**。
 * allText 是按节点换行拼的，验证不了「事实（facts）」这种同一行内的相邻关系。
 */
function summaryTexts(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) summaryTexts(n, out);
    return out;
  }
  if (node.type === 'summary') {
    out.push(collectStrings(node.kids, []).join(''));
    return out;
  }
  summaryTexts(node.kids ?? node.children, out);
  return out;
}

const CLIENT_SOURCE = fs.readFileSync(CLIENT_FILE, 'utf8');

/** 在假 window 里执行 client.js，拿回它注册的 factory 与调用记录。 */
function loadFactory() {
  const calls = [];
  let factory = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry) {
        calls.push(entry);
        factory = entry?.factory;
      },
    },
  };
  // client.js 是被当 classic script 执行的，`new Function` 正是同一种执行方式
  // eslint-disable-next-line no-new-func
  new Function('window', CLIENT_SOURCE)(fakeWindow);
  return { factory, calls };
}

/**
 * 最小 React：只实现 hooks 语义（useState / useEffect / useCallback）。
 *
 * `useState` 在状态变化时**同步重渲染**整个组件 —— 比实现一个调度器简单得多，
 * 而且对这个组件足够：它只有"挂载 → 拉到数据 → 重渲染"这一条链路。
 */
function makeFakeReact(makeElement) {
  const react = {
    hooks: [],
    cursor: 0,
    setStateAt: null,
    createElement: makeElement,
    useState(initial) {
      const i = react.cursor;
      react.cursor += 1;
      if (!(i in react.hooks)) react.hooks[i] = typeof initial === 'function' ? initial() : initial;
      const set = (v) => {
        const next = typeof v === 'function' ? v(react.hooks[i]) : v;
        if (Object.is(next, react.hooks[i])) return;
        react.hooks[i] = next;
        react.setStateAt(i);
      };
      return [react.hooks[i], set];
    },
    useCallback(fn) {
      react.cursor += 1;
      return fn;
    },
    useEffect(fn, deps) {
      const i = react.cursor;
      react.cursor += 1;
      const prev = react.hooks[i];
      const changed =
        !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]));
      if (changed) {
        react.hooks[i] = { deps };
        fn();
      }
    },
  };
  return react;
}

/**
 * 物化 client.js 并渲染一次组件的**完整装配**（每个用例一份，互不串状态）。
 *
 * ⚠️ 返回 `tree()` **取值函数**而不是 `tree` 快照：状态更新会换一棵新树，
 * 直接返回变量只会永远拿到首帧那棵（"读取中…"）。
 */
function mountPanel(props) {
  const element = (type, elemProps, ...kids) => ({ type, props: elemProps ?? null, kids: kids.length ? kids : [] });
  const react = makeFakeReact(element);
  const required = [];
  const fakeRequire = (spec) => {
    required.push(spec);
    if (spec === 'react') return react;
    if (spec === 'react-dom') return {};
    throw new Error(`假的 require 不认识 ${spec}`);
  };

  const { factory, calls: loadCalls } = loadFactory();
  const exportsOf = factory(fakeRequire);

  let tree = null;
  let depth = 0;
  react.setStateAt = () => {
    if (depth > 20) throw new Error('重渲染次数过多（hooks 里可能有死循环）');
    depth += 1;
    react.cursor = 0;
    tree = exportsOf.MemoryPanel(props);
  };
  react.cursor = 0;
  tree = exportsOf.MemoryPanel(props);

  return { exportsOf, required, loadCalls, tree: () => tree, react };
}

/** 等微任务队列清空（把 fetch 的 promise 链跑完）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/* -------------------------------------------------- 加载 client.js（真文件） */

section('client.js 的形态：classic script、没有 ESM 语法');
{
  check('文件存在且非空', CLIENT_SOURCE.length > 500, `${CLIENT_SOURCE.length} 字节`);
  check('没有 `</script>` 字面量（会提前关掉外层的 script 元素）', !CLIENT_SOURCE.includes('</' + 'script>'));
  // 逐行看行首，避免把注释里提到的 "import" 误判成语句
  const illegal = CLIENT_SOURCE.split(/\r?\n/)
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^\s*(import|export)\s/.test(line));
  check('没有行首的 import / export 语句', illegal.length === 0, illegal.map(([n, l]) => `${n}: ${l.trim()}`).join(' | '));
  check('不出现动态 import(', !/\bimport\s*\(/.test(CLIENT_SOURCE));
  check('注册调用是 window.__ModuleLoader__.load({...})', /window\.__ModuleLoader__\.load\(\{/.test(CLIENT_SOURCE));
}

/* ----------------------------------------------- 在假环境里真的执行它 */

section('在假 window 里执行：注册了 id = dsh-memory-delta 的 factory');
{
  let thrown = null;
  let loaded = null;
  try {
    loaded = loadFactory();
  } catch (error) {
    thrown = error;
  }
  check('执行不抛异常', thrown === null, thrown ? `${thrown.name}: ${thrown.message}` : '');
  check('load 恰好被调用一次', loaded?.calls.length === 1, String(loaded?.calls.length));
  // 宿主用"解析出的包名"当浏览器模块身份 —— 写成改名前那个 dsh-memory 会对不上，页签静默不出现
  check('注册的 id 是包名 dsh-memory-delta', loaded?.calls[0]?.id === 'dsh-memory-delta', String(loaded?.calls[0]?.id));
  check('factory 是函数', typeof loaded?.factory === 'function');
}

/* ------------------------------------------------- 用假 require 物化 factory */

section('物化 factory：导出 apply / inject');
{
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  check('导出 apply 是函数', typeof mounted.exportsOf?.apply === 'function');
  check('导出 inject 是数组', Array.isArray(mounted.exportsOf?.inject), JSON.stringify(mounted.exportsOf?.inject));
  check("inject 含 'betterSidebar'", mounted.exportsOf?.inject?.includes('betterSidebar'), JSON.stringify(mounted.exportsOf?.inject));
  check(
    '只 require 基座内的模块（react / react-dom）',
    mounted.required.every((s) => s === 'react' || s === 'react-dom'),
    mounted.required.join(','),
  );
}

/* ------------------------------------------------------ apply 注册页签 */

section('apply：注册页签 descriptor');
{
  const mounted = mountPanel({ scope: { sessionId: 's1' } });
  const effects = [];
  let captured = null;
  const fakeCtx = {
    effect(fn) {
      effects.push(fn);
      return fn();
    },
    betterSidebar: {
      registerTab(descriptor) {
        captured = descriptor;
        return () => {};
      },
    },
  };
  let thrown = null;
  try {
    mounted.exportsOf.apply(fakeCtx);
  } catch (error) {
    thrown = error;
  }
  check('apply 不抛异常', thrown === null, thrown ? `${thrown.name}: ${thrown.message}` : '');
  check('走了 ctx.effect（副作用由 Cordis 托管，可卸载）', effects.length === 1, String(effects.length));
  check('注册了 descriptor', !!captured);
  check('id 正确（包名:memory）', captured?.id === 'dsh-memory-delta:memory', String(captured?.id));
  check('title 是「记忆」', captured?.title === '记忆', String(captured?.title));
  check('component 是函数', typeof captured?.component === 'function');
  check('component 就是导出的 MemoryPanel', captured?.component === mounted.exportsOf.MemoryPanel);
}

/* --------------------------------------------- 组件：正常数据能渲染出来 */

const SAMPLE = {
  ok: true,
  root: 'D:\\proj\\memory',
  scope: 'workspace:D:\\proj',
  workspace: 'D:\\proj',
  today: '2026-09-17',
  budget: 3072,
  bytes: 953,
  entries: [
    { id: 'fact-a', type: 'fact', key: 'node-rm-nonascii', status: 'active', tags: ['node'], line: '路径含非 ASCII 时不要用 rmSync' },
    { id: 'dec-b', type: 'decision', status: 'active', tags: [], line: '记忆的事实层只能由人确认后写入' },
  ],
  due: [{ id: 'fact-a', line: '路径含非 ASCII 时不要用 rmSync', verifyWhen: '2026-09-14', due: '2026-09-14', overdueDays: 3 }],
  inbox: [{ id: 'cand-1', type: 'fact', line: '沙箱禁止命名管道', date: '2026-09-17' }],
  counts: { active: 2, facts: 1, decisions: 1, inbox: 1, archive: 0, due: 1 },
};

section('组件：正常数据');
{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  };

  let mounted = null;
  let thrown = null;
  try {
    mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  } catch (error) {
    thrown = error;
  }
  const firstText = mounted ? allText(mounted.tree()) : '';
  check('渲染不抛异常', thrown === null, thrown ? `${thrown.name}: ${thrown.message}` : '');
  check('挂载时先显示"读取中…"', firstText.includes('读取中…'), firstText.slice(0, 120));
  check('fetch 指向 /dsh-memory-delta/state', calls[0]?.url === '/dsh-memory-delta/state', String(calls[0]?.url));
  check('用 POST（workspace 走 JSON body，不做路径编码）', calls[0]?.options?.method === 'POST', String(calls[0]?.options?.method));
  check(
    '把 scope.cwd 作为 workspace 传过去',
    JSON.parse(calls[0]?.options?.body ?? '{}').workspace === 'D:\\proj',
    String(calls[0]?.options?.body),
  );

  await flush();
  const text = allText(mounted.tree());
  check('显示记忆库 root', text.includes('D:\\proj\\memory'), text.slice(0, 200));
  check('显示常驻条数', text.includes('常驻 2 条'), text.slice(0, 200));
  check('显示注入字节与预算', text.includes('注入 953 / 3072 字节'), text.slice(0, 200));
  check('没有超出预算时不给超预算提示', !text.includes('超出预算'), text.slice(0, 200));
  check('列出待复核项', text.includes('待复核') && text.includes('已超期 3 天'), text.slice(0, 400));
  check('待复核项带上 verify_when', text.includes('verify_when: 2026-09-14'), text.slice(0, 400));
  check('待复核项显示结论行', text.includes('路径含非 ASCII 时不要用 rmSync'), text.slice(0, 400));
  check('常驻条目按事实/决策分组', text.includes('事实') && text.includes('决策'), text.slice(0, 400));
  const summaries = summaryTexts(mounted.tree()).join(' | ');
  check(
    '分组标题标出磁盘目录名（中文 ↔ 文件夹对照）',
    summaries.includes('事实（facts）') && summaries.includes('决策（decisions）'),
    summaries,
  );
  check('收件箱分目标出 inbox 目录', summaries.includes('收件箱候选（inbox）'), summaries);
  check('收件箱说明里点名 inbox/ → facts/decisions 的去向', text.includes('inbox/ 目录') && text.includes('facts/ 或 decisions/'), text.slice(0, 500));
  check('带 key 的条目显示 [key]', text.includes('[node-rm-nonascii]'), text.slice(0, 400));
  check('收件箱候选有数量与提示', text.includes('收件箱候选') && text.includes('确认后才成为常驻记忆'), text.slice(0, 500));
  check('收件箱列出候选结论', text.includes('沙箱禁止命名管道'), text.slice(0, 500));
  check('有刷新按钮', text.includes('刷新'), text.slice(0, 200));
  check('读取完成后没有错误块', !hasClassName(mounted.tree(), 'dsh-memory-delta-error'));

  globalThis.fetch = originalFetch;
}

/* ------------------------------------------------- 组件：超预算要标红 */

section('组件：超预算');
{
  const originalFetch = globalThis.fetch;
  const over = { ...SAMPLE, bytes: 4096, due: [], counts: { ...SAMPLE.counts, due: 0 } };
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(over) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();
  const text = allText(mounted.tree());
  check('超出预算时明确标出', text.includes('注入 4096 / 3072 字节') && text.includes('超出预算'), text.slice(0, 240));
  check(
    '没有到期项时说清楚"什么时候才会出现"',
    text.includes('没有到复核期的记忆') && text.includes('verify_when 到期后才会出现'),
    text.slice(0, 400),
  );
  globalThis.fetch = originalFetch;
}

/* ------------------------------------------------------- 组件：空态文案 */

section('组件：空态文案（没有任何数据时不能让人以为是坏了）');
{
  const originalFetch = globalThis.fetch;
  // 空收件箱最容易让人误会成"面板读的是文件夹吗/是不是坏了"—— 文案必须说清它为什么空
  const empty = { ...SAMPLE, due: [], inbox: [], counts: { ...SAMPLE.counts, due: 0, inbox: 0 } };
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(empty) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();
  const text = allText(mounted.tree());
  check(
    '空收件箱时说明"模型写了才会出现，空着正常"',
    text.includes('还没有待确认的候选') && text.includes('memory_write') && text.includes('空着是正常的'),
    text.slice(0, 400),
  );
  check('空收件箱时依然保留"确认后才成为常驻记忆"的说明', text.includes('确认后才成为常驻记忆'), text.slice(0, 400));
  globalThis.fetch = originalFetch;
}

/* ------------------------------------------------------- 组件：错误态 */

section('组件：fetch 抛错 / ok:false');
{
  const originalFetch = globalThis.fetch;

  globalThis.fetch = () => Promise.reject(new Error('Failed to fetch'));
  const a = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  let thrownA = null;
  try {
    await flush();
  } catch (error) {
    thrownA = error;
  }
  check('fetch 抛错时不向外抛异常', thrownA === null, thrownA ? String(thrownA.message) : '');
  const textA = allText(a.tree());
  check('fetch 抛错时有明确错误行', textA.includes('读取记忆库失败') && textA.includes('Failed to fetch'), textA.slice(0, 240));
  check('错误态有可操作的提示（同步 + 重启）', textA.includes('重启 DSH'), textA.slice(0, 320));
  check('错误块真的渲染出来了', hasClassName(a.tree(), 'dsh-memory-delta-error'));

  globalThis.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ ok: false, error: '只允许来自本机回环地址的请求' }),
    });
  const b = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();
  check('HTTP 非 2xx 时回显宿主的错误文案', allText(b.tree()).includes('只允许来自本机回环地址的请求'), allText(b.tree()).slice(0, 240));

  globalThis.fetch = () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: false, error: '读取记忆库失败：EACCES' }) });
  const c = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();
  check('ok:false 时也显示错误', allText(c.tree()).includes('EACCES'), allText(c.tree()).slice(0, 240));

  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) });
  const d = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();
  check('响应不是 JSON 时也不炸', allText(d.tree()).includes('读取记忆库失败'), allText(d.tree()).slice(0, 240));

  globalThis.fetch = originalFetch;
}

/* --------------------------------------------- 组件：scope 里没有 cwd */

section('组件：scope 里没有 cwd（从响应反推 workspace）');
{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    calls.push(JSON.parse(options.body ?? '{}'));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  };
  const mounted = mountPanel({ scope: { sessionId: 's1' } });
  await flush();
  check(
    '第一次请求不带 workspace（让宿主退回插件配置的 root）',
    calls.length >= 1 && calls[0].workspace === undefined,
    JSON.stringify(calls[0] ?? null),
  );
  check('从响应的 workspace 反推出后续请求的参数', calls.length >= 2 && calls[1].workspace === 'D:\\proj', JSON.stringify(calls));
  check('反推之后仍然渲染成功', allText(mounted.tree()).includes('常驻 2 条'), allText(mounted.tree()).slice(0, 200));
  globalThis.fetch = originalFetch;
}

/* --------------------------------------------------------------- 汇总 */

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
