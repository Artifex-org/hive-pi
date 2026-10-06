import { describe, expect, it } from "vitest";
import { registerSessionTitleTool } from "../extensions/hive-remote/sessionTitle.ts";
import { MAX_SESSION_TITLE, normalizeSessionTitle } from "../extensions/hive-remote/sessionTitleText.ts";
import { exposureFor } from "../extensions/loadout/policy.ts";
import { createFakePi } from "./fake-pi.ts";

function setup() {
	const pi = createFakePi();
	registerSessionTitleTool(pi.api);
	const entry = pi.tools.find((t) => t.name === "session_title")!;
	const run = (title: string) =>
		(entry.definition.execute as (...args: unknown[]) => Promise<{ isError?: boolean; content: { text: string }[] }>)("call", { title }, undefined, undefined, {});
	return { pi, entry, run };
}

describe("session_title", () => {
	// pi's session name is what hive-remote reports on every conversation
	// refresh, so setting it IS retitling the session in the Hive workspace.
	it("sets pi's session name", async () => {
		const { pi, run } = setup();
		const res = await run("Fixed runs-table sort drift — PR #8123");
		expect(res.isError).toBeFalsy();
		expect(pi.sessionNames).toEqual(["Fixed runs-table sort drift — PR #8123"]);
	});

	it("refuses an empty title rather than blanking the session", async () => {
		const { pi, run } = setup();
		expect((await run(" ** ")).isError).toBe(true);
		expect(pi.sessionNames).toEqual([]);
	});

	it("is deferred: the direct-tool budget is full, and the nudges name it exactly", () => {
		expect(exposureFor("session_title")).toBe("deferred");
		expect(setup().entry.definition.exposure).toBe("deferred");
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
