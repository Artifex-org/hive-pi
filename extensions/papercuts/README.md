# papercuts

A `papercut` tool the agent calls the moment something in this environment gets in its way, plus the log it writes to.

## Why in-the-moment beats mining it later

The workstation already mines transcripts nightly — the `session-introspection` timer at 07:00. That is **archaeology**: it can only recover friction that left a trace. A failed command, a guard hit, a retry loop.

The expensive friction leaves no trace, because the model **routes around it and succeeds**. A doc that was wrong. A workflow that took four steps. A tool whose error message sent it down a dead end for exactly one turn. All of that ends in a green result, and a green result is invisible to any miner. The only moment it is knowable is the moment it is felt, by the only party that felt it.

So the rule is in the tool description, not in a summary prompt: **call it mid-task, before you work around the problem.** A model asked at the end of a task compresses four minutes of thrashing into "some tooling issues", which is not a bug report.

## What counts

The description names these explicitly, because a vague invitation gets vague entries:

- a tool failed in a way whose message did not say what to do
- a doc, README or comment was wrong
- something took four steps that should take one
- a guard or check blocked something reasonable
- a name, path or flag had to be guessed that should have been discoverable
- the answer was somewhere other than where you first, reasonably, looked

One papercut per call, quoting the exact command, path or message. Severity is `minor` | `moderate` | `blocking`, defaulting to **minor** — the default has to be the low one, or the model deliberates before every call, and that deliberation is the tax that stops the call being made.

## The container-exfil design point

The markdown file looks like the deliverable. It is not, for the agents that matter most.

**A factory run's container is destroyed when the run ends.** A `papercuts.md` written inside it is gone, along with every observation the most heavily-worked agents on the fleet made. What *does* survive is the session transcript, which is collected and shipped to the Hive agents workspace.

So the structured entry rides out on the tool result's `details`, where collection already looks:

```json
{ "v": 1, "type": "papercut", "entry": { "at": "…", "severity": "moderate", "cwd": "…", "friction": "…", "context": "…" } }
```

`v` is a version tag rather than decoration: the consumer on the other side of that collection is deployed separately from this extension and will be reading v1 shapes long after this one changes. The same envelope is why a failed write does not fail the call — the entry is already in the transcript, and turning an unwritable log into a tool error would make the aside the agent's problem.

A failed write is **recorded**, not swallowed, and the two ways it can fail are kept apart because they say opposite things about where the record lives:

| field | meaning | transcript line |
|---|---|---|
| neither | appended and capped | `logged to <path>` |
| `writeError` | the entry is **transcript-only** — the append failed | `log write failed — entry is in the transcript` |
| `capError` | the entry **is on disk**; only the trim failed, so the file is over its cap | `logged to <path> — cap not applied` |

Both are absent on the happy path and additive to the v1 shape. Folding a failed trim into `writeError` would make every surface — the transcript line, the tool text, and the consumer that partitions transcript-only entries from on-disk ones — deny a write that actually succeeded.

## The format

```
## 2026-08-15T09:12:04.113Z · blocking
- cwd: /home/dev/repos/hive-pi__worktrees/feature-hiv-1883
- context: running the scoped test file
> `npm run check` is whole-project, so a half-written sibling file
> fails a run that has nothing to do with my change.
```

Markdown, not JSONL, because there are two readers with opposite needs: a human runs `grep -n "hive check" papercuts.md` and wants to read the hit, and a future miner wants the fields back. `parseEntries` recovers the record; the friction text is literal in the file either way.

The body is **blockquoted**, which is the one non-obvious choice. It makes the format closed under its own content: friction *about* markdown ("the `## Config` section is wrong") would otherwise open a new entry mid-body and split one record in two. There is a test for exactly that.

`parseEntries` **never throws.** This is a file humans are invited to grep, open and edit, so malformed content is the steady state, not an error case — a half-written entry from a killed process, a hand-added note, a conflict marker. Bad blocks are skipped and their neighbours still come back.

## Config

`~/.pi/agent/hive-telemetry/papercuts.config.json` — the repo's `configPathFor("papercuts")` path, which is *not* `~/.pi/agent/papercuts.json`; the state directory name is frozen for the reason `hive-common/identity.ts` documents.

```json
{
  "enabled": true,
  "path": "~/.pi/agent/papercuts.md",
  "maxEntries": 500
}
```

- **`enabled`** defaults **on**, for narrate's reason rather than hive-telemetry's: this writes one local file that nobody uploads, and the `details` envelope travels only inside a transcript the session was already shipping. Disabled means **no tool and no command are registered at all** — a registered no-op is worse than an absence, and a tool the model can see is one it spends tokens deciding about on every request.
- **`path`** takes `~`, an absolute path, or a name relative to `~/.pi/agent`. It is user-configurable, so it can point at a protected worktree — which is why the tool declares `writesResolved` and the worktree guard gets to refuse.
- **`maxEntries`** (floor 10, default 500) caps the file. Capping runs on **every** append, which keeps the file self-bounding: it can never hold more than `maxEntries + 1`, so the read-parse-rewrite is bounded at ~100KB. The one unbounded read is the first append against an already-oversized file, which is precisely the moment the cap is for.

## `/papercuts [n]`

Shows the last `n` entries (default 10), one line each. The file is the record; this is a peek — the friction text can be a pasted stack trace, and a notify that scrolls the terminal off the top stops being read.

## Cost to the agent loop

**None.** This extension registers **no event handlers at all** — there is a test asserting that. The filesystem work happens inside a tool `execute`, which pi runs as the tool call the model asked for, not inside the loop that dispatches it. That is what buys the synchronous read-cap-rewrite the right to exist.
