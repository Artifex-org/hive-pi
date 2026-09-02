# pr-attachments

Nudge agents that change UI to capture **before** and **after** screenshots and
attach them to their pull request, using GitHub CLI 2.99's repeatable
`--attach '<file>#<alt text>'` flag.

Two non-blocking hints, a gh version gate, and one on-disk manifest that a
hive-side Go consumer reads. Nothing here blocks a command — see
[`logic.ts`](./logic.ts)'s header and
[`../guards-common/gh-body-guard.ts`](../guards-common/gh-body-guard.ts) for why
a nicety must never be a gate.

## The nudges

- **BEFORE nudge** — on the first `edit`/`write` of a session that touches a
  UI-visible file (globs: `web/**`, `frontend/**`, `mobile/**`, `apps/**`,
  `**/*.tsx`, `**/*.jsx`, `**/*.vue`, `**/*.svelte`, `**/*.css`, `**/*.scss`,
  `**/templates/**/*.html`, `**/*.stories.*`), when no screenshot has been
  taken yet: reminds the agent to take a `browser_screenshot` with label
  `before` **now**, because the before-state cannot be captured after the edit
  lands. Fires at most once per session.
- **PR nudge** — on a `bash`/`background_bash` running `gh (pr|issue)
  (create|edit|comment)` **without** `--attach`, when the session has
  screenshots: injects the exact single-quoted `--attach '<file>#<alt>'` lines
  and suggests `--body-file` for the body. Fires once per command shape (a retry
  does not repeat it).

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
