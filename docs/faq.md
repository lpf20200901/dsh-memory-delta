# FAQ

> The questions real users (including the author) get wrong most often, with what the plugin actually does and why.
> 中文版见 [faq.zh.md](faq.zh.md).

---

## 1. Injection: what gets sent, and when?

### Q: It says "injected automatically at session start" — so is the whole memory re-sent on **every turn**?

**No.** The plugin does **differential injection**:

| Turn | What the model actually receives |
| --- | --- |
| First turn of a session | the **full baseline**: the first line of every "in use" entry, plus a short framing paragraph |
| Every later turn | the diff only — **nothing at all when nothing changed**, otherwise just the entries that were added / updated / removed |

So the cost of a session is:

```
total injection ≈ baseline (once) + the changes that happened during the session
```

The `injection 4546 / 5000 bytes` figure in the sidebar is the **baseline size** — it answers
"what does starting a *new* session cost", not "what does every turn cost".

### Q: If nothing is injected when nothing changed, how does the model know the memory is still there?

Because **silence is the signal**: a turn with no memory message means every conclusion from the previous
turn is still valid. The plugin only speaks up when something **stops** being valid (an entry that was
superseded or archived is announced as "no longer valid, stop relying on it").

### Q: What happens when a store goes over budget? Do entries get dropped?

**Nothing is dropped.** Injection is **not truncated** — going over budget only costs those extra tokens per
session, and it is reported in three places: `mem inject`, `mem validate`, and an amber notice on the sidebar tab.

Fixes, cheapest first:

1. **Write shorter conclusion first lines** (only the first line is injected; the body costs nothing)
2. **Archive / withdraw** entries you no longer need
3. **Raise the budget** (`injectBudget` in `memory.config.json`, or `maxBytes` in the plugin config)

> ⚠️ There are **two** budget settings and the **plugin config wins**:
> `plugin maxBytes || store injectBudget || 3072`. Changing only the store value has no effect after a restart.

### Q: Why is there a limit at all?

Because the injected text is **standing context sent on every turn**, not a one-off. As a rule of thumb
**3 bytes ≈ 1 token**, so 3000 bytes ≈ 1000 tokens. The cap + the notices + archiving are how the store is
kept from growing without bound.

---

## 2. Stages and actions: what is the difference between archive, withdraw and supersede?

`awaiting confirmation (inbox) → in use (facts/decisions) → archived (archive)` is the **lifecycle**, not three copies.

| What you mean | Command | Effect |
| --- | --- | --- |
| "I accept this" | `mem promote <id>` (panel: promote) | inbox → facts/decisions, **injected from now on** |
| "Not true yet, but don't delete it" | `mem demote <id>` (panel: withdraw) | standing → inbox (**status unchanged**, promote it back later as-is) |
| "No longer applicable, nothing replaces it" | `mem archive <id>` (panel: archive) | → archive/, `status=expired`, **not injected, still searchable** |
| "There is a better statement of this" | `mem supersede <old> <new>` | bidirectional link + old marked `superseded` + moved to archive |
| "I archived that by mistake" | `mem restore <id>` (panel: restore) | archive → **inbox** (you confirm once more — it does not bypass human review) |
| "This candidate is worthless" | `mem rm <id>` (panel: delete) | **candidates only**; deleting a standing entry silently would lose it, so it is refused |

**Archive ≠ delete.** `mem recall` and the sidebar search still find archived entries; they are simply no
longer sent to the model every session.

### Q: What are all those categories and topics in the archived stage?

The archived stage reads in three levels:

```
archived
  已废弃 (20)        ← category: why it left. Three are always present (已蒸馏 / 已废弃 / 暂时不用; an empty one shows 0)
    · gitignore-…    ← entries with no topic are listed right under the category
    DSH 插件开发 (6)  ← topic rows: click one to reveal its entries
    开源与发布 (5)
  已蒸馏 (20)        ← superseded / distilled into the docs (set automatically, not hand-picked)
  暂时不用 (0)       ← not needed right now, but this workspace may want it again (restore → promote)
```

- **Category** (the `category` field) is *why it left*. Three defaults:
  `已蒸馏` (distilled into the docs / superseded), `已废弃` (useless for good),
  `暂时不用` (not needed right now, but another project or business need may want it back — the difference
  from `已废弃` is only "might it return"; both keep `status: expired`).
  When archiving (single or batch) you can pick one of them or **type a new one**.
- **Topic rows** are the entry's own `topic`. **Click one to see its entries** — the archive gives you a
  table of contents first instead of dumping dozens of rows. Topics have **one level**: same name, same group
  (a `/` inside a name is just an ordinary character — no parent/child splitting any more).
- To move an entry: the 分类 button on its row, or `mem set <id> --category "…"`.
- The old default name `已过期` (written by v1.2.x) is grouped as `已废弃` on both read and write, so no
  migration is required.

### Q: Why can only candidates be deleted?

A standing entry has probably been injected and referenced by other entries. Deleting it makes it vanish for
the model *and* for you at the same time — **silent loss**, the hardest class of problem to diagnose.
Standing entries therefore have exactly two exits: **withdraw** or **archive / supersede**, both reversible.

### Q: Why "one key, one truth"?

A `key` is the entry's semantic identity (`sandbox-no-pipe`). Two "in use" entries sharing a key would send the
model two contradictory sentences every turn — worse than not remembering it at all. Promotion therefore
refuses to collide, and you have to say explicitly that the new one replaces the old (`--supersedes`).

---

## 3. Does this duplicate DSH's built-in `AGENTS.md` injection?

No — different plugin, different source:

| | Owner | Injected | Differential? |
| --- | --- | --- | --- |
| `AGENTS.md` (global / workspace / `.local`) | DSH's own `dsh-agent-instructions` | the **whole file** | **No** — any edit re-injects all of it |
| this plugin | `dsh-memory-delta` | the "in use" entries of `<workspace>/memory` | **Yes** (see §1) |

The sidebar tab shows both (global instructions / workspace instructions) but each plugin owns its own
injection. This plugin deliberately does **not** implement a second global injection — that would create two
sources of global truth.

---

## 4. What may the model do?

Two tools only:

- `memory_write` — **writes to the inbox (candidates) only**, never promotes
- `memory_search` — retrieval over entries *and* the journal

It **cannot** promote / demote / archive / supersede. Those are human actions, because a wrong conclusion that
silently reaches the standing layer would be **injected on every turn** — far more expensive than asking once.

### Q: So who does the "distill knowledge into docs" step?

The human, in the loop. The usual rhythm:

1. A session produces something worth keeping → the model writes it to the inbox
2. You confirm → it becomes standing (and starts being injected)
3. Every so often (e.g. after a release) move the **"how to do it"** entries into docs / skills and archive them

Judgement rule: **only move something into a document if you would look it up yourself.** Once moved, stop
expecting it to come to you automatically.

---

## 5. One rule of thumb for keeping the store small

| Content | Where it belongs |
| --- | --- |
| **"I want to know this without looking it up"** — current conventions, accounts, environment facts, in-flight decisions | **the memory store ("in use")** — delivered automatically every session |
| **"I only need this when doing that kind of work, and I will look it up"** — pitfalls and how to avoid them, processes, checklists | **docs / skills** — loaded on demand, no per-session cost |

⚠️ Do not move **in-flight decisions** into docs: after the move the model no longer knows them automatically
while you still believe they are in force — that is silent failure.

---

## 6. Still curious?

- `mem init` writes a `README.md` into the store itself (never overwritten) explaining the three exits
- The sidebar tab has a lifecycle strip, an over-budget notice, and collapsible groups
- On the command line: `mem help`, or run any command without arguments to see its usage
