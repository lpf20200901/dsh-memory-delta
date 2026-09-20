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
    // 检索：和 `mem recall` / 插件工具 memory_search **同一份实现**（宿主侧复用 searchLibrary）
    const SEARCH_URL = '/dsh-memory-delta/search';
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

/* 小按钮：提升 / 整理文件名（只保留"要写库/要判断"的动作，纯跳转类的按钮都去掉了） */
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
/* 危险动作的按钮与行内确认条 —— 只做视觉区分，真正的闸门是"必须点两次" */
.dsh-memory-delta-mini.is-danger {
  border-color: var(--dsw-alias-state-error-secondary, rgba(198,40,40,.45));
  color: var(--dsw-alias-state-error-primary, #c62828);
}
.dsh-memory-delta-confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-state-error-secondary, rgba(198,40,40,.35));
  background: var(--dsw-alias-state-error-secondary, rgba(198,40,40,.08));
}
.dsh-memory-delta-confirm-text { flex: 1 1 auto; min-width: 0; font-size: 11px; }
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
/* 搜索框：一行占满，和分组头同一层的视觉重量 */
.dsh-memory-delta-search { display: flex; align-items: center; gap: 6px; }
.dsh-memory-delta-search > input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: inherit;
  font: inherit;
}
.dsh-memory-delta-search > input::placeholder { color: var(--dsw-alias-label-tertiary, #8c8c8c); }
.dsh-memory-delta-search > input:focus { outline: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.5)); outline-offset: 0; }
.dsh-memory-delta-snippet { color: var(--dsw-alias-label-secondary, #6b6b6b); }
/* 流程条：把"这几组在流程里的前后关系"摆在一行里，不用读小字注释 */
.dsh-memory-delta-flow {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 4px;
  padding: 4px 7px;
  border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1));
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  font-size: 11px;
}
.dsh-memory-delta-flow-now { color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.dsh-memory-delta-flow-dim { color: var(--dsw-alias-label-tertiary, #8c8c8c); }
/* 全局规范的预览：等宽 + 可滚动 + 不撑破面板（它是 Markdown 原文，不是渲染后的） */
.dsh-memory-delta-preview {
  margin: 4px 0 0;
  padding: 6px 8px;
  max-height: 260px;
  overflow: auto;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06));
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 10.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.dsh-memory-delta-where {
  flex: none;
  font-size: 10px;
  line-height: 15px;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
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

    const row = (key, children) => h('div', { className: 'dsh-memory-delta-row', key }, children);

    /**
     * 检索记忆库。
     *
     * 分词/打分/片段**全在宿主**（`searchLibrary` → `src/search.mjs`）—— 面板搜出来的顺序与
     * 片段必须和 `mem recall`、模型看到的 `memory_search` 一模一样，否则就会出现
     * "我明明记过这条，界面却搜不到"这种最难查的分歧。
     */
    function requestSearch(query, workspace) {
      return fetch(SEARCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(workspace ? { query, workspace } : { query }),
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

    /** 命中所在的层 —— 界面上的中文名（与 `（facts）` 那种目录名对照）。 */
    const WHERE_LABEL = {
      facts: '事实',
      decisions: '决策',
      inbox: '收件箱',
      archive: '归档',
      journal: '流水',
      sessions: '会话',
      index: '索引',
    };

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
     * @param {object} spec `{ key, title, slug, count, hint, open, onToggle, className }`
     *   `slug` 是磁盘上的文件夹名（facts / decisions / inbox）；没有对应目录的分组传 null。
     */
    function section(spec, children) {
      const { key, title, slug, count, hint, open, onToggle, className } = spec;
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
          opts.showWhere && e.where
            ? h('span', { className: 'dsh-memory-delta-where' }, WHERE_LABEL[e.where] || e.where)
            : null,
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
            // 不再给「打开」小标签：整行本来就可点（hover 有底色 + title 提示），标签只是噪音
          ),
        ),
        h('div', { className: 'dsh-memory-delta-line' }, e.line),
        // 搜索结果里带命中片段（含上下文，比首行更有信息量）；相关度只放进 title，不占视觉
        opts.showSnippet && e.snippet && e.snippet !== e.line
          ? h('div', { className: 'dsh-memory-delta-snippet', title: typeof e.score === 'number' ? `score ${e.score}` : undefined }, e.snippet)
          : null,
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
      // 「全局规范」默认**折叠**：它是工作区外的整篇指令文件，展开会把面板淹掉
      //（也避免截图时把里面的个人信息带出去）。
      const [collapsed, setCollapsed] = useState({ 'stage:global': true });
      const [groupBy, setGroupBy] = useState('type');
      const [actionError, setActionError] = useState(null);
      const [notice, setNotice] = useState(null);
      // 搜索：query 是输入框内容，results 是宿主回的命中（null = 还没搜/已清空）
      const [query, setQuery] = useState('');
      const [results, setResults] = useState(null);
      const [searchedQuery, setSearchedQuery] = useState(null);
      const [searching, setSearching] = useState(false);
      const [searchError, setSearchError] = useState(null);
      // 「整理文件名」的内联输入：{ id, value }。改名会同时改 frontmatter 的 id 与别处的引用，
      // 所以**不猜名字**（猜错就是一次全库引用改写），让用户自己填。
      const [renaming, setRenaming] = useState(null);
      const [pendingId, setPendingId] = useState(null);
      /**
       * 危险动作的**行内确认条**：`{ id, op, label, hint }`。
       *
       * 为什么不用浏览器原生 `confirm()`：它阻塞页面、跟界面风格不搭，
       * 而且**无头截图会卡在那里**（我们靠截图出产品图）。行内确认既好测也好看。
       */
      const [confirming, setConfirming] = useState(null);
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

      const actionWorkspace = () =>
        state && typeof state.workspace === 'string' && state.workspace ? state.workspace : workspace;

      /**
       * 跑一次检索。同一个词不重复请求（回车会立刻调它，而防抖那一路稍后也会到）。
       * 清空输入框时不发请求，只把结果丢掉 —— 回到分组视图。
       */
      const runSearch = (raw) => {
        const q = String(raw ?? '').trim();
        if (!q) {
          setResults(null);
          setSearchedQuery(null);
          setSearchError(null);
          return;
        }
        if (q === searchedQuery) return;
        setSearchedQuery(q);
        setSearching(true);
        requestSearch(q, actionWorkspace())
          .then((data) => {
            setResults({ total: data.total || 0, matches: Array.isArray(data.matches) ? data.matches : [], query: q });
            setSearchError(null);
          })
          .catch((err) => {
            setResults(null);
            setSearchError(err && err.message ? err.message : String(err));
          })
          .then(() => setSearching(false));
      };

      // 输入停顿 200ms 自动搜（回车立即搜）：不轮询、不每次按键都砸一遍磁盘
      useEffect(() => {
        const q = query.trim();
        if (!q) {
          setResults(null);
          setSearchedQuery(null);
          setSearchError(null);
          return undefined;
        }
        const timer = setTimeout(() => runSearch(q), 200);
        return () => clearTimeout(timer);
      }, [query]);

      /** 确认条上的动词（"要<动词>这条？"）。 */
      const CONFIRM_VERB = { demote: '撤回', archive: '归档', restore: '取回', remove: '删除' };

      /** 用户点了「确认 X」之后，按 op 分派到对应动作（危险动作只有这一个出口）。 */
      const runConfirmed = (op, id) => {
        if (op === 'remove') return removeCandidate(id);
        if (op === 'demote') return demote(id);
        if (op === 'archive') return archive(id);
        if (op === 'restore') return restore(id);
        setConfirming(null);
        return undefined;
      };

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

      /**
       * **撤回**：常驻 → 候选。和"取代"是两件事（取代进归档；撤回只是"先不当真"）。
       * 它会改冻结层，所以走行内确认。
       */
      const demote = (id) => {
        setConfirming(null);
        setPendingId(id);
        return callAction({ op: 'demote', id })
          .then((r) => {
            setActionError(null);
            setNotice(`已撤回 ${r.id}：回到「待你确认」，下一轮起不再发给模型`);
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`撤回失败：${err && err.message ? err.message : String(err)}`);
          })
          .then(() => setPendingId(null));
      };

      /** 删除候选：不可恢复，所以必须过确认条。 */
      const removeCandidate = (id) => {
        setConfirming(null);
        setPendingId(id);
        return callAction({ op: 'remove', id })
          .then((r) => {
            setActionError(null);
            setNotice(`已删除候选 ${r.id}`);
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`删除失败：${err && err.message ? err.message : String(err)}`);
          })
          .then(() => setPendingId(null));
      };

      /** **归档**：不再适用又没有替代 → archive/（区别于"取代"）。 */
      const archive = (id) => {
        setConfirming(null);
        setPendingId(id);
        return callAction({ op: 'archive', id })
          .then((r) => {
            setActionError(null);
            setNotice(`已归档 ${r.id}（${r.status}）：不再发给模型，但搜得到、也能取回`);
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`归档失败：${err && err.message ? err.message : String(err)}`);
          })
          .then(() => setPendingId(null));
      };

      /** **取回**：archive/ → 待你确认（再确认一次才会重新生效）。 */
      const restore = (id) => {
        setConfirming(null);
        setPendingId(id);
        return callAction({ op: 'restore', id })
          .then((r) => {
            setActionError(null);
            setNotice(`已取回 ${r.id}：回到「待你确认」，再点「提升」才会重新生效`);
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`取回失败：${err && err.message ? err.message : String(err)}`);
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

      /**
       * 常驻条目上的「撤回」按钮 —— 双向迁移的另一半（常驻 → 候选）。
       * 会改冻结层，所以先弹**行内确认条**，不直接动手。
       */
      const demoteButton = (e) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-memory-delta-mini',
            disabled: pendingId === e.id,
            title: '撤回：回到「待你确认」，下一轮起不再发给模型（不等于取代 —— 取代是进归档）',
            onClick: (ev) => {
              stop(ev);
              setConfirming(
                confirming && confirming.id === e.id
                  ? null
                  : {
                      id: e.id,
                      op: 'demote',
                      label: '确认撤回',
                      hint: '撤回后它回到「待你确认」，不再发给模型；想再放回去点一次「提升」就行。',
                    },
              );
            },
          },
          confirming && confirming.id === e.id && confirming.op === 'demote' ? '取消' : '撤回',
        );

      /**
       * 常驻条目上的「归档」按钮 —— 这条不再适用、**又没有新版本顶上来**时用。
       * 与「撤回」的区别：撤回是"先不当真"（还能再提升回来），归档是"退场"（进 archive/，仍可搜、可取回）。
       */
      const archiveButton = (e) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-memory-delta-mini',
            disabled: pendingId === e.id,
            title: '归档：不再适用又没有替代 → 进 archive/（不再发给模型，仍能搜到，也能取回）',
            onClick: (ev) => {
              stop(ev);
              setConfirming(
                confirming && confirming.id === e.id
                  ? null
                  : {
                      id: e.id,
                      op: 'archive',
                      label: '确认归档',
                      hint: '归档后它不再发给模型，但仍能搜到、也能「取回」；有替代它的新结论请用 CLI 的 mem supersede 建立双向链接。',
                    },
              );
            },
          },
          confirming && confirming.id === e.id && confirming.op === 'archive' ? '取消' : '归档',
        );

      /** 归档条目上的「取回」按钮 —— 归档不是终点。 */
      const restoreButton = (e) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-memory-delta-mini',
            disabled: pendingId === e.id,
            title: '取回：archive/ → 待你确认（status 复位为 active，等你再确认一次）',
            onClick: (ev) => {
              stop(ev);
              setConfirming(
                confirming && confirming.id === e.id
                  ? null
                  : { id: e.id, op: 'restore', label: '确认取回', hint: '取回后它回到「待你确认」，再点「提升」才会重新生效。' },
              );
            },
          },
          confirming && confirming.id === e.id && confirming.op === 'restore' ? '取消' : '取回',
        );

      /** 候选条目上的「删除」按钮 —— 不可恢复，同样走确认条。 */
      const removeButton = (e) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-memory-delta-mini is-danger',
            disabled: pendingId === e.id,
            title: '删除这个候选（文件会被删掉，不可恢复）',
            onClick: (ev) => {
              stop(ev);
              setConfirming(
                confirming && confirming.id === e.id
                  ? null
                  : {
                      id: e.id,
                      op: 'remove',
                      label: '确认删除',
                      hint: '这个候选的文件会被直接删掉，不可恢复（常驻条目不能这样删，请用「撤回」或取代）。',
                    },
              );
            },
          },
          confirming && confirming.id === e.id && confirming.op === 'remove' ? '取消' : '删除',
        );

      /** 行内确认条：危险动作的第二道闸（替代浏览器原生 confirm —— 那个会卡住无头截图）。 */
      const confirmRow = (e) =>
        confirming && confirming.id === e.id
          ? h(
              'div',
              { className: 'dsh-memory-delta-confirm', key: `${e.id}:confirm`, onClick: stop },
              h(
                'span',
                { className: 'dsh-memory-delta-confirm-text' },
                `要${CONFIRM_VERB[confirming.op] || '执行'}这条？${confirming.hint}`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: confirming.op === 'remove' ? 'dsh-memory-delta-mini is-danger' : 'dsh-memory-delta-mini',
                  disabled: pendingId === e.id,
                  onClick: (ev) => {
                    stop(ev);
                    runConfirmed(confirming.op, e.id);
                  },
                },
                pendingId === e.id ? '处理中…' : confirming.label,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-memory-delta-mini',
                  onClick: (ev) => {
                    stop(ev);
                    setConfirming(null);
                  },
                },
                '取消',
              ),
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

      /** 搜索框：中文连写也能搜（bigram 在宿主侧切），回车立即搜、停顿 200ms 自动搜。 */
      const searchRow = h(
        'div',
        { className: 'dsh-memory-delta-search' },
        h('input', {
          type: 'search',
          className: 'dsh-memory-delta-search-input',
          value: query,
          placeholder: '搜索记忆与流水（中文连写也行，如 沙箱禁管道）',
          'aria-label': '搜索记忆',
          onChange: (ev) => setQuery(ev && ev.target ? ev.target.value : ''),
          onKeyDown: (ev) => {
            if (ev && ev.key === 'Enter') {
              if (typeof ev.preventDefault === 'function') ev.preventDefault();
              runSearch(query);
            }
          },
        }),
        query
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-memory-delta-mini',
                title: '清空搜索，回到分组视图',
                onClick: () => {
                  setQuery('');
                  setResults(null);
                  setSearchedQuery(null);
                  setSearchError(null);
                },
              },
              '清空',
            )
          : null,
        searching ? h('span', { className: 'dsh-memory-delta-dim' }, '搜索中…') : null,
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

      // 状态行只留"库在哪 + 注入花多少字节"：各阶段的条数**只在流程条里报一次**，
      // 同一屏里两处报同样的数字只会让人多读一遍（截图里发现的冗余）。
      const statusRow = row(
        'status',
        [
          h('span', { key: 'root', className: 'dsh-memory-delta-muted dsh-memory-delta-path' }, `库：${state.root || '（未配置）'}`),
          h(
            'span',
            { key: 'b', className: over ? 'dsh-memory-delta-warn' : 'dsh-memory-delta-muted' },
            `注入 ${bytes} / ${budget} 字节${over ? '（超出预算）' : ''}`,
          ),
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

      /**
       * 统一渲染一条条目：可点开、带「整理文件名」入口、危险动作要展开确认条。
       *
       * `standing` 为真 = 这条在「已在用」里（给「撤回」按钮）；否则按候选处理（给「删除」）。
       */
      const renderItem = (e, extra) =>
        item(
          e,
          Object.assign(
            {
              onOpen: openMemoryFile,
              showType: false,
              actions: [demoteButton(e), archiveButton(e), tidyButton(e)],
              // 确认条优先：它出现时说明用户刚点了危险按钮，此时不该再显示改名输入
              extraRow: confirmRow(e) || renameRow(e),
            },
            extra || {},
          ),
        );

      const groupSection = (key, title, slug, list, hint, note) =>
        list.length
          ? section(
              {
                key: `type:${key}`,
                title,
                slug,
                count: list.length,
                // 分组名只说明"是什么"，hint 说明"在流程哪一步、管不管注入" ——
                // 光看 `facts` 这个名字判断不出它在流程里的位置（真实反馈）。
                hint,
                open: isOpen(`type:${key}`),
                onToggle: () => toggleSection(`type:${key}`),
              },
              // note = 这一组"到底记什么"的人话说明（用户反馈：`事实`/`决策` 这两个词太抽象）
              (note ? [h('div', { className: 'dsh-memory-delta-dim', key: 'note' }, note)] : []).concat(
                byDateDesc(list).map((e) => renderItem(e)),
              ),
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

      /* -------------------------------------------------- 已在用（常驻层）
         阶段视角：这一层 = "每轮会话都会自动发给模型"的结论。
         类型（事实/决策）是**这一层内部**的子分组 —— 它回答的是"这条该放哪边"，
         不是"这条在流程哪一步"。以前把类型放在最外层，于是流程位置只能靠小字注释，
         结果是"一眼看不出是干啥的"（真实反馈）。 */
      const standingBody =
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
              groupSection(
                'facts',
                '事实',
                'facts',
                facts,
                '踩过的坑 & 绕开的方法',
                '换个环境或换个版本，它可能就不成立了 —— 所以写清"什么情况下适用"最有价值。',
              ),
              groupSection(
                'decisions',
                '决策',
                'decisions',
                decisions,
                '你定下的约定',
                '业务/流程/口味上的决定：只有你改主意才会变 —— 记下"为什么这么定"，我就不会再问第二遍。',
              ),
              // 「其它」没有对应目录（type 不是 fact/decision 的条目仍放在两个有类型目录里），所以不给 slug
              groupSection(
                'other',
                '其它',
                null,
                other,
                'type 未识别',
                '这些条目的 type 字段不是 fact / decision，面板不知道该怎么归类。',
              ),
            ];

      /* -------------------------------------------------- 全局规范（工作区外）
         这份是 **DSH 自己**注入的用户级指令文件（`$DSH_HOME/AGENTS.md`），每个工作区都生效 ——
         它不是本插件注入的，但"已经在生效的东西"不该在界面上完全看不见，否则用户会以为
         全局规范没起作用。它放在「已在用」里最前面（和常驻条目是同一类东西：**每轮都会进上下文**），
         但默认**折叠**：标题上给路径与大小就够，不把整篇糊在脸上。 */
      const glob = state.global && typeof state.global === 'object' ? state.global : null;
      const globalBlock = glob
        ? section(
            {
              key: 'stage:global',
              title: '全局规范',
              slug: null,
              count: glob.exists ? 1 : 0,
              hint: glob.exists
                ? `${glob.displayPath} · ${glob.bytes} 字节 · 每个工作区都生效（DSH 注入，不是本插件）`
                : `${glob.displayPath} 还不存在`,
              open: isOpen('stage:global'),
              onToggle: () => toggleSection('stage:global'),
            },
            [
              h(
                'div',
                { className: 'dsh-memory-delta-dim', key: 'why' },
                '这份文件由 DSH 自带的指令管道注入 —— 不管在哪个工作区、开哪个新会话，它都在上下文里。本插件的记忆库只管当前工作区（`<工作区>/memory`）。',
              ),
              glob.exists && Array.isArray(glob.preview) && glob.preview.length
                ? h(
                    'pre',
                    { className: 'dsh-memory-delta-preview', key: 'preview' },
                    `${glob.preview.join('\n')}\n${glob.truncated ? `…（共 ${glob.lines} 行，面板只显示前 ${glob.preview.length} 行）` : ''}`,
                  )
                : h(
                    'div',
                    { className: 'dsh-memory-delta-muted dsh-memory-delta-empty', key: 'empty' },
                    glob.exists ? '文件是空的' : '还没有这份文件 —— 建了它，每个工作区的新会话都会自动带上',
                  ),
              glob.source
                ? h(
                    'div',
                    { className: 'dsh-memory-delta-dim', key: 'source' },
                    `本库源文件 ${glob.source.name}（${glob.source.bytes} 字节）—— 改完它要同步到上面那份才生效。`,
                  )
                : null,
            ],
          )
        : null;

      /**
       * 工作区规范：`<工作区>/AGENTS.md` + `AGENTS.local.md`（DSH 也每轮注入）。
       *
       * 与全局那份的区别：**这两个文件在工作区内** → better-sidebar 的 workspace fence 允许打开，
       * 所以能直接给「编辑」按钮进侧边栏编辑器（不用我们再造编辑 UI）。
       */
      const wsRules = Array.isArray(state.workspaceRules) ? state.workspaceRules : [];
      const workspaceRulesBlock = section(
        {
          key: 'stage:wsrules',
          title: '工作区规范',
          slug: null,
          count: wsRules.length,
          hint: '只在本工作区生效 · 每轮注入（含 AGENTS.local.md 私有层）',
          open: isOpen('stage:wsrules'),
          onToggle: () => toggleSection('stage:wsrules'),
        },
        wsRules.length
          ? wsRules.map((r) =>
              h(
                'div',
                { className: 'dsh-memory-delta-item', key: r.name },
                h(
                  'div',
                  { className: 'dsh-memory-delta-item-head' },
                  h('span', { className: 'dsh-memory-delta-key' }, r.name),
                  h(
                    'span',
                    { className: 'dsh-memory-delta-meta' },
                    h('span', { className: 'dsh-memory-delta-dim' }, `${r.bytes} 字节`),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-memory-delta-mini',
                        title: `在侧边栏编辑器里打开 ${r.name}（这个文件在工作区内，可以直接改）`,
                        onClick: () => openMemoryFile(r.file),
                      },
                      '编辑',
                    ),
                  ),
                ),
              ),
            )
          : h(
              'div',
              { className: 'dsh-memory-delta-muted dsh-memory-delta-empty' },
              '这个工作区还没有 AGENTS.md —— 建了它，本工作区的每个新会话都会自动带上（想只给自己看用 AGENTS.local.md，不进 git）',
            ),
      );

      const standing = entries.length
        ? section(
            {
              key: 'stage:standing',
              title: '已在用',
              slug: null,
              count: entries.length,
              hint: '每轮会话自动发给模型 · 这就是"它记住了"的部分',
              open: isOpen('stage:standing'),
              onToggle: () => toggleSection('stage:standing'),
            },
            [globalBlock, workspaceRulesBlock].concat(standingBody),
          )
        : section(
            {
              key: 'stage:standing',
              title: '已在用',
              slug: null,
              count: 0,
              hint: '每轮会话自动发给模型',
              open: isOpen('stage:standing'),
              onToggle: () => toggleSection('stage:standing'),
            },
            h(
              'div',
              { className: 'dsh-memory-delta-muted dsh-memory-delta-empty' },
              '还没有已确认的记忆 —— 模型写进「待你确认」的候选，你点一下提升就会到这里',
            ),
          );

      const inbox = Array.isArray(state.inbox) ? state.inbox : [];
      const inboxBlock = section(
        {
          key: 'stage:inbox',
          title: '待你确认',
          slug: 'inbox',
          count: typeof counts.inbox === 'number' ? counts.inbox : inbox.length,
          hint: '模型想记住的 · 你点头才生效（在那之前不会发给模型）',
          open: isOpen('stage:inbox'),
          onToggle: () => toggleSection('stage:inbox'),
        },
        [
          h(
            'div',
            { className: 'dsh-memory-delta-dim', key: 'hint' },
            '这些都是模型自己写的候选（它只能写这里）。点「提升到 facts/ decisions/」确认后才会进「已在用」，才会每轮带给模型。',
          ),
          inbox.length === 0
            ? h(
                'div',
                { className: 'dsh-memory-delta-muted dsh-memory-delta-empty', key: 'empty' },
                '没有待确认的候选 —— 模型用 memory_write 写了结论才会出现在这里，空着是正常的',
              )
            : inbox.map((e) => renderItem(e, { showType: true, actions: [promoteButton(e), tidyButton(e), removeButton(e)] })),
        ],
      );

      /* 归档层：以前只显示一个条数，现在**把条目列出来** —— 否则「取回」没有入口，
         用户会以为"记过、后来被取代了"的东西丢了（其实它还在，也能搜到）。 */
      const archiveCount = typeof counts.archive === 'number' ? counts.archive : 0;
      const archived = Array.isArray(state.archive) ? state.archive : [];
      const archiveBlock = section(
        {
          key: 'stage:archive',
          title: '已归档',
          slug: 'archive',
          count: archiveCount,
          hint: '不再适用 / 被取代 · 不再发给模型，但搜得到、也能取回',
          open: isOpen('stage:archive'),
          onToggle: () => toggleSection('stage:archive'),
        },
        [
          h(
            'div',
            { className: 'dsh-memory-delta-dim', key: 'note' },
            archiveCount === 0
              ? '还没有归档 —— 结论被取代（supersede）或不再适用（归档）时会搬到这里，不再发给模型'
              : '这些是退场的旧结论：不再发给模型，但仍在库里（可搜索）。点「取回」会把它放回「待你确认」，再确认一次才重新生效。',
          ),
          ...(archived.length
            ? archived.map((e) =>
                renderItem(e, {
                  showType: true,
                  actions: [restoreButton(e)],
                  extraRow: confirmRow(e) || null,
                }),
              )
            : []),
          archiveCount > archived.length
            ? h(
                'div',
                { className: 'dsh-memory-delta-dim', key: 'more' },
                `面板只列前 ${archived.length} 条，其余用搜索框搜（归档层能被搜到）`,
              )
            : null,
        ].filter(Boolean),
      );

      /** 流程条：一眼看出"我现在看的这几组在流程里的前后关系"。 */
      const flow = h(
        'div',
        { className: 'dsh-memory-delta-flow' },
        '流程：模型写入 → ',
        h('span', { className: 'dsh-memory-delta-flow-now' }, `待你确认 ${typeof counts.inbox === 'number' ? counts.inbox : 0}`),
        ' → ',
        h('span', { className: 'dsh-memory-delta-flow-now' }, `已在用 ${entries.length}`),
        ' → ',
        h('span', { className: 'dsh-memory-delta-flow-dim' }, `已归档 ${archiveCount}`),
      );

      /* ------------------------------------------------------------ 搜索块 */
      const searching_ = query.trim().length > 0;
      const hits = results && Array.isArray(results.matches) ? results.matches : [];
      const searchBlock = searching_
        ? section(
            {
              key: 'search',
              title: '搜索结果',
              slug: null,
              count: results ? results.total : 0,
              hint: results ? `“${results.query}”` : `“${query.trim()}”`,
              open: isOpen('search'),
              onToggle: () => toggleSection('search'),
            },
            [
              h(
                'div',
                { className: 'dsh-memory-delta-dim', key: 'hint' },
                '在条目（facts/ decisions/ inbox/ archive）与流水里按相关度搜 —— 和 `mem recall`、模型用的 memory_search 是同一套打分。清空搜索框回到分组视图。',
              ),
              searchError
                ? h('div', { className: 'dsh-memory-delta-error', key: 'err' }, `搜索失败：${searchError}`)
                : results && results.total === 0
                  ? h(
                      'div',
                      { className: 'dsh-memory-delta-muted dsh-memory-delta-empty', key: 'empty' },
                      '没有匹配 —— 换个说法，或拆成几个关键词（中文连写会自动切 bigram，不用手动加空格）',
                    )
                  : hits.map((hit) =>
                      item(hit, { onOpen: openMemoryFile, showType: true, showWhere: true, showSnippet: true, actions: [] }),
                    ),
            ],
          )
        : null;

      return h(
        'div',
        { className: 'dsh-memory-delta-tab' },
        head,
        searchRow,
        statusRow,
        flow,
        actionError ? h('div', { className: 'dsh-memory-delta-note' }, actionError) : null,
        notice ? h('div', { className: 'dsh-memory-delta-note dsh-memory-delta-ok' }, notice) : null,
        // 有搜索词时**只显示结果**（否则一屏里两套列表，谁也看不清）
        // 分组顺序 = 流程顺序：待你确认 → 已在用（含全局规范）→ 已归档（待复核是跨阶段提醒，放最前）
        searching_ ? searchBlock : [dueBlock, inboxBlock, standing, archiveBlock],
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
