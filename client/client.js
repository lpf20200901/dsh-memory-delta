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
.dsh-memory-delta-section { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18)); padding-top: 8px; }
.dsh-memory-delta-section > summary {
  cursor: pointer;
  list-style: none;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.dsh-memory-delta-section > summary::-webkit-details-marker { display: none; }
.dsh-memory-delta-due {
  border: 1px solid var(--dsw-alias-state-warn-primary, rgba(178,106,0,.4));
  border-radius: 6px;
  padding: 6px 8px;
}
.dsh-memory-delta-due-line { display: flex; gap: 6px; align-items: baseline; margin-top: 4px; }
.dsh-memory-delta-due-line:first-of-type { margin-top: 0; }
.dsh-memory-delta-flag { white-space: nowrap; font-weight: 600; }
.dsh-memory-delta-item { margin-top: 4px; }
.dsh-memory-delta-line { word-break: break-word; }
.dsh-memory-delta-verify { margin-left: 10px; }
.dsh-memory-delta-empty { padding: 2px 0; }
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

    function item(key, line, tail) {
      return h(
        'div',
        { className: 'dsh-memory-delta-item', key },
        h('div', { className: 'dsh-memory-delta-line' }, line),
        tail || null,
      );
    }

    /**
     * 分节。
     *
     * @param slug 磁盘上的**文件夹名**（`facts` / `decisions` / `inbox`），显示在中文标题后面，
     *   让用户能把界面上的分组和记忆库里的目录对上号。没有对应目录的分组传 null。
     */
    function section(key, title, count, children, slug) {
      return h(
        'details',
        { className: 'dsh-memory-delta-section', key, open: true },
        h(
          'summary',
          null,
          title,
          slug ? h('span', { className: 'dsh-memory-delta-dim dsh-memory-delta-slug' }, `（${slug}）`) : null,
          h('span', { className: 'dsh-memory-delta-dim' }, `（${count}）`),
        ),
        children,
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

      const head = h(
        'div',
        { className: 'dsh-memory-delta-head' },
        h('span', { className: 'dsh-memory-delta-title' }, '记忆'),
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
      const dueBlock = h(
        'div',
        { className: dueList.length ? 'dsh-memory-delta-section dsh-memory-delta-due' : 'dsh-memory-delta-section' },
        h(
          'div',
          { className: 'dsh-memory-delta-title' },
          '待复核',
          h('span', { className: 'dsh-memory-delta-dim' }, `（${dueList.length}）`),
        ),
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
      const facts = entries.filter((e) => e.type === 'fact');
      const decisions = entries.filter((e) => e.type === 'decision');
      const other = entries.filter((e) => e.type !== 'fact' && e.type !== 'decision');
      const group = (key, title, list, slug) =>
        list.length
          ? section(
              key,
              title,
              list.length,
              list.map((e) =>
                item(
                  e.id,
                  h('span', null, e.line, e.key ? h('span', { className: 'dsh-memory-delta-dim' }, ` [${e.key}]`) : null),
                ),
              ),
              slug,
            )
          : null;

      const standing = entries.length
        ? h(
            'div',
            null,
            group('facts', '事实', facts, 'facts'),
            group('decisions', '决策', decisions, 'decisions'),
            // 「其它」没有对应目录（type 不是 fact/decision 的条目仍放在两个有类型目录里），所以不给 slug
            group('other', '其它', other, null),
          )
        : h('div', { className: 'dsh-memory-delta-section' }, h('div', { className: 'dsh-memory-delta-muted dsh-memory-delta-empty' }, '还没有常驻记忆'));

      const inbox = Array.isArray(state.inbox) ? state.inbox : [];
      const inboxBlock = section(
        'inbox',
        '收件箱候选',
        typeof counts.inbox === 'number' ? counts.inbox : inbox.length,
        h(
          'div',
          null,
          h('div', { className: 'dsh-memory-delta-dim' }, '候选放在 inbox/ 目录；确认后才成为常驻记忆（promote 后写进 facts/ 或 decisions/ 才会被注入）。'),
          inbox.length === 0
            ? h(
                'div',
                { className: 'dsh-memory-delta-muted dsh-memory-delta-empty' },
                '还没有待确认的候选 —— 模型用 memory_write 写了结论才会出现在这里，空着是正常的',
              )
            : inbox.map((e) => item(e.id, e.line, h('div', { className: 'dsh-memory-delta-dim' }, `${e.type || '—'}${e.date ? ` · ${e.date}` : ''}`))),
        ),
        'inbox',
      );

      return h('div', { className: 'dsh-memory-delta-tab' }, head, statusRow, dueBlock, standing, inboxBlock);
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
          component: MemoryPanel,
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
