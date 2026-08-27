/**
 * payload.ts is the privacy boundary: the one function that decides what leaves
 * the machine. These tests exist so that boundary cannot be widened silently —
 * a new field in the wire shape has to break a test here before it can ship.
 *
 * The first case is a regression test for a bug that reached production on
 * 2026-08-05 and was only caught by reading a live dashboard.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRun, type ModelBucket, type RunAccumulator,
	recordCompaction,
} from "../extensions/hive-telemetry/accumulator.ts";
import { buildPayload } from "../extensions/hive-telemetry/payload.ts";
import type { ResolvedConfig } from "../extensions/hive-telemetry/types.ts";

const CFG: ResolvedConfig = {
	enabled: true,
	url: "https://hive.example/api/v1/agent-sessions",
	flushIntervalMs: 120_000,
	eventThreshold: 25,
	spoolEveryFlush: false,
	projectOverride: null,
};

const T0 = 1_770_000_000_000;
const inheritedLaunchId = process.env.HIVE_LAUNCH_ID;

beforeEach(() => {
	delete process.env.HIVE_LAUNCH_ID;
});

afterEach(() => {
	if (inheritedLaunchId === undefined) delete process.env.HIVE_LAUNCH_ID;
	else process.env.HIVE_LAUNCH_ID = inheritedLaunchId;
});

function run(): RunAccumulator {
	return createRun("run-1", "sess-1", "", "workstation", T0);
}

function model(a: RunAccumulator, key: string, patch: Partial<ModelBucket>) {
	a.models.set(key, { ...bucket(), ...patch });
}

function bucket(): ModelBucket {
	return {
		model: "m",
		provider: "p",
		authMode: "api_key",
		turns: 1,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

describe("buildPayload — billing honesty", () => {
	it("reports a model that burned tokens at zero cost as `unknown`, not `api_key`", () => {
		// PRODUCTION BUG, 2026-08-05: cursor/composer-2-5 has no entry in pi's
		// bundled price table, so it reports 16920 in / 150 out at cost 0. Sent as
		// api_key the server classified it `metered` and the dashboard stated
		// "$0.00 billable" for real work — confidently wrong in the flattering
		// direction, the exact failure the three-way split exists to prevent.
		const a = run();
		model(a, "cursor/composer-2-5", {
			model: "composer-2-5",
			provider: "cursor",
			authMode: "api_key",
			input: 16920,
			output: 150,
			cost: 0,
		});

		const [m] = buildPayload(a, CFG, "0.83.0", T0).models;
		expect(m.auth_mode).toBe("unknown");
	});

	it("keeps a priced model's declared auth mode", () => {
		const a = run();
		model(a, "openrouter/x", { authMode: "api_key", input: 100, output: 10, cost: 0.02 });

		const [m] = buildPayload(a, CFG, "0.83.0", T0).models;
		expect(m.auth_mode).toBe("api_key");
		expect(m.cost_usd).toBeCloseTo(0.02);
	});

	it("does not downgrade a model that simply did no work", () => {
		// Zero tokens AND zero cost is not evidence of an unpriced model.
		const a = run();
		model(a, "openai-codex/gpt", { authMode: "subscription", input: 0, output: 0, cost: 0 });

		const [m] = buildPayload(a, CFG, "0.83.0", T0).models;
		expect(m.auth_mode).toBe("subscription");
	});

	it("never emits a non-finite cost", () => {
		// One +Inf row would make every SUM(cost_usd) Infinity org-wide, forever.
		const a = run();
		model(a, "p/m", { input: 1, output: 1, cost: Number.POSITIVE_INFINITY });

		const [m] = buildPayload(a, CFG, "0.83.0", T0).models;
		expect(Number.isFinite(m.cost_usd)).toBe(true);
		expect(m.cost_usd).toBe(0);
	});
});

describe("buildPayload — the allowlist", () => {
	it("emits exactly the permitted top-level keys and nothing else", () => {
		// The guard against silent widening. A new field must be added here
		// deliberately, which is the moment to ask whether it is metrics-only.
		// launch_id is deliberately NOT set in this test's environment: absent
		// the env var, the key must be absent from the wire.
		const a = run();
		a.project = { repo: "Artifex-org/hive", projectHint: "hive" };
		const p = buildPayload(a, CFG, "0.83.0", T0 + 1000);

		expect(Object.keys(p).sort()).toEqual(
			[
				"agent",
				"agent_version",
				"client_run_id",
				"client_session_id",
				"duration_ms",
				"gates",
				// Added deliberately (HIV-1176). It is a BOOLEAN about the process —
				// "is a human sitting at this" — not a name, a path, or anything the
				// rest of this list is here to keep out.
				"interactive",
				"models",
				"outcome",
				"parent_session_id",
				"repo",
				"seq",
				"source",
				"started_at",
				"status",
				"tool_calls",
				"tool_errors",
				"compactions",
				"compaction_overflows",
				"tools",
				"turns",
			].sort(),
		);
	});

	it("emits the git remote as owner/repo, never a filesystem path", () => {
		const a = run();
		a.project = { repo: "Artifex-org/hive", projectHint: "/home/someone/repos/hive" };
		expect(buildPayload(a, CFG, "0.83.0", T0).repo).toBe("Artifex-org/hive");
	});

	it("falls back to the pseudonymous bucket when there is no remote", () => {
		const a = run();
		a.project = { repo: "", projectHint: "local-ab12cd34ef56" };
		expect(buildPayload(a, CFG, "0.83.0", T0).repo).toBe("local-ab12cd34ef56");
	});

	// launch_id closes the launch→session loop the node cannot close itself. A
	// Hive-minted UUID, never a path or a name — and only when Hive actually
	// launched this process.
	it("emits launch_id only when HIVE_LAUNCH_ID is set", () => {
		expect("launch_id" in buildPayload(run(), CFG, "0.83.0", T0)).toBe(false);
		process.env.HIVE_LAUNCH_ID = "8b6be0d2-3f5e-4e0e-9a30-1c8f0a1c2d3e";
		try {
			expect(buildPayload(run(), CFG, "0.83.0", T0).launch_id).toBe(
				"8b6be0d2-3f5e-4e0e-9a30-1c8f0a1c2d3e",
			);
		} finally {
			delete process.env.HIVE_LAUNCH_ID;
		}
	});
});

describe("buildPayload — terminal snapshots", () => {
	it("omits ended_at while the run is active", () => {
		expect(buildPayload(run(), CFG, "0.83.0", T0)).not.toHaveProperty("ended_at");
	});

	it("pairs ended_at with a terminal status", () => {
		// The server rejects an ended_at on a non-terminal snapshot and requires
		// one on a terminal snapshot, so the two fields move together or not at all.
		const a = run();
		a.status = "ended";
		a.endedAtMs = T0 + 5000;

		const p = buildPayload(a, CFG, "0.83.0", T0 + 9999);
		expect(p.status).toBe("ended");
		expect(p.ended_at).toBe(new Date(T0 + 5000).toISOString());
		// Duration is measured to the end, not to the snapshot clock.
		expect(p.duration_ms).toBe(5000);
	});
});

describe("buildPayload — caps and clamping", () => {
	it("clamps tool errors to calls so the server CHECK cannot reject the row", () => {
		const a = run();
		a.tools.set("bash", { calls: 2, errors: 7 });

		const [t] = buildPayload(a, CFG, "0.83.0", T0).tools;
		expect(t.errors).toBe(2);
	});

	it("truncates the wire arrays at the server's caps", () => {
		const a = run();
		for (let i = 0; i < 200; i++) a.tools.set(`tool_${i}`, { calls: 1, errors: 0 });

		expect(buildPayload(a, CFG, "0.83.0", T0).tools).toHaveLength(128);
	});
});

describe("buildPayload — reasoning tokens", () => {
	// The server distinguishes NULL ("no provider reported a breakdown") from 0
	// ("a provider reported one, and the model did not think"). Sending 0 for the
	// first case would assert a measurement nobody took, and would make a model
	// whose provider is simply silent look like a model that never thinks.
	it("omits the key entirely when no turn reported a reasoning breakdown", () => {
		const a = run();
		model(a, "m", { output: 500 }); // bucket.reasoning left undefined
		const [m] = buildPayload(a, CFG, "0.83.0", T0).models;
		expect("reasoning_tokens" in m).toBe(false);
	});

	it("sends an explicit 0 when the provider reported a breakdown of zero", () => {
		const a = run();
		model(a, "m", { output: 500, reasoning: 0 });
		const [m] = buildPayload(a, CFG, "0.83.0", T0).models;
		expect(m.reasoning_tokens).toBe(0);
	});

	// Reasoning is a SUBSET of output — pi's Usage type says "output already
	// includes these tokens" — so output must be reported unchanged. Adding them
	// would double-count and make a thinking model look twice as expensive.
	it("reports reasoning as a subset, leaving output untouched", () => {
		const a = run();
		model(a, "m", { output: 9000, reasoning: 8000 });
		const [m] = buildPayload(a, CFG, "0.83.0", T0).models;
		expect(m.output_tokens).toBe(9000);
		expect(m.reasoning_tokens).toBe(8000);
	});
});

describe("buildPayload — compaction", () => {
	// "overflow" means the session ran OUT of context; "threshold" is routine
	// housekeeping. Burying both in one total would hide the only one that
	// indicates a problem.
	it("counts overflows separately from the total", () => {
		const a = run();
		recordCompaction(a, "threshold", 180_000);
		recordCompaction(a, "overflow", 220_000);
		recordCompaction(a, "manual", 90_000);
		const p = buildPayload(a, CFG, "0.83.0", T0);
		expect(p.compactions).toBe(3);
		expect(p.compaction_overflows).toBe(1);
		expect(p.compaction_tokens_before).toBe(490_000);
	});

	// A session that never compacted reports 0 — a real measurement, since the
	// client counts them for every session. But it must NOT report a context
	// size of 0, which would be a measurement nobody took.
	it("reports zero compactions but omits the size entirely", () => {
		const p = buildPayload(run(), CFG, "0.83.0", T0);
		expect(p.compactions).toBe(0);
		expect(p.compaction_overflows).toBe(0);
		expect("compaction_tokens_before" in p).toBe(false);
	});
})

// Not every pi process is a session (HIV-1176).
//
// `pi-delegate` spawning pi to answer one question for another agent registers
// identically to a real session — own conversation, two turns, gone in twelve
// seconds — and each one appeared in the Hive agents workspace as an agent to
// supervise. Three of them run on a single workstation.
describe("interactive", () => {
	const stdout = process.stdout;

	afterEach(() => {
		Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
	});

	function withTTY(isTTY: boolean) {
		Object.defineProperty(process, "stdout", {
			value: { ...stdout, isTTY },
			configurable: true,
		});
	}

	it("reports true in a real terminal", () => {
		withTTY(true);
		expect(buildPayload(run(), CFG, "0.83.0", Date.now()).interactive).toBe(true);
	});

	// A delegate's stdout is a pipe. $TMUX would NOT separate these — it is
	// inherited, which is why one delegate reported living in tmux session "68"
	// with nobody in it.
	it("reports false when stdout is a pipe", () => {
		withTTY(false);
		expect(buildPayload(run(), CFG, "0.83.0", Date.now()).interactive).toBe(false);
	});

	// A cloud launch runs `pi --mode rpc` in a pod: stdout is the wrapper's
	// pipe, but a human supervises it from the workspace. The launch path
	// asserts that with HIVE_INTERACTIVE=1 — a delegate never sets it, so the
	// HIV-1176 separation survives.
	it("reports true for a piped process when HIVE_INTERACTIVE=1", () => {
		withTTY(false);
		process.env.HIVE_INTERACTIVE = "1";
		try {
			expect(buildPayload(run(), CFG, "0.83.0", Date.now()).interactive).toBe(true);
		} finally {
			delete process.env.HIVE_INTERACTIVE;
		}
	});

	// The field is a boolean about the process. It must never become a name, a
	// path, or anything else this file's allowlist exists to keep out.
	it("is a boolean, always present", () => {
		withTTY(false);
		const payload = buildPayload(run(), CFG, "0.83.0", Date.now());
		expect(typeof payload.interactive).toBe("boolean");
	});
});
