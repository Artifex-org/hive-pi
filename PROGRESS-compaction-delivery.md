# Remote command loss during compaction

Target: `ffe777dd-cd82-4265-990a-2184919aa914` (home session, tmux `hive-agents-f4524f29:1.1`).

## Incident evidence

- 2026-10-07 15:44:57Z: provider response ended with `terminated`.
- 15:49:18Z: operator interrupt aborted the retry. Its queued `continue` was restored into the idle TUI editor.
- 15:49:23Z: recorded activity described manual compaction of ~106k tokens; persisted agenda status then incorrectly led diagnosis to claim an approval prompt.
- 15:49:42Z: another operator `continue` was echoed into Hive (seq 776), but never became a local user message.
- 15:52:11Z: local compaction completed. The pane stayed idle with the restored `continue` draft.
- 15:56:51Z: submitted the existing draft with Enter (no approval or force-kill). Agent resumed; subsequent pane showed new tool calls, turns 189, context ~90k/272k.

Parse JSONL with newline-delimited iteration, not Python `str.splitlines()` (which also splits legal Unicode separators inside strings). No session-file corruption was found.

## Root cause and fix

Pi 1.0.2 `AgentSession.prompt` rejects while manual compaction is running. `ExtensionAPI.sendUserMessage` returns void and internally reports the rejection; Hive remote immediately echoed the command anyway and never retried it. Commands sent during compaction were consumed without reaching the model.

The fix retains remote steer/follow-up commands in a session-scoped FIFO, drains on the existing detached command poll once Pi is idle or has started its automatic retry, preserves control commands, and invalidates late claim/attachment work on session change. It does not await the void API or submit prompts from serial compaction event handlers.

Native SDK tests use an offline faux provider and real compaction, including cancellation. Wiring tests cover failure, ordering/images, control commands, automatic retries, and session replacement.

## Delivery

The running agent was recovered without restarting or altering its WIP. It still runs its originally loaded extension; source changes need review/merge and the managed harness update to become fleet-wide. No machine configuration or installed harness files were edited. Operator approved pushing and opening a PR; merge/deployment remain unrequested.

Verification: full `npm run check` passed (typecheck; 281 test files, 4,643 tests passed; 4 files/13 tests skipped by existing repository configuration). Independent review found no actionable issues. `quality_gate` found no supported gate script; `.github/workflows/check.yml` declares the npm typecheck and full Vitest suite instead.

The first full run exposed a pre-existing LSP disposal race: `dispose()` sent SIGTERM but left pending requests live until the child exit event, allowing an already-written response to resolve a supposedly cancelled request. Reused the existing `fail()` path to retire pending and future requests synchronously on disposal; the existing real-server regression now passes in the full gate. This small root-cause repair unblocks the shared gate without changing assertions or skipping tests.
