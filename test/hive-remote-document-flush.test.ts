import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	HIVE_PLAN_CHANNEL,
	HIVE_SESSION_CHANNEL,
	HIVE_WORKFLOW_CHANNEL,
} from "../extensions/hive-common/channels.ts";
import hiveRemote, { type RemoteDeps } from "../extensions/hive-remote/index.ts";
import type { RemoteConfig } from "../extensions/hive-remote/config.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

/**
 * The DOCUMENT FLUSH SEAM: doorbell → read the entry → PUT it.
 *
 * Both document features are split across two extensions on purpose. `plan` and
 * `workflow` announce a REVISION on the bus and nothing else; hive-remote reads
 * the document out of the session entries under its own consent and sends it.
 * That split is what keeps step titles, branch names and file paths off a
 * process-local bus any loaded extension could subscribe to — and it means
 * neither side's tests cover the join. Both halves were tested; the seam
 * between them was not, and it is the only part where "the panel is empty"
 * would be the sole symptom.
 *
 * It got sharper when the workflow shipped: `latestPlanEntry` was refactored
 * into a shared `latestEntryOfType`, so ONE function now carries both features.
 * A bug in it stops plans AND workflows syncing, silently, with the client
 * still reporting healthy.
 */

const URL_BASE = "https://hive.test";
const SESSION_ID = "sess-1";
const RUN_ID = "run-abc";

interface Call {
	method: string;
	path: string;
	body: Record<string, unknown> | undefined;
}

function config(over: Partial<RemoteConfig> = {}): RemoteConfig {
	return {
		enabled: true,
		url: URL_BASE,
		flushIntervalMs: 1_000,
		eventThreshold: 200,
		allowSteer: true,
		allowInterrupt: true,
		allowKill: true,
		allowSetMode: true,
		allowSetOpMode: true,
		reportStatus: false,
		streamDeltas: false,
		streamThinking: true,
		reportActivity: false,
		reportWorktree: false,
		allowAddWorkspace: false,
		...over,
	};
}

function deps(cfg: RemoteConfig = config()): RemoteDeps {
	return {
		loadConfig: () => cfg,
		resolveAuth: () => ({ token: "t", url: URL_BASE, source: "test" }),
	};
}

/** Records every call; answers attach so the extension gets past it. */
function fakeHive(over: { planStatus?: number; workflowStatus?: number } = {}) {
	const calls: Call[] = [];
	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const path = String(url).replace(`${URL_BASE}/api/v1`, "");
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		calls.push({ method: String(init?.method ?? "GET"), path, body });

		if (path.startsWith("/agent-sessions/by-run/")) return json(200, { id: SESSION_ID });
		if (path.endsWith("/conversation")) return json(200, { session_id: SESSION_ID, last_seq: 0 });
		if (path.endsWith("/commands/claim")) return json(200, { items: [] });
		if (path.endsWith("/plan")) return json(over.planStatus ?? 200, { revision: 1 });
		if (path.endsWith("/workflow")) return json(over.workflowStatus ?? 200, { revision: 1 });
		return json(200, {});
	});

	return {
		calls,
		to: (suffix: string) => calls.filter((c) => c.path.endsWith(suffix)),
	};
}

const planEntry = (title: string) => ({
	customType: "plan",
	data: { kind: "plan", schemaVersion: 1, doc: { title, phase: "drafting", blocks: [] } },
});

const workflowEntry = (title: string) => ({
	customType: "workflow",
	data: {
		kind: "workflow",
		schemaVersion: 1,
		doc: { title, stages: [{ id: "s1", title: "Execute", kind: "execute", status: "running", steps: [] }] },
	},
});

/**
 * Get past attach AND leave `latestCtx` holding these entries.
 *
 * The flush reads the document from the ctx it last saw, so the entries have to
 * arrive on an emit — appendEntry alone would not be visible to it, which is
 * exactly the shape of the bug this file is here to catch.
 */
async function attachWith(fake: FakePi, branch: unknown[]): Promise<void> {
	fake.api.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: RUN_ID });
	await vi.advanceTimersByTimeAsync(400);
	await fake.emit(
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
		{ branch: branch as never },
	);
}

let fake: FakePi;

beforeEach(() => {
	vi.useFakeTimers();
	fake = createFakePi();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the workflow doorbell reaches Hive", () => {
	it("PUTs the document the bus never carried", async () => {
		const hive = fakeHive();
		hiveRemote(fake.api, deps());
		await attachWith(fake, [workflowEntry("Ship the graph")]);

		fake.api.events.emit(HIVE_WORKFLOW_CHANNEL, { revision: 4 });
		await vi.advanceTimersByTimeAsync(50);

		const puts = hive.to(`/agent-sessions/${SESSION_ID}/workflow`);
		expect(puts).toHaveLength(1);
		expect(puts[0].method).toBe("PUT");
		// The REVISION rode the bus; the DOCUMENT was read from the session
		// entries. Both have to arrive, or the server's staleness guard has
		// nothing to compare and the panel has nothing to draw.
		expect(puts[0].body?.revision).toBe(4);
		const doc = puts[0].body?.document as { doc?: { title?: string } };
		expect(doc?.doc?.title).toBe("Ship the graph");
	});

	it("sends NOTHING when no workflow entry exists", async () => {
		// A revision announced without a document is a client bug, not a reason
		// to PUT `null` over a document the server already holds.
		const hive = fakeHive();
		hiveRemote(fake.api, deps());
		await attachWith(fake, [planEntry("only a plan here")]);

		fake.api.events.emit(HIVE_WORKFLOW_CHANNEL, { revision: 2 });
		await vi.advanceTimersByTimeAsync(50);

		expect(hive.to("/workflow")).toHaveLength(0);
	});

	it("ignores a doorbell carrying no revision", async () => {
		const hive = fakeHive();
		hiveRemote(fake.api, deps());
		await attachWith(fake, [workflowEntry("x")]);

		fake.api.events.emit(HIVE_WORKFLOW_CHANNEL, {});
		fake.api.events.emit(HIVE_WORKFLOW_CHANNEL, { revision: "four" });
		await vi.advanceTimersByTimeAsync(50);

		expect(hive.to("/workflow")).toHaveLength(0);
	});

	it("does not fail the session when Hive rejects the PUT", async () => {
		// A dropped snapshot costs a stale panel until the next tick. Failing
		// loudly would put a network error in front of a developer whose only
		// crime was ticking a step.
		const hive = fakeHive({ workflowStatus: 409 });
		hiveRemote(fake.api, deps());
		await attachWith(fake, [workflowEntry("stale")]);

		fake.api.events.emit(HIVE_WORKFLOW_CHANNEL, { revision: 1 });
		await vi.advanceTimersByTimeAsync(50);

		expect(hive.to("/workflow")).toHaveLength(1);
		expect(fake.notifications).toHaveLength(0);
	});
});

describe("the two documents do not interfere", () => {
	// The refactor that made this worth pinning: `latestPlanEntry` became a
	// wrapper over a shared `latestEntryOfType`, so one function now carries
	// both features. A `customType` mix-up would send a plan to /workflow, or a
	// workflow to /plan, and both would look like "the panel is empty".
	it("sends each document to its OWN endpoint", async () => {
		const hive = fakeHive();
		hiveRemote(fake.api, deps());
		await attachWith(fake, [planEntry("the plan"), workflowEntry("the workflow")]);

		fake.api.events.emit(HIVE_PLAN_CHANNEL, { revision: 1 });
		fake.api.events.emit(HIVE_WORKFLOW_CHANNEL, { revision: 1 });
		await vi.advanceTimersByTimeAsync(50);

		const plan = hive.to(`/agent-sessions/${SESSION_ID}/plan`);
		const workflow = hive.to(`/agent-sessions/${SESSION_ID}/workflow`);
		expect(plan).toHaveLength(1);
		expect(workflow).toHaveLength(1);
		expect((plan[0].body?.document as { doc?: { title?: string } })?.doc?.title).toBe("the plan");
		expect((workflow[0].body?.document as { doc?: { title?: string } })?.doc?.title).toBe("the workflow");
	});

	// The plan flush is the one that already worked; the workflow refactor could
	// only have broken it silently, because nothing on either side would error.
	it("still sends the plan after the shared-helper refactor", async () => {
		const hive = fakeHive();
		hiveRemote(fake.api, deps());
		await attachWith(fake, [planEntry("plan still syncs")]);

		fake.api.events.emit(HIVE_PLAN_CHANNEL, { revision: 9 });
		await vi.advanceTimersByTimeAsync(50);

		const puts = hive.to(`/agent-sessions/${SESSION_ID}/plan`);
		expect(puts).toHaveLength(1);
		expect(puts[0].body?.revision).toBe(9);
	});

	// Newest wins: the reader scans backwards, so a second snapshot of the same
	// type must supersede the first rather than resend it.
	it("sends the NEWEST snapshot of a type", async () => {
		const hive = fakeHive();
		hiveRemote(fake.api, deps());
		await attachWith(fake, [workflowEntry("older"), workflowEntry("newer")]);

		fake.api.events.emit(HIVE_WORKFLOW_CHANNEL, { revision: 2 });
		await vi.advanceTimersByTimeAsync(50);

		const doc = hive.to("/workflow")[0].body?.document as { doc?: { title?: string } };
		expect(doc?.doc?.title).toBe("newer");
	});
});
