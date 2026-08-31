import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	HIVE_PLAN_CHANNEL,
	HIVE_SESSION_CHANNEL,
} from "../extensions/hive-common/channels.ts";
import {
	applyOps,
	emptyPlan,
	PLAN_ENTRY_TYPE,
	PLAN_TICK_ENTRY_TYPE,
	tickEntry,
	toEntry,
} from "../extensions/plan/state.ts";
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
function fakeHive(over: { planStatus?: number } = {}) {
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


/**
 * Get past attach AND leave `latestCtx` holding these entries.
 *
 * The flush reads the document from the ctx it last saw, so the entries have to
 * arrive on an emit — appendEntry alone would not be visible to it, which is
 * exactly the shape of the bug this file is here to catch.
 */
async function attachWith(fake: FakePi, branch: unknown[]): Promise<void> {
	await fake.emit({ type: "session_start", reason: "startup" }, { branch: branch as never });
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

describe("the plan flush, on the terms the workflow flush was held to", () => {
	// Four assertions restored from the two workflow describes HIV-2904 removed.
	// The endpoint they guarded is gone — lanes live in the plan, so there is one
	// document and one endpoint — but every property below was about the FLUSH
	// rather than about which document it carried, and each is still a way the
	// panel goes quietly stale.

	it("sends NOTHING when no plan entry exists", async () => {
		// A revision announced without a document is a client bug, not a reason
		// to PUT `null` over a document the server already holds.
		const hive = fakeHive();
		hiveRemote(fake.api, deps());
		await attachWith(fake, []);

		fake.api.events.emit(HIVE_PLAN_CHANNEL, { revision: 2 });
		await vi.advanceTimersByTimeAsync(50);

		expect(hive.to("/plan")).toHaveLength(0);
	});

	it("ignores a doorbell carrying no revision", async () => {
		const hive = fakeHive();
		hiveRemote(fake.api, deps());
		await attachWith(fake, [planEntry("x")]);

		fake.api.events.emit(HIVE_PLAN_CHANNEL, {});
		fake.api.events.emit(HIVE_PLAN_CHANNEL, { revision: "four" });
		await vi.advanceTimersByTimeAsync(50);

		expect(hive.to("/plan")).toHaveLength(0);
	});

	it("does not fail the session when Hive rejects the PUT", async () => {
		// A dropped snapshot costs a stale panel until the next tick. Failing
		// loudly would put a network error in front of a developer whose only
		// crime was ticking a step.
		const hive = fakeHive({ planStatus: 409 });
		hiveRemote(fake.api, deps());
		await attachWith(fake, [planEntry("stale")]);

		fake.api.events.emit(HIVE_PLAN_CHANNEL, { revision: 1 });
		await vi.advanceTimersByTimeAsync(50);

		expect(hive.to("/plan")).toHaveLength(1);
		expect(fake.notifications).toHaveLength(0);
	});

	// Newest wins: the reader scans backwards, so a second snapshot must
	// supersede the first rather than resend it.
	it("sends the NEWEST snapshot", async () => {
		const hive = fakeHive();
		hiveRemote(fake.api, deps());
		await attachWith(fake, [planEntry("older"), planEntry("newer")]);

		fake.api.events.emit(HIVE_PLAN_CHANNEL, { revision: 2 });
		await vi.advanceTimersByTimeAsync(50);

		const doc = hive.to("/plan")[0].body?.document as { doc?: { title?: string } };
		expect(doc?.doc?.title).toBe("newer");
	});

	// What replaced the two workflow describes that stood here.
	//
	// They pinned a second endpoint and the hazard of confusing it with the
	// first; HIV-2904 removed both — lanes live in the plan, so there is one
	// document and one endpoint. The hazard that took their place is sharper:
	// a status change now writes a small `plan.tick` entry instead of
	// re-emitting the document, and a flush that sent the newest SNAPSHOT would
	// ship Hive a plan whose checkboxes never move. That is not a visible
	// failure — it is a plausible, out-of-date plan — which is exactly the kind
	// worth a test.
	it("folds the ticks that follow the newest snapshot", async () => {
		const hive = fakeHive();
		hiveRemote(fake.api, deps());

		const doc = applyOps(
			emptyPlan(1_700_000_000_000),
			[
				{ op: "header", title: "the plan" },
				{ op: "lane", kind: "execute", items: [{ id: "a", title: "do it" }] },
			],
			1_700_000_000_000,
		).doc;
		const ticked = applyOps(doc, [{ op: "set_step", id: "a", status: "done" }], 1_700_000_060_000).doc;

		await attachWith(fake, [
			{ customType: PLAN_ENTRY_TYPE, data: toEntry(doc) },
			{ customType: PLAN_TICK_ENTRY_TYPE, data: tickEntry(ticked) },
		]);

		fake.api.events.emit(HIVE_PLAN_CHANNEL, { revision: doc.revision, progress: ticked.progress });
		await vi.advanceTimersByTimeAsync(50);

		const puts = hive.to(`/agent-sessions/${SESSION_ID}/plan`);
		expect(puts).toHaveLength(1);
		const sent = puts[0].body?.document as { doc?: { blocks?: Array<{ steps?: Array<{ status?: string }> }> } };
		expect(sent?.doc?.blocks?.[0].steps?.[0].status).toBe("done");
	});
});
