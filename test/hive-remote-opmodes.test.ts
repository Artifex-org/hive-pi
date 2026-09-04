/**
 * What the client tells the server it can enforce.
 *
 * `can_set_op_mode` says an enforcer is present; it does not say WHICH postures
 * that enforcer knows. An older pi handed an unknown `--op-mode` drops it in
 * silence and runs unrestricted in `build`, so a server offering a posture on
 * the strength of the boolean alone can show a lead as coordination-only while
 * every write tool stays open.
 */

import { describe, expect, it } from "vitest";
import { readAnnouncedModes } from "../extensions/hive-remote/opmodes.ts";
import { OP_MODES } from "../extensions/opmode/modes.ts";

describe("readAnnouncedModes", () => {
	it("accepts the set an opmode build announces", () => {
		expect(readAnnouncedModes({ mode: "build", modes: OP_MODES })).toEqual([...OP_MODES]);
	});

	it("copies rather than aliasing the announced array", () => {
		// The event belongs to the emitter; holding its array would let a later
		// mutation there rewrite what we have already told the server.
		const modes = ["build", "plan"];
		const read = readAnnouncedModes({ mode: "build", modes });
		modes.push("orchestrate");
		expect(read).toEqual(["build", "plan"]);
	});

	it("returns undefined — never an empty set — for an enforcer that says nothing", () => {
		// Silence and "none" are different answers. Collapsing them would make the
		// server withhold every mode from a client that enforces all of them.
		expect(readAnnouncedModes(undefined)).toBeUndefined();
		expect(readAnnouncedModes({ mode: "build" })).toBeUndefined();
		expect(readAnnouncedModes({ mode: "build", modes: [] })).toBeUndefined();
	});

	it("rejects a set that is not plainly a list of mode names", () => {
		expect(readAnnouncedModes({ mode: "build", modes: "orchestrate" } as never)).toBeUndefined();
		expect(readAnnouncedModes({ mode: "build", modes: [1, 2] } as never)).toBeUndefined();
		expect(readAnnouncedModes({ mode: "build", modes: ["build", ""] })).toBeUndefined();
	});

	it("carries orchestrate, which is the whole reason the server needs this", () => {
		expect(readAnnouncedModes({ mode: "build", modes: OP_MODES })).toContain("orchestrate");
	});
});
