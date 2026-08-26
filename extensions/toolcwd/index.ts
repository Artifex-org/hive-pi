/**
 * toolcwd — a `bash` call that names a directory runs in it.
 *
 * pi's `bash` tool has no `cwd` parameter. `background_bash` does, and that
 * asymmetry is the trap: an agent working in a second worktree — which every
 * launched agent is, by construction — reasonably passes `cwd`, pi drops it
 * silently, and the command runs in the SESSION's checkout instead.
 *
 * Measured 2026-08-17/18, eleven papercuts in 48 hours, and the failures are
 * not cosmetic:
 *
 *   - `uv run pytest …` ran in the base checkout, so a deliberate NEGATIVE
 *     CONTROL was never executed — the agent read a pass as evidence for an
 *     edit the run had not seen.
 *   - `uv run ruff format --check …` reported 16 files formatted, none of them
 *     in the worktree being repaired: "making the reported 16 formatted files
 *     non-evidence for the repair diff".
 *   - `git status` in the wrong worktree made a freshly created ASF-3685
 *     checkout appear to be on branch ASF-3686, which was then filed as a gwq
 *     bug. It was not one.
 *
 * That last one is why this is worth an extension rather than a line of advice:
 * a silently misdirected command does not fail, it answers — about somewhere
 * else — and the answer is indistinguishable from the truth until something
 * downstream contradicts it.
 *
 * The repair is in `cwd.ts`, pure and tested. This file is the wiring, and it
 * does the two halves in the two phases pi offers:
 *
 *   1. `tool_call` — mutate `input.command` before execution (pi documents
 *      `event.input` as mutable for exactly this) so the command runs where the
 *      caller meant.
 *   2. `tool_result` — append one sentence saying what was changed and why, so
 *      the repair is never invisible. A harness that silently fixes calls is
 *      the same class of bug as one that silently breaks them.
 *
 * Both handlers are a string test and a string concat — no fs, no network,
 * nothing that can hang the agent loop (the constraint toolhints states).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { appendHint } from "../toolhints/index.ts";
import { repairBashCwd } from "./cwd.ts";

/** Off switch, matching toolhints' PI_TOOLHINTS. */
function disabled(env: Record<string, string | undefined>): boolean {
	return env.PI_TOOLCWD === "0";
}

export default function (pi: ExtensionAPI) {
	if (disabled(process.env)) return;

	/**
	 * Call ids whose command we rewrote, and the sentence owed to each.
	 *
	 * Keyed by call id because a turn can hold several bash calls at once and
	 * the note has to land on the right one. Deleted on delivery, so nothing
	 * accumulates across a long session; a call that somehow never produces a
	 * result leaves one short string behind, which is the cheapest possible
	 * leak and bounded by the turn.
	 */
	const owed = new Map<string, string>();

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const input = event.input as Record<string, unknown> | undefined;
		const repair = repairBashCwd(input);
		if (!repair.note) return;

		if (repair.command !== null && input) {
			input.command = repair.command;
		}
		// Dropped either way: pi ignores it, and leaving it in place would let a
		// later handler repair it a second time.
		if (input) delete input.cwd;
		owed.set(event.toolCallId, repair.note);
	});

	pi.on("tool_result", (event) => {
		const note = owed.get(event.toolCallId);
		if (!note) return;
		owed.delete(event.toolCallId);
		// toolhints' appender, deliberately: it merges into the last text part
		// rather than pushing a new one, and one way of adding a harness sentence
		// to a tool result is enough for both extensions.
		return { content: appendHint(event.content, `\n\n[harness] ${note}`) };
	});
}
