import { afterEach, describe, expect, it } from "vitest";
import agenda from "../extensions/agenda/index.ts";
import background from "../extensions/background/index.ts";
import { createJob } from "../extensions/background/jobs.ts";
import { JOB_RECORD, jobRecord } from "../extensions/background/journal.ts";
import { OWN_WORK_CHANNEL, OWN_WORK_REQUEST_CHANNEL, type OwnWorkEvent } from "../extensions/hive-common/own-work.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

const sessions: FakePi[] = [];
afterEach(async () => {
	for (const pi of sessions.splice(0)) await pi.emit({ type: "session_shutdown" });
});

function boot(order = [background, agenda]): FakePi {
	const pi = createFakePi();
	sessions.push(pi);
	for (const owner of order) owner(pi.api);
	return pi;
}
const snapshots = (pi: FakePi): OwnWorkEvent[] =>
	pi.busEvents.filter((event) => event.name === OWN_WORK_CHANNEL).map((event) => event.payload as OwnWorkEvent);
const zeroes = [
	{ by: "background", running: 0, descriptions: [] },
	{ by: "orchestrate", running: 0 },
];

describe("own-work snapshot handshake", () => {
	it.each(["new", "startup", "resume"])("announces every idle owner on session_start (%s)", async (reason) => {
		const pi = boot();
		await pi.emit({ type: "session_start", reason });
		expect(snapshots(pi)).toEqual(zeroes);
	});

	it.each([false, true])("answers a late consumer for every owner, in either load order (%s)", async (reverse) => {
		const pi = boot(reverse ? [agenda, background] : [background, agenda]);
		await pi.emit({ type: "session_start" });
		const received: OwnWorkEvent[] = [];
		pi.api.events.on(OWN_WORK_CHANNEL, (data) => received.push(data as OwnWorkEvent));
		expect(received).toEqual([]); // Startup announcements were missed.
		pi.api.events.emit(OWN_WORK_REQUEST_CHANNEL, {});
		expect(received.sort((a, b) => a.by.localeCompare(b.by))).toEqual(zeroes);
	});

	it("re-announces live background work on same-session restore and requests without repainting", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" });
		pi.api.events.emit("background.job", {
			action: "start", id: "sub-1", sessionId: "fake-session", executionId: "execution",
			what: "reviewing", kind: "subagent", detail: "review",
		});
		pi.busEvents.length = 0;
		await pi.emit({ type: "session_start", reason: "resume" });
		expect(snapshots(pi)).toEqual([{ by: "background", running: 1, descriptions: ["reviewing"] }, zeroes[1]]);
		pi.busEvents.length = 0;
		const painted = pi.statuses.length;
		pi.api.events.emit(OWN_WORK_REQUEST_CHANNEL, undefined);
		expect(snapshots(pi)).toEqual([{ by: "background", running: 1, descriptions: ["reviewing"] }, zeroes[1]]);
		expect(pi.statuses).toHaveLength(painted);
	});

	it("announces after tree restoration, not from the abandoned live branch", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" });
		pi.api.events.emit("background.job", {
			action: "start", id: "sub-1", sessionId: "fake-session", executionId: "execution",
			what: "old branch", kind: "subagent", detail: "review",
		});
		pi.busEvents.length = 0;
		const job = createJob({ id: "bg-9", what: "saved work", kind: "bash", detail: "sleep", startedAtMs: 1 });
		await pi.emit({ type: "session_tree", oldLeafId: "old", newLeafId: "saved" }, {
			branch: [{ type: "custom", customType: JOB_RECORD, data: jobRecord("fake-session", "saved-execution", job) }],
		});
		// Persisted running jobs are recovered as unconfirmed, never restarted.
		expect(snapshots(pi)).toEqual(zeroes);
		pi.busEvents.length = 0;
		pi.api.events.emit(OWN_WORK_REQUEST_CHANNEL, {});
		expect(snapshots(pi)).toEqual(zeroes);
	});

	it("does not claim a background zero before initialization or after failed restoration", async () => {
		const pi = boot();
		pi.api.events.emit(OWN_WORK_REQUEST_CHANNEL, {});
		expect(snapshots(pi)).toEqual([zeroes[1]]);
		pi.busEvents.length = 0;
		await pi.emit({ type: "session_start" }, {
			branch: [{ type: "custom", customType: JOB_RECORD, data: {} }],
		});
		pi.api.events.emit(OWN_WORK_REQUEST_CHANNEL, {});
		expect(snapshots(pi).some((event) => event.by === "background")).toBe(false);
	});
});
