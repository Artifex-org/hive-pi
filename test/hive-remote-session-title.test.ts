import { describe, expect, it } from "vitest";
import { registerSessionTitleTool } from "../extensions/hive-remote/sessionTitle.ts";
import { MAX_SESSION_TITLE, normalizeSessionTitle } from "../extensions/hive-remote/sessionTitleText.ts";
import { exposureFor } from "../extensions/loadout/policy.ts";
import { createFakePi } from "./fake-pi.ts";

function setup() {
	const pi = createFakePi();
	registerSessionTitleTool(pi.api);
	const entry = pi.tools.find((t) => t.name === "session_title")!;
	const run = (title: string, description = "Goal: revise the approach. Approach: inspect the new target.", reason = "The task changed scope.") =>
		(entry.definition.execute as (...args: unknown[]) => Promise<{ isError?: boolean; content: { text: string }[] }>)
			("call", { title, description, reason }, undefined, undefined, {});
	return { pi, entry, run };
}

describe("session_title", () => {
	it("requires an explicit pivot and emits all canonical identity fields without a second writer", async () => {
		const { pi, run } = setup();
		const res = await run("Investigate new failure", "Goal: find root cause. Approach: trace the failing flow.", "The requested work pivoted.");
		expect(res.isError).toBeFalsy();
		expect(pi.sessionNames).toEqual([]);
		expect(pi.busEvents).toContainEqual(expect.objectContaining({
			name: "session-identity:canonical",
			payload: expect.objectContaining({ title: "Investigate new failure", source: "pivot", reason: "The requested work pivoted." }),
		}));
	});

	it("refuses a blank title", async () => {
		const { pi, run } = setup();
		await expect(run(" ** ")).rejects.toThrow();
		expect(pi.sessionNames).toEqual([]);
	});

	it("requires a non-empty description and reason", async () => {
		const { run } = setup();
		await expect(run("A task", "", "")).rejects.toThrow(/requires title, description, and reason/);
	});

	it("remains discoverable through its deferred loadout policy", () => {
		expect(exposureFor("session_title")).toBe("deferred");
		expect(setup().entry.definition.exposure).toBe("deferred");
		expect(String(setup().entry.definition.description)).not.toContain("when you finish");
	});
});

describe("normalizeSessionTitle", () => {
	it("keeps characters that are content: PR numbers, snake_case, arrows", () => {
		expect(normalizeSessionTitle("Fix feature_flag -> PR #8123")).toBe("Fix feature_flag -> PR #8123");
	});

	it("flattens to one plain line within pi's auto-title cap", () => {
		expect(normalizeSessionTitle("  Fix **runs** table\n\tsort `drift`  ")).toBe("Fix runs table sort drift");
		expect(normalizeSessionTitle("# Lane L5 — sort")).toBe("Lane L5 — sort");
		const long = normalizeSessionTitle("word ".repeat(40))!;
		expect(long.length).toBeLessThanOrEqual(MAX_SESSION_TITLE);
		expect(long.endsWith("…")).toBe(true);
	});
});
