/**
 * The durable worker's dispatch against pi's REAL queue semantics.
 *
 * Every orchestrate worker in a session once read "idle, 0 turn(s), 0 tokens"
 * for the full settle timeout. The child was fine; the parent's first dispatch
 * was a `follow_up`, which pi 0.84.2 queues on an idle agent and never drains
 * (measured: `response success` + `queue_update`, no `agent_start`). The unit
 * tests around `advanceDesiredTurns` could not see it because they never send
 * anything. These do, through a fake `pi` that models exactly that behaviour
 * (test/fixtures/fake-rpc-pi.mjs), so the regression is a red test rather than
 * a fifteen-minute silence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import { dispatchCommand, finalText } from "../extensions/agenda/rpc-protocol.ts";
import { startDurableWorker, type WorkerHandle } from "../extensions/agenda/rpc-worker.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-rpc-pi.mjs", import.meta.url));

describe("dispatchCommand", () => {
	it("is always a prompt, with the mode selecting the queue", () => {
		expect(dispatchCommand("w-1", "go", "follow_up")).toEqual({
			id: "w-1",
			type: "prompt",
			message: "go",
			streamingBehavior: "followUp",
		});
		expect(dispatchCommand("w-2", "stop that", "steer")).toEqual({
			id: "w-2",
			type: "prompt",
			message: "stop that",
			streamingBehavior: "steer",
		});
	});

	it("never emits the queue-only commands that strand an idle child", () => {
		for (const mode of ["steer", "follow_up"] as const) {
			expect(dispatchCommand("w", "m", mode).type).toBe("prompt");
		}
	});
});

describe("durable worker against pi 0.84 queue semantics", () => {
	const previous = process.env.PI_HOUSE_PI_BIN;
	const live: WorkerHandle[] = [];

	beforeAll(() => {
		process.env.PI_HOUSE_PI_BIN = FAKE_PI;
	});
	afterAll(() => {
		for (const worker of live) worker.stop();
		if (previous === undefined) delete process.env.PI_HOUSE_PI_BIN;
		else process.env.PI_HOUSE_PI_BIN = previous;
	});

	it("starts a turn on an idle worker when delivery is follow_up", async () => {
		const worker = startDurableWorker({ id: "dispatch-1", role: "research", cwd: process.cwd() });
		live.push(worker);

		await worker.send("hello", "follow_up");
		await worker.waitForSettle(10_000);

		const state = worker.state();
		expect(worker.startFailure?.()).toBeUndefined();
		expect(state.turns).toBe(1);
		expect(state.everSettled).toBe(true);
		expect(finalText(state)).toBe("echo: hello");
		expect(state.tokens).toBeGreaterThan(0);
	});

	it("names a dispatch the child accepted and never started, instead of waiting out the settle timeout", async () => {
		const worker = startDurableWorker({
			id: "dispatch-2",
			role: "research",
			cwd: process.cwd(),
			env: { FAKE_RPC_PI_MODE: "never-start" },
			startTimeoutMs: 400,
		});
		live.push(worker);

		const startedAt = Date.now();
		await worker.send("hello", "follow_up");
		await worker.waitForSettle(10_000);

		expect(Date.now() - startedAt).toBeLessThan(5_000);
		expect(worker.alive()).toBe(true);
		expect(worker.state().turns).toBe(0);
		expect(worker.startFailure?.()).toMatch(/never started a turn within 400ms/);
		expect(worker.startFailure?.()).toContain('received {"id":"dispatch-2-1","type":"prompt"');
	});
});

/**
 * The same dispatch against the REAL binary. Opt-in like orchestrator-live:
 *
 *   PI_HOUSE_LIVE=1 PI_HOUSE_PI_BIN=~/.hive/harness/bin/pi \
 *     PI_HOUSE_LIVE_MODEL=openai-codex/gpt-5.6-luna \
 *     npx vitest run --pool=forks test/agenda-rpc-worker-dispatch.test.ts
 *
 * The fake above encodes what pi did on the day this was fixed; this is the
 * check that pi still does it, which is the only thing that can make the fake
 * lie.
 */
const LIVE = process.env.PI_HOUSE_LIVE === "1";
const LIVE_MODEL = process.env.PI_HOUSE_LIVE_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";

describe.skipIf(!LIVE)("durable worker against the real pi", () => {
	it("completes one turn from a follow_up dispatch on a fresh worker", async () => {
		const worker = startDurableWorker({
			id: "live-dispatch",
			role: "research",
			cwd: process.cwd(),
			model: LIVE_MODEL,
			tools: ["read"],
		});
		try {
			await worker.send("Reply with the single word OK and nothing else.", "follow_up");
			await worker.waitForSettle(120_000);
			expect(worker.startFailure?.()).toBeUndefined();
			expect(worker.state().turns).toBeGreaterThanOrEqual(1);
			expect(finalText(worker.state())).toMatch(/OK/);
		} finally {
			worker.stop();
		}
	}, 150_000);
});
