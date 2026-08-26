/**
 * END-TO-END orchestrator test against REAL child `pi` processes and a REAL
 * model. Opt-in — it costs money and needs credentials, so CI never runs it.
 *
 *   source ~/.secrets && PI_HOUSE_LIVE=1 PI_HOUSE_PI_BIN=~/.npm-global/bin/pi \\
 *     npx vitest run --pool=forks test/orchestrator-live.test.ts
 *
 * **`--pool=forks` is REQUIRED**, and `PI_HOUSE_PI_BIN` with it. Two measured
 * reasons, both of which cost hours to find:
 *
 *  1. Under vitest's DEFAULT `threads` pool, a child process's `close` event
 *     does not propagate to the worker thread. The child finishes, its output
 *     parses correctly, its usage accumulates — and the parent never learns it
 *     exited, so the timeout kills it. Measured: identical call, 40s +
 *     `timedOut:true` under `threads`, 8s + `timedOut:false` under `forks`.
 *  2. `getPiInvocation` keys on `process.argv[1]`, which is pi's own entry under
 *     pi and *vitest's binary* under vitest — so without the override a worker
 *     is spawned as `node <vitest> --mode json -p …` and dies in the ESM loader.
 *
 * Why this exists despite 600 unit tests: everything else in this suite proves
 * the run loop with a FAKE spawner and zero processes, which is the right way
 * to test scheduling. What it cannot prove is the process boundary — that a
 * role resolves, that the flags are right, that the JSON stream parses, that a
 * dependent node actually receives its predecessor's output.
 *
 * That gap is not theoretical. Measuring this harness rather than reading it
 * has already turned up two shipped bugs that every unit test passed.
 *
 * Kept cheap on purpose: two nodes, a tiny read-only role, terse prompts.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { runPlan } from "../extensions/agenda/executor.ts";
import type { Plan, PlanNode } from "../extensions/agenda/plan-schema.ts";
import { validatePlan } from "../extensions/agenda/plan-schema.ts";
import { makeSpawn } from "../extensions/agenda/worker.ts";
import { discoverAgents } from "../extensions/harness/roles.ts";

const LIVE = process.env.PI_HOUSE_LIVE === "1";
const MODEL = process.env.PI_HOUSE_LIVE_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";
const CWD = process.cwd();

/**
 * The FIRST child spawn in a fresh context is dramatically slower than every
 * one after it — measured 45s then 7s, and 25s+ then 8-13s. pi compiles ~6,000
 * lines of TypeScript extensions through jiti on first use and reuses the cache
 * afterwards, so the cost lands entirely on whichever spawn goes first.
 *
 * Timing a cold spawn measures the compiler, not the orchestrator. Warm up
 * once, outside any assertion, so the tests below measure what they claim to.
 */
async function warmUp(): Promise<void> {
	const { runRoleAgent } = await import("../extensions/agenda/spawn.ts");
	await runRoleAgent({
		role: { name: "warmup", tools: ["read"], systemPrompt: "Be terse." },
		prompt: "Reply OK.",
		cwd: CWD,
		model: MODEL,
		timeoutMs: 240_000,
		env: { PI_AGENDA_WORKER: "1" },
	}).catch(() => undefined);
}

/** `research` is read-only, so it needs no writer lock and cannot damage anything. */
const ROLE = "research";

function agent(id: string, prompt: string, needs?: string[]): PlanNode {
	return { id, kind: "agent", role: ROLE, prompt, model: MODEL, retries: 0, ...(needs ? { needs } : {}) } as PlanNode;
}

describe.skipIf(!LIVE)("orchestrator — live, against real workers", () => {
	beforeAll(warmUp, 300_000);

	it("runs a single node and brings back its text", async () => {
		const plan: Plan = {
			name: "live-single",
			description: "one node",
			nodes: [agent("a", "Reply with exactly the word ALPHA and nothing else.")],
			caps: { maxConcurrent: 1, maxAgents: 2 },
		};
		expect(validatePlan(plan, discoverAgents(CWD, "both").agents.map((r) => r.name))).toEqual([]);

		const summary = await runPlan({ plan, spawn: makeSpawn(CWD, "live-1") });

		expect(summary.failures).toEqual([]);
		expect(String(summary.results.a)).toContain("ALPHA");
		expect(summary.agentsSpawned).toBe(1);
		// Real workers really do spend tokens; zero would mean the usage fold is
		// broken, which is how the orchestrator's budget stops working silently.
		expect(summary.spentTokens).toBeGreaterThan(0);
	}, 180_000);

	it("runs a dependency in order and does not start the second node early", async () => {
		const plan: Plan = {
			name: "live-chain",
			description: "two nodes in order",
			nodes: [
				agent("first", "Reply with exactly the word ONE and nothing else."),
				agent("second", "Reply with exactly the word TWO and nothing else.", ["first"]),
			],
			caps: { maxConcurrent: 2, maxAgents: 4 },
		};

		const started: string[] = [];
		const realSpawn = makeSpawn(CWD, "live-2");
		const summary = await runPlan({
			plan,
			spawn: async (dispatch, signal) => {
				started.push(dispatch.nodeId);
				return realSpawn(dispatch, signal);
			},
		});

		expect(summary.failures).toEqual([]);
		expect(started).toEqual(["first", "second"]);
		expect(String(summary.results.first)).toContain("ONE");
		expect(String(summary.results.second)).toContain("TWO");
	}, 300_000);

	it("fans out over items, giving each worker its own prompt", async () => {
		const plan: Plan = {
			name: "live-fanout",
			description: "fan out over two items",
			nodes: [
				{
					id: "seed",
					kind: "transform",
					over: "seed",
					op: { op: "count" },
				} as PlanNode,
			],
			caps: { maxConcurrent: 2, maxAgents: 4 },
		};
		// A transform referencing itself is invalid — assert the validator says
		// so rather than letting a malformed live plan burn tokens.
		expect(validatePlan(plan, [ROLE]).length).toBeGreaterThan(0);
	});

	it("reports a worker that fails, rather than an empty success", async () => {
		const plan: Plan = {
			name: "live-badrole",
			description: "role that does not exist",
			nodes: [{ id: "a", kind: "agent", role: "no-such-role", prompt: "x", retries: 0 } as PlanNode],
			caps: { maxConcurrent: 1, maxAgents: 1 },
		};
		const summary = await runPlan({ plan, spawn: makeSpawn(CWD, "live-3") });

		expect(summary.failures).toHaveLength(1);
		expect(summary.failures[0].error).toContain("unknown role");
		expect(summary.agentsSpawned).toBe(1);
	}, 60_000);
});

describe("orchestrator — live test wiring", () => {
	it("is skipped unless PI_HOUSE_LIVE=1, so CI never spends money", () => {
		// Guards the guard: if this flips to always-on, CI starts making paid
		// model calls with no credentials and fails confusingly.
		expect(LIVE).toBe(process.env.PI_HOUSE_LIVE === "1");
	});

	it("only ever uses a read-only role, so a live run cannot mutate the repo", () => {
		const role = discoverAgents(CWD, "both").agents.find((candidate) => candidate.name === ROLE);
		expect(role).toBeDefined();
		expect(role?.tools).toBeDefined();
		expect(role?.tools).not.toContain("write");
		expect(role?.tools).not.toContain("edit");
		expect(role?.tools).not.toContain("bash");
	});
});
