/**
 * The accumulator's whole reason to exist is that totals derived from the
 * session branch DECREASE after a compaction — money already spent vanishes
 * from `getBranch()`. These tests pin the properties that make event-folding
 * structurally incapable of that: monotonicity, per-model attribution, bounded
 * cardinality, and the refusal to carry any free text.
 */

import { describe, expect, it } from "vitest";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	MAX_MODELS,
	MAX_PENDING_TOOLS,
	MAX_TOOLS,
	classifyError,
	createRun,
	foldGate,
	foldMessageEnd,
	foldToolEnd,
	foldToolStart,
	foldToolUsage,
	foldTurnEnd,
	markEnded,
	resolveEndOutcome,
	sanitizeName,
	shouldHeartbeat,
} from "../extensions/hive-telemetry/accumulator.ts";

const T0 = 1_770_000_000_000;

function run() {
	return createRun("run-1", "sess-1", "", "workstation", T0);
}

function usage(input: number, output: number, cost = 0): Usage {
	return { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } as unknown as Usage;
}

function assistant(provider: string, model: string, u: Usage, responseModel?: string): AssistantMessage {
	return { role: "assistant", provider, model, responseModel, usage: u } as unknown as AssistantMessage;
}

describe("foldMessageEnd — attribution and monotonicity", () => {
	it("never decreases a total, which is the property getBranch() cannot offer", () => {
		const a = run();
		foldMessageEnd(a, assistant("openai-codex", "gpt-5.6-sol", usage(1000, 100)), true);
		const afterFirst = a.models.get("openai-codex/gpt-5.6-sol")!.input;

		// A compaction here removes entries from the session branch. The
		// accumulator never looks back at the tree, so the next fold can only add.
		foldMessageEnd(a, assistant("openai-codex", "gpt-5.6-sol", usage(500, 50)), true);

		expect(a.models.get("openai-codex/gpt-5.6-sol")!.input).toBe(afterFirst + 500);
	});

	it("keeps one bucket per model rather than crediting the last one reached", () => {
		// The failure migration 0131 records about factory_spend: a single model
		// column on a multi-model run credits everything to whichever finished.
		const a = run();
		foldMessageEnd(a, assistant("openai-codex", "gpt-5.6-luna", usage(100, 10)), true);
		foldMessageEnd(a, assistant("openai-codex", "gpt-5.6-sol", usage(900, 90)), true);

		expect(a.models.size).toBe(2);
		expect(a.models.get("openai-codex/gpt-5.6-luna")!.input).toBe(100);
		expect(a.models.get("openai-codex/gpt-5.6-sol")!.input).toBe(900);
	});

	it("attributes to the RESPONSE model so provider routing stays visible", () => {
		const a = run();
		foldMessageEnd(a, assistant("openrouter", "auto", usage(10, 1), "anthropic/claude-opus-4.8"), false);

		expect([...a.models.keys()]).toEqual(["openrouter/anthropic/claude-opus-4.8"]);
	});

	it("declares subscription auth when the cost is notional", () => {
		const a = run();
		foldMessageEnd(a, assistant("openai-codex", "gpt-5.6-sol", usage(10, 1, 0.5)), true);

		expect(a.models.get("openai-codex/gpt-5.6-sol")!.authMode).toBe("subscription");
	});

	it("ignores a non-finite cost rather than poisoning the sum", () => {
		const a = run();
		foldMessageEnd(a, assistant("p", "m", usage(10, 1, Number.POSITIVE_INFINITY)), false);

		expect(a.models.get("p/m")!.cost).toBe(0);
	});

	it("drops a message with no model instead of creating an empty bucket", () => {
		const a = run();
		foldMessageEnd(a, assistant("p", "", usage(10, 1)), false);

		expect(a.models.size).toBe(0);
	});

	it("stops creating buckets at the cardinality cap", () => {
		const a = run();
		for (let i = 0; i < MAX_MODELS + 10; i++) {
			foldMessageEnd(a, assistant("p", `m${i}`, usage(1, 1)), false);
		}
		expect(a.models.size).toBe(MAX_MODELS);
	});
});

describe("foldToolUsage — nested subagent spend", () => {
	it("keeps legacy or missing details in the explicit unknown bucket", () => {
		// Missing identity must not undercount or acquire a plausible model.
		const a = run();
		foldToolUsage(a, usage(5000, 400, 0.03));

		const b = a.models.get("nested/subagent")!;
		expect(b.input).toBe(5000);
		expect(b.cost).toBeCloseTo(0.03);
		expect(b.authMode).toBe("unknown");
	});

	it("preserves verified child provider/model and billing facts", () => {
		const a = run();
		foldToolUsage(a, usage(5000, 400, 0.05), [
			{ provider: "zai", model: "glm-5.3-flash", authMode: "subscription", turns: 2, input: 4500, output: 350, cacheRead: 0, cacheWrite: 0, cost: 0.04 },
			{ provider: "openrouter", model: "deepseek/deepseek-v4-flash", authMode: "api_key", turns: 1, input: 500, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
		]);

		expect(a.models.get("zai/glm-5.3-flash")).toMatchObject({ authMode: "subscription", turns: 2, input: 4500, cost: 0.04 });
		expect(a.models.get("openrouter/deepseek/deepseek-v4-flash")).toMatchObject({ authMode: "api_key", turns: 1, input: 500, cost: 0.01 });
		expect(a.models.has("nested/subagent")).toBe(false);
	});

	it("falls back when metric details do not reconcile with aggregate usage", () => {
		const a = run();
		foldToolUsage(a, usage(5000, 400, 0.03), [
			{ provider: "zai", model: "glm-5.3-flash", authMode: "subscription", turns: 1, input: 4999, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0.03 },
		]);

		expect(a.models.has("zai/glm-5.3-flash")).toBe(false);
		expect(a.models.get("nested/subagent")?.input).toBe(5000);
	});

	it("is a no-op when the tool reported no usage", () => {
		const a = run();
		foldToolUsage(a, undefined);
		expect(a.models.size).toBe(0);
	});
});

describe("tool folds — names only, bounded", () => {
	it("counts calls and errors, and recovers the name from the pending map", () => {
		const a = run();
		foldToolStart(a, "call-1", "mcp__qmd__query");
		foldToolEnd(a, "call-1", "", false);
		foldToolStart(a, "call-2", "mcp__qmd__query");
		foldToolEnd(a, "call-2", "", true);

		// The unclassified error becomes `other` rather than vanishing: an error
		// whose kind nobody determined is still an error, and folding it into
		// nothing would make the kind counts disagree with the error total.
		expect(a.tools.get("mcp__qmd__query")).toEqual({
			calls: 2,
			errors: 1,
			errorKinds: new Map([["other", 1]]),
		});
		expect(a.toolCalls).toBe(2);
		expect(a.toolErrors).toBe(1);
	});

	it("releases the pending entry once the tool ends", () => {
		const a = run();
		foldToolStart(a, "call-1", "bash");
		foldToolEnd(a, "call-1", "bash", false);

		expect(a.pending.size).toBe(0);
	});

	it("evicts oldest-first so an aborted tool cannot leak the map", () => {
		// A tool interrupted with Ctrl-C may never emit its end event. This
		// eviction is the only thing bounding the map if that is true.
		const a = run();
		for (let i = 0; i < MAX_PENDING_TOOLS + 25; i++) foldToolStart(a, `call-${i}`, "bash");

		expect(a.pending.size).toBe(MAX_PENDING_TOOLS);
		expect(a.pending.has("call-0")).toBe(false);
		expect(a.pending.has(`call-${MAX_PENDING_TOOLS + 24}`)).toBe(true);
	});

	it("stops creating tool buckets at the cardinality cap", () => {
		const a = run();
		for (let i = 0; i < MAX_TOOLS + 10; i++) foldToolEnd(a, `c${i}`, `tool_${i}`, false);

		expect(a.tools.size).toBe(MAX_TOOLS);
	});
});

describe("foldTurnEnd", () => {
	it("counts session turns rather than the per-run turnIndex", () => {
		// turnIndex resets to 0 on every agent_start, so it is a per-run counter.
		const a = run();
		foldTurnEnd(a);
		foldTurnEnd(a);
		foldTurnEnd(a);

		expect(a.turns).toBe(3);
	});
});

describe("foldGate — untrusted bus input", () => {
	it("tallies each outcome", () => {
		const a = run();
		foldGate(a, { kind: "gate", name: "verification-loop", outcome: "pass", value: 1200 });
		foldGate(a, { kind: "gate", name: "verification-loop", outcome: "fail", value: 800 });

		expect(a.gates.get("verification-loop")).toEqual({
			passed: 1,
			failed: 1,
			timedOut: 0,
			skipped: 0,
			durationMs: 2000,
		});
	});

	it("ignores an unrecognised outcome instead of inventing a bucket state", () => {
		const a = run();
		foldGate(a, { kind: "gate", name: "g", outcome: "banana" as never, value: 1 });

		expect(a.gates.get("g")).toEqual({ passed: 0, failed: 0, timedOut: 0, skipped: 0, durationMs: 0 });
	});
});

describe("sanitizeName — the bus is a path past the allowlist if unguarded", () => {
	it("strips anything that could carry a path or a client name", () => {
		expect(sanitizeName("/home/dev/repos/acme-corp/secret.ts")).toBe("_home_dev_repos_acme-corp_secret.ts");
	});

	it("length-bounds the result", () => {
		expect(sanitizeName("x".repeat(500))).toHaveLength(64);
	});

	it("returns empty for a non-string", () => {
		expect(sanitizeName(undefined as unknown as string)).toBe("");
	});
});

describe("classifyError — classify then DISCARD the string", () => {
	it.each([
		["Rate limit exceeded for org", "rate_limit"],
		["upstream returned 503, overloaded", "overloaded"],
		["context length exceeded", "context_length"],
		["401 Unauthorized", "auth"],
		["request timed out", "timeout"],
		["connect ECONNREFUSED 127.0.0.1:9", "network"],
		["The operation was aborted", "aborted"],
		["something nobody anticipated", "unknown"],
	])("maps %j to %s", (message, expected) => {
		expect(classifyError(message)).toBe(expected);
	});

	it("returns an enum member, never the message, for text quoting a prompt", () => {
		const leaky = "Request failed: prompt was 'migrate the acme-corp billing schema'";
		expect(classifyError(leaky)).toBe("unknown");
	});

	it("handles an absent message", () => {
		expect(classifyError(undefined)).toBe("unknown");
	});
});

describe("markEnded", () => {
	it("records a terminal snapshot with a bounded outcome", () => {
		const a = run();
		markEnded(a, "x".repeat(100), T0 + 42);

		expect(a.status).toBe("ended");
		expect(a.endedAtMs).toBe(T0 + 42);
		expect(a.outcome).toHaveLength(32);
	});
});

describe("resolveEndOutcome", () => {
	it("maps a plain quit to completed", () => {
		expect(resolveEndOutcome(undefined, "quit")).toBe("completed");
	});

	it("passes a non-quit shutdown reason through", () => {
		expect(resolveEndOutcome(undefined, "reload")).toBe("reload");
	});

	// The regression this exists for. A kill from the Hive agents workspace
	// shuts pi down GRACEFULLY, so pi reports "quit" — identical to a user
	// typing /quit. Without the announced reason the session was recorded as
	// `completed`: an operator stopping a wedged agent looked, in every fleet
	// aggregate, exactly like an agent that finished its work.
	it("prefers an announced kill over a graceful quit", () => {
		expect(resolveEndOutcome("killed", "quit")).toBe("killed");
	});
});

/**
 * A busy session must still say it is alive (HIV-1996).
 *
 * The tick used to skip the heartbeat whenever it had QUEUED a usage flush.
 * `dirty > 0` is true on every tick of a working session, so a busy run never
 * once reached the heartbeat: `last_seen_at` was NULL for a whole 22-turn
 * session (a78c92ef, 2026-08-17). When the flush loop then stopped, the
 * server's 5-minute sweep ended the session `heartbeat_timeout` while the agent
 * kept working — 22 turns and $1.57 recorded against the pane's 59 and $6.11,
 * hidden from every `only_live` view.
 */
describe("shouldHeartbeat", () => {
	const INTERVAL = 60_000;
	const at = (lastFlushOkMs: number) => ({ lastFlushOkMs });

	it("ALWAYS beats when no flush was queued — the idle path, unchanged", () => {
		expect(shouldHeartbeat(at(0), false, 1_000, INTERVAL)).toBe(true);
		expect(shouldHeartbeat(at(999), false, 1_000, INTERVAL)).toBe(true);
	});

	it("beats from tick one, before any flush has ever landed", () => {
		// lastFlushOkMs is 0 until the first ACK. This single case is the measured
		// bug: a session that is busy from its first tick used to start life
		// invisible and stay that way.
		expect(shouldHeartbeat(at(0), true, 1_000, INTERVAL)).toBe(true);
	});

	it("stays silent while an acknowledged flush is recent — the optimisation survives", () => {
		// "Reporting usage IS contact" is right, and this is the case where it is
		// true: the server heard from us 10s ago.
		expect(shouldHeartbeat(at(50_000), true, 60_000, INTERVAL)).toBe(false);
	});

	it("beats again once the last LANDED flush is two intervals old", () => {
		// The stall. Flushes are still being queued — `flushing` is true — but
		// nothing has arrived, which is exactly what reaped a78c92ef.
		expect(shouldHeartbeat(at(0), true, 2 * INTERVAL, INTERVAL)).toBe(true);
		expect(shouldHeartbeat(at(1_000), true, 1_000 + 2 * INTERVAL, INTERVAL)).toBe(true);
	});

	it("tolerates ONE slow flush without double-posting", () => {
		// A POST in flight legitimately occupies about an interval. One interval
		// of silence is normal; two is a stall. Pinned so a future tightening to
		// 1x has to be a deliberate change.
		//
		// A flush must have LANDED for this to be the question — `lastFlushOkMs:
		// 0` is the never-landed case above, and writing this with 0 is how the
		// first draft of this test asserted the opposite of what it meant.
		expect(shouldHeartbeat(at(1_000), true, 1_000 + INTERVAL, INTERVAL)).toBe(false);
		expect(shouldHeartbeat(at(1_000), true, 1_000 + 2 * INTERVAL - 1, INTERVAL)).toBe(false);
	});
});
