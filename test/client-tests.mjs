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
 * 每个分组头（`.dsh-memory-delta-toggle`）的直接文本，**相邻拼接**。
 * allText 是按节点换行拼的，验证不了「事实（facts）」这种同一行内的相邻关系。
 */
function headerTexts(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) headerTexts(n, out);
    return out;
  }
  if (typeof node.props?.className === 'string' && node.props.className.includes('dsh-memory-delta-toggle')) {
    out.push(collectStrings(node.kids, []).join(''));
    return out;
  }
  headerTexts(node.kids ?? node.children, out);
  return out;
}

/** 深度优先找第一个 className 含某串的节点（找不到返回 null）。 */
function findByClass(node, className) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findByClass(n, className);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node.props?.className === 'string' && node.props.className.includes(className)) return node;
  return findByClass(node.kids ?? node.children, className);
}

/** 找所有 className 含某串的节点。 */
function findAllByClass(node, className, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) findAllByClass(n, className, out);
    return out;
  }
  if (typeof node.props?.className === 'string' && node.props.className.includes(className)) out.push(node);
  findAllByClass(node.kids ?? node.children, className, out);
  return out;
}

/** 按 props 上的任意键找第一个节点（`section()` 把分组 key 放在 props.key 上，断言分组要用它）。 */
function findByProp(node, prop, value) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findByProp(n, prop, value);
      if (hit) return hit;
    }
    return null;
  }
  if (node.props && node.props[prop] === value) return node;
  return findByProp(node.kids ?? node.children, prop, value);
}

/** 树里所有**分组**（`.dsh-memory-delta-section` 且带 props.key）的 key，按渲染顺序。 */
function orderedSectionKeys(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) orderedSectionKeys(n, out);
    return out;
  }
  const cls = node.props?.className;
  // ⚠️ className 用**整词**匹配：`dsh-memory-delta-section-head` 这类子节点也含这一段
  if (typeof cls === 'string' && cls.split(/\s+/).includes('dsh-memory-delta-section') && node.props.key) out.push(node.props.key);
  orderedSectionKeys(node.kids ?? node.children, out);
  return out;
}

/** 某个分组（section）节点本身 —— 断言"这一组里有什么"时用它，避免命中同名的别层分组。 */
const sectionByKey = (mounted, key) => findByProp(mounted.tree(), 'key', key);

/**
 * 切换归纳维度（主题 / 类型 / 标签 / 日期）。
 *
 * ⚠️ 维度是**三个阶段共用**的，默认是「主题」—— 所以任何断言"类型视图长什么样"的用例
 * 都得先切过去，否则会在主题视图上断言类型分组（改默认维度时真踩到：测试直接崩在一句 undefined 上）。
 */
function selectDimension(mounted, label) {
  const seg = findAllByClass(mounted.tree(), 'dsh-memory-delta-seg')[0];
  const btn = seg && seg.kids.find((n) => allText(n).trim() === label);
  if (!btn) throw new Error(`找不到维度按钮：${label}`);
  btn.props.onClick({});
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
  // ⚠️ 这里数的是**渲染嵌套深度**，不是"总渲染次数"：
  // 一个用例里点十几次按钮本来就是正常的（每次 setState 都是一次重渲染），
  // 而"渲染过程中又 setState"才会让深度无限增长 —— 那才是 hooks 死循环。
  let renderDepth = 0;
  react.setStateAt = () => {
    if (renderDepth > 20) throw new Error('重渲染嵌套过深（hooks 里可能有死循环）');
    renderDepth += 1;
    react.cursor = 0;
    try {
      tree = exportsOf.MemoryPanel(props);
    } finally {
      renderDepth -= 1;
    }
  };
  react.cursor = 0;
  tree = exportsOf.MemoryPanel(props);

  return { exportsOf, required, loadCalls, tree: () => tree, react };
}

/** 等微任务队列清空（把 fetch 的 promise 链跑完）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 等一段时间 —— 搜索框是**防抖 200ms** 后才发请求的，测它必须真的等过去。 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // component 现在是一层包装（把 ctx 喂给面板，面板要用 ctx.betterSidebar.openFile）
  const wrapped = captured?.component?.({ scope: { sessionId: 's1' } });
  check('component 包的是导出的 MemoryPanel', wrapped?.type === mounted.exportsOf.MemoryPanel, String(wrapped?.type?.name));
  check('包装层把 ctx 传给面板（面板靠它调 openFile）', wrapped?.props?.hostCtx === fakeCtx, String(wrapped?.props?.hostCtx));
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
    // 故意把**旧的**放前面：界面要按日期倒序（最近记的排前面），断言能抓到这个排序
    {
      id: 'fact-old',
      type: 'fact',
      key: 'old-key',
      status: 'active',
      topic: '环境与沙箱',
      tags: ['node'],
      date: '2026-09-01',
      file: 'D:\\proj\\memory\\facts\\fact-old.md',
      line: '旧的一条事实',
    },
    {
      id: 'fact-a',
      type: 'fact',
      key: 'node-rm-nonascii',
      status: 'active',
      topic: '环境与沙箱',
      tags: ['node', 'sandbox'],
      date: '2026-09-17',
      file: 'D:\\proj\\memory\\facts\\node-rm-nonascii.md',
      line: '路径含非 ASCII 时不要用 rmSync',
    },
    {
      // 故意**不写 topic**：面板里要落到「未归类」组，且它得排在命名组后面
      id: 'dec-b',
      type: 'decision',
      status: 'active',
      tags: [],
      date: '2026-09-16',
      file: 'D:\\proj\\memory\\decisions\\fact-layer-writer.md',
      line: '记忆的事实层只能由人确认后写入',
    },
  ],
  due: [{ id: 'fact-a', line: '路径含非 ASCII 时不要用 rmSync', verifyWhen: '2026-09-14', due: '2026-09-14', overdueDays: 3 }],
  inbox: [{ id: 'cand-1', type: 'fact', line: '沙箱禁止命名管道', date: '2026-09-17', file: 'D:\\proj\\memory\\inbox\\cand-1.md' }],
  counts: { active: 3, facts: 2, decisions: 1, inbox: 1, archive: 0, due: 1 },
};

/** 面板要用 ctx.betterSidebar.openFile；这里给一个记账用的假服务。 */
function fakeSidebar(overrides = {}) {
  const opened = [];
  return {
    opened,
    service: {
      openFile(scope, path, title) {
        opened.push({ scope, path, title });
      },
      ...overrides,
    },
  };
}

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

  // 默认维度是「主题」（人指定的归纳）—— 先验它，再切到「类型」验下面那一批类型视图的断言
  const segHead = allText(findAllByClass(mounted.tree(), 'dsh-memory-delta-seg')[0]);
  check('头部有四个维度按钮（主题在前）', ['主题', '类型', '标签', '日期'].every((t) => segHead.includes(t)), segHead);
  {
    const first = findAllByClass(mounted.tree(), 'dsh-memory-delta-seg')[0].kids[0];
    check('默认选中「主题」', String(first.props.className).includes('is-on') && allText(first).trim() === '主题', `${allText(first)} / ${first.props.className}`);
  }
  {
    check('主题视图：同主题的条目归到一组', Boolean(sectionByKey(mounted, 'standing:topic:环境与沙箱')), headerTexts(mounted.tree()).join(' | '));
    // 顺序要在**同一层内部**比：三层的分组头都在同一份列表里，跨层比会误判
    const keys = orderedSectionKeys(mounted.tree());
    check(
      '主题视图：没归类的单独一组，且排在同一层的命名组之后',
      Boolean(sectionByKey(mounted, 'standing:topic:__untopic__')) &&
        keys.indexOf('standing:topic:环境与沙箱') < keys.indexOf('standing:topic:__untopic__'),
      keys.join(' > '),
    );
    check('待你确认这一层也跟随维度（单条候选也有「未归类」分组头）', Boolean(sectionByKey(mounted, 'inbox:topic:__untopic__')), keys.join(' > '));
  }
  selectDimension(mounted, '类型');

  const text = allText(mounted.tree());
  check('显示记忆库 root', text.includes('D:\\proj\\memory'), text.slice(0, 200));
  // 条数只在流程条里报一次（状态行不再重复"常驻 N 条"）
  check('流程条显示已在用条数', text.includes('已在用 3'), text.slice(0, 240));
  check('显示注入字节与预算', text.includes('注入 953 / 3072 字节'), text.slice(0, 200));
  check('没有超出预算时不给超预算提示', !text.includes('超出预算'), text.slice(0, 200));
  check('列出待复核项', text.includes('待复核') && text.includes('已超期 3 天'), text.slice(0, 400));
  check('待复核项带上 verify_when', text.includes('verify_when: 2026-09-14'), text.slice(0, 400));
  check('待复核项显示结论行', text.includes('路径含非 ASCII 时不要用 rmSync'), text.slice(0, 400));
  check('常驻条目按事实/决策分组', text.includes('事实') && text.includes('决策'), text.slice(0, 400));
  const headers = headerTexts(mounted.tree()).join(' | ');
  check(
    '分组标题标出磁盘目录名（中文 ↔ 文件夹对照）',
    headers.includes('事实（facts）') && headers.includes('决策（decisions）'),
    headers,
  );
  check('收件箱分目标出 inbox 目录', headers.includes('待你确认（inbox）'), headers);
  // 分组按**流程阶段**排：待你确认 → 已在用 → 已归档，一眼看出东西在哪一步
  //（真实反馈：光看 facts 这个名字判断不出它在流程里的位置 —— 所以把阶段提到最外层）
  check(
    '分组按流程阶段排（待你确认 → 已在用 → 已归档）',
    ['待你确认', '已在用', '已归档'].every((t) => headers.includes(t)) &&
      headers.indexOf('待你确认') < headers.indexOf('已在用') &&
      headers.indexOf('已在用') < headers.indexOf('已归档'),
    headers,
  );
  check(
    '每个阶段都有一句人话说明它在流程里干什么',
    headers.includes('你点头才生效') && headers.includes('每轮会话自动发给模型') && headers.includes('不再发给模型'),
    headers,
  );
  check(
    '类型（事实/决策）降为「已在用」内部的子分组，并用**人话**说明各自记什么',
    headers.includes('事实（facts）踩过的坑') && headers.includes('决策（decisions）你定下的约定'),
    headers,
  );
  check(
    '每个类型组里还有一句"写起来的诀窍"（什么情况下适用 / 为什么这么定）',
    text.includes('什么情况下适用') && text.includes('为什么这么定'),
    text.slice(0, 800),
  );
  {
    const flowText = allText(findByClass(mounted.tree(), 'dsh-memory-delta-flow'));
    check(
      '顶部流程条列出各阶段当前条数',
      flowText.includes('流程') && flowText.includes('待你确认') && flowText.includes('已在用') && flowText.includes('已归档'),
      flowText,
    );
    check(
      '流程条数字与状态一致（候选 1 / 已在用 3 / 归档 0）',
      /待你确认 1/.test(flowText) && /已在用 3/.test(flowText) && /已归档 0/.test(flowText),
      flowText,
    );
  }
  check('收件箱说明里点名候选的去向', text.includes('提升到 facts/ decisions/') && text.includes('已在用'), text.slice(0, 600));
  check('带 key 的条目显示 key（等宽、不带方括号）', text.includes('node-rm-nonascii'), text.slice(0, 400));
  check('待你确认分组带数量', /待你确认（inbox）[^|]*1/.test(headers), headers);
  check('收件箱列出候选结论', text.includes('沙箱禁止命名管道'), text.slice(0, 500));
  check('有刷新按钮', text.includes('刷新'), text.slice(0, 200));
  check('读取完成后没有错误块', !hasClassName(mounted.tree(), 'dsh-memory-delta-error'));

  // ④ 层级：箭头（可展开的标志）+ 条目上的标签/日期/文件名
  const carets = findAllByClass(mounted.tree(), 'dsh-memory-delta-caret');
  check('每个分组头都有自绘箭头（能看出可以展开）', carets.length >= 4, String(carets.length));
  check('默认展开 → 箭头带 is-open', carets.every((c) => c.props.className.includes('is-open')), carets.map((c) => c.props.className).join('|'));
  check('条目显示标签', text.includes('sandbox'), text.slice(0, 400));
  check('条目显示日期', text.includes('2026-09-17'), text.slice(0, 400));
  check('条目显示文件名（暴露难看的自动命名）', text.includes('node-rm-nonascii.md'), text.slice(0, 400));
  check(
    '条目按日期倒序（09-17 在 09-01 之前）',
    text.indexOf('路径含非 ASCII 时不要用 rmSync') < text.indexOf('旧的一条事实'),
    text.slice(0, 500),
  );

  globalThis.fetch = originalFetch;
}

/* ------------------------------------- 组件：抽屉（折叠）真的能收起来 */

section('组件：折叠 / 展开');
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();
  selectDimension(mounted, '类型'); // 下面断言的是「事实」分组头 —— 先切到类型视图

  // ⚠️ 必须**按分组 key 定位**「已在用」的事实组：类型视图下「待你确认」里也可能有事实组，
  // 按"第一个文字含事实的分组头"找会命中上面那一层（去掉"单组不出头"之后真踩到）
  const factsToggle = () => findAllByClass(sectionByKey(mounted, 'standing:type:facts'), 'dsh-memory-delta-toggle')[0];
  check('找到「已在用」的事实分组头（是 button，键盘也能操作）', factsToggle()?.type === 'button', String(factsToggle()?.type));
  check('展开时 aria-expanded=true', factsToggle()?.props?.['aria-expanded'] === 'true', String(factsToggle()?.props?.['aria-expanded']));

  // ⚠️ 「路径含非 ASCII…」这句话在**待复核**块里也有一份（SAMPLE.due 用的同一行），
  // 所以不能拿全文断言，得盯住「事实」分组里的条目节点。
  const factItems = () =>
    findAllByClass(mounted.tree(), 'dsh-memory-delta-item').filter((n) => allText(n).includes('路径含非 ASCII'));
  check('收起前「事实」分组里有这条条目', factItems().length === 1, String(factItems().length));

  factsToggle().props.onClick({});
  check('收起后条目消失', factItems().length === 0, String(factItems().length));
  const after = allText(mounted.tree());
  check('收起后其它分组不受影响（决策仍在）', after.includes('记忆的事实层只能由人确认后写入'), after.slice(0, 300));
  check('收起后该分组头的箭头不再带 is-open', !findByClass(factsToggle(), 'dsh-memory-delta-caret').props.className.includes('is-open'));
  check('分组头的展开标志变成"展开"（标题提示）', factsToggle().props.title === '展开', String(factsToggle().props.title));

  // 重渲染（点刷新）之后折叠状态必须**记住** —— 早前用 <details open> 时会被弹回全展开
  const refresh = findAllByClass(mounted.tree(), 'dsh-memory-delta-btn')[0];
  refresh.props.onClick({});
  await flush();
  check('刷新后仍然是收起的（折叠状态由组件记着）', factItems().length === 0, String(factItems().length));

  globalThis.fetch = originalFetch;
}

/* --------------------------- 组件：点条目打开文件（唯一的外跳入口） */

section('组件：点条目打开文件');
{
  const originalFetch = globalThis.fetch;
  const sidebar = fakeSidebar();
  const fetched = [];
  globalThis.fetch = (url, options) => {
    fetched.push({ url, body: options?.body });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  };

  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: sidebar.service } });
  await flush();

  // 点条目 → 在侧边栏编辑器里打开这条记忆（官方 openFile）
  const item = findAllByClass(mounted.tree(), 'dsh-memory-delta-item').find((n) => allText(n).includes('路径含非 ASCII'));
  check('条目行可点（role=button，title 提示会打开哪个文件）', item?.props?.role === 'button' && /打开 .*node-rm-nonascii\.md/.test(String(item?.props?.title)), String(item?.props?.title));
  item.props.onClick({});
  check('openFile 被调用，参数是绝对路径', sidebar.opened[0]?.path === 'D:\\proj\\memory\\facts\\node-rm-nonascii.md', JSON.stringify(sidebar.opened[0]));
  check('openFile 带上 scope（会话作用域）', sidebar.opened[0]?.scope?.sessionId === 's1', JSON.stringify(sidebar.opened[0]?.scope));
  check('openFile 的标题用文件名', sidebar.opened[0]?.title === 'node-rm-nonascii.md', String(sidebar.opened[0]?.title));

  // 按用户要求精简：不再有「打开」小标签、「打开目录」按钮，也不再请求 /reveal
  check('条目行没有多余的「打开」小标签（整行可点就够）', !allText(mounted.tree()).includes('打开目录'), allText(mounted.tree()).slice(0, 200));
  check('分组头上没有「打开目录」按钮', findAllByClass(mounted.tree(), 'dsh-memory-delta-mini').every((n) => !allText(n).includes('打开目录')));
  check('不再请求 /dsh-memory-delta/reveal', fetched.every((c) => c.url !== '/dsh-memory-delta/reveal'), fetched.map((c) => c.url).join(','));

  globalThis.fetch = originalFetch;
}

/* --------------------- 组件：打开失败要说清原因（不能"点了没反应"） */

section('组件：打开失败的原因要显示出来');
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });

  // better-sidebar 没有 openFile（老版本）→ 给出可读提示，而不是静默无反应
  const noApi = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: {} } });
  await flush();
  findByClass(noApi.tree(), 'dsh-memory-delta-item').props.onClick({});
  check('没有 openFile 接口时给出可读提示', allText(noApi.tree()).includes('没有 openFile 接口'), allText(noApi.tree()).slice(0, 200));

  globalThis.fetch = originalFetch;
}

/* --------------------------- 组件：收件箱提升 / 整理文件名（写记忆库） */

section('组件：收件箱提升与整理文件名');
{
  const originalFetch = globalThis.fetch;
  const actionCalls = [];
  let stateCalls = 0;
  const respond = (url, options) => {
    if (url === '/dsh-memory-delta/action') {
      const body = JSON.parse(options?.body ?? '{}');
      actionCalls.push(body);
      if (body.op === 'promote') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, op: 'promote', id: body.id, target: 'facts', superseded: [] }) });
      }
      if (body.to === 'bad-name') {
        return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ ok: false, error: '目标 id 已被占用：bad-name' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, op: 'rename', from: body.id, to: body.to, refs: ['new-one'] }) });
    }
    stateCalls += 1;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  };
  globalThis.fetch = respond;

  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();

  // ⑤ 收件箱一键提升
  const inboxItem = findAllByClass(mounted.tree(), 'dsh-memory-delta-item').find((n) => allText(n).includes('沙箱禁止命名管道'));
  const promoteBtn = findAllByClass(inboxItem, 'dsh-memory-delta-mini').find((n) => allText(n).includes('提升到'));
  check('收件箱条目上有「提升到 facts/」按钮', allText(promoteBtn).includes('提升到 facts/'), allText(promoteBtn));
  const before = stateCalls;
  promoteBtn.props.onClick({ stopPropagation() {}, preventDefault() {} });
  await flush();
  check('提升发的是 op=promote + 条目 id', actionCalls[0]?.op === 'promote' && actionCalls[0]?.id === 'cand-1', JSON.stringify(actionCalls[0]));
  check('提升请求带上 workspace（宿主据此定位记忆库）', actionCalls[0]?.workspace === 'D:\\proj', JSON.stringify(actionCalls[0]));
  check('提升成功后重新拉状态（界面立刻与磁盘一致）', stateCalls > before, `${before} → ${stateCalls}`);
  check('提升成功后给出提示', allText(mounted.tree()).includes('已提升 cand-1 → facts/'), allText(mounted.tree()).slice(0, 200));

  // ⑥ 整理文件名：内联输入 → rename
  const tidyItem = findAllByClass(mounted.tree(), 'dsh-memory-delta-item').find((n) => allText(n).includes('旧的一条事实'));
  const tidyBtn = findAllByClass(tidyItem, 'dsh-memory-delta-mini').find((n) => allText(n).includes('整理文件名'));
  check('文件名与 key 不一致的条目会给「整理文件名」入口', Boolean(tidyBtn));
  tidyBtn.props.onClick({ stopPropagation() {}, preventDefault() {} });
  const input = findByClass(mounted.tree(), 'dsh-memory-delta-rename')?.kids?.find?.((n) => n.type === 'input');
  check('点开后出现内联输入框', Boolean(input), JSON.stringify(findByClass(mounted.tree(), 'dsh-memory-delta-rename')));
  check('输入框预填已有的 key', input?.props?.value === 'old-key', String(input?.props?.value));

  input.props.onChange({ target: { value: 'renamed-entry' } });
  const okBtn = findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-rename'), 'dsh-memory-delta-mini')[0];
  okBtn.props.onClick({ stopPropagation() {}, preventDefault() {} });
  await flush();
  const renameCall = actionCalls.find((c) => c.op === 'rename');
  check('改名发的是 op=rename + 新名字', renameCall?.id === 'fact-old' && renameCall?.to === 'renamed-entry', JSON.stringify(renameCall));
  check('改名成功后提示里带上同步的引用数', allText(mounted.tree()).includes('已改名 fact-old → renamed-entry') && allText(mounted.tree()).includes('1 处引用'), allText(mounted.tree()).slice(0, 240));

  // 失败态：宿主拒绝时把原因原样显示
  tidyBtn.props.onClick({ stopPropagation() {}, preventDefault() {} });
  const input2 = findByClass(mounted.tree(), 'dsh-memory-delta-rename').kids.find((n) => n.type === 'input');
  input2.props.onChange({ target: { value: 'bad-name' } });
  findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-rename'), 'dsh-memory-delta-mini')[0].props.onClick({
    stopPropagation() {},
    preventDefault() {},
  });
  await flush();
  check('改名被拒绝时回显宿主原因', allText(mounted.tree()).includes('改名失败') && allText(mounted.tree()).includes('已被占用'), allText(mounted.tree()).slice(0, 260));

  // 空名字：本地就挡住，不发请求
  const callsBeforeEmpty = actionCalls.length;
  input2.props.onChange({ target: { value: '   ' } });
  findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-rename'), 'dsh-memory-delta-mini')[0].props.onClick({
    stopPropagation() {},
    preventDefault() {},
  });
  await flush();
  check('空名字不请求宿主（本地就拦）', actionCalls.length === callsBeforeEmpty, String(actionCalls.length - callsBeforeEmpty));
  check('空名字给出可操作提示', allText(mounted.tree()).includes('新文件名不能为空'), allText(mounted.tree()).slice(0, 240));

  globalThis.fetch = originalFetch;
}

/* --------------------------- 组件：搜索（复用宿主同一套检索实现） */

section('组件：搜索');
{
  const originalFetch = globalThis.fetch;
  const sidebar = fakeSidebar();
  const searchCalls = [];
  globalThis.fetch = (url, options) => {
    if (url === '/dsh-memory-delta/search') {
      const body = JSON.parse(options?.body ?? '{}');
      searchCalls.push(body);
      if (body.query === '没这个词') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, query: body.query, where: 'all', total: 0, matches: [] }) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            query: body.query,
            where: 'all',
            total: 2,
            matches: [
              {
                id: 'sandbox-no-pipe',
                where: 'facts',
                type: 'fact',
                key: 'sandbox-no-pipe',
                tags: ['sandbox'],
                date: '2026-09-17',
                file: 'D:\\proj\\memory\\facts\\sandbox-no-pipe.md',
                line: '沙箱禁止命名管道：捕获子进程输出会 EPERM',
                snippet: '…沙箱禁止命名管道：捕获子进程输出会 EPERM，要重定向到文件…',
                matched: ['沙箱', '管道'],
                score: 12.5,
              },
              { id: 'journal:42', where: 'journal', line: '今天在讨论把面板接上检索', snippet: '今天在讨论把面板接上检索，复用 rankDocs', score: 3.2, file: 'D:\\proj\\memory\\journal.md' },
            ],
          }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  };

  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: sidebar.service } });
  await flush();

  const input = findByClass(mounted.tree(), 'dsh-memory-delta-search-input');
  check('面板上有搜索框', input?.type === 'input', String(input?.type));
  check('搜索框有说明性 placeholder', /搜索/.test(String(input?.props?.placeholder)), String(input?.props?.placeholder));

  input.props.onChange({ target: { value: '沙箱禁管道' } });
  await wait(320);
  check('停顿后自动发搜索请求', searchCalls.length === 1 && searchCalls[0].query === '沙箱禁管道', JSON.stringify(searchCalls));
  check('搜索请求带上 workspace（宿主据此定位记忆库）', searchCalls[0]?.workspace === 'D:\\proj', JSON.stringify(searchCalls[0]));

  const text = allText(mounted.tree());
  check('搜索时只显示结果（分组视图让位，避免两套列表混在一起）', text.includes('搜索结果') && !headerTexts(mounted.tree()).some((hd) => hd.includes('已在用')), text.slice(0, 200));
  check('分组头上显示命中条数', headerTexts(mounted.tree()).some((hd) => hd.includes('搜索结果') && hd.includes('2')), headerTexts(mounted.tree()).join(' | '));
  check('结果里标出命中所在的层（事实 / 流水）', text.includes('事实') && text.includes('流水'), text.slice(0, 300));
  check('结果里显示命中片段（不只是首行）', text.includes('要重定向到文件'), text.slice(0, 400));
  check('结果里显示文件名', text.includes('sandbox-no-pipe.md'), text.slice(0, 400));
  check('结果里显示 key 与日期', text.includes('sandbox-no-pipe') && text.includes('2026-09-17'), text.slice(0, 400));

  const hit = findAllByClass(mounted.tree(), 'dsh-memory-delta-item').find((n) => allText(n).includes('沙箱禁止命名管道'));
  hit.props.onClick({});
  check('点命中 → 打开对应条目文件', sidebar.opened[0]?.path === 'D:\\proj\\memory\\facts\\sandbox-no-pipe.md', JSON.stringify(sidebar.opened[0]));
  const journalHit = findAllByClass(mounted.tree(), 'dsh-memory-delta-item').find((n) => allText(n).includes('把面板接上检索'));
  journalHit.props.onClick({});
  check('流水命中也能点开（归属 journal.md）', sidebar.opened[1]?.path === 'D:\\proj\\memory\\journal.md', JSON.stringify(sidebar.opened[1]));

  // 零命中
  input.props.onChange({ target: { value: '没这个词' } });
  await wait(320);
  check('零命中时给出可操作的空态', allText(mounted.tree()).includes('没有匹配') && allText(mounted.tree()).includes('换个说法'), allText(mounted.tree()).slice(0, 260));

  // 回车立即搜（不等防抖）
  // ⚠️ 重新取一次节点：假 React 是**同步重渲染**，onChange 之后旧节点上的闭包里还是旧 query
  //    （真实浏览器里 React 会把新 props 挂到同一个 DOM 节点上，所以这不是产品 bug）。
  const before = searchCalls.length;
  findByClass(mounted.tree(), 'dsh-memory-delta-search-input').props.onChange({ target: { value: '回车立即搜' } });
  findByClass(mounted.tree(), 'dsh-memory-delta-search-input').props.onKeyDown({ key: 'Enter', preventDefault() {} });
  await flush();
  check('回车立即搜（不等防抖）', searchCalls.length === before + 1 && searchCalls.at(-1).query === '回车立即搜', JSON.stringify(searchCalls.slice(-2)));

  // 清空 → 回到分组视图
  const clearBtn = findAllByClass(mounted.tree(), 'dsh-memory-delta-mini').find((n) => allText(n).includes('清空'));
  check('有清空按钮', Boolean(clearBtn));
  clearBtn.props.onClick({});
  await flush();
  const back = allText(mounted.tree());
  check('清空后回到分组视图', !back.includes('搜索结果') && headerTexts(mounted.tree()).some((hd) => hd.includes('已在用')), back.slice(0, 200));
  check('清空后不再发搜索请求', searchCalls.length === before + 1, String(searchCalls.length));

  globalThis.fetch = originalFetch;
}

/* --------------------- 组件：全局规范（工作区外，DSH 自己注入的那份） */

section('组件：全局规范');
{
  const originalFetch = globalThis.fetch;
  const withGlobal = {
    ...SAMPLE,
    global: {
      file: 'C:\\Users\\someone\\AppData\\Roaming\\dsh-desktop\\harness\\AGENTS.md',
      displayPath: '~/.dsh/AGENTS.md',
      exists: true,
      bytes: 4173,
      lines: 120,
      mtime: '2026-09-20T05:00:00.000Z',
      preview: ['# 全局记忆', '', '- 中文交流，直接给结论'],
      truncated: true,
      source: { name: 'global-AGENTS.md', bytes: 4173, mtime: '2026-09-20T04:00:00.000Z' },
    },
  };
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(withGlobal) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();

  const headers = headerTexts(mounted.tree()).join(' | ');
  check('「已在用」里有「全局规范」一节', headers.includes('全局规范'), headers);
  check('说明它是"每个工作区都生效"（DSH 注入，不是本插件）', headers.includes('每个工作区都生效') && headers.includes('不是本插件'), headers);
  check('标题上给出文件大小与展示路径（不显示绝对路径）', headers.includes('~/.dsh/AGENTS.md') && headers.includes('4173 字节'), headers);
  check('不把绝对路径（带用户名）带到界面上', !allText(mounted.tree()).includes('someone'), allText(mounted.tree()).slice(0, 300));

  // 默认折叠：只给标题，不把整篇糊在脸上（也避免截图泄露里面的个人信息）
  const globalToggle = findAllByClass(mounted.tree(), 'dsh-memory-delta-toggle').find((n) => collectStrings(n.kids, []).join('').includes('全局规范'));
  check('全局规范默认折叠（箭头不是 is-open）', !findByClass(globalToggle, 'dsh-memory-delta-caret').props.className.includes('is-open'), String(globalToggle.props['aria-expanded']));
  check('折叠时不渲染预览内容', !allText(mounted.tree()).includes('中文交流，直接给结论'));

  globalToggle.props.onClick({});
  const expanded = allText(mounted.tree());
  check('展开后显示预览', expanded.includes('中文交流，直接给结论'), expanded.slice(0, 400));
  check('展开后说明只是前几行', expanded.includes('共 120 行'), expanded.slice(0, 500));
  check('展开后说明本库有源文件、改完要同步', expanded.includes('global-AGENTS.md') && expanded.includes('同步'), expanded.slice(0, 500));
  check('说明这份是 DSH 的管道注入、本插件只管当前工作区', expanded.includes('DSH 自带') || expanded.includes('DSH 自带的指令管道'), expanded.slice(0, 500));

  globalThis.fetch = originalFetch;
}

/* --------------------- 组件：没有全局文件时也要说清状态 */

section('组件：全局规范不存在');
{
  const originalFetch = globalThis.fetch;
  const noGlobal = { ...SAMPLE, global: { displayPath: '~/.dsh/AGENTS.md', exists: false, bytes: 0, lines: 0, mtime: null, preview: [] } };
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(noGlobal) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();
  const headers = headerTexts(mounted.tree()).join(' | ');
  check('文件不存在时给出提示而不是空白', headers.includes('全局规范') && headers.includes('还不存在'), headers);
  const toggle = findAllByClass(mounted.tree(), 'dsh-memory-delta-toggle').find((n) => collectStrings(n.kids, []).join('').includes('全局规范'));
  toggle.props.onClick({});
  check('展开后说清"建了它就会生效"', allText(mounted.tree()).includes('还没有这份文件'), allText(mounted.tree()).slice(0, 400));
  globalThis.fetch = originalFetch;
}

/* --------------------- 组件：撤回 / 删除候选（都要过行内确认条） */

section('组件：撤回与删除候选（危险动作二次确认）');
{
  const originalFetch = globalThis.fetch;
  const actionCalls = [];
  globalThis.fetch = (url, options) => {
    if (url === '/dsh-memory-delta/action') {
      const body = JSON.parse(options?.body ?? '{}');
      actionCalls.push(body);
      if (body.op === 'demote') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, op: 'demote', id: body.id, from: 'facts', target: 'inbox' }) });
      }
      if (body.op === 'remove') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, op: 'remove', id: body.id }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, op: body.op, id: body.id, target: 'facts', refs: [] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  };

  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();

  const standingItem = () =>
    findAllByClass(mounted.tree(), 'dsh-memory-delta-item').find((n) => allText(n).includes('路径含非 ASCII'));
  const demoteBtn = () => findAllByClass(standingItem(), 'dsh-memory-delta-mini').find((n) => allText(n).trim() === '撤回');

  check('常驻条目上有「撤回」按钮', Boolean(demoteBtn()));
  demoteBtn().props.onClick({ stopPropagation() {}, preventDefault() {} });
  check('点撤回后**没有**立刻发请求（先确认）', actionCalls.length === 0, JSON.stringify(actionCalls));
  const confirmBar = findByClass(mounted.tree(), 'dsh-memory-delta-confirm');
  check('出现行内确认条', Boolean(confirmBar), allText(mounted.tree()).slice(0, 200));
  check(
    '确认条说清后果（回到待你确认、不再发给模型）',
    allText(confirmBar).includes('要撤回这条？') && allText(confirmBar).includes('不再发给模型'),
    allText(confirmBar),
  );

  // 取消 → 什么都不发生
  findAllByClass(confirmBar, 'dsh-memory-delta-mini')
    .find((b) => allText(b).trim() === '取消')
    .props.onClick({ stopPropagation() {}, preventDefault() {} });
  check('点取消后确认条消失且不发请求', !findByClass(mounted.tree(), 'dsh-memory-delta-confirm') && actionCalls.length === 0, String(actionCalls.length));

  // 再点一次并确认 → 发 demote
  demoteBtn().props.onClick({ stopPropagation() {}, preventDefault() {} });
  findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-confirm'), 'dsh-memory-delta-mini')
    .find((b) => allText(b).includes('确认撤回'))
    .props.onClick({ stopPropagation() {}, preventDefault() {} });
  await flush();
  check('确认后发 op=demote + id', actionCalls[0]?.op === 'demote' && actionCalls[0]?.id === 'fact-a', JSON.stringify(actionCalls[0]));
  check(
    '撤回成功后提示"回到待你确认"',
    allText(mounted.tree()).includes('已撤回 fact-a') && allText(mounted.tree()).includes('待你确认'),
    allText(mounted.tree()).slice(0, 260),
  );

  // 候选条目：「删除」→ 同样要确认，且按钮是危险样式
  const inboxItem = findAllByClass(mounted.tree(), 'dsh-memory-delta-item').find((n) => allText(n).includes('沙箱禁止命名管道'));
  const removeBtn = findAllByClass(inboxItem, 'dsh-memory-delta-mini').find((n) => allText(n).trim() === '删除');
  check('候选条目上有「删除」按钮', Boolean(removeBtn));
  check('删除按钮是危险样式', String(removeBtn.props.className).includes('is-danger'), String(removeBtn.props.className));
  removeBtn.props.onClick({ stopPropagation() {}, preventDefault() {} });
  const bar3 = findByClass(mounted.tree(), 'dsh-memory-delta-confirm');
  check('删除也要先确认', Boolean(bar3) && allText(bar3).includes('要删除这条？'), allText(bar3));
  check('删除的确认文案说明不可恢复', allText(bar3).includes('不可恢复'), allText(bar3));
  findAllByClass(bar3, 'dsh-memory-delta-mini')
    .find((b) => allText(b).includes('确认删除'))
    .props.onClick({ stopPropagation() {}, preventDefault() {} });
  await flush();
  check('确认后发 op=remove + id', actionCalls.at(-1)?.op === 'remove' && actionCalls.at(-1)?.id === 'cand-1', JSON.stringify(actionCalls.at(-1)));
  check('删除成功后给出提示', allText(mounted.tree()).includes('已删除候选 cand-1'), allText(mounted.tree()).slice(0, 260));

  globalThis.fetch = originalFetch;
}

/* --------------------- 组件：撤回/删除失败要把原因显示出来 */

section('组件：撤回失败时回显宿主原因');
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    if (url === '/dsh-memory-delta/action') {
      return Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ ok: false, error: '只能删除 inbox/ 里的候选（这条在 facts/）' }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  };
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();
  const item = findAllByClass(mounted.tree(), 'dsh-memory-delta-item').find((n) => allText(n).includes('路径含非 ASCII'));
  findAllByClass(item, 'dsh-memory-delta-mini')
    .find((n) => allText(n).trim() === '撤回')
    .props.onClick({ stopPropagation() {}, preventDefault() {} });
  findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-confirm'), 'dsh-memory-delta-mini')
    .find((b) => allText(b).includes('确认撤回'))
    .props.onClick({ stopPropagation() {}, preventDefault() {} });
  await flush();
  const text = allText(mounted.tree());
  check('撤回失败时回显宿主原因', text.includes('撤回失败') && text.includes('只能删除 inbox/'), text.slice(0, 300));
  globalThis.fetch = originalFetch;
}

/* --------------------- 组件：工作区规范（可点编辑） */

section('组件：工作区规范');
{
  const originalFetch = globalThis.fetch;
  const sidebar = fakeSidebar();
  const withRules = {
    ...SAMPLE,
    workspaceRules: [
      { name: 'AGENTS.md', exists: true, file: 'D:\\proj\\AGENTS.md', bytes: 1200, mtime: '2026-09-20T05:00:00.000Z' },
      { name: 'AGENTS.local.md', exists: true, file: 'D:\\proj\\AGENTS.local.md', bytes: 800, mtime: '2026-09-20T05:00:00.000Z' },
    ],
  };
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(withRules) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: sidebar.service } });
  await flush();

  const headers = headerTexts(mounted.tree()).join(' | ');
  check('「已在用」里有「工作区规范」一节', headers.includes('工作区规范'), headers);
  check('说明它只在本工作区生效、每轮注入', headers.includes('只在本工作区生效') && headers.includes('每轮注入'), headers);
  const text = allText(mounted.tree());
  check('列出两个文件与大小', text.includes('AGENTS.md') && text.includes('AGENTS.local.md') && text.includes('1200 字节'), text.slice(0, 400));

  const editBtn = findAllByClass(mounted.tree(), 'dsh-memory-delta-mini').find((n) => allText(n).trim() === '编辑');
  check('有「编辑」按钮（工作区内的文件可直接进编辑器）', Boolean(editBtn));
  editBtn.props.onClick({});
  check('点编辑 → 走 openFile 打开该文件', sidebar.opened[0]?.path === 'D:\\proj\\AGENTS.md', JSON.stringify(sidebar.opened[0]));

  globalThis.fetch = originalFetch;

  // 没有规范文件时给出可操作的空态
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...SAMPLE, workspaceRules: [] }) });
  const empty = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();
  const emptyText = allText(empty.tree());
  check('没有工作区规范时说明"建了就生效"', emptyText.includes('还没有 AGENTS.md') && emptyText.includes('AGENTS.local.md'), emptyText.slice(0, 400));
  globalThis.fetch = originalFetch;
}

/* --------------------- 组件：归档条目要列出来并能「取回」 */

section('组件：已归档列出条目 + 取回');
{
  const originalFetch = globalThis.fetch;
  const sidebar = fakeSidebar();
  const calls = [];
  const withArchive = {
    ...SAMPLE,
    counts: { ...SAMPLE.counts, archive: 1 },
    archive: [
      { id: 'retired-fact', type: 'fact', key: 'retired-fact', status: 'expired', date: '2026-09-01', line: '这条不再适用了', file: 'D:\\proj\\memory\\archive\\retired-fact.md' },
    ],
  };
  globalThis.fetch = (url, options) => {
    if (url === '/dsh-memory-delta/action') {
      const body = JSON.parse(options?.body ?? '{}');
      calls.push(body);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, op: body.op, id: body.id, from: 'archive', target: 'inbox' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(withArchive) });
  };

  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: sidebar.service } });
  await flush();

  const text = allText(mounted.tree());
  check('已归档组里列出了归档条目本身（不只是条数）', text.includes('这条不再适用了') && text.includes('retired-fact.md'), text.slice(-500));

  const restoreBtn = findAllByClass(mounted.tree(), 'dsh-memory-delta-mini').find((n) => allText(n).trim() === '取回');
  check('归档条目上有「取回」按钮', Boolean(restoreBtn));
  restoreBtn.props.onClick({ stopPropagation() {}, preventDefault() {} });
  check('取回也要先确认（点一次不发请求）', calls.length === 0, JSON.stringify(calls));
  const bar = findByClass(mounted.tree(), 'dsh-memory-delta-confirm');
  check('确认条说清"回到待你确认、再提升才生效"', allText(bar).includes('要取回这条？') && allText(bar).includes('提升'), allText(bar));
  findAllByClass(bar, 'dsh-memory-delta-mini')
    .find((b) => allText(b).includes('确认取回'))
    .props.onClick({ stopPropagation() {}, preventDefault() {} });
  await flush();
  check('确认后发 op=restore', calls[0]?.op === 'restore' && calls[0]?.id === 'retired-fact', JSON.stringify(calls[0]));
  check('取回成功后给出提示', allText(mounted.tree()).includes('已取回 retired-fact'), allText(mounted.tree()).slice(0, 300));

  globalThis.fetch = originalFetch;
}

/* --------------------- 组件：常驻条目也能手动归档 */

section('组件：常驻条目的「归档」按钮');
{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, options) => {
    if (url === '/dsh-memory-delta/action') {
      const body = JSON.parse(options?.body ?? '{}');
      calls.push(body);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, op: body.op, id: body.id, status: 'expired', from: 'facts' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  };
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();

  const item = findAllByClass(mounted.tree(), 'dsh-memory-delta-item').find((n) => allText(n).includes('路径含非 ASCII'));
  const archiveBtn = findAllByClass(item, 'dsh-memory-delta-mini').find((n) => allText(n).trim() === '归档');
  check('常驻条目上有「归档」按钮', Boolean(archiveBtn));
  archiveBtn.props.onClick({ stopPropagation() {}, preventDefault() {} });
  check('归档也要先确认', calls.length === 0 && Boolean(findByClass(mounted.tree(), 'dsh-memory-delta-confirm')), JSON.stringify(calls));
  const bar = findByClass(mounted.tree(), 'dsh-memory-delta-confirm');
  check('确认文案区分"归档"与"取代"', allText(bar).includes('要归档这条？') && allText(bar).includes('supersede'), allText(bar));
  findAllByClass(bar, 'dsh-memory-delta-mini')
    .find((b) => allText(b).includes('确认归档'))
    .props.onClick({ stopPropagation() {}, preventDefault() {} });
  await flush();
  check('确认后发 op=archive', calls[0]?.op === 'archive' && calls[0]?.id === 'fact-a', JSON.stringify(calls[0]));
  check('归档成功后提示"搜得到、也能取回"', allText(mounted.tree()).includes('已归档 fact-a') && allText(mounted.tree()).includes('取回'), allText(mounted.tree()).slice(0, 300));

  globalThis.fetch = originalFetch;
}

/* --------------------------- 组件：按日期分组（第三个维度） */

section('组件：类型 / 标签 / 日期 三个维度可切换');
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();

  const seg = findAllByClass(mounted.tree(), 'dsh-memory-delta-seg')[0];
  const segBtn = (label) => seg.kids.find((n) => allText(n).trim() === label);
  check('头部有四个维度按钮', ['主题', '类型', '标签', '日期'].every((t) => allText(seg).includes(t)), allText(seg));
  check('默认是「主题」选中', String(segBtn('主题').props.className).includes('is-on'), String(segBtn('主题').props.className));

  segBtn('日期').props.onClick({});
  const headers = headerTexts(mounted.tree()).join(' | ');
  // SAMPLE 的 today = 2026-09-17；条目日期是 09-17 / 09-16 / 09-01
  check('切到日期视图：分组头变成日期', headers.includes('2026-09-17') && headers.includes('2026-09-16') && headers.includes('2026-09-01'), headers);
  check('今天的组带人话标注', headers.includes('2026-09-17（今天）'), headers);
  check('新的日期排前面（09-17 在 09-01 之前）', headers.indexOf('2026-09-17') < headers.indexOf('2026-09-01'), headers);
  check('日期视图里不再按类型分组', !headers.includes('（facts）') && !headers.includes('（decisions）'), headers);
  const text = allText(mounted.tree());
  check('日期视图里条目自己标出是事实还是决策', text.includes('事实') && text.includes('决策'), text.slice(0, 500));

  // 切回去不影响其它维度
  segBtn('类型').props.onClick({});
  check('能切回类型视图', headerTexts(mounted.tree()).join(' | ').includes('（facts）'), headerTexts(mounted.tree()).join(' | '));

  globalThis.fetch = originalFetch;
}

/* ------------------- 组件：主题归纳（默认维度）+ 行内「归类」+ 三阶段共用维度 */

section('组件：按主题归纳与「归类」按钮');
{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    // 动作路由的真实回执形状：`{ ok, op, id, topic }`（topic 为 null = 已清除）
    const payload =
      url === '/dsh-memory-delta/action'
        ? { ok: true, op: body?.op, id: body?.id, topic: body?.topic ? body.topic : null }
        : SAMPLE;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  };
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();

  // 默认主题视图：命名组在前、未归类在后；条目行上**不再重复**标主题（分组头已经说了）
  const headers = headerTexts(mounted.tree()).join(' | ');
  check('默认按主题分组：命名组与「未归类」都在（且同层内命名组在前）', Boolean(sectionByKey(mounted, 'standing:topic:环境与沙箱')) && Boolean(sectionByKey(mounted, 'standing:topic:__untopic__')) && orderedSectionKeys(mounted.tree()).indexOf('standing:topic:环境与沙箱') < orderedSectionKeys(mounted.tree()).indexOf('standing:topic:__untopic__'), orderedSectionKeys(mounted.tree()).join(' > '));
  check('未归类组给一句"怎么做"', headers.includes('归类'), headers);
  check('主题视图里条目行不重复标主题', findAllByClass(mounted.tree(), 'is-topic').length === 0, String(findAllByClass(mounted.tree(), 'is-topic').length));

  // 换成类型视图：条目行要自己标出主题（那时分组头是事实/决策，主题得看行）
  selectDimension(mounted, '类型');
  const chips = findAllByClass(mounted.tree(), 'is-topic');
  check('类型视图里条目行标出主题', chips.length >= 1 && allText(chips[0]).includes('环境与沙箱'), chips.map((c) => allText(c)).join('|'));

  // 「归类」：行内输入（已有主题做候选）→ 保存 → 发 op=topic
  // ⚠️ 按**条目内容**定位那一行：面板上每个条目都有「归类」，抓到第一个会点错行
  const targetRow = findAllByClass(mounted.tree(), 'dsh-memory-delta-item').find((n) => allText(n).includes('记忆的事实层只能由人确认后写入'));
  check('找到目标条目行（dec-b）', Boolean(targetRow), allText(targetRow ?? {}).slice(0, 120));
  const topicBtn = findAllByClass(targetRow, 'dsh-memory-delta-mini').find((n) => allText(n).trim() === '归类');
  check('条目上有「归类」按钮', Boolean(topicBtn), findAllByClass(targetRow, 'dsh-memory-delta-mini').map((n) => allText(n)).join('|'));
  topicBtn.props.onClick({ stopPropagation() {} });
  const row = findByClass(mounted.tree(), 'dsh-memory-delta-topic');
  const input = row && row.kids.find((k) => k.type === 'input');
  check('点「归类」展开行内输入', Boolean(input), row ? collectStrings(row.kids, []).join('|') : 'no-row');
  check('输入框带已有主题候选（datalist）', input?.props?.list === 'dsh-memory-delta-topic-options', String(input?.props?.list));
  {
    const options = findByProp(mounted.tree(), 'id', 'dsh-memory-delta-topic-options');
    // 假 React 是 `h(type, props, ...kids)`，所以传进去的数组会变成 kids[0] —— 摊平一层再取
    const values = options ? options.kids.flat().filter(Boolean).map((o) => o.props?.value) : [];
    check('候选里有库里已有的主题', values.includes('环境与沙箱'), JSON.stringify(values));
  }

  input.props.onChange({ target: { value: 'DSH 插件开发' } });
  const save = findAllByClass(mounted.tree(), 'dsh-memory-delta-mini').find((n) => allText(n).trim() === '保存');
  check('输入行有「保存」', Boolean(save));
  save.props.onClick({ stopPropagation() {} });
  await flush();
  const topicCall = calls.find((c) => c.body && c.body.op === 'topic');
  check('归类发的是 op=topic（复用动作路由）', Boolean(topicCall) && topicCall.body.id === 'dec-b' && topicCall.body.topic === 'DSH 插件开发', JSON.stringify(topicCall));
  check('归类成功后给一句回执', allText(mounted.tree()).includes('已归类'), allText(mounted.tree()).slice(0, 200));

  globalThis.fetch = originalFetch;
}

section('组件：维度作用于三个阶段（待你确认 / 已在用 / 已归档）');
{
  const originalFetch = globalThis.fetch;
  // 三个阶段各有两个主题 —— 主题分组头应当**在每个阶段内部**出现
  const THREE = {
    ...SAMPLE,
    inbox: [
      { id: 'i1', type: 'fact', topic: 'DSH 插件开发', tags: ['dsh'], line: '候选一', date: '2026-09-17', file: 'D:\\proj\\memory\\inbox\\i1.md' },
      { id: 'i2', type: 'decision', topic: 'DSH 技能', tags: [], line: '候选二', date: '2026-09-17', file: 'D:\\proj\\memory\\inbox\\i2.md' },
    ],
    archive: [
      { id: 'a1', type: 'fact', topic: 'DSH 插件开发', status: 'expired', tags: ['dsh'], line: '老的坑一', date: '2026-09-10', file: 'D:\\proj\\memory\\archive\\a1.md' },
      { id: 'a2', type: 'decision', status: 'superseded', tags: [], line: '老的坑二', date: '2026-09-09', file: 'D:\\proj\\memory\\archive\\a2.md' },
    ],
    counts: { ...SAMPLE.counts, inbox: 2, archive: 2 },
  };
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(THREE) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();

  check('已在用里按主题分了组', Boolean(findByProp(mounted.tree(), 'key', 'standing:topic:环境与沙箱')), headerTexts(mounted.tree()).join(' | '));
  check('待你确认里也按主题分了组（不再平铺）', Boolean(findByProp(mounted.tree(), 'key', 'inbox:topic:DSH 插件开发')) && Boolean(findByProp(mounted.tree(), 'key', 'inbox:topic:DSH 技能')), headerTexts(mounted.tree()).join(' | '));
  check('已归档里也按主题分了组（不再平铺）', Boolean(findByProp(mounted.tree(), 'key', 'archive:topic:DSH 插件开发')) && Boolean(findByProp(mounted.tree(), 'key', 'archive:topic:__untopic__')), headerTexts(mounted.tree()).join(' | '));

  // 换维度：三个阶段一起跟着变
  selectDimension(mounted, '类型');
  check('切到类型：三个阶段都改按类型分组', Boolean(findByProp(mounted.tree(), 'key', 'inbox:type:facts')) && Boolean(findByProp(mounted.tree(), 'key', 'archive:type:facts')), headerTexts(mounted.tree()).join(' | '));

  globalThis.fetch = originalFetch;
}

section('组件：每个阶段都照当前维度分组（不做"单组就不出头"的特殊处理）');
{
  const originalFetch = globalThis.fetch;
  // 只有一条候选、且没主题。**曾经**这种情况不加分组头，结果真实数据上表现为
  // "待你确认只有类型看得出分组"（用户反馈）—— 现在一致性优先：单组也照样出那个头，
  // 顺带说明"这一组是什么"。
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();
  check('单条候选的收件箱也照维度出分组头（「未归类」）', Boolean(sectionByKey(mounted, 'inbox:topic:__untopic__')), headerTexts(mounted.tree()).join(' | '));
  check('候选本身照常列出来', allText(mounted.tree()).includes('沙箱禁止命名管道'), allText(mounted.tree()).slice(0, 300));
  // 换维度也一样：日期视图下同一天也算一组
  selectDimension(mounted, '日期');
  check('换到日期视图，收件箱同样跟着走', Boolean(sectionByKey(mounted, 'inbox:date:2026-09-17')), orderedSectionKeys(mounted.tree()).join(' > '));
  globalThis.fetch = originalFetch;
}

/* --------------------- 组件：勾选 + 批量操作 + 主题改名 + 按主题搜 */

section('组件：勾选与批量操作');
{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    const payload =
      url === '/dsh-memory-delta/action'
        ? { ok: true, op: body?.op, action: body?.action, total: (body?.ids || []).length, succeeded: body?.ids || [], failed: [] }
        : SAMPLE;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  };
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();

  // 每条都有勾选框（⚠️ `findAllByClass` 是子串匹配，`...-item-head` 也会被算进来 → 用整词筛）
  const boxes = findAllByClass(mounted.tree(), 'dsh-memory-delta-check');
  const items = findAllByClass(mounted.tree(), 'dsh-memory-delta-item').filter((n) => n.props.className.split(/\s+/).includes('dsh-memory-delta-item'));
  check('每条条目都有勾选框', boxes.length === items.length && boxes.length >= 3, `${boxes.length} 勾选框 / ${items.length} 条目`);
  check('没勾选时不显示批量条', findByClass(mounted.tree(), 'dsh-memory-delta-batch') === null, 'batch bar');

  // 勾一条 → 出现批量条
  const firstBox = boxes[0];
  firstBox.props.onChange({});
  const bar = findByClass(mounted.tree(), 'dsh-memory-delta-batch');
  check('勾选后出现批量工具条', Boolean(bar), 'batch bar');
  check('批量条报出已选条数', allText(bar).includes('已选 1 条'), allText(bar));
  check('勾选框不会连带着打开文件（自己停冒泡）', typeof firstBox.props.onClick === 'function', 'onClick 存在');

  // 清空 → 批量条消失
  findAllByClass(bar, 'dsh-memory-delta-mini').find((n) => allText(n).includes('清空勾选')).props.onClick({ stopPropagation() {} });
  check('清空勾选后批量条消失', findByClass(mounted.tree(), 'dsh-memory-delta-batch') === null, 'batch bar');

  // 「选本组 N 条」= 一次选整组（这就是"按主题/类型/标签/日期批量操作"的入口）
  const groupSelect = findAllByClass(sectionByKey(mounted, 'standing:topic:环境与沙箱'), 'dsh-memory-delta-mini').find((n) => allText(n).includes('选本组'));
  check('主题分组头上有「选本组」', Boolean(groupSelect), '选本组');
  groupSelect.props.onClick({ stopPropagation() {} });
  check('选本组后条数变成本组条数（2 条）', allText(findByClass(mounted.tree(), 'dsh-memory-delta-batch')).includes('已选 2 条'), allText(findByClass(mounted.tree(), 'dsh-memory-delta-batch')));

  // 批量归类：输入 → 保存 → op=batch action=topic
  findByClass(mounted.tree(), 'dsh-memory-delta-batch');
  const topicBtn = findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-batch'), 'dsh-memory-delta-mini').find((n) => allText(n).includes('归类'));
  topicBtn.props.onClick({ stopPropagation() {} });
  const topicInput = findByClass(mounted.tree(), 'dsh-memory-delta-topic').kids.find((k) => k.type === 'input');
  topicInput.props.onChange({ target: { value: 'DSH 技能' } });
  const saveTopic = findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-topic'), 'dsh-memory-delta-mini').find((n) => allText(n).includes('保存归类'));
  saveTopic.props.onClick({ stopPropagation() {} });
  await flush();
  const batchCall = calls.find((c) => c.body && c.body.op === 'batch');
  check('批量归类发的是 op=batch + action=topic', batchCall?.body.action === 'topic' && batchCall.body.topic === 'DSH 技能' && batchCall.body.ids.length === 2, JSON.stringify(batchCall));
  check('批量成功后给回执并清空勾选', allText(mounted.tree()).includes('批量归类：2 条完成') && findByClass(mounted.tree(), 'dsh-memory-delta-batch') === null, allText(mounted.tree()).slice(0, 160));

  // 危险动作（撤回/归档/删除）走行内确认条，不是直接执行
  const standingBoxes = findAllByClass(sectionByKey(mounted, 'standing:topic:环境与沙箱'), 'dsh-memory-delta-check');
  standingBoxes[0].props.onChange({});
  const demoteBtn = findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-batch'), 'dsh-memory-delta-mini').find((n) => allText(n).trim() === '撤回');
  demoteBtn.props.onClick({ stopPropagation() {} });
  check('批量撤回先要确认（不会直接动手）', !calls.some((c) => c.body && c.body.action === 'demote') && allText(findByClass(mounted.tree(), 'dsh-memory-delta-batch')).includes('要批量撤回这 1 条'), allText(findByClass(mounted.tree(), 'dsh-memory-delta-batch')));
  const goBtn = findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-batch'), 'dsh-memory-delta-mini').find((n) => allText(n).includes('确认撤回'));
  goBtn.props.onClick({ stopPropagation() {} });
  await flush();
  check('确认后才真的批量撤回', calls.some((c) => c.body && c.body.op === 'batch' && c.body.action === 'demote'), JSON.stringify(calls.filter((c) => c.body && c.body.op === 'batch').slice(-1)));

  globalThis.fetch = originalFetch;
}

section('组件：批量部分失败要如实说出来');
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    const payload =
      url === '/dsh-memory-delta/action'
        ? { ok: true, op: 'batch', action: body?.action, total: 2, succeeded: [body?.ids?.[0]], failed: [{ id: body?.ids?.[1], error: '同一个 key（x）上已经有 active 条目：y' }] }
        : SAMPLE;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  };
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();
  findAllByClass(sectionByKey(mounted, 'inbox:topic:__untopic__'), 'dsh-memory-delta-check')[0].props.onChange({});
  const promoteBtn = findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-batch'), 'dsh-memory-delta-mini').find((n) => allText(n).trim() === '提升');
  promoteBtn.props.onClick({ stopPropagation() {} });
  await flush();
  const text = allText(mounted.tree());
  check('部分失败时同时报成功与失败条数', /成功 1 条、失败 1 条/.test(text), text.slice(0, 240));
  check('失败原因原样显示（不是"点了没反应"）', text.includes('同一个 key'), text.slice(0, 240));
  globalThis.fetch = originalFetch;
}

section('组件：主题改名与按主题搜');
{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    const payload =
      url === '/dsh-memory-delta/action'
        ? { ok: true, op: body?.op, from: body?.from, to: body?.to, changed: 2 }
        : url === '/dsh-memory-delta/search'
          ? { ok: true, query: body?.query, where: 'all', topic: body?.topic ?? null, total: 1, truncated: false, matches: [{ id: 'x', where: 'facts', line: '打桩的命中', snippet: '打桩的命中', score: 1 }] }
          : SAMPLE;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  };
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();

  // 改主题名：分组头 → 输入 → 改名（走 op=topic-rename，全库同名主题一起改）
  const renameBtn = findAllByClass(sectionByKey(mounted, 'standing:topic:环境与沙箱'), 'dsh-memory-delta-mini').find((n) => allText(n).includes('改主题名'));
  check('主题分组头上有「改主题名」', Boolean(renameBtn), '改主题名');
  renameBtn.props.onClick({ stopPropagation() {} });
  const input = findByClass(mounted.tree(), 'dsh-memory-delta-topic').kids.find((k) => k.type === 'input');
  check('改名输入框预填当前主题名', input?.props?.value === '环境与沙箱', String(input?.props?.value));
  input.props.onChange({ target: { value: '沙箱与环境' } });
  const goRename = findAllByClass(findByClass(mounted.tree(), 'dsh-memory-delta-topic'), 'dsh-memory-delta-mini').find((n) => allText(n).includes('改名'));
  goRename.props.onClick({ stopPropagation() {} });
  await flush();
  const renameCall = calls.find((c) => c.body && c.body.op === 'topic-rename');
  check('改名发的是 op=topic-rename（from/to）', renameCall?.body.from === '环境与沙箱' && renameCall.body.to === '沙箱与环境', JSON.stringify(renameCall));
  check('改名后给回执（说明改了几条）', /主题「环境与沙箱」→「沙箱与环境」（改了 2 条/.test(allText(mounted.tree())), allText(mounted.tree()).slice(0, 200));

  // 搜这组：搜索请求要带上主题筛选
  const searchBtn = findAllByClass(sectionByKey(mounted, 'standing:topic:环境与沙箱'), 'dsh-memory-delta-mini').find((n) => allText(n).includes('搜这组'));
  check('主题分组头上有「搜这组」', Boolean(searchBtn), '搜这组');
  findByClass(mounted.tree(), 'dsh-memory-delta-search-input').props.onChange({ target: { value: '沙箱' } });
  await wait(320);
  searchBtn.props.onClick({ stopPropagation() {} });
  await wait(320);
  const scoped = calls.filter((c) => c.url === '/dsh-memory-delta/search' && c.body.topic);
  check('「搜这组」把主题带进了搜索请求', scoped.length >= 1 && scoped.at(-1).body.topic === '环境与沙箱', JSON.stringify(calls.filter((c) => c.url === '/dsh-memory-delta/search').slice(-2)));
  const text = allText(mounted.tree());
  check('搜索视图里显示出主题筛选条', text.includes('主题：环境与沙箱'), text.slice(0, 240));
  const clearTopic = findAllByClass(mounted.tree(), 'dsh-memory-delta-mini').find((n) => allText(n).includes('取消主题筛选'));
  check('主题筛选可以取消', Boolean(clearTopic), '取消主题筛选');
  clearTopic.props.onClick({ stopPropagation() {} });
  await wait(320);
  check('取消后搜索请求不再带主题', calls.filter((c) => c.url === '/dsh-memory-delta/search').at(-1).body.topic === undefined, JSON.stringify(calls.filter((c) => c.url === '/dsh-memory-delta/search').at(-1)));

  globalThis.fetch = originalFetch;
}

/* --------------------- 组件：搜索失败要回显宿主的原因 */

section('组件：搜索失败');
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) =>
    url === '/dsh-memory-delta/search'
      ? Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ ok: false, error: '不认识的 where：nope（只支持 all / facts …）' }) })
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' }, hostCtx: { betterSidebar: fakeSidebar().service } });
  await flush();
  findByClass(mounted.tree(), 'dsh-memory-delta-search-input').props.onChange({ target: { value: 'x' } });
  await wait(320);
  const text = allText(mounted.tree());
  check('搜索失败时回显宿主原因', text.includes('搜索失败') && text.includes('不认识的 where'), text.slice(0, 260));
  globalThis.fetch = originalFetch;
}

/* --------------------------- 组件：按标签分组（自动归纳的廉价那半） */

section('组件：类型 ↔ 标签 分组切换');
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();

  const seg = findAllByClass(mounted.tree(), 'dsh-memory-delta-seg')[0];
  const tagBtn = seg.kids.find((n) => allText(n).includes('标签'));
  check('头部有「类型 / 标签」切换', allText(seg).includes('类型') && allText(seg).includes('标签'), allText(seg));
  tagBtn.props.onClick({});
  const headers = headerTexts(mounted.tree()).join(' | ');
  check('切到标签视图：分组头变成标签名', headers.includes('node') && headers.includes('未加标签'), headers);
  check('标签视图里没有再按类型分组', !headers.includes('（facts）'), headers);
  const text = allText(mounted.tree());
  check('标签视图里条目自己标出是事实还是决策', text.includes('事实') && text.includes('决策'), text.slice(0, 400));

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
  // 告警要说人话：超了什么 / 为什么有上限 / 怎么办（用户要求"别让使用者一脸懵"）
  check('告警说清"超了什么"（几条、合计多少、超多少）', /3 条常驻合计 4096 字节.*超 1024/.test(text), text.slice(0, 400));
  check('告警说清"为什么有上限"（每轮都发给模型、换算成 token）', text.includes('每一轮会话都会发给模型') && text.includes('tokens/轮'), text.slice(0, 600));
  check('告警说清"不会丢东西"', text.includes('不会丢东西') && text.includes('不会截断'), text.slice(0, 600));
  check(
    '告警给出可执行的三条办法（归档/撤回、首行写短、调大 maxBytes）',
    text.includes('归档') && text.includes('结论首行') && text.includes('maxBytes'),
    text.slice(0, 800),
  );
  check(
    '没有到期项时说清楚"什么时候才会出现"',
    text.includes('没有到复核期的记忆') && text.includes('verify_when 到期后才会出现'),
    text.slice(0, 400),
  );
  globalThis.fetch = originalFetch;
}

/* ------------------------- 组件：归档层要露个面（不然像凭空消失） */

section('组件：状态行标出归档条数');
{
  const originalFetch = globalThis.fetch;
  const withArchive = { ...SAMPLE, counts: { ...SAMPLE.counts, archive: 4 } };
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(withArchive) });
  const mounted = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();
  const text = allText(mounted.tree());
  check('流程条标出「已归档 N」', text.includes('已归档 4'), text.slice(0, 240));
  check('归档组说明说清"不再发给模型、可搜索、能取回"', /不再发给模型/.test(text) && /取回/.test(text), text.slice(0, 600));
  globalThis.fetch = originalFetch;

  // 没有归档时也要看到这一层存在（否则被取代的东西像凭空消失），但说清它是空的
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SAMPLE) });
  const clean = mountPanel({ scope: { sessionId: 's1', cwd: 'D:\\proj' } });
  await flush();
  const cleanText = allText(clean.tree());
  check('没有归档时仍然显示「已归档」这一层', cleanText.includes('已归档') && cleanText.includes('（archive）'), cleanText.slice(0, 300));
  check('没有归档时说清什么时候才会有', cleanText.includes('还没有归档') && cleanText.includes('不再发给模型'), cleanText.slice(0, 400));
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
    text.includes('没有待确认的候选') && text.includes('memory_write') && text.includes('空着是正常的'),
    text.slice(0, 400),
  );
  check(
    '空收件箱时依然说清"确认后才生效"',
    text.includes('你点头才生效') && text.includes('提升到 facts/ decisions/'),
    text.slice(0, 600),
  );
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
  check('反推之后仍然渲染成功', allText(mounted.tree()).includes('已在用 3'), allText(mounted.tree()).slice(0, 200));
  globalThis.fetch = originalFetch;
}

/* --------------------------------------------------------------- 汇总 */

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
