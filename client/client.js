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
    const { useState, useEffect, useCallback, useRef } = React;
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
  /* 四个维度按钮 + 标题 + 刷新，侧栏很窄时会挤到一行放不下 → 允许换行，
     不要让"日期"被压出可视区（宁可换行，也不要横着溢出） */
  flex-wrap: wrap;
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
/* 子主题：缩进一格 + 左侧竖线，一眼看出它是挂在上面那个父主题下面的（两级主题用）
   ⚠️ 只改**缩进与描边**，不改字号/颜色 —— 层级靠位置表达，别再靠小字注释 */
.dsh-memory-delta-section.is-child { margin-left: 12px; padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28)); }
.dsh-memory-delta-section.is-child .dsh-memory-delta-section-title { font-weight: 500; }
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
/* 主题（人指定的归纳）与 tags（关键词）**视觉上必须能分开**：
   主题是"这条属于哪一堆"，所以给它边框 + 主色，别让两者看着一样 */
.dsh-memory-delta-tag.is-topic {
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45));
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-memory-delta-file {
  margin-top: 1px;
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #8c8c8c);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 截断在 JS 里做（tailOf）：CSS 的 direction: rtl 会在 RTL 段落里按 bidi 规则重排数字开头的名字 */
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
/* 检索被截断的说明：和普通提示同一块风格（顶部留一点间距，接在命中列表后面） */
.dsh-memory-delta-trunc { margin-top: 3px; }
/* 搜索框：一行占满，和分组头同一层的视觉重量 */
/* 超预算告警：不是一行红字，而是一块"说人话"的告警（超了什么 / 为什么 / 怎么办）
   ⚠️ 底色**不铺**：主题里 state-warn-secondary 是实心琥珀，铺上去后正文（浅色）几乎看不清
   （实测截图发现的）。改成"透明底 + 描边 + 左侧粗 accent + 彩色标题"，深浅主题都读得清。 */
.dsh-memory-delta-over {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 9px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-state-warn-primary, rgba(178,106,0,.55));
  border-left-width: 3px;
  background: transparent;
  color: inherit;
  line-height: 1.6;
}
.dsh-memory-delta-over-title { font-weight: 600; color: var(--dsw-alias-state-warn-label, #b26a00); }
.dsh-memory-delta-over-fix { color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dsh-memory-delta-over-list { margin: 0; padding-left: 16px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
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
/* 「整理文件名」与「归类」的内联输入行：都是"让人自己填一个值"的小动作，
/* 勾选框：批量操作的入口。缩到最小、别抢注意力，但要一直看得见（否则不知道能选） */
.dsh-memory-delta-check {
  flex: none;
  width: 12px;
  height: 12px;
  margin: 0 2px 0 0;
  accent-color: var(--dsw-alias-brand-primary, #4a7dff);
  cursor: pointer;
}
/* 分组头下面那条小工具条（选本组 / 改主题名 / 搜这组）：一行、可换行、低调 */
.dsh-memory-delta-groupbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 2px 0 3px;
}
/* 批量工具条：勾选后出现，粘在顶部（滚动时也能操作） */
.dsh-memory-delta-batch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  margin: 2px 0 4px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06));
  font-size: 11px;
}
.dsh-memory-delta-batch-count { font-weight: 600; margin-right: 2px; }
/* 「整理文件名」与「归类」的内联输入行：都是"让人自己填一个值"的小动作，
   共用同一套样式（两者都刻意**不猜**：猜错文件名会改全库引用，猜错主题会造出同义主题） */
.dsh-memory-delta-rename,
.dsh-memory-delta-topic { display: flex; gap: 4px; margin-top: 3px; }
.dsh-memory-delta-rename > input,
.dsh-memory-delta-topic > input {
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
    function requestSearch(query, workspace, topic) {
      const payload = { query };
      if (workspace) payload.workspace = workspace;
      // 主题筛选：只在这个主题里搜（分组头的「搜这组」）
      if (topic) payload.topic = topic;
      return fetch(SEARCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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
     * 「未归类 / 未加标签 / 没有日期」这三个**哨兵值**。
     *
     * 分组用的是"拿一个字符串当 Map 键"，取值函数没拿到就退回哨兵。哨兵必须**不可能撞上真实取值**：
     * 以前直接写字面量 `'__untopic__'`，那样库里只要真有一条主题叫这个名字就会被并进"未归类"。
     * 用 `\u0000` 前缀（frontmatter 里不可能出现）从根上排除，宿主侧 `normalizeTopic` 也拒收。
     */
    const NO_TOPIC = '\u0000untopic';
    const NO_TAG = '\u0000untagged';
    const NO_DATE = '\u0000nodate';

    /**
     * 归档层的**默认分类**：条目没写 `category` 时按"为什么退场"落进哪一类。
     *
     * 与宿主的 `ARCHIVE_CATEGORY_DEFAULT` 必须一致（真正会用到的值由宿主在 payload 里算好 ——
     * 客户端这份只是渲染兜底：万一字段缺失也不至于显示成空白）。
     */
    const ARCHIVE_CATEGORY_DEFAULT = { superseded: '已蒸馏', expired: '已过期' };
    const ARCHIVE_CATEGORY_OTHER = '其它退场';
    /** 归档确认里给的**快捷分类**：默认第一项（已过期）—— "不再适用"是归档最常见的理由。 */
    const ARCHIVE_PRESET_CATEGORIES = ['已过期', '已蒸馏'];

    /**
     * 归档层的**分类 → 小主题 → 条目**三层（用户 2026-09-23 定的结构）：
     *
     *   已归档 → 「已过期 / 已蒸馏 / 你自建的」→ 小主题（这条记忆原本的 topic，可无）→ 条目
     *
     * 为什么分两层而不是像别的阶段那样只按一个维度分：归档条目已经不影响模型了，
     * 这时最有用的两个问题依次是"它为什么退场"（决定还能不能取回、值不值得看）
     * 和"它讲的是什么话题"（在那堆里找具体一条）。挤成一层就只能回答其中一个。
     */
    const archiveCategoryOf = (e) => {
      const own = e && typeof e.category === 'string' ? e.category.trim() : '';
      if (own) return own;
      const byStatus = ARCHIVE_CATEGORY_DEFAULT[e && e.status];
      return byStatus || ARCHIVE_CATEGORY_OTHER;
    };

    /**
     * **子主题**：主题名里带分隔符就是两级（`DSH 插件开发/面板` → 父 `DSH 插件开发` + 子 `面板`）。
     *
     * 为什么用"约定分隔符"而不是加一个字段：主题是**人**手填的字符串（CLI `--topic` / 面板归类），
     * 加字段就要同时改存储、CLI、面板、迁移脚本四处；而分隔符只影响**显示**，
     * 旧数据（不带分隔符）自动就是"只有一级" —— 零迁移、零兼容负担。
     */
    const TOPIC_SEP = /[\/／›]/;
    const splitTopic = (topic) => {
      const t = typeof topic === 'string' ? topic.trim() : '';
      if (!t) return { parent: null, child: null };
      const parts = t.split(TOPIC_SEP).map((s) => s.trim()).filter(Boolean);
      if (parts.length <= 1) return { parent: parts[0] ?? t, child: null };
      return { parent: parts[0], child: parts.slice(1).join(' / ') };
    };

    /**
     * 长路径从**开头**截断，保留尾部（`D:\…\memory\archive\a-very-long-id.md`）。
     *
     * 为什么不用 CSS 的 `direction: rtl` 那套技巧：在 RTL 段落里，bidi 规则会把
     * `2026-09-23-xxx` 这种数字开头的名字**重排**（行首的日期被搬到行尾），显示出来是错的名字。
     * 所以在 JS 里按字符数截，`…` 手动补 —— 显示长度可控，也不受 bidi 影响。
     */
    const tailOf = (s, max = 46) => {
      const str = String(s == null ? '' : s);
      if (str.length <= max) return str;
      return `…${str.slice(str.length - (max - 1))}`;
    };

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
          // 勾选框：批量操作的入口。自己挡住冒泡（否则点勾选会打开文件），
          // 用 `onChange` 而不是 `onClick` 切换（受控 checkbox 点一下会同时触发两者 → 会被切换两次）
          opts.select
            ? h('input', {
                type: 'checkbox',
                className: 'dsh-memory-delta-check',
                checked: Boolean(opts.select.checked),
                'aria-label': '选择这条',
                onClick: (ev) => {
                  if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
                },
                onChange: () => opts.select.onToggle(),
              })
            : null,
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
            // 主题只在"没按主题分组"时显示 —— 那时分组头就是主题，再标一遍是纯噪音
            opts.showTopic && e.topic ? h('span', { className: 'dsh-memory-delta-tag is-topic', title: `主题：${e.topic}` }, String(e.topic)) : null,
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
        // 路径长时截**开头**（tailOf）而不是靠 CSS 的 ellipsis：尾部才是可辨识的 id/文件名。
        // title 永远给完整路径 —— 截断只是显示层的事，别让人为了看全路径去翻文件树。
        file ? h('div', { className: 'dsh-memory-delta-file', title: file }, tailOf(file)) : null,
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

      /**
       * 会话切了工作区（或页签被宿主复用）时，`props.scope.cwd` 会变，而 `workspace` 是
       * `useState(cwd)` **只取一次**的旧值 —— 上面那条 effect 只依赖 `workspace`，
       * 所以它永远不会因为 cwd 变化而重跑：面板会一直显示（并用它发起写请求）**旧库**。
       * 审计给了 better-sidebar 复用页签实例的源码证据（key 是静态串、scope 来自当前活动会话）。
       * 这里补一条：cwd 变了就跟着换，换了自然触发上面那条 effect 重新拉。
       */
      useEffect(() => {
        if (cwd && cwd !== workspace) setWorkspace(cwd);
      }, [cwd]);

      const onRefresh = () => load(workspace);

      /**
       * 折叠状态：**由我们持有**，默认全展开。
       *
       * 之前用 `<details open>`：`open` 是受控属性，任何一次重渲染（比如点刷新）都会
       * 把用户刚收起来的分组重新弹开，而且原生 marker 又被样式藏了 ——
       * 结果是"看不出能点、点了也记不住"。
       */
      // 「全局规范」与「已归档」默认**折叠**：前者是工作区外的整篇指令文件（展开会把面板淹掉、
      // 也可能把里面的个人信息带进截图）；后者是已经退场的旧结论 —— 它们不再发给模型，
      // 界面上只需要"知道有多少、需要时点开"，默认摊开会把真正在用的 15 条挤到看不见。
      const [collapsed, setCollapsed] = useState({ 'stage:global': true, 'stage:archive': true });
      /**
       * 归纳维度：**三个阶段共用**（待你确认 / 已在用 / 已归档 都跟随它）。
       *
       * 默认 `topic`（主题）—— 主题是**人**指定的归纳（`mem set --topic` / 面板「归类」），
       * 因为类型只回答"该放哪边"，标签又被书写习惯带偏（实测库里 27 条有 21 条的 tags[0]
       * 是 dsh / dsh-memory / dsh-memory-delta 三个几乎同义的桶），只有主题真的把条目**归纳到一起**。
       */
      const [groupBy, setGroupBy] = useState('topic');
      /**
       * 归档层的分组维度。
       *
       * 归档层**也跟随头部的 主题/类型/标签/日期**（用户要求"选主题时归档也按主题分"），
       * 而"主题"这一档在归档层用的是 `archiveTopicOf`：没写主题的按退场原因落到
       * 「已蒸馏」/「已过期」，写了的用你给的主题 —— 所以**你可以在「已归档」下自建大主题**。
       */
      const archiveDimension = () => (groupBy === 'topic' ? 'archive' : groupBy);
      const [topicing, setTopicing] = useState(null);
      /**
       * **勾选**（批量操作的入口）：`{ [id]: true }`。
       *
       * 为什么用勾选而不是"整组按钮"：用户要的两件事其实是同一件 ——
       * "按主题/类型/标签/日期成批处理"（选整组）与"挑出具体几条标记主题"（选部分）。
       * 勾选 + 一条批量工具条能同时满足，而且只有一套心智模型。
       */
      const [selected, setSelected] = useState({});
      /** 批量归类的行内输入（`{ value }`，null = 没打开）。 */
      const [batchTopic, setBatchTopic] = useState(null);
      /** 归档确认里选的分类（默认「已过期」，可改成预设里的另一个或自己写）。 */
      const [archiveCategoryInput, setArchiveCategoryInput] = useState(ARCHIVE_PRESET_CATEGORIES[0]);
      /** 「改归档分类」的行内输入：`{ id, value }`。 */
      const [categorizing, setCategorizing] = useState(null);
      /** 主题归类（分组头「改主题名」）：`{ from, value }`。 */
      const [renamingTopic, setRenamingTopic] = useState(null);
      /** 按主题搜：`null` = 不限主题。 */
      const [searchTopic, setSearchTopic] = useState(null);
      /** 上一次请求实际用的主题（`runSearch` 用它去重；不然切主题后同词会被当成重复请求跳过）。 */
      const [searchedTopic, setSearchedTopic] = useState(null);
      /**
       * 检索的去重键与请求序号。
       * ⚠️ 必须放 ref：用 state 会被**渲染闭包**卡住（防抖定时器持有旧闭包 → 同词发两次），
       * 而且去重键要能"失败后重置"（state 在 catch 里改要等下一次渲染才生效）。
       */
      const lastSearchKey = useRef(null);
      const searchSeq = useRef(0);
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
      /**
       * 收尾清 `pendingId`。**每个动作的最后一步都要走它**，包括 catch 那一支 ——
       * 以前是 `.then(() => setPendingId(null))` 逐处手写，漏一处那个按钮就永远停在"保存中…"
       * （而且 `pendingId` 只有一个槽位，`batch`/`topic` 互相同住一个变量，更容易串）。
       */
      const clearPending = () => setPendingId(null);
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
       * 跑一次检索。
       *
       * 三条时序纪律（审计 2026-09-23 实测出的三个毛病）：
       *   1. **去重键放 ref、且只在"真的发出去"时写**：以前读的是渲染闭包里的 `searchedQuery`，
       *      而防抖定时器持有旧闭包 → 输入后立刻回车会**同词发两次**；而且失败后仍算"搜过"，
       *      按回车再也发不出去（界面永远停在错误上，只能改字）。
       *   2. **请求带序号**：乱序返回时旧响应会把新结果覆盖掉（输入框写着 A、结果区是 B）。
       *   3. 主题筛选参与去重键：切主题要能重搜。
       */
      const runSearch = (raw, topicOverride) => {
        const q = String(raw ?? '').trim();
        if (!q) {
          setResults(null);
          setSearchedQuery(null);
          setSearchError(null);
          lastSearchKey.current = null;
          return;
        }
        // 主题筛选：`topicOverride` 是"刚点了搜这组"那一路传进来的新主题（状态还没生效，不能用闭包里的）
        const topic = topicOverride !== undefined ? topicOverride : searchTopic;
        const key = `${q}\u0000${topic ?? ''}`;
        if (key === lastSearchKey.current) return;
        const seq = searchSeq.current + 1;
        searchSeq.current = seq;
        lastSearchKey.current = key;
        setSearchedQuery(q);
        setSearchedTopic(topic);
        setSearching(true);
        requestSearch(q, actionWorkspace(), topic)
          .then((data) => {
            if (seq !== searchSeq.current) return; // 过期响应：更新的请求已经在路上，别覆盖
            setResults({
              total: data.total || 0,
              matches: Array.isArray(data.matches) ? data.matches : [],
              query: q,
              topic: data.topic ?? null,
              // 宿主早就在报这两个信号，以前客户端**直接丢掉** —— 于是"搜索结果 20"看起来就是全部
              truncated: data.truncated === true,
              lineDropped: Number(data.lineDropped) || 0,
            });
            setSearchError(null);
          })
          .catch((err) => {
            if (seq !== searchSeq.current) return;
            lastSearchKey.current = null; // 失败不算"搜过" → 再按回车能重试
            setResults(null);
            setSearchError(err && err.message ? err.message : String(err));
          })
          .then(() => {
            if (seq === searchSeq.current) setSearching(false);
          });
      };

      // 输入停顿 200ms 自动搜（回车立即搜）：不轮询、不每次按键都砸一遍磁盘。
      // 主题筛选也进依赖：切主题就该重搜一次（否则界面显示的是上一个主题的结果）。
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
      }, [query, searchTopic]);

      /** 确认条上的动词（"要<动词>这条？"）。 */
      const CONFIRM_VERB = { demote: '撤回', archive: '归档', restore: '取回', remove: '删除' };

      /** 用户点了「确认 X」之后，按 op 分派到对应动作（危险动作只有这一个出口）。 */
      const runConfirmed = (op, id) => {
        if (op === 'remove') return removeCandidate(id);
        if (op === 'demote') return demote(id);
        if (op === 'archive') return archive(id, archiveCategoryInput);
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
       * 只挡冒泡、**绝不动默认行为** —— 包着输入框的容器与输入框自己的按键事件必须用这个。
       *
       * ⚠️ 真机踩到（用户 2026-09-22："改主题名只能追加、数字加不进去"）：
       * 这里原来用的是 `stop()`（它顺手 `preventDefault()`），而 keydown 的**默认行为就是"把字符插进输入框"**——
       * 于是直接键入的数字/退格全被吃掉；中文反而能进去（输入法上屏走的是合成事件，不是 keydown 的默认行为）。
       * 表现就是"能追加中文、打不了数字、也删不掉预填的旧名字"。**输入框上的按键处理器只能用 halt。**
       */
      const halt = (ev) => {
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
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
          .then(() => clearPending());
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
          .then(() => clearPending());
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
          .then(() => clearPending());
      };

      /** **归档**：不再适用又没有替代 → archive/（区别于"取代"）。 */
      const archive = (id, category) => {
        setConfirming(null);
        setPendingId(id);
        return callAction(category ? { op: 'archive', id, category } : { op: 'archive', id })
          .then((r) => {
            setActionError(null);
            setNotice(`已归档 ${r.id}（${r.status}｜分类「${r.category || archiveCategoryOf(r)}」）：不再发给模型，但搜得到、也能取回`);
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`归档失败：${err && err.message ? err.message : String(err)}`);
          })
          .then(() => clearPending());
      };

      /** 改**归档分类**（「已归档 → 已蒸馏/已过期/其它」那一层）。只对归档里的条目有效。 */
      const setCategory = (id, category) => {
        setPendingId(id);
        return callAction({ op: 'category', id, category })
          .then((r) => {
            setCategorizing(null);
            setActionError(null);
            setNotice(`已把 ${r.id} 归到「${r.category}」`);
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`改归档分类失败：${err && err.message ? err.message : String(err)}`);
          })
          .then(() => clearPending());
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
          .then(() => clearPending());
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
          .then(() => clearPending());
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
              // 每次打开确认条都把分类**重置回默认**（上次给别人选过「已蒸馏」不该带到这一条）
              setArchiveCategoryInput(ARCHIVE_PRESET_CATEGORIES[0]);
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
              // 归档时**选分类**（「已归档」下的第一层）—— 用户在确认条里就定好，不用事后补
              confirming.op === 'archive'
                ? h(
                    'div',
                    { className: 'dsh-memory-delta-topic', key: 'cat' },
                    ...ARCHIVE_PRESET_CATEGORIES.map((cat) =>
                      h(
                        'button',
                        {
                          type: 'button',
                          key: `cat:${cat}`,
                          className: archiveCategoryInput === cat ? 'dsh-memory-delta-mini is-on' : 'dsh-memory-delta-mini',
                          onClick: (ev) => {
                            stop(ev);
                            setArchiveCategoryInput(cat);
                          },
                        },
                        cat,
                      ),
                    ),
                    h('input', {
                      value: archiveCategoryInput && !ARCHIVE_PRESET_CATEGORIES.includes(archiveCategoryInput) ? archiveCategoryInput : '',
                      placeholder: '或自己写一个分类',
                      'aria-label': '归档分类',
                      onChange: (ev) => setArchiveCategoryInput(ev && ev.target ? ev.target.value : ''),
                      onKeyDown: (ev) => halt(ev),
                    }),
                  )
                : null,
            )
          : null;

      /** 展开的内联改名输入行。 */
      const renameRow = (e) =>
        renaming && renaming.id === e.id
          ? h(
              'div',
              { className: 'dsh-memory-delta-rename', key: `${e.id}:rename`, onClick: halt },
              h('input', {
                value: renaming.value,
                placeholder: '新文件名（字母/数字/._-，建议用语义键）',
                'aria-label': '新文件名',
                onChange: (ev) => setRenaming({ id: e.id, value: ev && ev.target ? ev.target.value : '' }),
                onKeyDown: (ev) => {
                  halt(ev);
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

      /* ------------------------------------------------------- 归档分类 */
      /**
       * 归档条目上的「分类」按钮 + 行内输入。
       *
       * 作用范围**只有归档层**（`setArchiveCategory` 在宿主侧也会拒绝非归档条目）：
       * 分类回答的是"它为什么退场"，常驻条目还没退场，不该被问这个问题 ——
       * 否则它就会变成第二个 topic 字段。
       */
      const startCategory = (e) => {
        setConfirming(null);
        setRenaming(null);
        setTopicing(null);
        setCategorizing((prev) => (prev && prev.id === e.id ? null : { id: e.id, value: archiveCategoryOf(e) }));
      };

      const categoryButton = (e) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-memory-delta-mini',
            disabled: pendingId === e.id,
            title: `改归档分类（现在是「${archiveCategoryOf(e)}」）—— 它决定这条排在「已归档」下的哪一类`,
            onClick: (ev) => {
              stop(ev);
              startCategory(e);
            },
          },
          '分类',
        );

      const categoryRow = (e) =>
        categorizing && categorizing.id === e.id
          ? h(
              'div',
              { className: 'dsh-memory-delta-topic', key: `${e.id}:category`, onClick: halt },
              h('input', {
                value: categorizing.value,
                list: 'dsh-memory-delta-category-options',
                placeholder: '归档分类，例如 已过期 / 已蒸馏',
                'aria-label': '归档分类',
                onChange: (ev) => setCategorizing({ id: e.id, value: ev && ev.target ? ev.target.value : '' }),
                onKeyDown: (ev) => {
                  halt(ev);
                  if (ev && ev.key === 'Enter') setCategory(e.id, categorizing.value);
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
                    setCategory(e.id, categorizing.value);
                  },
                },
                pendingId === e.id ? '保存中…' : '保存',
              ),
            )
          : null;

      /* ---------------------------------------------------------------- 归类 */
      // 主题是**人**的归纳（模型不写它），所以只给一个内联输入 —— 复用「整理文件名」那套交互，
      // 不造完整 CRUD：点「归类」→ 填一个主题名（已有主题做候选）→ 保存。
      const startTopic = (e) => {
        setConfirming(null);
        setRenaming(null);
        setTopicing((prev) => (prev && prev.id === e.id ? null : { id: e.id, value: typeof e.topic === 'string' ? e.topic : '' }));
      };

      const doTopic = (id, topic) => {
        setPendingId(id);
        return callAction({ op: 'topic', id, topic: String(topic || '') })
          .then((r) => {
            setTopicing(null);
            setActionError(null);
            setNotice(r.topic ? `已归类 ${r.id} → 「${r.topic}」` : `已清除 ${r.id} 的主题（回到「未归类」）`);
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`归类失败：${err && err.message ? err.message : String(err)}`);
          })
          .then(() => clearPending());
      };

      /** 条目行上的「归类」按钮（三种阶段都有 —— 归档层恰恰是最需要归纳的那一层）。 */
      const topicButton = (e) =>
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-memory-delta-mini',
            disabled: pendingId === e.id,
            title: e.topic ? `改主题（现在是「${e.topic}」）` : '归类：给这条指定一个主题（面板按主题归纳）',
            onClick: (ev) => {
              stop(ev);
              startTopic(e);
            },
          },
          e.topic ? '改主题' : '归类',
        );

      /** 展开的内联「归类」输入行；`datalist` 给的是**库里已有的主题**，避免同义主题越写越多。 */
      const topicRow = (e) =>
        topicing && topicing.id === e.id
          ? h(
              'div',
              { className: 'dsh-memory-delta-topic', key: `${e.id}:topic`, onClick: halt },
              h('input', {
                value: topicing.value,
                list: 'dsh-memory-delta-topic-options',
                placeholder: '主题名，例如 DSH 插件开发（留空 = 未归类）',
                'aria-label': '主题',
                onChange: (ev) => setTopicing({ id: e.id, value: ev && ev.target ? ev.target.value : '' }),
                onKeyDown: (ev) => {
                  halt(ev);
                  if (ev && ev.key === 'Enter') doTopic(e.id, topicing.value);
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
                    doTopic(e.id, topicing.value);
                  },
                },
                pendingId === e.id ? '保存中…' : '保存',
              ),
            )
          : null;

      /* ------------------------------------------------------------ 勾选与批量 */

      /** 原始勾选（可能含已经不存在的 id —— 见 `activeSelection`）。 */
      /**
       * 这条在哪个阶段（批量按钮据此判断"这个动作对整批都成立吗"）。
       *
       * ⚠️ 找不到时必须回 `null`，**不能兜底成 `standing`**：勾选是"跨阶段"的（可以勾一部分候选
       * 再勾一部分常驻），而列表随时会变（刷新后条目可能已经被别处提升/归档）。旧代码兜底成
       * `standing`，于是"只在常驻条目上成立"的动作对一个其实已经不在列表里的 id 也判定可用 ——
       * 点了整批失败、原因还看不懂。现在认不出来就一律不可用。
       */
      const layerOfId = (id) => {
        if ((Array.isArray(state && state.inbox) ? state.inbox : []).some((e) => e && e.id === id)) return 'inbox';
        if ((Array.isArray(state && state.archive) ? state.archive : []).some((e) => e && e.id === id)) return 'archive';
        if ((Array.isArray(state && state.entries) ? state.entries : []).some((e) => e && e.id === id)) return 'standing';
        return null;
      };

      /**
       * 当前界面上真实存在的条目 id 集合（三个阶段合起来）。
       *
       * 勾选状态是**跨视图存活**的（切维度、切阶段、刷新都不清），所以它会残留：
       * 勾了 A 与 B，刷新后 B 已经被别处提升走了 —— 这时候批量工具条还写着"已选 2 条"，
       * 而实际只有 1 条可执行。改成"只把还看得见的算进选中"。
       *
       * ⚠️ 必须在**声明处就能读**：`selectedIds` / `activeSelection` / `layerOfId` 都是
       * 渲染期直接求值的 `const`，放到文件后面会踩 TDZ（`Cannot access before initialization`）。
       */
      const visibleIds = new Set(
        (state
          ? [
              ...(Array.isArray(state.entries) ? state.entries : []),
              ...(Array.isArray(state.inbox) ? state.inbox : []),
              ...(Array.isArray(state.archive) ? state.archive : []),
            ]
          : []
        )
          .map((e) => (e && typeof e.id === 'string' ? e.id : null))
          .filter(Boolean),
      );

      const selectedIds = Object.keys(selected).filter((id) => selected[id]);
      /**
       * **真正参与批量**的选中项：剔除界面上已经没有的 id。
       *
       * 勾选状态跨视图存活（切维度、切阶段、刷新都不清），所以它会残留：勾了 A 与 B，
       * 刷新后 B 已被别处提升走 —— 只报"已选 2 条"、拿 2 条去提交，就会出现
       * "成功 1 条、失败 1 条：找不到条目"这种用户没做错什么的失败。
       */
      const activeSelection = selectedIds.filter((id) => visibleIds.has(id));
      const isSelected = (id) => Boolean(selected[id]);
      const toggleSelected = (id) =>
        setSelected((prev) => {
          const next = { ...prev };
          if (next[id]) delete next[id];
          else next[id] = true;
          return next;
        });
      /** 整组勾选 / 取消（分组头与批量条都用它）。 */
      const setSelection = (ids, on) =>
        setSelected((prev) => {
          const next = { ...prev };
          for (const id of ids) {
            if (on) next[id] = true;
            else delete next[id];
          }
          return next;
        });
      const clearSelection = () => setSelected({});

      /** 批量动作的中文动词（回执与确认条共用）。 */
      const BATCH_VERB = { promote: '提升', demote: '撤回', archive: '归档', restore: '取回', remove: '删除候选', topic: '归类' };

      /**
       * 跑一批动作 —— 宿主侧是 `applyBatch`（逐个复用单条实现）。
       *
       * ⚠️ **部分失败必须说出来**：批量提升时撞上"同一个 key 已有 active"的那几条会失败，
       * 只说"完成"会让人以为全都成功了（"点了没反应"是最难查的体验）。
       */
      const runBatch = (action, ids, extra) => {
        if (!ids.length) return Promise.resolve();
        setPendingId('__batch__');
        return callAction({ op: 'batch', action, ids, ...extra })
          .then((r) => {
            clearSelection();
            setBatchTopic(null);
            setConfirming(null);
            const okCount = Array.isArray(r.succeeded) ? r.succeeded.length : 0;
            const failed = Array.isArray(r.failed) ? r.failed : [];
            if (failed.length) {
              const head = failed.slice(0, 3).map((f) => `${f.id}：${f.error}`).join('；');
              setNotice(null);
              setActionError(`批量${BATCH_VERB[action] || action}：成功 ${okCount} 条、失败 ${failed.length} 条 —— ${head}${failed.length > 3 ? `；其余 ${failed.length - 3} 条同类原因` : ''}`);
            } else {
              setActionError(null);
              setNotice(`批量${BATCH_VERB[action] || action}：${okCount} 条完成`);
            }
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`批量${BATCH_VERB[action] || action}失败：${err && err.message ? err.message : String(err)}`);
          })
          .then(() => clearPending());
      };

      /** 批量工具条上的按钮：`stage` 限定只在选中的条目都属于该阶段时可用。 */
      const batchButton = (action, label, stage, extra) => {
        // ⚠️ 用 `activeSelection`（已剔除界面上不存在的 id）而不是 `selectedIds`：
        // 残留的 id 会让"整批都属于某阶段"的判断失败，于是**所有**按钮都灰着，
        // 而界面上明明显示"已选 1 条"（2026-09-23 测试现场抓到）。
        const ids = activeSelection;
        const ok = ids.length > 0 && (!stage || ids.every((id) => layerOfId(id) === stage));
        const danger = action === 'remove' || action === 'archive';
        return h(
          'button',
          {
            type: 'button',
            className: danger ? 'dsh-memory-delta-mini is-danger' : 'dsh-memory-delta-mini',
            disabled: !ok || pendingId === '__batch__',
            title: ok ? undefined : stage === 'inbox' ? '只有候选能做这个（选中的条目里混了别的阶段）' : stage === 'standing' ? '只有常驻条目能做这个' : stage === 'archive' ? '只有归档条目能做这个' : undefined,
            onClick: (ev) => {
              stop(ev);
              if (!ok) return;
              // 危险动作（归档 / 删除）走行内确认；提升本来就是"人确认"那一步，直接执行
              if (action === 'demote' || action === 'archive' || action === 'restore' || action === 'remove') {
                setConfirming({ batch: { action, ids, extra }, label: `${label} ${ids.length} 条`, hint: '' });
                return;
              }
              runBatch(action, ids, extra);
            },
          },
          label,
        );
      };

      /* ------------------------------------------------------------ 主题改名 / 按主题搜 */

      const doRenameTopic = (from, to) => {
        const value = String(to || '').trim();
        if (!value) {
          setActionError('改主题名：新名字不能为空');
          return Promise.resolve();
        }
        setPendingId('__topic__');
        return callAction({ op: 'topic-rename', from, to: value })
          .then((r) => {
            setRenamingTopic(null);
            setActionError(null);
            setNotice(`主题「${r.from}」→「${r.to}」（改了 ${r.changed} 条，含归档层里同名的）`);
            load(workspace);
          })
          .catch((err) => {
            setNotice(null);
            setActionError(`改主题名失败：${err && err.message ? err.message : String(err)}`);
          })
          .then(() => clearPending());
      };

      /** 在某个主题里搜：切到搜索视图并带上主题筛选（输入框里的词保留）。 */
      const searchInTopic = (topic) => {
        setSearchTopic(topic);
        const q = query.trim();
        if (q) runSearch(q, topic);
      };

      const head = h(
        'div',
        { className: 'dsh-memory-delta-head' },
        h('span', { className: 'dsh-memory-delta-title' }, '记忆'),
        h(
          'span',
          { className: 'dsh-memory-delta-seg' },
          // 顺序即推荐顺序：主题（真正把条目归纳到一起）→ 类型 → 标签 → 日期。
          // 四档都**作用于三个阶段**（待你确认 / 已在用 / 已归档）。
          // 不再有"退场原因"档位（用户 2026-09-23 反馈：不需要）：归档层的主题视角本来就
          // 是「已蒸馏」/「已过期」+ 你自建的主题，见 `archiveTopicOf`。
          h(
            'button',
            { type: 'button', className: groupBy === 'topic' ? 'is-on' : undefined, onClick: () => setGroupBy('topic'), title: '按主题分组（你指定的归纳：没归类的落在「未归类」；主题名里写 `父/子` 就是两级。归档层默认落在「已蒸馏」/「已过期」，也可以自己归类到别的主题）' },
            '主题',
          ),
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
          h(
            'button',
            {
              type: 'button',
              className: groupBy === 'date' ? 'is-on' : undefined,
              onClick: () => setGroupBy('date'),
              title: '按记录日期分组（同一天的归一组，新的在前）',
            },
            '日期',
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

      // ⚠️ 这几个"计数"必须在 `head` **之前**求值：头部要用 archiveCount 决定"退场原因"按钮出不出
      //（放后面会踩 TDZ：`Cannot access 'archiveCount' before initialization` —— 渲染顺序就是求值顺序）。
      // 纯计算、无副作用。
      const counts = state.counts || {};
      const archiveCount = typeof counts.archive === 'number' ? counts.archive : 0;
      const archived = Array.isArray(state.archive) ? state.archive : [];

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

      /**
       * 超预算告警 —— 说清**超了什么 / 为什么有上限 / 怎么办**。
       *
       * 用户反馈："到时提醒明显些，说明白是什么超出了，为什么限制预算等等，别让使用者一脸懵。"
       * 所以这里不是一行红字，而是一块说人话的告警：
       *   · 超了什么：几条常驻、合计多少、超了多少
       *   · 为什么：这段**每轮会话都要发给模型**，是持续成本（顺带换算成 token 量级）
       *   · 怎么办：三个可执行动作（归档/撤回、结论首行写短、调大 maxBytes）
       *   · 还要说清"不会丢东西" —— 否则用户会以为条目被截掉了
       */
      const overBudgetNotice = over
        ? h(
            'div',
            { className: 'dsh-memory-delta-over' },
            h(
              'div',
              { className: 'dsh-memory-delta-over-title' },
              `⚠ 注入已超预算：${counts.active || 0} 条常驻合计 ${bytes} 字节，上限 ${budget} 字节（超 ${bytes - budget}）`,
            ),
            h(
              'div',
              null,
              '这段内容每一轮会话都会发给模型，所以设了上限 —— 大约 1000 字节 ≈ 300~400 tokens/轮，超了就是每轮都多花。',
            ),
            h('div', null, '不会丢东西：注入不会截断，条目一条都不会少（超了只是每轮更贵）。'),
            h('div', { className: 'dsh-memory-delta-over-fix' }, '怎么办：'),
            h(
              'ul',
              { className: 'dsh-memory-delta-over-list' },
              h('li', null, '把不再需要的「归档」或「撤回」—— 就在下面各组条目上'),
              h('li', null, '把条目的结论首行写短：注入只取首行 + key，正文写多长都不花预算'),
              h('li', null, '确实每条都要：把插件配置 maxBytes 调大（如 4096）'),
            ),
          )
        : null;

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

      /* ------------------------------------------------------------ 归纳维度
         四个维度：**主题**（人指定的归纳，默认）/ 类型（该放哪边）/ 标签 / 日期（什么时候记的）。

         ⚠️ 这些分组以前只作用于「已在用」，于是「待你确认」和「已归档」是两坨平铺的列表
         （用户 2026-09-22 反馈："待我确认和已归档没有跟着类型/标签、日期进行归纳"）——
         尤其归档层（实测 27 条里 21 条在归档）平铺起来最乱。现在**三个阶段共用这一份实现**。 */

      /** 库里已有的主题（给「归类」输入做候选，避免同义主题越写越多）。 */
      const KNOWN_TOPICS = [
        ...new Set(
          [...(Array.isArray(state.entries) ? state.entries : []), ...(Array.isArray(state.inbox) ? state.inbox : []), ...(Array.isArray(state.archive) ? state.archive : [])]
            .map((e) => (e && typeof e.topic === 'string' && e.topic ? e.topic : null))
            .filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b));

      /** 库里已经用过的归档分类（给「分类」输入做候选；默认那两个由常量补上）。 */
      const KNOWN_CATEGORIES = [
        ...new Set(
          (Array.isArray(state.archive) ? state.archive : [])
            .map((e) => (e && typeof e.category === 'string' && e.category ? e.category : null))
            .filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b));

      /**
       * 按记录日期分组用的日期人话（今天 / 昨天 / 前天 / 周几）——
       * 比一串 ISO 日期好读，且**用 state.today 算差**，不靠浏览器本地时区猜。
       */
      const TODAY = typeof state.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.today) ? state.today : null;
      const dayLabel = (day) => {
        if (day === NO_DATE) return '没有日期';
        if (!TODAY) return day;
        const diff = (Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000;
        if (diff === 0) return `${day}（今天）`;
        if (diff === 1) return `${day}（昨天）`;
        if (diff === 2) return `${day}（前天）`;
        const week = '日一二三四五六'[new Date(`${day}T00:00:00Z`).getUTCDay()];
        return diff > 0 ? `${day}（周${week}）` : `${day}（未来）`;
      };

      /** 按"取值函数"分组：命名组按条数降序（大头在前），未命名的组**永远放最后**。 */
      const bucket = (list, pick, { missingKey, missingTitle, missingHint, hint, namedHint }) => {
        const map = new Map();
        for (const e of list) {
          const k = pick(e) || missingKey;
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(e);
        }
        const named = [...map.entries()].filter(([k]) => k !== missingKey);
        named.sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
        const groups = named.map(([k, l]) => ({ key: k, title: String(k), hint: namedHint || hint, list: l }));
        const missing = map.get(missingKey);
        if (missing) groups.push({ key: missingKey, title: missingTitle, hint: missingHint, list: missing });
        return groups;
      };

      /**
       * 当前维度下的子分组 —— **三个阶段共用**。
       *
       * ⚠️ 分组头里的 `slug`（`（facts）` 这种磁盘目录名）与 hint 必须**按层**给：
       * `facts/` 只对「已在用」才是这条条目真正住的地方；候选住在 `inbox/`，
       * 给它标个 `（facts）` 会让人以为文件在那儿（写测试时真踩到）。
       */
      const subGroups = (list, dimension, layer) => {
        if (dimension === 'topic') {
          // **两级主题**：父主题（`DSH 插件开发`）下面挂子主题（`面板`）。
          // 没写分隔符的主题直接就是"只有一级"，不额外包一层（避免给老数据加噪音层级）。
          const byParent = new Map();
          for (const e of list) {
            const { parent, child } = splitTopic(e.topic);
            const p = parent || NO_TOPIC;
            if (!byParent.has(p)) byParent.set(p, []);
            byParent.get(p).push({ e, child });
          }
          const named = [...byParent.entries()].filter(([k]) => k !== NO_TOPIC);
          named.sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
          const out = [];
          for (const [p, items] of named) {
            const children = [...new Set(items.map((i) => i.child).filter(Boolean))].sort();
            if (children.length === 0) {
              // 父主题自身没有子主题 → 就是一条普通分组（老数据走这条）
              out.push({ key: p, title: p, hint: '按主题（你指定的归纳）', list: items.map((i) => i.e) });
              continue;
            }
            // 有子主题：父主题**始终**出一条分组（装"没再分小主题"的那部分），
            // 子主题再跟在后面 —— 这样"父主题"这一层的条数（含子）在分组头上看得出来，
            // 而点父主题能拿到它自己那几条。父组没有自己的条目时不占位置。
            const noChild = items.filter((i) => !i.child).map((i) => i.e);
            if (noChild.length) out.push({ key: p, title: p, hint: '这个主题下没再分小主题的条目', list: noChild });
            for (const c of children) {
              const sub = items.filter((i) => i.child === c).map((i) => i.e);
              out.push({ key: `${p}/${c}`, title: c, parent: p, hint: '子主题', list: sub });
            }
          }
          const missing = byParent.get(NO_TOPIC);
          if (missing) {
            out.push({
              key: NO_TOPIC,
              title: '未归类',
              hint: '还没归纳 · 在条目上点「归类」填一个主题名；想要两级就写 `父主题/子主题`',
              list: missing.map((i) => i.e),
            });
          }
          return out;
        }
        if (dimension === 'archive') {
          // **归档层的三层结构**（分类 → 小主题 → 条目）：
          //   分类 = `category`（人写的）或按 status 推的默认（已蒸馏 / 已过期）
          //   小主题 = 这条记忆原本的 `topic`（可选，支持 `父/子` 两级）
          // 分类这一层**始终出分组头**（哪怕只有一类），否则用户看不到"这条为什么在这"；
          // 小主题只在确实分了类时才出，避免每条都套一层空壳。
          const byCategory = new Map();
          for (const e of list) {
            const cat = archiveCategoryOf(e);
            if (!byCategory.has(cat)) byCategory.set(cat, []);
            byCategory.get(cat).push(e);
          }
          const cats = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
          const out = [];
          for (const [cat, items] of cats) {
            const hint =
              cat === ARCHIVE_CATEGORY_DEFAULT.superseded
                ? '结论已经搬进文档、或被新版本顶上 —— 留着只为留个出处'
                : cat === ARCHIVE_CATEGORY_DEFAULT.expired
                  ? '不再适用又没有替代 —— 结论作废，原因写在条目正文里'
                  : '你给的归档分类';
            // 分类下再按 topic 分（没有 topic 的直接挂在分类下，不额外造一层）
            const withTopic = items.filter((e) => typeof e.topic === 'string' && e.topic.trim());
            if (!withTopic.length) {
              out.push({ key: cat, title: cat, hint, list: items });
              continue;
            }
            const plain = items.filter((e) => !(typeof e.topic === 'string' && e.topic.trim()));
            if (plain.length) out.push({ key: cat, title: cat, hint, list: plain });
            const topicMap = new Map();
            for (const e of withTopic) {
              const t = e.topic.trim();
              if (!topicMap.has(t)) topicMap.set(t, []);
              topicMap.get(t).push(e);
            }
            for (const [t, sub] of [...topicMap.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
              out.push({ key: `${cat}\u0000${t}`, title: t, parent: cat, hint: `「${cat}」下的小主题`, list: sub });
            }
          }
          return out;
        }
        if (dimension === 'tag') {
          return bucket(list, (e) => (Array.isArray(e.tags) && e.tags.length ? String(e.tags[0]) : ''), {
            missingKey: NO_TAG,
            missingTitle: '未加标签',
            missingHint: '这条没有 tags',
            namedHint: '按第一个标签',
          });
        }
        if (dimension === 'date') {
          return bucket(list, (e) => (typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : ''), {
            missingKey: NO_DATE,
            missingTitle: '没有日期',
            missingHint: '条目没写 date',
            namedHint: '按记录日期',
          }).map((g) => ({ ...g, title: dayLabel(g.key) }))
            .sort((a, b) => (a.key === NO_DATE ? 1 : b.key === NO_DATE ? -1 : b.key.localeCompare(a.key)));
        }
        // 类型：事实 / 决策 / 其它。目录名（slug）与说明都按层给 —— 见函数头的注释
        const real = layer === 'standing';
        const typeHints =
          layer === 'standing'
            ? { facts: '踩过的坑 & 绕开的方法', decisions: '你定下的约定', other: 'type 未识别' }
            : layer === 'inbox'
              ? { facts: '提升后进 facts/', decisions: '提升后进 decisions/', other: 'type 未识别' }
              : { facts: '归档的事实', decisions: '归档的决策', other: 'type 未识别' };
        const facts = list.filter((e) => e.type === 'fact');
        const decisions = list.filter((e) => e.type === 'decision');
        const other = list.filter((e) => e.type !== 'fact' && e.type !== 'decision');
        return [
          { key: 'facts', title: '事实', slug: real ? 'facts' : null, hint: typeHints.facts, list: facts },
          { key: 'decisions', title: '决策', slug: real ? 'decisions' : null, hint: typeHints.decisions, list: decisions },
          { key: 'other', title: '其它', slug: null, hint: typeHints.other, list: other },
        ].filter((g) => g.list.length);
      };

      /** 某一阶段的条目按钮组 —— 三个阶段各自的动作不一样（提升 / 撤回 / 取回…）。 */
      const actionsFor = (layer, e) => {
        const base = layer === 'inbox' ? [promoteButton(e)] : layer === 'archive' ? [restoreButton(e)] : [demoteButton(e), archiveButton(e)];
        // 「分类」只在归档层出现（它问的是"为什么退场"）
        return [...base, topicButton(e), layer === 'archive' ? categoryButton(e) : null, tidyButton(e), layer === 'inbox' ? removeButton(e) : null];
      };

      /**
       * 分组头下面那条小工具条：**选本组**（批量入口）+ 主题视图里的「改主题名」「搜这组」。
       *
       * 放在组体最前面而不是挤进分组头：分组头已经很满（标题/目录名/说明/条数），
       * 再塞三个按钮就会在窄侧栏里换行难看。
       */
      const groupBar = (layer, dimension, g) => {
        const ids = g.list.map((e) => e.id);
        const allOn = ids.length > 0 && ids.every(isSelected);
        const buttons = [
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-memory-delta-mini',
              onClick: (ev) => {
                stop(ev);
                setSelection(ids, !allOn);
              },
            },
            allOn ? `取消本组 ${ids.length} 条` : `选本组 ${ids.length} 条`,
          ),
        ];
        const isNamedTopic = dimension === 'topic' && g.key !== NO_TOPIC;
        if (isNamedTopic) {
          buttons.push(
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-memory-delta-mini',
                title: '改这个主题的名字（所有层里同名的条目一起改）',
                onClick: (ev) => {
                  stop(ev);
                  setRenamingTopic((prev) => (prev && prev.from === g.key ? null : { from: g.key, value: g.key }));
                },
              },
              '改主题名',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-memory-delta-mini',
                title: `只在这个主题里搜（${ids.length} 条）`,
                onClick: (ev) => {
                  stop(ev);
                  searchInTopic(g.key);
                },
              },
              '搜这组',
            ),
          );
        }
        const renaming = isNamedTopic && renamingTopic && renamingTopic.from === g.key;
        return h(
          'div',
          { className: 'dsh-memory-delta-groupbar', key: `${layer}:${dimension}:${g.key}:bar` },
          ...buttons,
          renaming
            ? h(
                'div',
                { className: 'dsh-memory-delta-topic', onClick: halt },
                h('input', {
                  value: renamingTopic.value,
                  list: 'dsh-memory-delta-topic-options',
                  placeholder: '新主题名',
                  'aria-label': '新主题名',
                  onChange: (ev) => setRenamingTopic({ from: g.key, value: ev && ev.target ? ev.target.value : '' }),
                  onKeyDown: (ev) => {
                    halt(ev);
                    if (ev && ev.key === 'Enter') doRenameTopic(g.key, renamingTopic.value);
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-memory-delta-mini',
                    disabled: pendingId === '__topic__',
                    onClick: (ev) => {
                      stop(ev);
                      doRenameTopic(g.key, renamingTopic.value);
                    },
                  },
                  pendingId === '__topic__' ? '改名中…' : '改名',
                ),
              )
            : null,
        );
      };

      /**
       * 渲染一个阶段的条目：按当前维度分子组。
       *
       * **只有一组时不出分组头** —— 那时"归纳"其实没发生，一个折叠头包着全部条目只是噪音
       * （「待你确认」经常只有两三条，套一层头更难看）。这条判据让三个阶段都能跟随维度，
       * 又不会在小列表上凭空多一层。
       */
      const groupedBody = (list, dimension, layer) => {
        const groups = subGroups(list, dimension, layer);
        const rowOf = (e) =>
          renderItem(e, {
            showType: dimension !== 'type',
            showTopic: dimension !== 'topic',
            actions: actionsFor(layer, e),
            extraRow: confirmRow(e) || renameRow(e) || topicRow(e) || categoryRow(e),
            // 勾选：三个阶段都能选，批量条按"选中的条目属于哪个阶段"决定按钮可用性
            select: { checked: isSelected(e.id), onToggle: () => toggleSelected(e.id) },
          });
        // ⚠️ **不再"单组就不出头"**：早期为了少一层折叠试过这个判据，结果真实数据上翻车 ——
        // 「待你确认」里两条候选没主题、第一个标签又相同 → 主题/标签/日期各只剩一组，
        // 于是界面上"只有类型看得出分组"（用户 2026-09-22 反馈的就是这个）。
        // 现在**每个阶段都照维度分组**，一致性优先；单组时那个头也顺带说明"这一组是什么"。
        return groups.map((g) => {
          // 子主题的 key 要带父主题前缀（不然 `面板` 这种子主题名会在别的父主题下撞 key，
          // 折叠状态是**按 key 存的**，撞了就会一起开合）
          const key = g.parent ? `${layer}:${dimension}:${g.parent}/${g.title}` : `${layer}:${dimension}:${g.key}`;
          const note = dimension === 'type' && layer === 'standing' && g.key === 'facts'
            ? '换个环境或换个版本，它可能就不成立了 —— 所以写清"什么情况下适用"最有价值。'
            : dimension === 'type' && layer === 'standing' && g.key === 'decisions'
              ? '业务/流程/口味上的决定：只有你改主意才会变 —— 记下"为什么这么定"，我就不会再问第二遍。'
              : null;
          return section(
            {
              key,
              title: g.parent ? `${g.parent} › ${g.title}` : g.title,
              slug: g.slug ?? null,
              count: g.list.length,
              hint: g.hint,
              // 子主题缩进一格，一眼看出层级
              className: g.parent ? 'is-child' : undefined,
              open: isOpen(key),
              onToggle: () => toggleSection(key),
            },
            [groupBar(layer, dimension, g)]
              .concat(note ? [h('div', { className: 'dsh-memory-delta-dim', key: 'note' }, note)] : [])
              .concat(byDateDesc(g.list).map(rowOf)),
          );
        });
      };

      /* -------------------------------------------------- 已在用（常驻层）
         阶段视角：这一层 = "每轮会话都会自动发给模型"的结论。
         类型（事实/决策）是**这一层内部**的子分组 —— 它回答的是"这条该放哪边"，
         不是"这条在流程哪一步"。以前把类型放在最外层，于是流程位置只能靠小字注释，
         结果是"一眼看不出是干啥的"（真实反馈）。 */
      /**
       * 面板有条数上限（常驻 200 / 候选 50 / 归档 50）。**超过时必须说出来** ——
       * 否则界面看着"库里就这么点东西"，而「取回」「归档」这些承诺在真实数据量下会静默失效
       * （审计 2026-09-23：流程条报的是真实总数，列表却只显示前 N 条，两边对不上还没提示）。
       *
       * ⚠️ 这两个函数必须定义在**用到它们的阶段块之前** —— 之前放在归档块后面，
       * 结果 `standing`/`inboxBlock` 先构造时报 `Cannot access 'omissionFor' before initialization`
       * （TDZ），面板直接变成"读取失败"。
       */
      const omitted = (total, shown, what, howTo) =>
        typeof total === 'number' && total > shown
          ? h('div', { className: 'dsh-memory-delta-note', key: `omitted:${what}` }, `还有 ${total - shown} 条${what}没列出来：${howTo}`)
          : null;

      /** 某个阶段的"省略提示"（放在该阶段的列表后面）。 */
      const omissionFor = (layer) => {
        if (layer === 'inbox') return omitted(typeof counts.inbox === 'number' ? counts.inbox : 0, inbox.length, '候选', '用搜索框搜，或在命令行 mem list --where inbox 看全量');
        if (layer === 'standing') return omitted(typeof counts.active === 'number' ? counts.active : 0, entries.length, '常驻条目', '用搜索框搜，或在命令行 mem list 看全量');
        return null;
      };

      const standingBody = groupedBody(entries, groupBy, 'standing');

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
            [globalBlock, workspaceRulesBlock].concat(standingBody).concat([omissionFor('standing')].filter(Boolean)),
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
            : [groupedBody(inbox, groupBy, 'inbox'), omissionFor('inbox')].filter(Boolean),
        ],
      );

      /* 归档层：以前只显示一个条数，现在**把条目列出来** —— 否则「取回」没有入口，
         用户会以为"记过、后来被取代了"的东西丢了（其实它还在，也能搜到）。
         `archiveCount` / `archived` 在上面统一定义（头部按钮要用，见 TDZ 注释）。 */
      const archiveBlock = section(
        {
          key: 'stage:archive',
          title: '已归档',
          slug: 'archive',
          count: archiveCount,
          // 默认**折叠**：退场的旧结论不再发给模型，界面上只需"知道多少条、需要时点开"
          hint: '已退场 · 不再发给模型，但搜得到、也能取回（点开看退场原因）',
          open: isOpen('stage:archive'),
          onToggle: () => toggleSection('stage:archive'),
        },
        [
          h(
            'div',
            { className: 'dsh-memory-delta-dim', key: 'note' },
            archiveCount === 0
              ? '还没有归档 —— 结论被取代（supersede）或不再适用（归档）时会搬到这里，不再发给模型'
              : '这些是退场的旧结论：不再发给模型，但仍在库里（可搜索）。点「取回」会把它放回「待你确认」，再确认一次才重新生效。' +
                '默认按**退场原因**分组（顶部点「主题/类型/标签/日期」它就跟着换，点「退场原因」切回来）。',
          ),
          ...(archived.length ? groupedBody(archived, archiveDimension(), 'archive') : []),
          archiveCount > archived.length
            ? h(
                'div',
                { className: 'dsh-memory-delta-note', key: 'more' },
                `还有 ${archiveCount - archived.length} 条归档没列出来（列表按日期**倒序**，所以缺的是更老的）：` +
                  '用搜索框搜它们（归档层能被搜到），或在命令行按 id `mem restore <id>` 取回。',
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
        h('span', { className: 'dsh-memory-delta-flow-now' }, `已在用 ${typeof counts.active === 'number' ? counts.active : entries.length}`),
        ' → ',
        h('span', { className: 'dsh-memory-delta-flow-dim' }, `已归档 ${archiveCount}`),
      );

      /* --------------------------------------------------------- 批量操作条 */

      /**
       * 勾选之后出现的批量工具条。
       *
       * 按钮**按阶段的合法性启用**：选中的条目必须全属于该动作要求的阶段（比如"提升"要求全是候选），
       * 混选时按钮禁用并在 title 里说明原因 —— 比"点了报错"友好，也比"静默只处理一部分"诚实。
       * 危险动作（撤回/归档/取回/删除）走**行内确认条**（和单条一样，不用 window.confirm）。
       */
      const batchBar = activeSelection.length
        ? (() => {
            const batch = confirming && confirming.batch ? confirming.batch : null;
            const inner = batch
              ? [
                  h('span', { className: 'dsh-memory-delta-confirm-text', key: 'ask' }, `要批量${BATCH_VERB[batch.action] || batch.action}这 ${batch.ids.length} 条？${batch.hint || ''}`),
                  h(
                    'button',
                    {
                      type: 'button',
                      key: 'go',
                      className: batch.action === 'remove' || batch.action === 'archive' ? 'dsh-memory-delta-mini is-danger' : 'dsh-memory-delta-mini',
                      disabled: pendingId === '__batch__',
                      onClick: (ev) => {
                        stop(ev);
                        runBatch(batch.action, batch.ids, batch.extra);
                      },
                    },
                    `确认${BATCH_VERB[batch.action] || ''} ${batch.ids.length} 条`,
                  ),
                  h(
                    'button',
                    { type: 'button', key: 'cancel', className: 'dsh-memory-delta-mini', onClick: (ev) => { stop(ev); setConfirming(null); } },
                    '取消',
                  ),
                ]
              : [
                  h(
                    'button',
                    {
                      type: 'button',
                      key: 'topic',
                      className: 'dsh-memory-delta-mini',
                      disabled: pendingId === '__batch__',
                      title: '给选中的条目指定同一个主题（留空 = 取消归类）',
                      onClick: (ev) => {
                        stop(ev);
                        setBatchTopic((prev) => (prev ? null : { value: '' }));
                      },
                    },
                    '归类…',
                  ),
                  batchButton('promote', '提升', 'inbox'),
                  batchButton('demote', '撤回', 'standing'),
                  batchButton('archive', '归档', 'standing'),
                  batchButton('restore', '取回', 'archive'),
                  batchButton('remove', '删除候选', 'inbox'),
                  h(
                    'button',
                    { type: 'button', key: 'clear', className: 'dsh-memory-delta-mini', onClick: (ev) => { stop(ev); clearSelection(); } },
                    '清空勾选',
                  ),
                ];
            return h(
              'div',
              { className: 'dsh-memory-delta-batch' },
              h('span', { className: 'dsh-memory-delta-batch-count' }, `已选 ${activeSelection.length} 条`),
              ...inner,
              batchTopic
                ? h(
                    'div',
                    { className: 'dsh-memory-delta-topic', onClick: halt },
                    h('input', {
                      value: batchTopic.value,
                      list: 'dsh-memory-delta-topic-options',
                      placeholder: '主题名（留空 = 取消归类）',
                      'aria-label': '批量主题',
                      onChange: (ev) => setBatchTopic({ value: ev && ev.target ? ev.target.value : '' }),
                      onKeyDown: (ev) => {
                        halt(ev);
                        if (ev && ev.key === 'Enter') runBatch('topic', activeSelection, { topic: batchTopic.value });
                      },
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-memory-delta-mini',
                        disabled: pendingId === '__batch__',
                        onClick: (ev) => {
                          stop(ev);
                          runBatch('topic', activeSelection, { topic: batchTopic.value });
                        },
                      },
                      '保存归类',
                    ),
                  )
                : null,
            );
          })()
        : null;

      /* ------------------------------------------------------------ 搜索块 */
      const searching_ = query.trim().length > 0;
      const hits = results && Array.isArray(results.matches) ? results.matches : [];
      /**
       * 被截断的说明。
       *
       * 宿主一直在回 `truncated`（条数封顶）与 `lineDropped`（流水/会话索引被行级降权折叠），
       * 客户端以前**把它们全丢了** —— 于是"搜索结果 20"看起来就是全部，用户会以为"就这些"
       * （尤其流水层：命中被刻意封顶过，缺的往往正是最相关的那几条）。
       * 没有这个说明时，界面在"结果不全"这件事上是在撒谎。
       */
      const truncationNotice = () => {
        if (!results) return null;
        const parts = [];
        if (results.truncated && !results.lineDropped) parts.push(`命中太多，这里只列了相关度最高的 ${hits.length} 条（共 ${results.total} 条）`);
        if (results.lineDropped) parts.push(`另有 ${results.lineDropped} 条流水/会话索引命中被降权折叠`);
        if (!parts.length) return null;
        return h(
          'div',
          { className: 'dsh-memory-delta-note dsh-memory-delta-trunc', key: 'trunc' },
          `${parts.join('；')} —— 换个更具体的词、或按主题搜（分组头的「搜这组」）能收窄；流水全量用 \`mem recall --where journal\`。`,
        );
      };
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
                searchTopic
                  ? `只在这个主题里搜：「${searchTopic}」—— 主题筛选只作用于条目，流水/会话索引没有主题所以不参与。`
                  : '在条目（facts/ decisions/ inbox/ archive）与流水里按相关度搜 —— 和 `mem recall`、模型用的 memory_search 是同一套打分。清空搜索框回到分组视图。',
              ),
              searchTopic
                ? h(
                    'div',
                    { className: 'dsh-memory-delta-groupbar', key: 'topic-filter' },
                    h('span', { className: 'dsh-memory-delta-tag is-topic' }, `主题：${searchTopic}`),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-memory-delta-mini',
                        onClick: (ev) => {
                          stop(ev);
                          setSearchTopic(null);
                        },
                      },
                      '取消主题筛选',
                    ),
                  )
                : null,
              searchError
                ? h('div', { className: 'dsh-memory-delta-error', key: 'err' }, `搜索失败：${searchError}`)
                : results && results.total === 0
                  ? h(
                      'div',
                      { className: 'dsh-memory-delta-muted dsh-memory-delta-empty', key: 'empty' },
                      searchTopic
                        ? `「${searchTopic}」里没有匹配 —— 换个说法，或点上面的「取消主题筛选」去全库搜`
                        : '没有匹配 —— 换个说法，或拆成几个关键词（中文连写会自动切 bigram，不用手动加空格）',
                    )
                  : hits.map((hit) =>
                      item(hit, { onOpen: openMemoryFile, showType: true, showWhere: true, showSnippet: true, actions: [] }),
                    ),
              // 截断说明放在命中列表**之后**：先给结果，再说"还有没列出来的"
              truncationNotice(),
            ],
          )
        : null;

      return h(
        'div',
        { className: 'dsh-memory-delta-tab' },
        head,
        searchRow,
        statusRow,
        overBudgetNotice,
        flow,
        batchBar,
        // 「归类」输入的候选 = 库里**已有**的主题（写新主题是允许的，只是别造同义词）
        KNOWN_TOPICS.length
          ? h(
              'datalist',
              { id: 'dsh-memory-delta-topic-options' },
              KNOWN_TOPICS.map((t) => h('option', { key: t, value: t })),
            )
          : null,
        // 「归档分类」的候选 = 两个默认 + 库里**已经用过**的分类（避免同义分类越写越多）
        h(
          'datalist',
          { id: 'dsh-memory-delta-category-options' },
          [...new Set([...ARCHIVE_PRESET_CATEGORIES, ...ARCHIVE_CATEGORY_OTHER ? [ARCHIVE_CATEGORY_OTHER] : [], ...KNOWN_CATEGORIES])].map((c) =>
            h('option', { key: c, value: c }),
          ),
        ),
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
