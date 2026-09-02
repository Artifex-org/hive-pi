# pr-attachments

Nudge agents that change UI to capture **before** and **after** screenshots and
attach them to their pull request, using GitHub CLI 2.99's repeatable
`--attach '<file>#<alt text>'` flag.

A gh version gate, one on-disk manifest that a hive-side Go consumer reads, and
two reminders — a PR-time **hint** and one just-in-time **block**. The block is
the single deliberate exception to the hint-not-guard rule (see
[`logic.ts`](./logic.ts)'s header and
[`../guards-common/gh-body-guard.ts`](../guards-common/gh-body-guard.ts)):
blocking a PR for lacking `--attach` would be harmful, but the `before`
screenshot is physically impossible after the edit lands, so that one moment is
worth a one-time block.

## The reminders

- **BEFORE block** — on the first `edit`/`write` of a session that touches a
  UI-visible file (globs: `web/**`, `frontend/**`, `mobile/**`, `apps/**`,
  `**/*.tsx`, `**/*.jsx`, `**/*.vue`, `**/*.svelte`, `**/*.css`, `**/*.scss`,
  `**/templates/**/*.html`, `**/*.stories.*`), when no screenshot has been taken
  yet **and a screenshot is possible** (a dev server has been reported, or a
  browser page has been opened this session): the `tool_call` is **blocked once**
  with *“take browser_screenshot label:before now, then re-run this edit”*. It
  must be a block, not a hint: a hint fires on the `tool_result`, i.e. after the
  edit has landed and Vite HMR has repainted the dev server, at which point the
  before-state is gone. The block fires at most once per session; the next edit
  runs normally. When **nothing is capturable** (no dev server, no page opened),
  there is nothing to screenshot, so it degrades to a non-blocking hint on the
  result instead.

  The "capturable" state lives in another extension's closure, so the browser
  (`browser_navigate`) and flows (`report_dev_server`) extensions raise it on
  pi's shared event bus (`pr-attachments.capturable`); this extension listens.
- **PR nudge (hint)** — on a `bash`/`background_bash` running `gh (pr|issue)
  (create|edit|comment)` **without** `--attach`, when the session has
  screenshots: injects the exact single-quoted `--attach '<file>#<alt>'` lines
  and suggests `--body-file` for the body. Fires once per command shape (a retry
  does not repeat it). Never blocks.

## The gh version gate

`gh --version` is probed once per session (`/usr/bin/gh` first, then `gh` —
the mise shim is dead read-only inside the sandbox). `--attach` is only
suggested at **>= 2.99.0**; below that the nudge says to post without images and
list the screenshot paths in the final message. A companion toolhint
(`gh-attach-flag-unsupported` in `../toolhints/hints.ts`) catches
`unknown flag: --attach` with the same guidance.

## The `pr-attachments.json` manifest — contract for the Go consumer

`extensions/browser`'s `browser_screenshot` writes this file after **every**
screenshot (see [`manifest.ts`](./manifest.ts) for the implementation).

**Location**, in priority order:

1. `$HIVE_PR_ATTACHMENTS_DIR/pr-attachments.json` when that env var is set — the
   funnel's contract. The Go reader sets the var to a directory it controls and
   reads the manifest back from it.
2. otherwise `<os.tmpdir()>/pi-browser-<pid>/pr-attachments.json`, next to the
   screenshots themselves.

**Body**: a JSON array, oldest first, rewritten in full on every screenshot:

```json
[
  {
    "path": "/tmp/pi-browser-4131/shot-1725291600000.png",
    "label": "before",
    "url": "http://127.0.0.1:3000/dashboard",
    "taken_at": "2026-09-02T16:40:29.011Z"
  }
]
```

| field | meaning |
| --- | --- |
| `path` | absolute path to the PNG on this sandbox's disk |
| `label` | the free-text label the agent passed (`before`/`after` by convention); `""` when none |
| `url` | the page URL the shot was taken against — **not** the uploaded GitHub asset URL, which does not exist until `gh … --attach` runs and is the consumer's to capture |
| `taken_at` | ISO-8601 UTC timestamp |

A missing or malformed file is equivalent to an empty array: the manifest is
best-effort telemetry, never a hard dependency, and a write that fails never
fails the screenshot. If the manifest is lost but the `shot-*.png` files remain,
the ledger re-derives a labelless array from them (`reDeriveFromDisk`).

## Off switch

`PI_PR_ATTACHMENTS=0` registers nothing (matching `PI_TOOLHINTS`).
