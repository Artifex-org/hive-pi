# deck — the one pinned widget (HIV-1219)

One widget key, `deck`, pinned in pi's `aboveEditor` band between the
transcript and the input editor. Before it, five in-house keys (`tasks`,
`plan`, `conductor`, `agenda-run`, `subagent-status`) competed for that band
in Map insertion order; each took its own rows and none knew about the
others.

## How it works

- **Publishers** (`tasks`, `plan`, `agenda`, `subagent`) emit their section
  state on `pi.events` channel `deck.section` (`protocol.ts`). They own their
  state and their pure renderers; the deck owns layout, modes, and the single
  `setWidget` slot. A bus rather than a shared module because pi builds a
  fresh jiti instance per extension with `moduleCache: false` — module-level
  state does not cross extension boundaries.
- **Sync**: the deck emits `deck.sync` when it gains a paintable ctx;
  publishers re-state what they know. Load order stops mattering.
- **Factory widget, not string[]**: pi hard-truncates string-array widgets at
  10 lines; component factories are exempt. The deck enforces its own cap
  instead (`TOTAL_CAP` in `render.ts`).
- **Modes**: `auto` (default — live sections expanded, idle sections folded
  into one summary line adjacent to the editor), `collapsed` (one line),
  `expanded` (everything). `/deck [expand|collapse|auto]`; bare `/deck`
  toggles collapsed; `ctrl+alt+t` cycles (`ctrl+t` is taken by pi core).
- **Ticking**: one 1 s unref'd interval, running only while a live section
  shows elapsed time (running subagents; an orchestrate run). Publishers do
  not re-emit unchanged state per second — elapsed is computed at render time
  from `startedAtMs`.
- **Attention**: sections may carry `waitingOnInput`; the deck sums and
  renders a leading `⚠ N waiting on input` segment. Wired for the in-house
  ask_user_question (HIV-1220) — nothing sets it yet.

## Rendering rules worth knowing (sources in HIV-1218 research)

- Tasks: imperative `subject` at rest, present-continuous `activeForm` on the
  in-progress row (Claude Code's dual-text trick); ALL rows render, capped
  with `+N more` that never hides the active row (their 5-row cap is the
  most-complained-about todo bug).
- Subagents: all in-flight states read as one steady `working` (t3code rule —
  a stalled worker is still the fleet doing its job), except prolonged
  silence, which gets the `working — no event 2m30s` quiet marker
  (run-view's rule — silence and progress must not look identical).
  Finished agents linger below running ones and fold into a count.
- Idle deck = no widget at all. A lifecycle indicator that is always on
  screen is one nobody reads.

## Bus trust boundary

`deck.section` carries display strings (task subjects, agent activity) —
allowed, unlike the hive channels, because it is consumed for LOCAL rendering
only and everything on it already exists in the session transcript. The deck
still treats the bus as untrusted: `sanitizeSectionEvent` validates shape,
clamps strings, caps rows; malformed payloads are dropped, never thrown over.
Nothing from this channel may be relayed off-machine.
