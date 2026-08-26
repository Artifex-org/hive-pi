# artifacts

The file is the ground truth. The message is a pointer.

## Why

A subagent finds something large — a 900KB build log, a full stack dump, a query that returned ten thousand rows — and today it has two bad options. Paste it, and the parent's context floods with text it did not ask for and mostly will not read. Summarise it, and the detail that gets dropped is exactly the detail somebody would later have wanted to grep.

oh-my-pi's `docs/blob-artifact-architecture.md` names the third option, which is our own doctrine made concrete: write the bytes to a file, hand back a reference, let the reader decide whether to open it.

## The shape

| | |
| --- | --- |
| `spill(body, {dir, kind, previewBytes})` | the producer side. Small bodies pass through untouched; large ones are written and replaced by a preview plus `artifact://<id>` |
| `artifact_read` | read one back, by reference. Optional `head`/`tail` line counts |
| `artifact_list` | the index: reference, kind, bytes, age. Reads no bodies |
| `adoptDir(from, to)` | copy a store into a fork's directory, so inherited references still resolve |
| `PI_ARTIFACT_DIR` | exported into `process.env` so a child pi joins this store instead of starting its own |

Producers import `spill` from `../artifacts/store.ts`. There is no "write an artifact" tool: an artifact is a side effect of output being too big, never a thing a model decides to create.

## Three budgets, orders of magnitude apart

This is the same asymmetry `background` documents, one level up. Text that is **injected** into context is the most expensive text there is per byte — the reader did not ask for it and cannot decline it. Text **retained** on disk is nearly free. Text **pulled** back deliberately sits in between: a tool call was spent asking for it, which is the signal that it was wanted.

| | | |
| --- | --- | --- |
| `PREVIEW_BYTES` | 2KB | what a spill **volunteers**, unasked |
| `READ_BACK_CAP_BYTES` | 64KB | what one `artifact_read` returns by default |
| `MAX_ARTIFACT_BYTES` | 4MB | what one artifact **retains** on disk |

2KB matches `background`'s `NOTIFY_TAIL_BYTES` and for its reason: enough to carry a stack trace or a test summary — the cases where the reader should act immediately — and small enough not to matter when it is noise. 64KB is 32× that because it was asked for; it is still bounded, since an unbounded read-back would put the whole 4MB into context and defeat the point of having written a file at all. 4MB is roughly a very verbose CI log, an order of magnitude above the 256KB `background` holds in memory — that budget is heap, this one is disk.

## Tail, not head — everywhere

Every truncation in this extension keeps the **end**. A failing build prints its error last, a test runner prints its summary last, a traceback puts the exception type on the final line. "The first 2KB of a 900KB log" is an expensive way to say nothing.

The preview is a header line naming the reference and the true size, then the tail. The header is first so a reader knows this is a preview before reading it; the tail is last so the message still *ends* on the error.

**Nothing is dropped silently.** A truncated artifact opens with a line saying how many bytes went; a preview says how much it is showing out of how much; a full store says it is full. A store whose losses are invisible is worse than no store, because the reader believes they have the whole thing.

## Where artifacts live

Beside the session file: `<timestamp>_<sessionId>.jsonl` gets a `<timestamp>_<sessionId>/` next to it. That is what a fork copies, what a resume reopens and what an operator deletes when cleaning up, so co-locating gives the artifacts that whole lifecycle without a line of code arranging it — and a human who finds one finds the other.

Resolution order, and the order is the interesting part:

1. **An inherited `PI_ARTIFACT_DIR`.** A child pi launched by a parent that already has a store must write into *that* store — that is the entire point of exporting the variable, and a child preferring its own session file would break the chain the variable exists to create. The value is read once, in the extension factory, **before** this extension exports its own; so "inherited" means exactly "put there by a parent process", and a second session in a long-lived process cannot inherit the first one's directory by accident.
2. **This session's own jsonl file**, via `ctx.sessionManager.getSessionFile()`.
3. **`os.tmpdir()/pi-artifacts-<pid>`.**

### The fallback, stated rather than discovered

Case 3 is real, not defensive padding. `SessionManager.getSessionFile()` returns `undefined` whenever the session is not persisted, and this repo's `test/fake-pi.ts` does not implement the method at all — so the call sits behind a `typeof` check rather than being made bare. Both cases land in the per-process tmpdir.

**Artifacts in the fallback directory do not survive the session.** They are not beside a session file, nothing copies them into a fork, and the OS will eventually reap them. Spilling still works and references still resolve for the life of the process; a resumed session simply starts an empty store. If that matters for your use, run a persisted session.

## Identity survives a restart

Ids are numeric, and `nextId` **scans the directory** rather than remembering a counter. It has to: a session is resumed, forked and branched, and each of those either restarts the process or leaves a second writer against the same directory. A remembered counter would restart at 1 and overwrite artifact 1 of the previous life.

It returns `max + 1`, not `count + 1` — a deleted artifact must not make the next spill re-use a reference somebody is still holding in their transcript.

**Accepted limitation:** two processes spilling into one directory at the same instant can scan the same maximum and both claim the next id; the loser's bytes are the casualty. The window is narrow (the scan and the write are adjacent) and the alternative — a lockfile — is a new failure mode with its own stale-lock recovery story. Noted, not engineered around.

## Fork

`adoptDir` copies a store into a new session's directory. This is what makes branching non-lossy: pi copies custom entries into a fork, so the forked transcript still says `artifact://7`, and without the bytes the branch is a session whose own history lies to it.

Ids are **preserved, not renumbered**, because the transcript names them. An id the destination already has is **skipped, never overwritten** — the destination's own artifact 3 has a reference pointing at it too, and there is no ordering in which clobbering it is right. The counter needs no separate arrangement: `nextId` scans, so after the copy it already continues past the highest id across both stores.

## Deliberate limits

- **256 artifacts per session.** At the 4MB ceiling that is a bounded 1GB worst case, but disk is not really the point — the cap is about the store staying *readable*. `artifact_list` at four hundred rows is not an index, it is another haystack. When it is reached, `spill` still returns the preview and **says the store is full**; it does not silently drop the ref, and it does not evict an older artifact, because something is already holding a reference to that id.
- **4MB per artifact.** Above it the tail is kept and the head is dropped with a stated count. The failure mode of no cap is a full disk, which takes the whole workstation down and not just this feature.
- **Nothing is ever deleted.** Artifacts are ground truth; they live and die with the session directory they sit in.
- **A reference is a pointer, never a path.** `parseRef` accepts `artifact://7` and a bare `7` and nothing else — no `../`, no filename. That is the property that keeps `artifact_read` a reader of this session's own store rather than a second `read` tool with no guard on it, and it is why the `kind` is slugged to `[a-z0-9_-]` before it becomes part of a filename.

## It never injects

No `before_agent_start` handler, no `sendMessage`, no footer segment, no session entry. Both entry points are tools the model calls when it decides it wants the bytes.

That is not an omission, it is the doctrine of the feature: an artifact exists so that large text does **not** enter context unasked, and an extension that announced its own artifacts would be spending precisely the budget it was built to protect.

## Guarding

Both tools are registered through `registerGuardedTool` with `writesExemptBecause`, because both genuinely only read — one file inside a directory this extension chose, addressed by a numeric id that `parseRef` will not let be a path. The declaration is what makes `test/tool-capability.test.ts` treat them as accounted for rather than ungoverned; it is stated on the tool rather than added to that test's `READ_ONLY` list so the reason sits next to the thing it describes.
