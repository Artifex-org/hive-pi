/**
 * A prompt that mandates `@orchestrator` must also say what to do when it is
 * refused.
 *
 * `@orchestrator` resolves to the session that CONTROLS yours
 * (`controlled_by_session_id`). A launch may set `team_id` and leave that empty,
 * and then the worker is on a team with nobody above it, and every mandated
 * report answers
 *
 *	cannot resolve "@orchestrator": this session has no controller on its team
 *	(it was launched without controlled_by_session_id)
 *
 * Hive fixed its own half: `teamNoControllerProtocol` in
 * `internal/mcp/agentops_launch_protocol.go` routes a controller-less worker to
 * `post_team_note` instead, and the papercuts went 14 → 2.
 *
 * Then they came back — **13 in the 46 hours to 2026-08-19**, two blocking,
 * across hive and Aurora, every one of them an agent quoting a task protocol that
 * "requires" the handle. That is these prompts. They mandate the same four
 * moments as hive's block and were never given its fallback, so a worker obeying
 * the prompt is refused however correct the server-side block is.
 *
 * Two sources for one instruction is the defect; this test is what stops them
 * drifting apart again.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

/** The controller itself has no fallback to name — it IS the orchestrator. */
const CONTROLLERS = new Set(["team-lead.md"]);

function teamPrompts(): string[] {
	return readdirSync(PROMPTS).filter((f) => f.startsWith("team-") && f.endsWith(".md"));
}

describe("team prompts that mandate @orchestrator", () => {
	it("finds the prompts (a rename must not silently empty this suite)", () => {
		expect(teamPrompts().length).toBeGreaterThan(1);
	});

	for (const file of teamPrompts()) {
		if (CONTROLLERS.has(file)) continue;
		const text = readFileSync(join(PROMPTS, file), "utf8");
		if (!text.includes("@orchestrator")) continue;

		it(`${file} names the no-controller route`, () => {
			// The refusal, so the reader can match what they actually saw.
			expect(text).toMatch(/has no controller on its team/);
			// And the route out, which must be the one hive's own block uses —
			// a different answer here would be a second protocol, not a fix.
			expect(text).toMatch(/post_team_note/);
		});

		it(`${file} does not present the refusal as a reason to skip the report`, () => {
			// The failure mode this replaces is an agent that reads "refused" and
			// moves on, leaving the four moments unreported. The text has to say
			// the report still happens.
			expect(text).toMatch(/not a reason to skip|post the same thing|report .*(anyway|instead)/i);
		});
	}
});
