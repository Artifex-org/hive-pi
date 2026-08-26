/**
 * A blocked command has to reach the operator's activity row, and it has to get
 * there WITHOUT silencing the heartbeat.
 *
 * That is the whole risk in this wiring. `shouldReport` treats `needs_input` as
 * idle-shaped and stops beating, on the reasoning that a session parked
 * overnight must not POST every ten seconds. Reporting a blocked command as
 * `needs_input` would therefore mean a FALSE POSITIVE silences the liveness
 * signal the workspace uses to tell a working agent from a dead one — the exact
 * failure HIV-2242 half-fixed. So this stays a detail on the running tool phase.
 */

import { describe, expect, it } from "vitest";

import { createActivity, enterPhase, shouldReport, updateDetail } from "../extensions/hive-remote/activity.ts";
import type { ActivityState } from "../extensions/hive-remote/activity.ts";

function toolRunning(now = 1_000): ActivityState {
	// The canonical factory, not a hand-rolled struct: ActivityState gains fields
	// (sinceMs, running) and a literal here would silently drift from it.
	const state = createActivity(now);
	enterPhase(state, "tool", now, "bash");
	return state;
}

/**
 * Settle a state as fully reported, so the next `shouldReport` answers the
 * question we actually care about — "does this phase keep beating?" — rather
 * than the trivial one, "has the phase changed since the last POST?".
 *
 * Getting this wrong is why the first version of the test below passed even
 * with the implementation sabotaged: `sent.phase` disagreed with `state.phase`,
 * so shouldReport short-circuited to true on the mismatch and never reached the
 * idle-shaped check.
 */
function settle(state: ActivityState, atMs: number): void {
	state.sent = { phase: state.phase, tool: state.tool, atMs };
	state.detailSent = true;
}

describe("a blocked command on the activity row", () => {
	it("annotates the running tool rather than changing phase", () => {
		const state = toolRunning();
		updateDetail(state, "tool", "bash · waiting for input (7s)");
		expect(state.phase).toBe("tool");
		expect(state.detail).toBe("bash · waiting for input (7s)");
	});

	/**
	 * THE LOAD-BEARING ASSERTION. A blocked command must keep beating; if this
	 * ever became `needs_input`, a false positive would stop the heartbeat and a
	 * working agent would start looking dead.
	 *
	 * Both states are settled first, so each is asked the same question about its
	 * own phase and the only difference is the phase itself.
	 */
	it("keeps beating while blocked, unlike needs_input", () => {
		const blocked = toolRunning();
		updateDetail(blocked, "tool", "bash · waiting for input (7s)");
		settle(blocked, 1_100);
		expect(shouldReport(blocked, 1_100 + 10_000)).toBe(true);

		const idleShaped = toolRunning();
		enterPhase(idleShaped, "needs_input", 1_000);
		settle(idleShaped, 1_100);
		expect(shouldReport(idleShaped, 1_100 + 600_000)).toBe(false);
	});

	// A new annotation is news even though the phase has not moved — otherwise
	// the block would wait for the next heartbeat to appear.
	it("reports a fresh detail immediately", () => {
		const state = toolRunning();
		settle(state, 1_000);
		expect(shouldReport(state, 1_001)).toBe(false);
		updateDetail(state, "tool", "bash · waiting for input (7s)");
		expect(shouldReport(state, 1_001)).toBe(true);
	});

	it("drops the annotation on resolve but keeps the command running", () => {
		const state = toolRunning();
		updateDetail(state, "tool", "bash · waiting for input (7s)");
		updateDetail(state, "tool", "bash");
		expect(state.phase).toBe("tool");
		expect(state.detail).toBe("bash");
	});

	// A block reported while the agent is thinking belongs to no command;
	// annotating the wrong phase would mislabel it.
	it("ignores a block reported outside the tool phase", () => {
		const state = createActivity(1_000);
		updateDetail(state, "tool", "bash · waiting for input (7s)");
		expect(state.detail).toBeUndefined();
	});

	// The two tiers say different things because they know different things: a
	// stalled `git fetch` in poll() reaches `quiet` and never reaches `proven`.
	it("words the two confidence tiers differently", () => {
		const proven = "bash · waiting for input (7s)";
		const quiet = "bash · no output for 120s";
		expect(proven).toContain("waiting for input");
		expect(quiet).toContain("no output");
		expect(proven).not.toBe(quiet);
	});
});
