/**
 * 真机预检 —— 必须在 **DSH profile 的 node_modules 里**运行，这样 `@deepseek-ai/*`
 * 才会解析到真实实现（而不是 test/stubs 里的桩）。
 *
 * 它验证的是桩测试覆盖不到的那部分：真实的 `defineTool` / `schemastery` 是否接受我们的定义。
 * 跑法（用 DSH 自带的 node）：
 *   <DSH_HOME>\.desktop-bin\node.cmd <profile>\node_modules\dsh-memory-delta\test\preflight-import.mjs
 *
 * ⚠️ 在 DSH 沙箱里跑时，默认的 store（插件目录下的 .preflight-store）在工作区之外，
 * 建目录会被拒（EPERM）。这时把 store 指到工作区/临时目录里：
 *   $env:MEM_PREFLIGHT_ROOT = 'D:\path\to\workspace\.preflight-store\memory'
 *
 * 退出码 0 = 预检通过；非 0 = 有问题，**此时不要把它加进 profile**。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push([ok, name, detail]);
  if (!ok) failed += 1;
}

// 必须用 fileURLToPath：`new URL(...).pathname` 会把非 ASCII 用户名百分号编码
// （C:\Users\李鹏飞 → C:\Users\%E6%9D%8E%E9%B9%8F%E9%A3%9E），路径就废了。
const here = fileURLToPath(new URL('.', import.meta.url));
const storeRoot = process.env.MEM_PREFLIGHT_ROOT || `${here}.preflight-store/memory`;

/**
 * 清掉本次预检写下的沙箱。
 *
 * ⚠️ 不能用 fs.rmSync：路径里有非 ASCII（用户名 C:\Users\李鹏飞\…）时它会**静默失败**
 * （甚至崩进程），这是本项目踩过的坑。逐项 unlinkSync / rmdirSync 才可靠。
 * 默认保留现场只有一种例外：跑之前设 MEM_PREFLIGHT_KEEP=1（排查失败原因时用）。
 */
function removeStore(root, errors = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return errors; // 不存在就算了
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      removeStore(full, errors); // 先清子目录
    } else {
      try {
        fs.unlinkSync(full);
      } catch (error) {
        errors.push(`${full}: ${error?.code ?? error?.message}`);
      }
    }
  }
  // ⚠️ 必须**后序**删除：先 rmdir 父目录会 ENOTEMPTY（第一版就是这么错的，实测踩到）
  try {
    fs.rmdirSync(root);
  } catch (error) {
    errors.push(`${root}: ${error?.code ?? error?.message}`);
  }
  return errors;
}

try {
  const mod = await import(new URL('../src/plugin.mjs', import.meta.url).href);
  check('插件模块可加载（真实 @deepseek-ai/* 全部解析成功）', true);
  check('导出 name = memory', mod.name === 'memory', String(mod.name));
  check('导出 inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject));
  check('导出 apply 是函数', typeof mod.apply === 'function');
  // 真实的 schemastery 返回的是 Schema 实例（自有键是 type/meta/toString/dict），
  // 所以要看它有没有把我们的字段解析进去，而不是看它像不像普通对象。
  const configKeys = mod.Config?.dict ? Object.keys(mod.Config.dict) : Object.keys(mod.Config ?? {});
  check(
    '真实 schemastery 解析出了 root/maxBytes/enabled/dueWithin',
    ['root', 'maxBytes', 'enabled', 'dueWithin'].every((k) => configKeys.includes(k)),
    configKeys.join(','),
  );
  try {
    const normalized = typeof mod.Config === 'function' ? mod.Config({}) : null;
    check(
      'Config({}) 能取到默认值 maxBytes=3072 / dueWithin=0',
      !normalized || (normalized.maxBytes === 3072 && normalized.dueWithin === 0),
      JSON.stringify(normalized),
    );
  } catch (error) {
    check('Config({}) 不应抛异常', false, `${error?.name}: ${error?.message}`);
  }

  /* ---- 用假 ctx 真 apply，看真实 defineTool 是否接受我们的工具定义 ---- */
  const handlers = new Map();
  const registered = [];
  const warnings = [];
  const ctx = {
    on: (event, fn) => handlers.set(event, fn),
    tools: { register: (tool) => registered.push(tool) },
    logger: { warn: (...a) => warnings.push(String(a[0])) },
    get: () => undefined,
  };

  mod.apply(ctx, { root: storeRoot, maxBytes: 3072, enabled: true });

  check('真实 defineTool 接受了两个工具定义', registered.length === 2, registered.map((t) => t.name).join(','));
  check('注册了 agent/pre-step', typeof handlers.get('agent/pre-step') === 'function');
  for (const tool of registered) {
    check(`${tool.name} 有 name/description/parameters/execute`, !!tool.name && !!tool.description && !!tool.parameters && typeof tool.execute === 'function');
  }

  /* ---- 工具真的能读写（真实模块链路） ---- */
  const agent = {
    session: { header: { cwd: `${here}.preflight-store`, id: 'preflight' } },
    inbox: { nextStep: [], prepend() {}, replace() {}, remove() {} },
  };

  const writeTool = registered.find((t) => t.name === 'memory_write');
  const searchTool = registered.find((t) => t.name === 'memory_search');

  const written = await writeTool.execute(
    { type: 'fact', conclusion: '真机预检写入的条目', tags: ['preflight'], key: 'preflight-entry' },
    { agent },
  );
  check('memory_write 返回 id/status', !!written.id && written.status === 'inbox', JSON.stringify(written));

  const found = await searchTool.execute({ query: '真机预检' }, { agent });
  check('memory_search 找得到刚写的条目', found.total >= 1, JSON.stringify(found).slice(0, 160));

  /* ---- 工具输出契约：用**真实的** DSH 校验器验返回值 ----
   *
   * 这一步是 2026-09-21 真机翻车后补上的：`memory_search` 的 output.schema 漏声明了
   * `tags`/`date`/`file`，而每条命中都带 `file` —— DSH 的
   * `ToolRuntime.createSuccessResult()` 会对返回值跑 `additionalProperties: false` 校验，
   * 不通过就 `throw ToolOutputError`，于是**只要有任何命中，整个工具调用就是一条错误**。
   *
   * 为什么原来没测出来：本文件只调 `execute()`，而校验发生在 runtime 层（execute 之外）；
   * 桩测试里的 `defineTool` 是 identity、更不校验。所以这里显式复刻 runtime 那一步 ——
   * 用的是**真的** `validateJsonSchemaValue`，和真机同一条代码路径。
   */
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
  const contract = (tool, value) => validateJsonSchemaValue(tool.output.schema, value, 'value');
  const writeViolations = contract(writeTool, written);
  check('memory_write 的返回值满足自己声明的 output.schema', writeViolations.length === 0, writeViolations.join('; '));
  const searchViolations = contract(searchTool, found);
  check('memory_search 的返回值满足自己声明的 output.schema', searchViolations.length === 0, searchViolations.join('; '));
  const missViolations = contract(searchTool, await searchTool.execute({ query: '绝对搜不到的词xyzzy' }, { agent }));
  check('memory_search 零命中时也满足 output.schema', missViolations.length === 0, missViolations.join('; '));
  check('校验器可用（不是空跑一场）', typeof validateJsonSchemaValue === 'function' && contract({ output: { schema: { type: 'object', additionalProperties: false, properties: {} } } }, { nope: 1 }).length === 1);

  const renderWrite = writeTool.output?.render?.({}, written);
  check('memory_write 的 render 可用', Array.isArray(renderWrite) && typeof renderWrite[0]?.text === 'string');
  const renderSearch = searchTool.output?.render?.({}, found);
  check('memory_search 的 render 可用', Array.isArray(renderSearch) && typeof renderSearch[0]?.text === 'string');

  /* ---- render 才是**模型可见**的那份文本 ----
   * `value` 到不了模型眼前：dsh-agent-loop 把 `result.content` 放进 tool/result 消息，
   * dsh-llm-deepseek 再 `flattenText(result.content)` 发给模型。
   * 曾经的 render 只有一句 `Matched N memory entries.` —— 调用不报错，模型却一条命中都拿不到。
   */
  const searchText = String(renderSearch[0]?.text ?? '');
  check('memory_search 的 render 真把命中交给了模型（含条目 id）', searchText.includes(written.id), searchText.slice(0, 240));
  check('memory_search 的 render 带片段与条目文件路径', /file: /.test(searchText) && searchText.length > 80, searchText.slice(0, 240));

  /* ---- 差分注入链路（真实模块 + 真 pre-step） ---- */
  const preStep = handlers.get('agent/pre-step');
  const step1Decision = { kind: 'ok', messages: [] };
  const out1 = await preStep({ agent: { ...agent, inbox: { nextStep: [], prepend(q, m) { this.nextStep.unshift(m); }, replace() {}, remove() {} } }, messages: [], step: 1 }, async () => step1Decision);
  check('pre-step 在 step 1 不打断 decision', out1 === step1Decision);
} catch (error) {
  check('预检未抛异常', false, `${error?.name}: ${error?.message}`);
}

console.log('\n=== 真机预检 ===');
for (const [ok, name, detail] of results) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}
console.log(`\n${results.length - failed} 通过 / ${failed} 失败`);

// 自己收拾现场：以前跑完不清理，会把沙箱留在安装副本里（profile 的 node_modules 越攒越脏）
if (process.env.MEM_PREFLIGHT_KEEP === '1') {
  console.log(`（MEM_PREFLIGHT_KEEP=1：保留现场 ${storeRoot}）`);
} else {
  const cleanupErrors = removeStore(process.env.MEM_PREFLIGHT_ROOT || `${here}.preflight-store`);
  console.log(cleanupErrors.length ? `⚠️ 清理沙箱时有 ${cleanupErrors.length} 项失败：${cleanupErrors.join('; ')}` : '已清理预检沙箱');
}

process.exit(failed ? 1 : 0);
