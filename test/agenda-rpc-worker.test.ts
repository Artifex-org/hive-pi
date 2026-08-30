import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
	advanceDesiredTurns,
	durableWorkerID,
	intentionallyStoppedResult,
	reachedDesiredTurns,
	startDurableWorker,
	WorkerRegistry,
	type WorkerHandle,
} from "../extensions/agenda/rpc-worker.ts";
import { emptyWorkerState } from "../extensions/agenda/rpc-protocol.ts";

function rpcChild(writes: string[]): ChildProcess {
	const child = new EventEmitter();
	Object.assign(child, {
		stdin: {
			writable: true,
			write(line: string) {
				writes.push(line);
				return true;
			},
		},
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	});
	return child as unknown as ChildProcess;
}

function handle(id: string): WorkerHandle & { aliveValue: { value: boolean } } {
	const aliveValue = { value: true };
	return {
		id,
		role: "research",
		cwd: "/tmp/repo",
		state: () => emptyWorkerState,
		alive: () => aliveValue.value,
		send: vi.fn(async () => {}),
		waitForSettle: vi.fn(async () => {}),
		stop: vi.fn(() => { aliveValue.value = false; }),
		aliveValue,
	};
}

describe("durable worker startup", () => {
	it("prompts the first task and preserves later delivery modes", async () => {
		const writes: string[] = [];
		const worker = startDurableWorker(
			{ id: "worker", role: "research", cwd: "/tmp/repo" },
			(() => rpcChild(writes)) as typeof import("node:child_process").spawn,
		);

		await worker.send("start", "follow_up");
		await worker.send("more scope", "follow_up");
		await worker.send("change course", "steer");

		expect(writes.map((line) => JSON.parse(line))).toEqual([
			{ id: "worker-1", type: "prompt", message: "start" },
			{ id: "worker-2", type: "follow_up", message: "more scope" },
			{ id: "worker-3", type: "steer", message: "change course" },
		]);
		worker.stop();
	});
});

describe("durable worker turn generations", () => {
	it("makes an in-flight steer supersede the interrupted turn's settlement", () => {
		let desired = advanceDesiredTurns(0, 0); // original prompt
		desired = advanceDesiredTurns(desired, 0); // steer while it is still busy

		expect(desired).toBe(2);
		expect(reachedDesiredTurns(false, 1, desired)).toBe(false); // interrupted turn settled
		expect(reachedDesiredTurns(false, 2, desired)).toBe(true); // steered turn settled
	});

	it("queues every additional follow-up as another required turn", () => {
		let desired = advanceDesiredTurns(0, 4);
		desired = advanceDesiredTurns(desired, 4);
		desired = advanceDesiredTurns(desired, 5);
		expect(desired).toBe(7);
	});
});

describe("production worker identity and stop result", () => {
	it("keeps identical work independently addressable across runs", () => {
		const first = durableWorkerID("run-a", "review", "0123456789abcdef");
		const second = durableWorkerID("run-b", "review", "0123456789abcdef");
		expect(first).not.toBe(second);
		expect(first).toContain("0123456789abcdef");
	});

	it("represents an intentional stop as a successful joinable value", () => {
		const worker = handle("worker");
		expect(intentionallyStoppedResult(worker)).toEqual({
			ok: true,
			value: { status: "stopped_by_orchestrator", worker_id: "worker" },
			tokens: 0,
			cost: 0,
		});
	});
});

describe("WorkerRegistry", () => {
	it("queues overlapping waves behind one session-global concurrency bound", async () => {
		const registry = new WorkerRegistry(2);
		const release1 = await registry.acquire();
		const release2 = await registry.acquire();
		let thirdEntered = false;
		const third = registry.acquire().then((release) => {
			thirdEntered = true;
			return release;
		});

		await Promise.resolve();
		expect(thirdEntered).toBe(false);
		release1();
		const release3 = await third;
		expect(thirdEntered).toBe(true);
		release2();
		release3();
	});

	it("rejects duplicate ids instead of overwriting an addressable worker", () => {
		const registry = new WorkerRegistry();
		registry.register(handle("same"));
		expect(() => registry.register(handle("same"))).toThrow("id collision");
	});

	it("cleanup from an old handle cannot remove a replacement", () => {
		const registry = new WorkerRegistry();
		const old = handle("worker");
		const replacement = handle("worker");
		registry.register(old);
		registry.remove(old.id, old);
		registry.register(replacement);

		expect(registry.remove(old.id, old)).toBe(false);
		expect(registry.get("worker")).toBe(replacement);
	});

	it("intentional stop makes the worker unreachable and records intent", () => {
		const registry = new WorkerRegistry();
		const worker = handle("worker");
		registry.register(worker);

		expect(registry.stop(worker.id)).toBe(worker);
		expect(worker.stop).toHaveBeenCalledOnce();
		expect(registry.wasIntentionallyStopped(worker)).toBe(true);
		expect(registry.get(worker.id)).toBeUndefined();
	});

	it("drops a worker that exited before its owning run unwound", () => {
		const registry = new WorkerRegistry();
		const worker = handle("dead");
		registry.register(worker);
		worker.aliveValue.value = false;
		expect(registry.list()).toEqual([]);
	});
});
