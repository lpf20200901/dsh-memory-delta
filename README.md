# dsh-memory-delta

English | [中文](README.zh.md)

**Layered, auto-injected cross-session memory for AI coding agents.**
A [DSH](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek Harness) plugin, plus a
zero-dependency standalone CLI. It borrows the *spec / change / archive* discipline from
[OpenSpec](https://github.com/Fission-AI/OpenSpec) — but **pushes** instead of pulls.

> **Canonical repository: [GitHub](https://github.com/lpf20200901/dsh-memory-delta)** ·
> [Gitee](https://gitee.com/xingluzhe/dsh-memory-delta) is a read-only mirror —
> please file issues and pull requests on GitHub.

> Status: **M1–M4 done**; M3/M4 (differential injection, both tools, the distillation nudge) were
> verified inside a real DSH session, and the M5 improvements below are covered by 695 assertions
> plus a real-machine preflight. See [Verification](#verification).

## Why

AI coding assistants have two recurring problems:

1. **A new session remembers nothing.** You re-explain the background, your preferences, and every
   conclusion you already reached.
2. **What does get remembered is unmanaged.** Everything piles into one or two Markdown files that grow
   without bound, cost more every session, and — worst of all — **stale conclusions are never removed.**

Existing spec-driven tools (OpenSpec and friends) solve "the code drifts away from the plan". But they
are **pull-based**: the agent has to be told to go read the specs, so a fresh session does not
spontaneously remember anything. dsh-memory-delta is **push-based**: at session start the agent is handed what
it should know — but only the *distilled* part, and only *what changed*. Details stay retrievable on demand.

## Design

```
        ┌─ PUSH: injected automatically at session start (hard byte budget)
        │    T0 identity & conventions   user preferences / machine facts / accounts
        │    T1 index & next actions     what to pick up
store ──┤
        └─ PULL: retrieved on demand (costs nothing by default)
             inbox/      candidate entries — **the only layer the model may write**
             facts/      current truth (only status=active is injected)
             decisions/  choices plus their reasons (append-only)
             archive/    superseded entries
             journal.md  activity log (never injected)
```

**Read the directory names along two axes** (this was unclear before — `facts` especially invites the wrong
guess: it is a *kind* of content, not a *stage* of the flow):

| Directory | Stage in the flow | What it holds | Who may write | Injected? |
| --- | --- | --- | --- | --- |
| `inbox/` | **candidate** (unconfirmed) | conclusions the model thinks are worth keeping | **only the model** (`memory_write`) | ❌ never |
| `facts/` | **standing** | conclusions about **the world** — falsifiable by reality (environment limits, tool behaviour, pitfalls) | **only the human** (promote) | ✅ every turn |
| `decisions/` | **standing** | **our own** conventions and trade-offs — they only expire when *we* change our mind | **only the human** (promote) | ✅ every turn |
| `archive/` | **archived** | superseded or expired entries | moved automatically on supersede | ❌ never (still searchable) |

The main flow: **the model may only write `inbox/` → the human promotes into `facts/` or `decisions/` →
superseded entries move to `archive/`**. Unsure which side an entry belongs to? Ask: **"if the world changes
tomorrow, does this stop being true?"** Yes → `facts/`; only *we* can invalidate it → `decisions/`.

> `mem init` writes the full explanation of these four directories (plus `journal.md` / `index.md` /
> `memory.config.json`) into the store's **own** `README.md` — open the memory directory and it is right there.

Seven rules:

- **The pushed part must be tiny.** Everything in the injected layer is paid for on every session, so the
  journal and design docs stay out of it. Measured on a real store (6 entries): **953 bytes** total, 68% of
  it the entry lines themselves, ~300 bytes of framing — about **159 bytes per entry**, so the 3 KB default
  budget holds ~19 entries. Entry ids are deliberately **not** written into the text (they ride along in the
  message's structured `source.entries`); inlining them used to eat 34% of the budget.
- **Only the delta is pushed.** Every entry carries a 12-char content hash; the plugin remembers the
  previous round's state and next round pushes only *added / updated / removed*. When nothing changed it
  injects **nothing at all**. (The upstream `dsh-agent-instructions` plugin has no diffing: any file
  change re-injects the whole file — measured at ~58k wasted tokens for 15 edits of one 8.5 KB file.)
- **State is recovered from the conversation itself.** No side-car state file: the plugin reads back the
  `{id: hash}` map from the message it previously injected, so session resume, replay and compaction all
  stay correct.
- **The model may only write to the inbox.** A wrong conclusion that silently reaches the standing layer
  gets **re-injected forever**. Promotion is an explicit `promote`.
- **One key, one truth.** Facts and decisions carry a semantic `key`, and only one *active* entry may
  exist per `scope+key`. A new conclusion must explicitly `--supersedes` the old one — that gate is what
  keeps memory rot out of the injected layer.
- **Entries have state**: `active` / `superseded` / `expired`. Superseded entries get bidirectional links
  and are archived, never appended forever.
- **Plain Markdown + frontmatter**: human-readable, diffable, reviewable, committable like code.

## Install (as a DSH plugin)

⚠️ This section is the result of real trial and error — both wrong turns below are silent failures:

```text
❌ Adding the package to package.json's dsh.profile.bundles
   → DSH regenerates that list from the market registry (.generations/desired.json) at boot;
     entries it does not know about are dropped.

❌ Writing a bare entry in cordis.patch.yml
   → silently ignored (a patch entry only targets an existing id for config/disable).

✅ Wrapping it in `- insert:` inside cordis.patch.yml
```

**Steps** (`DSH_HOME` is usually `%APPDATA%\dsh-desktop\harness`):

1. Copy this package into the profile's `node_modules`:

   ```
   <DSH_HOME>\profiles\web\node_modules\dsh-memory-delta\
       package.json
       bin\mem.mjs
       src\plugin.mjs  src\hook.mjs  src\planner.mjs
   ```

2. Append to `<DSH_HOME>\profiles\web\cordis.patch.yml`:

   ```yaml
   - insert:
       - id: dsh-memory-delta
         name: dsh-memory-delta
         config:
           root: ''              # empty = <session cwd>/memory
           maxBytes: 3072        # byte budget for the baseline injection
           enabled: true
           dueWithin: 0          # remind this many days before verify_when (0 = only when due)
           panel: true           # the memory tab's state/action routes
           allowWrite: true      # let panel buttons write the store (promote / rename)
   ```

3. Save. The patch layer is watched (`watchUserPatches`) — it **hot-reloads, no restart needed**.

**Uninstall**: remove that `- insert:` block and delete `node_modules\dsh-memory-delta`.

> The market/registry publishing flow was not investigated yet; the above is the local install path.

### What the plugin provides

| Capability | Detail |
| --- | --- |
| **Differential injection** | First round injects every active entry (baseline); afterwards only *added / updated / removed*; **nothing at all** when unchanged |
| `memory_search` | Relevance-ranked search across facts / decisions / inbox / archive / journal / session index. Field weights (key/id > tags > conclusion > body), a whole-phrase bonus, and Chinese matched by **bigram** so a query like `沙箱禁管道` hits `沙箱禁止命名管道` without spaces. Each hit carries a score and a snippet from its best-matching line |
| `memory_write` | Record a candidate into the inbox — **the model cannot touch the standing layer** |
| Distillation nudge | Once a session has run a few steps and memory is already current, it reminds the model to record conclusions with `memory_write`; one nudge per session, and the nudge message carries **no state**, so it cannot corrupt the diff baseline |
| Due-for-review reminder | `verify_when` is no longer a dead field: when an entry reaches its review date, the session is told once — "this conclusion may be stale, re-check it" — with the exact command to supersede or expire it. Prose values (`等换机器时`) never trigger it, so the reminder can always be resolved; it fires only on a step that injects nothing else, and it carries **no state** either |
| Sidebar memory tab | With [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) installed, a **记忆** tab lists collapsible groups (a drawn caret, so it is obvious they open), the standing entries, the due-for-review items and the inbox candidates, plus the current injection size and a **search box** (searches entries *and* the journal, Chinese run-together queries included — it is the **same scoring** as `mem recall` and the model's `memory_search`). **Clicking an entry opens its `.md`** through better-sidebar's official `openFile` (preview/edit in the sidebar editor). Groups are viewable by **type** (facts/decisions) or by **tag** (each entry's first tag). The client half is a **hand-written, zero-build browser bundle** (a `window.__ModuleLoader__.load({id, factory})` wrapper, no bundler); its data comes from this plugin's own read-only `POST /dsh-memory-delta/state` and `POST /dsh-memory-delta/search` routes — loopback-only, JSON in / JSON out, reading nothing but the memory store. The one route that *writes* is `POST /dsh-memory-delta/action` (inbox promote / safe rename, below); turn it off with `allowWrite: false` |
| Why editing/deleting memory is *not* built into the panel | The sidebar already ships an editor (opening an entry is enough) and a file tree with confirmed rename/delete. Re-implementing full CRUD in the panel would be duplication plus a permanent maintenance tax, so the panel offers **entry points** plus **the two actions that genuinely need human judgement**: open file, **one-click promote** of an inbox candidate (the human-confirmation step finally has a UI) and **tidy the file name** (`mem rename`: id + file name + references together). **Pure "jump to the folder" buttons are deliberately not built** — a caret to expand plus clicking an entry for detail is enough, and an extra button only adds noise plus a route that launches an external process. ⚠️ Do **not** rename memory entries through the file tree — the `id` lives in the frontmatter and must match the file name, or `mem validate` reports `id 与文件名不一致`; that is exactly why renaming is a dedicated safe operation instead of free-form editing |

The plugin never spawns the CLI: the DSH sandbox forbids named pipes (capturing a child's output fails
with EPERM), and there is no need — it imports the same store module directly (`bin/mem.mjs` only runs
the CLI when executed as the entry point). It also never *requires* the sidebar: `webServer` is read
through `ctx.get('webServer')` (an optional capability), so a headless or CLI-only composition loads the
plugin unchanged and simply skips the panel route.

![The 记忆 tab in the sidebar](assets/sidebar-memory-tab.png)

<sub>The **记忆** tab, opened from the sidebar's `+` menu: collapsible groups (the monospace text after a
title is the directory on disk), standing entries with their keys/tags/dates/file names, the
due-for-review section, the inbox candidates, and how many bytes the current store costs per session.
**Clicking an entry opens it in the editor** — the panel itself never writes to the store; the only
writes are the two inbox buttons (promote / tidy file name).</sub>

## CLI usage

```bash
# init (defaults to <cwd>/memory; override with --root or $DSH_MEMORY_ROOT)
mem init --root ./memory --scope "workspace:/path/to/project"

# record a candidate (lands in inbox, never injected)
#   --id  prefer an explicit short id; otherwise derived from the conclusion (capped at 20 chars)
#   --key semantic key: only one active truth per scope+key
mem new --type fact --id win-update-cache --key disk-cleanup \
        --conclusion "Cleaning the update cache reclaimed nothing measurable" \
        --reason "Directory emptied but free space did not move" --tags windows,disk --source session-abc
# with --key but no --id, the key *is* the id (and the file name): sandbox-no-pipe.md
# without a key the id falls back to "<date>-<truncated conclusion>" — prefer giving a key

# promote it once confirmed; when the key already has an active entry you must say who supersedes whom
mem promote win-update-cache
mem promote win-update-cache-v2 --supersedes win-update-cache

mem set <id> --key k --tags a,b --conclusion "…"   # edit an entry (add a key, reword, mark expired)
mem rename <old-id> <new-id>   # safe rename: frontmatter id + file name + supersedes refs together
                               # (never rename through the file tree — id must match the file name)
mem list --status active --tag windows
mem show <id>
mem validate [--fix]   # format / ids / bidirectional links / cycles / same-key conflicts / index / budget
mem index              # rebuild index.md
mem inject [--json] [--budget 3072]   # render what should be injected; --json adds per-entry hashes
mem recall <keywords> [--where all|facts|decisions|inbox|archive|journal|sessions|index] [--limit N] [--json]
                       # relevance-ranked: Chinese is matched by bigram, no spaces needed
mem due [--within N] [--json]   # entries whose verify_when is due (--within N also warns N days ahead)
mem journal add "one line"
```

`verify_when` takes either a date (`2027-03-01`) or a relative phrase measured from the entry's own
date (`3个月后`, `2周后`, `立即`); anything else is treated as prose and simply never auto-fires.

## Verification

Checked item by item inside a real DSH session:

| Capability | Live evidence |
| --- | --- |
| baseline injection | the session received every active entry |
| no change → zero injection | the next step injected nothing, only the one-time nudge |
| delta · added | "新增：<new entry>", explicitly noting "the other N entries are unchanged" |
| delta · updated | after editing one entry, only "已更新：<that entry>" was pushed |
| due-for-review reminder | adding an entry whose `verify_when` was 16 days overdue produced a one-time `form='due'` reminder on the next no-change step, and the step after it injected nothing (the reminder did not reset the diff baseline) |
| sidebar **记忆** tab | the tab opened on a live store and showed the real root, "常驻 12 条", "注入 1792 / 3072 字节", the facts/decisions split and the (empty) inbox |
| `memory_search` / `memory_write` | both called successfully in the real runtime |
| writes land only in the inbox | the written candidate did **not** enter the injection payload; it appeared as a delta only after promotion |

## Development

```bash
npm test        # 695 assertions, zero dependencies
```

| Suite | Assertions | Covers |
| --- | --- | --- |
| `test/run-tests.mjs` | 147 | CLI end-to-end (incl. a non-ASCII path regression, ranked recall, `mem due`, `mem rename` with reference sync, key-as-file-name) |
| `test/planner-tests.mjs` | 43 | the diff algorithm (pure logic) |
| `test/search-tests.mjs` | 51 | tokenizing / scoring / snippet selection (pure logic) |
| `test/due-tests.mjs` | 93 | `verify_when` parsing (dates, relative phrases, prose) and due collection (pure logic) |
| `test/hook-tests.mjs` | 63 | plugin wiring (fake agent / decision): diff injection, nudge, due reminder |
| `test/plugin-tests.mjs` | 181 | plugin integration (stubbed DSH modules, real `apply()` + both tools + both panel routes + promote/rename actually writing the store + whitelist/origin checks) |
| `test/client-tests.mjs` | 117 | the sidebar panel bundle (fake React + fake `fetch`: grouping/collapse, entry click → `openFile`, promote/tidy, failure states) |

`test/plugin-tests.mjs` replaces the four `@deepseek-ai/*` packages with the stubs in `test/stubs/`
(via `test/stub-loader.mjs`) and **actually `apply()`s the plugin**, so its behaviour is verifiable
without a DSH installation. `test/preflight-import.mjs` goes one step further: run it from inside a
profile and it exercises the **real** `@deepseek-ai/*` modules (does the real `defineTool` accept our
tool definitions, does the real `schemastery` accept our config schema).

Regression tests baked in from real bugs:

- With a **non-ASCII** path, Node's `fs.rmSync` fails **silently** (and can crash the process with
  `recursive`) — `unlinkSync` must be used instead;
- The DSH sandbox forbids named pipes, so `spawnSync` with the default `stdio: 'pipe'` hits EPERM —
  tests must redirect child output to a **file**;
- An entry written by the tool must carry the **session workspace** scope, not the harness process cwd;
- `new URL(import.meta.url).pathname` **percent-encodes a non-ASCII user name**
  (`C:\Users\李鹏飞` → `C:\Users\%E6%9D%8E%E9%B9%8F%E9%A3%9E`), which turns "write into my plugin folder"
  into "write into a path that does not exist" — always use `fileURLToPath`;
- A field added to *some* early-return paths of an internal planner function (`due`) was destructured
  into `undefined` and threw on every step, which the outer `try/catch` silently reported as
  "failed to load memory" — hence the defensive read and the zero-warning assertion.

## Roadmap

- **M1 ✅** CLI + structured entries + validate + index/injection budget
- **M2 ✅** explicit short ids, semantic keys and "one key one truth", `inject --json` diff payload,
  `validate --fix`, `mem set`
- **M3 ✅** DSH plugin: differential injection + both tools + the distillation nudge (verified live)
- **M4 ✅** published (GitHub primary / Gitee mirror)
- **M5 ✅** the memory got *usable at scale*: index-style injection (id-free text, ~159 bytes per
  entry), relevance-ranked search with Chinese bigrams, and `verify_when` turned into a real
  due-for-review reminder
- **Next** keep the store small as it grows; publish to npm

## Prior art & acknowledgements

The **spec / change / archive** discipline — a human-readable *current truth*, plus a staged change set
that gets archived once it lands — is borrowed from [OpenSpec](https://github.com/Fission-AI/OpenSpec)
(MIT).

dsh-memory-delta is an **independent implementation**: it contains and calls no OpenSpec code, its store
format and CLI are its own, and the direction is inverted — memory is **pushed** into the session instead
of the agent being told to **pull** it.

"OpenSpec" is its authors' name/trademark; the mentions here are attribution only, and imply no
affiliation with or endorsement by that project.

## License

MIT
