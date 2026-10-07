import { afterEach, describe, expect, it, vi } from "vitest";
import agenda from "../extensions/agenda/index.ts";
import { createFakePi } from "./fake-pi.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { emptyPlan, toEntry } from "../extensions/plan/state.ts";

const state = vi.hoisted(() => ({ fail: false, enabled: true, seed: "", duringRecap: undefined as (() => void) | undefined }));
vi.mock("../extensions/agenda/handoff.ts", async (original) => ({
	...await original<typeof import("../extensions/agenda/handoff.ts")>(),
	writeHandoff: (_cwd: string, seed: string) => {
		state.seed = seed;
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
	fetchRecapPayload: async () => { state.duringRecap?.(); return null; },
}));
afterEach(() => { state.fail = false; state.enabled = true; state.seed = ""; state.duringRecap = undefined; vi.useRealTimers(); });

function planned(manager: SessionManager, title: string) {
	const plan = emptyPlan(0);
	plan.blocks = [{ type: "steps", id: "lane", title: "Work", createdAt: 0, updatedAt: 0,
		steps: [{ id: "task", title, status: "pending" }] }];
	return manager.appendCustomEntry("plan", toEntry(plan));
}

describe("confirmed handoff reporting", () => {
	it("captures source and plan together before recap can change the branch", async () => {
		const manager = SessionManager.inMemory("/tmp");
		const leaf = planned(manager, "captured task");
		state.duringRecap = () => { planned(manager, "later task outside coverage"); };
		const fake = createFakePi(); agenda(fake.api);
		await fake.runCommand("handoff", "continue", { cwd: "/tmp", sessionManager: manager });
		expect(state.seed).toContain(JSON.stringify(leaf));
		expect(state.seed).toContain("captured task");
		expect(state.seed).not.toContain("later task outside coverage");
		expect(state.seed).not.toContain(JSON.stringify(manager.getLeafId()));
	});

	it("uses the same native source representation for threshold interception", async () => {
		vi.useFakeTimers();
		const manager = SessionManager.inMemory("/tmp");
		const leaf = planned(manager, "threshold task");
		const fake = createFakePi(); agenda(fake.api);
		const results = await fake.emit({ type: "session_before_compact", reason: "threshold" }, { cwd: "/tmp", sessionManager: manager });
		expect(results).toContainEqual({ cancel: true });
		expect(state.seed).toContain(JSON.stringify(manager.getSessionId()));
		expect(state.seed).toContain(JSON.stringify(leaf));
		expect(state.seed).toContain("threshold task");
		expect(state.seed).toContain("none (in-memory session)");
		await vi.advanceTimersByTimeAsync(0);
	});

	it("keeps readable local state when optional provenance lookup fails", async () => {
		const manager = SessionManager.inMemory("/tmp");
		planned(manager, "preserve this task");
		vi.spyOn(manager, "getSessionFile").mockImplementation(() => { throw new Error("identity unavailable"); });
		const fake = createFakePi(); agenda(fake.api);
		await fake.runCommand("handoff", "continue", { cwd: "/tmp", sessionManager: manager });
		expect(state.seed).toContain("preserve this task");
		expect(state.seed).toContain("Source unavailable");
	});

	it("reports oversized protected metadata without writing a truncated seed", async () => {
		const fake = createFakePi(); agenda(fake.api);
		await fake.runCommand("handoff", "x".repeat(13000), { cwd: "/tmp" });
		expect(state.seed).toBe("");
		expect(fake.notifications.some((notice) => notice.message.includes("shorten the objective"))).toBe(true);
		expect(fake.busEvents.filter((event) => event.name === "hive.context.handoff")).toEqual([]);
	});
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
