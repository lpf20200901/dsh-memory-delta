/* eslint-disable */
/**
 * dsh-memory-delta 的**客户端半边**：在 DSH 的 better-sidebar 里注册一个「记忆」页签。
 *
 * ⚠️ 这个文件是**手写的、零构建的** client bundle，不是普通 ES 模块：
 *   · 它被浏览器当 **classic script** 直接执行，所以**不能有 `import` / `export`**；
 *   · 顶部必须调用 `window.__ModuleLoader__.load({ id, factory })` 向宿主注册自己
 *     （格式照抄 `dsh-better-sidebar/lib/client.js` 的头尾）；
 *   · factory 收到的 `require` 走宿主的**冻结共享模块表**（React、Cordis、静态 UI 库）。
 *     本文件只用 `react` 与 `react-dom`，它们都在基座里，所以 `package.json` 的
 *     `dsh.client.external` 不需要声明任何东西（基座之外才要列）。
 *   · 模块副作用只有在宿主**物化**这个 factory 时才跑 —— 也就是说，没被用到的时候
 *     这里一行都不会执行。
 *
 * 页签本身刻意做得**很朴素**：状态行 + 待复核 + 常驻条目 + 收件箱 + 刷新按钮。
 * 不做仪表盘 / 健康度看板 / 图表 / 轮询 —— 这个面板是"让用户对记忆库有底"的，
 * 不是监控台。数据只在挂载时和点「刷新」时各拉一次。
 *
 * 数据从哪来：宿主路由 `POST /dsh-memory-delta/state`（见 `src/panel.mjs`）。
 * workspace 的取法见 `requestState()` 的注释。
 */

window.__ModuleLoader__.load({
  // ⚠️ id 必须是**包名**：宿主用"解析出的包名"作为浏览器模块身份，
  // 写成别的（比如改名前那个 dsh-memory）会直接对不上，页签静默不出现。
  id: 'dsh-memory-delta',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;
    // createRoot 备而不用：宿主给的是"把元素交给它渲染"的约定，我们只交出元素树。
    // 留这一行是为了说明**渲染权在宿主**，页签组件不该自己去 appendChild。
    require('react-dom');

    const STATE_URL = '/dsh-memory-delta/state';
    // 动作路由：让宿主用系统文件管理器打开记忆库里的某个目录（白名单 + 回环校验在宿主侧）。
    const REVEAL_URL = '/dsh-memory-delta/reveal';
    // 写记忆库的动作（收件箱提升 / 安全改名）—— 宿主侧复用 CLI 的 promoteEntry / renameEntry。
    const ACTION_URL = '/dsh-memory-delta/action';
    const PLUGIN_ID = 'dsh-memory-delta';
    const STYLE_ID = 'dsh-memory-delta/memory-tab.css';

    /* ------------------------------------------------------------ 样式 */

    const CSS = `
.dsh-memory-delta-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 16px;
  gap: 10px;
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-family: var(--dsw-font-family, system-ui, sans-serif);
  font-size: 12px;
  line-height: 1.5;
  box-sizing: border-box;
}
.dsh-memory-delta-head {
  display: flex;
  align-items: center;
  gap: 8px;
  position: sticky;
  top: 0;
  padding: 4px 0 6px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  z-index: 1;
}
.dsh-memory-delta-title { font-weight: 600; }
.dsh-memory-delta-btn {
  margin-left: auto;
  cursor: pointer;
  padding: 2px 10px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  background: transparent;
  color: inherit;
  font: inherit;
}
.dsh-memory-delta-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.dsh-memory-delta-btn:disabled { opacity: .5; cursor: default; }
.dsh-memory-delta-row { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.dsh-memory-delta-muted { color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dsh-memory-delta-dim { color: var(--dsw-alias-label-tertiary, #8c8c8c); }
.dsh-memory-delta-warn { color: var(--dsw-alias-state-warn-label, #b26a00); font-weight: 600; }
.dsh-memory-delta-error {
  color: var(--dsw-alias-state-error-primary, #c62828);
  border: 1px solid var(--dsw-alias-state-error-secondary, rgba(198,40,40,.35));
  border-radius: 6px;
  padding: 6px 8px;
}
.dsh-memory-delta-path { word-break: break-all; }
/* 文件夹名（facts / decisions / inbox）—— 用等宽字体，和中文标题区分开，方便对照磁盘上的目录 */
.dsh-memory-delta-slug {
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: .92em;
  font-weight: 400;
}

/* ---------------------------------------------------------------- 层级
   分节 = 一行「分组头」（可点，带箭头）+ 缩进的条目体。
   之前用原生 <details> 又隐藏了 ::-webkit-details-marker，结果**没有任何可展开的标志**
   —— 用户根本不知道能点。现在自绘箭头（CSS 三角），展开时旋转 90°。 */
.dsh-memory-delta-section { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18)); padding-top: 6px; }
.dsh-memory-delta-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dsh-memory-delta-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 4px;
  margin: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.dsh-memory-delta-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.dsh-memory-delta-toggle:focus-visible { outline: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.5)); outline-offset: 1px; }
.dsh-memory-delta-caret {
  flex: none;
  width: 0;
  height: 0;
  border-left: 5px solid currentColor;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  opacity: .65;
  transform-origin: 2px 4px;
  transition: transform .12s ease;
}
.dsh-memory-delta-caret.is-open { transform: rotate(90deg); }
.dsh-memory-delta-section-title { flex: none; }
.dsh-memory-delta-section-hint { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-memory-delta-count {
  flex: none;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16));
  font-weight: 400;
  font-size: 11px;
  text-align: center;
}
.dsh-memory-delta-body {
  margin: 2px 0 4px 15px;
  padding-left: 8px;
  border-left: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 小按钮：打开目录 / 打开文件 */
.dsh-memory-delta-mini {
  flex: none;
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-memory-delta-mini:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); color: inherit; }
.dsh-memory-delta-seg { display: flex; gap: 4px; margin-left: auto; align-items: center; }
.dsh-memory-delta-seg + .dsh-memory-delta-btn { margin-left: 6px; }
.dsh-memory-delta-seg > button {
  padding: 1px 8px;
  border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.dsh-memory-delta-seg > button.is-on {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18));
  color: inherit;
  font-weight: 600;
}

/* 条目：整行可点 = 打开这个 .md；缩进 + 右侧竖线已经把它和分组头分层 */
.dsh-memory-delta-item {
  margin: 0;
  padding: 3px 5px;
  border-radius: 5px;
  cursor: pointer;
}
.dsh-memory-delta-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-memory-delta-item:focus-visible { outline: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.5)); outline-offset: -1px; }
.dsh-memory-delta-item-head { display: flex; align-items: center; gap: 6px; }
.dsh-memory-delta-badge {
  flex: none;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 15px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dsh-memory-delta-badge.is-decision { border-style: dashed; }
.dsh-memory-delta-key {
  flex: none;
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55%;
}
.dsh-memory-delta-meta { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
.dsh-memory-delta-tag {
  padding: 0 4px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 15px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dsh-memory-delta-file {
  margin-top: 1px;
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #8c8c8c);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;      /* 文件名太长时从**左边**截断，保留结尾的标识部分 */
  text-align: left;
}
.dsh-memory-delta-due {
  border: 1px solid var(--dsw-alias-state-warn-primary, rgba(178,106,0,.4));
  border-radius: 6px;
  padding: 6px 8px;
}
.dsh-memory-delta-due-line { display: flex; gap: 6px; align-items: baseline; margin-top: 4px; }
.dsh-memory-delta-due-line:first-of-type { margin-top: 0; }
.dsh-memory-delta-flag { white-space: nowrap; font-weight: 600; }
.dsh-memory-delta-line { word-break: break-word; }
.dsh-memory-delta-verify { margin-left: 10px; }
.dsh-memory-delta-empty { padding: 2px 0; }
.dsh-memory-delta-note {
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
  border-radius: 6px;
  padding: 4px 8px;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dsh-memory-delta-ok { border-color: var(--dsw-alias-state-success-secondary, rgba(46,125,50,.35)); }
/* 「整理文件名」的内联输入行（改 id 是危险动作，所以不做猜名字的自动操作，让用户自己填） */
.dsh-memory-delta-rename { display: flex; gap: 4px; margin-top: 3px; }
.dsh-memory-delta-rename > input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: inherit;
  font: inherit;
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11px;
}
`;

    /** 样式只注入一次（宿主也可能加载多个 dsh-memory-delta 实例，靠 STYLE_ID 去重）。 */
    let styleInjected = false;
    function ensureStyles() {
      styleInjected = true;
      try {
        if (typeof document === 'undefined') return;
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = STYLE_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (error) {
        // 样式注入失败不该让页签打不开（宿主侧结构可能变了）
        console.error('[dsh-memory-delta] 注入样式失败', error);
      }
    }

    /* ------------------------------------------------------------ 取数 */

    /**
     * workspace 从哪来 —— 依据 `dsh-better-sidebar` 的 `TabComponentProps`：
     * `props.scope` 是 `SessionScope = { sessionId, cwd?, repoRoot? }`
     * （`lib/types/client/api.d.ts` 的 `interface SessionScope`），
     * 其中 `cwd` 就是该会话的工作目录，正是我们需要的 workspace。
     *
     * `cwd` 是可选的（客户端列表摘要里未必带），所以兜底顺序是：
     *   1. `scope.cwd`（首选）；
     *   2. 上一次成功响应里的 `state.workspace`（宿主已经从 root/scope 反推过）；
     *   3. 都不带 —— 仍然发一次不带 workspace 的请求：宿主会退回插件配置的 root，
     *      并在响应里回 `workspace`/`root`，我们据此把后续请求修正过来。
     */
    function requestState(workspace, signal) {
      const body = workspace ? { workspace } : {};
      return fetch(STATE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }).then(async (res) => {
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (!res.ok) {
          const reason = data && data.error ? data.error : `HTTP ${res.status}`;
          throw new Error(reason);
        }
        if (!data || typeof data !== 'object') throw new Error('宿主返回的不是 JSON 对象');
        if (data.ok === false) throw new Error(data.error || '宿主报告读取失败');
        return data;
      });
    }

    /* ------------------------------------------------------------ 渲染辅助 */

    /** 超期/临期的人话说法（与 `src/due.mjs` 的 `duePhrase` 同一个口径）。 */
    function overduePhrase(days) {
      if (typeof days !== 'number' || !isFinite(days)) return '已到期';
      if (days > 0) return `已超期 ${days} 天`;
      if (days < 0) return `还有 ${-days} 天`;
      return '今天到期';
    }

    /**
     * 让宿主打开一个目录（系统文件管理器）。
     *
     * 失败时**把宿主的原因原样抛出来** —— 「点了没反应」是最难查的用户体验，
     * 面板会把这句话显示在状态行下面。
     */
    function requestReveal(where, workspace) {
      return fetch(REVEAL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(workspace ? { where, workspace } : { where }),
      }).then(async (res) => {
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (!res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) || `HTTP ${res.status}`);
        }
        return data;
      });
    }

    const row = (key, children) => h('div', { className: 'dsh-memory-delta-row', key }, children);

    /** 只取文件名（`D:\...\facts\sandbox-no-egress.md` → `sandbox-no-egress.md`）。 */
    function baseNameOf(file) {
      const s = String(file || '');
      const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      return i >= 0 ? s.slice(i + 1) : s;
    }

    /**
     * 分节：一行「分组头」（**可点**，带自绘箭头）+ 缩进的条目体。
     *
     * 折叠状态由父组件的 `collapsed` 管（不受控的 `<details>` 在 React 里
     * 会被 `open` 属性来回覆盖，刷新后弹回全展开）。
     *
     * @param {object} spec `{ key, title, slug, count, hint, open, onToggle, onReveal }`
     *   `slug` 是磁盘上的文件夹名（facts / decisions / inbox）；没有对应目录的分组传 null。
     *   `onReveal` 有值时分组头右侧多一个「打开目录」按钮。
     */
    function section(spec, children) {
      const { key, title, slug, count, hint, open, onToggle, onReveal, className } = spec;
      return h(
        'div',
        { className: className ? `dsh-memory-delta-section ${className}` : 'dsh-memory-delta-section', key },
        h(
          'div',
          { className: 'dsh-memory-delta-section-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-memory-delta-toggle',
              onClick: onToggle,
              'aria-expanded': open ? 'true' : 'false',
              title: open ? '收起' : '展开',
            },
            h('span', { className: open ? 'dsh-memory-delta-caret is-open' : 'dsh-memory-delta-caret' }, null),
            h('span', { className: 'dsh-memory-delta-section-title' }, title),
            slug ? h('span', { className: 'dsh-memory-delta-dim dsh-memory-delta-slug' }, `（${slug}）`) : null,
            hint ? h('span', { className: 'dsh-memory-delta-dim dsh-memory-delta-section-hint' }, hint) : null,
            h('span', { className: 'dsh-memory-delta-count' }, String(count)),
          ),
          onReveal
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-memory-delta-mini',
                  onClick: onReveal,
                  title: slug ? `在系统文件管理器里打开 ${slug} 目录` : '在系统文件管理器里打开该目录',
                },
                '打开目录',
              )
            : null,
        ),
        open ? h('div', { className: 'dsh-memory-delta-body' }, children) : null,
      );
    }

    /**
     * 一条记忆。
     *
     * **整行可点 = 打开这条记忆的 .md**（走 `ctx.betterSidebar.openFile`）。
     * `showType` 只在"按标签分组"时开 —— 那时分组头是标签，条目得自己说明是事实还是决策。
     * `actions` 是行内按钮（提升 / 整理文件名），它们**必须自己 stopPropagation**，
     * 否则点按钮会连带触发整行的"打开文件"。
     */
    function item(e, opts) {
      const file = typeof e.file === 'string' && e.file ? e.file : null;
      const tags = Array.isArray(e.tags) ? e.tags : [];
      const typeLabel = e.type === 'decision' ? '决策' : e.type === 'fact' ? '事实' : null;
      const canOpen = Boolean(file) && typeof opts.onOpen === 'function';
      const actions = Array.isArray(opts.actions) ? opts.actions.filter(Boolean) : [];
      return h(
        'div',
        {
          className: 'dsh-memory-delta-item',
          key: e.id,
          role: canOpen ? 'button' : undefined,
          tabIndex: canOpen ? 0 : undefined,
          title: file ? `打开 ${file}` : undefined,
          onClick: canOpen ? () => opts.onOpen(file) : undefined,
        },
        h(
          'div',
          { className: 'dsh-memory-delta-item-head' },
          opts.showType && typeLabel
            ? h(
                'span',
                { className: e.type === 'decision' ? 'dsh-memory-delta-badge is-decision' : 'dsh-memory-delta-badge' },
                typeLabel,
              )
            : null,
          e.key ? h('span', { className: 'dsh-memory-delta-key' }, e.key) : null,
          h(
            'span',
            { className: 'dsh-memory-delta-meta' },
            tags.slice(0, 3).map((t) => h('span', { className: 'dsh-memory-delta-tag', key: t }, String(t))),
            e.date ? h('span', { className: 'dsh-memory-delta-dim' }, String(e.date)) : null,
            actions,
            canOpen ? h('span', { className: 'dsh-memory-delta-mini' }, '打开') : null,
          ),
        ),
        h('div', { className: 'dsh-memory-delta-line' }, e.line),
        file ? h('div', { className: 'dsh-memory-delta-file', title: file }, baseNameOf(file)) : null,
        opts.extraRow || null,
      );
    }

    /* ------------------------------------------------------------ 页签组件 */

    function MemoryPanel(props) {
      const scope = (props && props.scope) || {};
      const cwd = typeof scope.cwd === 'string' && scope.cwd ? scope.cwd : null;

      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      // 请求用的 workspace：先信 scope.cwd，scope 里没有就等宿主回话后再修正
      const [workspace, setWorkspace] = useState(cwd);

      const load = useCallback(
        (ws) => {
          setBusy(true);
          requestState(ws)
            .then((data) => {
              setState(data);
              setError(null);
              // 反推修正：宿主回的 workspace 才是权威（scope 里可能压根没有 cwd）。
              // 只在**真的变了**的时候才 set，否则每次挂载都会因为 workspace 变化多打一次请求。
              if (!ws && typeof data.workspace === 'string' && data.workspace) {
                setWorkspace((prev) => (prev === data.workspace ? prev : data.workspace));
              }
            })
            .catch((err) => {
              setError(err && err.message ? err.message : String(err));
            })
            .then(() => setBusy(false));
        },
        [],
      );

      // 挂载时拉一次；**不轮询** —— 这个面板是"看一下"用的，不是监控。
      useEffect(() => {
        ensureStyles();
        load(workspace);
        // workspace 变化时重新拉（例如会话切了工作区）
      }, [workspace]);

      const onRefresh = () => load(workspace);

      /**
       * 折叠状态：**由我们持有**，默认全展开。
       *
       * 之前用 `<details open>`：`open` 是受控属性，任何一次重渲染（比如点刷新）都会
       * 把用户刚收起来的分组重新弹开，而且原生 marker 又被样式藏了 ——
       * 结果是"看不出能点、点了也记不住"。
       */
      const [collapsed, setCollapsed] = useState({});
      const [groupBy, setGroupBy] = useState('type');
      const [actionError, setActionError] = useState(null);
      const [notice, setNotice] = useState(null);
      // 「整理文件名」的内联输入：{ id, value }。改名会同时改 frontmatter 的 id 与别处的引用，
      // 所以**不猜名字**（猜错就是一次全库引用改写），让用户自己填。
      const [renaming, setRenaming] = useState(null);
      const [pendingId, setPendingId] = useState(null);
      const toggleSection = (key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
      const isOpen = (key) => !collapsed[key];

      const hostCtx = props.hostCtx || props.ctx || null;

      /**
       * 点条目 → 在侧边栏编辑器里打开这条记忆的 `.md`。
       *
       * 用的是 better-sidebar 的**官方**客户端 API（`BetterSidebarService.openFile`，
       * v0.12.0+ 的能力位 `openFile`）：它内部是 `openTab({type:'editor', path})`，
       * 同一个文件重复点击会聚焦已有页签（tab id 由路径派生）。
       * 这样"改内容/归档/删除"就不必在面板里再造一套 —— 交给现成的编辑器。
       */
      const openMemoryFile = (file) => {
        const svc = hostCtx && hostCtx.betterSidebar;
        if (!svc || typeof svc.openFile !== 'function') {
          setActionError('这个版本的 better-sidebar 没有 openFile 接口，打不开文件（可以到记忆库目录里手动打开）。');
          return;
        }
        try {
          svc.openFile(scope, file, baseNameOf(file));
          setActionError(null);
        } catch (err) {
          setActionError(`打开失败：${err && err.message ? err.message : String(err)}`);
        }
      };

      /** 点「打开目录」→ 宿主用系统文件管理器打开（白名单目录 + 回环校验在宿主那侧）。 */
      const revealFolder = (where) => {
        const ws = state && typeof state.workspace === 'string' && state.workspace ? state.workspace : workspace;
        requestReveal(where, ws)
          .then(() => setActionError(null))
          .catch((err) => setActionError(`打开目录失败：${err && err.message ? err.message : String(err)}`));
      };

      const actionWorkspace = () =>
        state && typeof state.workspace === 'string' && state.workspace ? state.workspace : workspace;

      /** 行内按钮必须挡住冒泡 —— 否则点「提升」会连带触发整行的"打开文件"。 */
      const stop = (ev) => {
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      };

      /**
       * 写记忆库的动作（宿主侧复用 CLI 的 `promoteEntry` / `renameEntry`）。
       * 成功后**重新拉一次状态** —— 面板显示的内容必须立刻和磁盘一致。
       */
      const callAction = (payload) => {
        const ws = actionWorkspace();
        return fetch(ACTION_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ws ? { ...payload, workspace: ws } : payload),
        }).then(async (res) => {
          let data = null;
          try {
            data = await res.json();
          } catch {
            data = null;
          }
          if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || `HTTP ${res.status}`);
          return data;
        });
      };

      const promote = (e) => {
        setPendingId(e.id);
        return callAction({ op: 'promote', id: e.id })
          .then((r) => {
            setActionError(null);
            setNotice(`已提升 ${r.id} → ${r.target}/，下一轮会话起参与注入`);
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`提升失败：${err && err.message ? err.message : String(err)}`);
          })
          .then(() => setPendingId(null));
      };

      const startRename = (e) => {
        const base = baseNameOf(e.file || '').replace(/\.md$/, '');
        setRenaming((prev) => (prev && prev.id === e.id ? null : { id: e.id, value: e.key && e.key !== base ? e.key : '' }));
      };

      const doRename = (id, to) => {
        const value = String(to || '').trim();
        if (!value) {
          setActionError('改名失败：新文件名不能为空（建议给一条语义键，比如 sandbox-no-pipe）');
          return Promise.resolve();
        }
        setPendingId(id);
        return callAction({ op: 'rename', id, to: value })
          .then((r) => {
            setRenaming(null);
            setActionError(null);
            setNotice(`已改名 ${r.from} → ${r.to}${r.refs && r.refs.length ? `（同步了 ${r.refs.length} 处引用）` : ''}`);
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`改名失败：${err && err.message ? err.message : String(err)}`);
          })
          .then(() => setPendingId(null));
      };

      /**
       * 这条记忆的文件名"需要整理"吗？
       * 没给 key 的条目拿到的是 `<日期>-<截断的结论>.md`（截断还截在词中间），
       * 而有 key 的条目应当以 key 作文件名 —— 面板把这件事**显示出来**并给一个入口。
       */
      const needsTidy = (e) => {
        const base = baseNameOf(e.file || '').replace(/\.md$/, '');
        if (!base) return false;
        if (e.key) return base !== e.key;
        return /^\d{4}-\d{2}-\d{2}/.test(base);
      };

      /** 收件箱条目上的「提升到 facts/ decisions/」按钮。 */
      const promoteButton = (e) => {
        const target = e.type === 'decision' ? 'decisions' : e.type === 'fact' ? 'facts' : null;
        if (!target) return null;
        return h(
          'button',
          {
            type: 'button',
            className: 'dsh-memory-delta-mini',
            disabled: pendingId === e.id,
            title: `提升到 ${target}/（确认后才成为常驻记忆）`,
            onClick: (ev) => {
              stop(ev);
              promote(e);
            },
          },
          pendingId === e.id ? '提升中…' : `提升到 ${target}/`,
        );
      };

      /** 条目上的「整理文件名」按钮（id + 文件名 + 引用一起改）。 */
      const tidyButton = (e) =>
        needsTidy(e)
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-memory-delta-mini',
                title: '把文件名改成规范 slug：同时改 frontmatter 的 id、文件名与别处的引用（等价于 mem rename）',
                onClick: (ev) => {
                  stop(ev);
                  startRename(e);
                },
              },
              renaming && renaming.id === e.id ? '取消' : '整理文件名',
            )
          : null;

      /** 展开的内联改名输入行。 */
      const renameRow = (e) =>
        renaming && renaming.id === e.id
          ? h(
              'div',
              { className: 'dsh-memory-delta-rename', key: `${e.id}:rename`, onClick: stop },
              h('input', {
                value: renaming.value,
                placeholder: '新文件名（字母/数字/._-，建议用语义键）',
                'aria-label': '新文件名',
                onChange: (ev) => setRenaming({ id: e.id, value: ev && ev.target ? ev.target.value : '' }),
                onKeyDown: (ev) => {
                  stop(ev);
                  if (ev && ev.key === 'Enter') doRename(e.id, renaming.value);
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-memory-delta-mini',
                  disabled: pendingId === e.id,
                  onClick: (ev) => {
                    stop(ev);
                    doRename(e.id, renaming.value);
                  },
                },
                pendingId === e.id ? '改名中…' : '改',
              ),
            )
          : null;

      const head = h(
        'div',
        { className: 'dsh-memory-delta-head' },
        h('span', { className: 'dsh-memory-delta-title' }, '记忆'),
        h(
          'span',
          { className: 'dsh-memory-delta-seg' },
          h(
            'button',
            { type: 'button', className: groupBy === 'type' ? 'is-on' : undefined, onClick: () => setGroupBy('type'), title: '按类型分组：事实（facts）/ 决策（decisions）' },
            '类型',
          ),
          h(
            'button',
            { type: 'button', className: groupBy === 'tag' ? 'is-on' : undefined, onClick: () => setGroupBy('tag'), title: '按标签分组（取每条的第一个标签）' },
            '标签',
          ),
        ),
        h(
          'button',
          { type: 'button', className: 'dsh-memory-delta-btn', onClick: onRefresh, disabled: busy },
          busy ? '读取中…' : '刷新',
        ),
      );

      if (error) {
        return h(
          'div',
          { className: 'dsh-memory-delta-tab' },
          head,
          h('div', { className: 'dsh-memory-delta-error' }, `读取记忆库失败：${error}`),
          h('div', { className: 'dsh-memory-delta-dim' }, '可能原因：DSH 里还没加载 dsh-memory-delta 的宿主路由（改完源码要同步 + 重启 DSH）。'),
        );
      }

      if (!state) {
        return h('div', { className: 'dsh-memory-delta-tab' }, head, h('div', { className: 'dsh-memory-delta-muted' }, '读取中…'));
      }

      const counts = state.counts || {};
      const budget = typeof state.budget === 'number' ? state.budget : 0;
      const bytes = typeof state.bytes === 'number' ? state.bytes : 0;
      const over = budget > 0 && bytes > budget;

      const statusRow = row(
        'status',
        [
          h('span', { key: 'root', className: 'dsh-memory-delta-muted dsh-memory-delta-path' }, `库：${state.root || '（未配置）'}`),
          h('span', { key: 'n', className: 'dsh-memory-delta-muted' }, `常驻 ${counts.active || 0} 条`),
          h(
            'span',
            { key: 'b', className: over ? 'dsh-memory-delta-warn' : 'dsh-memory-delta-muted' },
            `注入 ${bytes} / ${budget} 字节${over ? '（超出预算）' : ''}`,
          ),
          counts.inbox
            ? h(
                'span',
                { key: 'i', className: 'dsh-memory-delta-muted' },
                '候选',
                h('span', { className: 'dsh-memory-delta-slug' }, '（inbox）'),
                `${counts.inbox} 条`,
              )
            : null,
        ].filter(Boolean),
      );

      const dueList = Array.isArray(state.due) ? state.due : [];
      const dueBlock = section(
        {
          key: 'due',
          title: '待复核',
          slug: null,
          count: dueList.length,
          className: dueList.length ? 'dsh-memory-delta-due' : null,
          open: isOpen('due'),
          onToggle: () => toggleSection('due'),
        },
        dueList.length === 0
          ? h(
              'div',
              { className: 'dsh-memory-delta-muted dsh-memory-delta-empty' },
              '没有到复核期的记忆 —— 条目的 verify_when 到期后才会出现在这里（mem due 看全量）',
            )
          : dueList.map((d) =>
              h(
                'div',
                { className: 'dsh-memory-delta-due-line', key: d.id },
                h('span', { className: 'dsh-memory-delta-flag dsh-memory-delta-warn' }, overduePhrase(d.overdueDays)),
                h(
                  'span',
                  null,
                  h('span', { className: 'dsh-memory-delta-line' }, d.line),
                  h(
                    'span',
                    { className: 'dsh-memory-delta-verify dsh-memory-delta-dim' },
                    `verify_when: ${d.verifyWhen || '—'}${d.due ? ` → ${d.due}` : ''}`,
                  ),
                ),
              ),
            ),
      );

      const entries = Array.isArray(state.entries) ? state.entries : [];
      /** 新的排前面（同一天按 id 稳定排序）—— "最近记了什么"比字母序有用得多。 */
      const byDateDesc = (list) =>
        [...list].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.id).localeCompare(String(b.id)));

      /** 统一渲染一条条目：可点开、带「整理文件名」入口、需要时展开改名输入行。 */
      const renderItem = (e, extra) =>
        item(e, Object.assign({ onOpen: openMemoryFile, showType: false, actions: [tidyButton(e)], extraRow: renameRow(e) }, extra || {}));

      const groupSection = (key, title, slug, list) =>
        list.length
          ? section(
              {
                key: `type:${key}`,
                title,
                slug,
                count: list.length,
                open: isOpen(`type:${key}`),
                onToggle: () => toggleSection(`type:${key}`),
                onReveal: slug ? () => revealFolder(slug) : null,
              },
              byDateDesc(list).map((e) => renderItem(e)),
            )
          : null;

      /**
       * 按标签分组（"自动归纳"里唯一确定有用的那半）：
       * 取每条**第一个**标签当主题，其余标签仍在条目行上显示；
       * 没标签的归到最后一组。组间按条数从多到少 —— 大头在前。
       */
      const tagGroups = () => {
        const map = new Map();
        for (const e of entries) {
          const tag = Array.isArray(e.tags) && e.tags.length ? String(e.tags[0]) : '__untagged__';
          if (!map.has(tag)) map.set(tag, []);
          map.get(tag).push(e);
        }
        const named = [...map.entries()].filter(([k]) => k !== '__untagged__');
        named.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
        const untagged = map.get('__untagged__');
        if (untagged) named.push(['__untagged__', untagged]);
        return named;
      };

      const facts = entries.filter((e) => e.type === 'fact');
      const decisions = entries.filter((e) => e.type === 'decision');
      const other = entries.filter((e) => e.type !== 'fact' && e.type !== 'decision');

      const standing = entries.length
        ? h(
            'div',
            null,
            groupBy === 'tag'
              ? tagGroups().map(([tag, list]) =>
                  section(
                    {
                      key: `tag:${tag}`,
                      title: tag === '__untagged__' ? '未加标签' : tag,
                      slug: null,
                      count: list.length,
                      hint: '按标签',
                      open: isOpen(`tag:${tag}`),
                      onToggle: () => toggleSection(`tag:${tag}`),
                    },
                    byDateDesc(list).map((e) => renderItem(e, { showType: true })),
                  ),
                )
              : [
                  groupSection('facts', '事实', 'facts', facts),
                  groupSection('decisions', '决策', 'decisions', decisions),
                  // 「其它」没有对应目录（type 不是 fact/decision 的条目仍放在两个有类型目录里），所以不给 slug
                  groupSection('other', '其它', null, other),
                ],
          )
        : h('div', { className: 'dsh-memory-delta-section' }, h('div', { className: 'dsh-memory-delta-muted dsh-memory-delta-empty' }, '还没有常驻记忆'));

      const inbox = Array.isArray(state.inbox) ? state.inbox : [];
      const inboxBlock = section(
        {
          key: 'inbox',
          title: '收件箱候选',
          slug: 'inbox',
          count: typeof counts.inbox === 'number' ? counts.inbox : inbox.length,
          open: isOpen('inbox'),
          onToggle: () => toggleSection('inbox'),
          onReveal: () => revealFolder('inbox'),
        },
        [
          h(
            'div',
            { className: 'dsh-memory-delta-dim', key: 'hint' },
            '候选放在 inbox/ 目录；确认后才成为常驻记忆（promote 后写进 facts/ 或 decisions/ 才会被注入）。',
          ),
          inbox.length === 0
            ? h(
                'div',
                { className: 'dsh-memory-delta-muted dsh-memory-delta-empty', key: 'empty' },
                '还没有待确认的候选 —— 模型用 memory_write 写了结论才会出现在这里，空着是正常的',
              )
            : inbox.map((e) => renderItem(e, { showType: true, actions: [promoteButton(e), tidyButton(e)] })),
        ],
      );

      return h(
        'div',
        { className: 'dsh-memory-delta-tab' },
        head,
        statusRow,
        actionError ? h('div', { className: 'dsh-memory-delta-note' }, actionError) : null,
        notice ? h('div', { className: 'dsh-memory-delta-note dsh-memory-delta-ok' }, notice) : null,
        dueBlock,
        standing,
        inboxBlock,
      );
    }

    /* ------------------------------------------------------------ 注册 */

    /** 客户端服务依赖：`betterSidebar` 由 `dsh-better-sidebar` 提供（见 package.json 的 dsh.client.inject）。 */
    const inject = ['betterSidebar'];

    function apply(ctx) {
      ctx.effect(() =>
        ctx.betterSidebar.registerTab({
          id: 'dsh-memory-delta:memory',
          title: '记忆',
          order: 60,
          // 单实例：多次打开只聚焦已有页签，不会叠出好几个「记忆」页
          single: true,
          // 把 ctx 显式喂给组件：面板要调 `ctx.betterSidebar.openFile` 打开条目文件。
          // 组件本身在模块顶层定义（不能闭包到 apply 的 ctx），所以这里包一层。
          component: (props) => h(MemoryPanel, Object.assign({}, props, { hostCtx: ctx })),
        }),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    // 给测试用的额外出口（宿主只认 apply / inject，其余导出无害）
    exports.MemoryPanel = MemoryPanel;
    exports.ensureStyles = ensureStyles;
    return module.exports;
  },
});
