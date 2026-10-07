import { afterEach, describe, expect, it, vi } from "vitest";
import agenda from "../extensions/agenda/index.ts";
import { createFakePi } from "./fake-pi.ts";

const state = vi.hoisted(() => ({ fail: false, enabled: true }));
vi.mock("../extensions/agenda/handoff.ts", async (original) => ({
	...await original<typeof import("../extensions/agenda/handoff.ts")>(),
	writeHandoff: () => {
		if (state.fail) throw new Error("seed write failed");
		return "/test/handoff.md";
	},
}));
vi.mock("../extensions/hive-common/identity.ts", async (original) => ({
	...await original<typeof import("../extensions/hive-common/identity.ts")>(),
	readJSON: () => ({ handoffOnThreshold: state.enabled }),
}));
vi.mock("../extensions/agenda/session-recap.ts", async (original) => ({
	...await original<typeof import("../extensions/agenda/session-recap.ts")>(),
	fetchRecapPayload: async () => null,
}));
afterEach(() => { state.fail = false; state.enabled = true; vi.useRealTimers(); });

describe("confirmed handoff reporting", () => {
	it.each([false, true])("reports manual handoff only after a successful seed write (fail=%s)", async (fail) => {
		state.fail = fail;
		const fake = createFakePi();
		agenda(fake.api);
		await fake.runCommand("handoff", "continue open work", { cwd: "/tmp" });
		const notices = fake.busEvents.filter((e) => e.name === "hive.context.handoff");
		expect(notices.map((e) => e.payload)).toEqual(fail ? [] : [{ trigger: "manual" }]);
	});

	it.each([false, true])("reports threshold handoff, never failed-write fallback (fail=%s)", async (fail) => {
		vi.useFakeTimers();
		state.fail = fail;
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_before_compact", reason: "threshold", preparation: { tokensBefore: 200000 } });
		await vi.advanceTimersByTimeAsync(0);
		const notices = fake.busEvents.filter((e) => e.name === "hive.context.handoff");
		expect(notices.map((e) => e.payload)).toEqual(fail ? [] : [{ trigger: "threshold" }]);
		expect(fake.shutdowns).toBe(fail ? 0 : 1);
	});

	it.each(["manual", "overflow"])("does not turn %s compaction into a handoff", async (reason) => {
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_before_compact", reason, preparation: { tokensBefore: 200000 } });
		expect(fake.busEvents.filter((e) => e.name === "hive.context.handoff")).toEqual([]);
	});

	it("does not report a threshold handoff merely because a threshold is reached", async () => {
		state.enabled = false;
		const fake = createFakePi();
		agenda(fake.api);
		await fake.emit({ type: "session_before_compact", reason: "threshold", preparation: { tokensBefore: 200000 } });
		expect(fake.busEvents.filter((e) => e.name === "hive.context.handoff")).toEqual([]);
		expect(fake.shutdowns).toBe(0);
	});
});
