import { describe, expect, it, vi } from "vitest";

import {
	advanceDesiredTurns,
	durableWorkerID,
	intentionallyStoppedResult,
	reachedDesiredTurns,
	WorkerRegistry,
	type WorkerHandle,
} from "../extensions/agenda/rpc-worker.ts";
import { emptyWorkerState } from "../extensions/agenda/rpc-protocol.ts";

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

// The refusal this fixes was printed verbatim, one line above a listing that
// contained the very id being refused:
//
//   No live worker "96fac376567e9ec8".
//   Live workers:
//     run-38c9a8e7-…:tes8841:96fac376567e9ec8 (retriever) — idle, …
//
// A supervisor that cannot name its own worker cannot steer or stop it.
describe("WorkerRegistry.resolve", () => {
	it("accepts the trailing work id and the node id the listing prints", () => {
		const registry = new WorkerRegistry();
		const worker = handle("run-38c9a8e7:tes8841:96fac376567e9ec8");
		registry.register(worker);

		expect(registry.resolve("96fac376567e9ec8").worker).toBe(worker);
		expect(registry.resolve("tes8841").worker).toBe(worker);
		expect(registry.resolve("run-38c9a8e7:tes8841:96fac376567e9ec8").worker).toBe(worker);
	});

	it("refuses to guess when a segment names more than one worker", () => {
		const registry = new WorkerRegistry();
		const first = handle("run-a:w01:1111");
		const second = handle("run-b:w01:2222");
		registry.register(first);
		registry.register(second);

		const resolved = registry.resolve("w01");
		expect(resolved.worker).toBeUndefined();
		expect(resolved.ambiguous).toHaveLength(2);
	});

	it("reports nothing for an id that names no worker", () => {
		const registry = new WorkerRegistry();
		registry.register(handle("run-a:w01:1111"));

		expect(registry.resolve("nope")).toEqual({});
	});
});
