/**
 * The watcher is the one part of this extension with a process in it, and its
 * three failure modes are all invisible from the outside:
 *
 *  - a bare instance id, which costs agmsg's liveness guard (the watcher then
 *    outlives the pi that started it);
 *  - chunk-boundary parsing, which drops or splices messages under load and
 *    only under load;
 *  - a restart loop against a watcher that exited because there was nothing to
 *    do, which spawns a process a second forever in every unjoined project.
 *
 * All three are tested here against an injected spawn, so no bash and no agmsg
 * install are involved.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { instanceId, startWatcher } from "../extensions/agmsg/watcher.ts";
import type { AgmsgMessage } from "../extensions/agmsg/message.ts";

class FakeChild extends EventEmitter {
	stdout = new PassThrough({ encoding: "utf8" });
	stderr = new PassThrough({ encoding: "utf8" });
	killed: string | undefined;
	kill(signal: string) {
		this.killed = signal;
		return true;
	}
}

function harness() {
	const spawns: Array<{ command: string; args: string[] }> = [];
	const children: FakeChild[] = [];
	const timers: Array<{ fn: () => void; ms: number }> = [];
	const messages: AgmsgMessage[] = [];
	const notices: string[] = [];

	const spawnFn = ((command: string, args: string[]) => {
		spawns.push({ command, args });
		const child = new FakeChild();
		children.push(child);
		return child;
	}) as never;

	const scheduler = (fn: () => void, ms: number) => {
		timers.push({ fn, ms });
		return 0;
	};

	return { spawns, children, timers, messages, notices, spawnFn, scheduler };
}

describe("instanceId", () => {
	it("is composite, so agmsg's liveness guard can see the pi process", () => {
		expect(instanceId("019f-abc", 4242)).toBe("019f-abc.4242");
	});

	it("still yields a composite id for an ephemeral session with no id", () => {
		expect(instanceId(undefined, 7)).toBe("pi-7.7");
	});
});

describe("startWatcher", () => {
	it("passes the composite id, the project and the type — and no active name by default", () => {
		const h = harness();
		startWatcher({
			project: "/repo",
			sessionId: "sid",
			pid: 99,
			home: "/agmsg",
			onMessage: (m) => h.messages.push(m),
			onNotice: (n) => h.notices.push(n),
			spawnFn: h.spawnFn,
			scheduler: h.scheduler,
		});
		expect(h.spawns[0].command).toBe("/agmsg/scripts/watch.sh");
		expect(h.spawns[0].args).toEqual(["sid.99", "/repo", "pi"]);
	});

	it("appends the active name for a claimed role, so the watcher receives exclusively", () => {
		const h = harness();
		startWatcher({
			project: "/repo",
			sessionId: "sid",
			pid: 99,
			home: "/agmsg",
			activeName: "alice",
			onMessage: (m) => h.messages.push(m),
			onNotice: (n) => h.notices.push(n),
			spawnFn: h.spawnFn,
			scheduler: h.scheduler,
		});
		expect(h.spawns[0].args).toEqual(["sid.99", "/repo", "pi", "alice"]);
	});

	it("reassembles a message split across chunks, and splits two that arrive in one", () => {
		const h = harness();
		startWatcher({
			project: "/repo",
			sessionId: "sid",
			pid: 1,
			home: "/agmsg",
			onMessage: (m) => h.messages.push(m),
			onNotice: (n) => h.notices.push(n),
			spawnFn: h.spawnFn,
			scheduler: h.scheduler,
		});

		const child = h.children[0];
		child.stdout.write("ts | t | bob → ali");
		expect(h.messages).toHaveLength(0);
		child.stdout.write("ce | first\nts | t | bob → alice | second\n");

		expect(h.messages.map((m) => m.body)).toEqual(["first", "second"]);
	});

	it("routes stderr to notices, never into the conversation", () => {
		const h = harness();
		startWatcher({
			project: "/repo",
			sessionId: "sid",
			pid: 1,
			home: "/agmsg",
			onMessage: (m) => h.messages.push(m),
			onNotice: (n) => h.notices.push(n),
			spawnFn: h.spawnFn,
			scheduler: h.scheduler,
		});
		h.children[0].stderr.write("agmsg watch: despawned 'alice'\n");
		expect(h.messages).toHaveLength(0);
		expect(h.notices).toEqual(["agmsg watch: despawned 'alice'"]);
	});

	it("does NOT restart a watcher that reported something and then exited", () => {
		const h = harness();
		const stopped = vi.fn();
		startWatcher({
			project: "/repo",
			sessionId: "sid",
			pid: 1,
			home: "/agmsg",
			onMessage: (m) => h.messages.push(m),
			onNotice: (n) => h.notices.push(n),
			onStopped: stopped,
			spawnFn: h.spawnFn,
			scheduler: h.scheduler,
		});

		h.children[0].stdout.write("agmsg watch: no available identities; nothing to do\n");
		h.children[0].emit("exit", 0, null);

		expect(h.timers).toHaveLength(0);
		expect(h.spawns).toHaveLength(1);
		expect(stopped).toHaveBeenCalledWith("exited");
	});

	it("restarts a watcher that crashed AFTER delivering — the case that ends delivery silently", () => {
		const h = harness();
		startWatcher({
			project: "/repo",
			sessionId: "sid",
			pid: 1,
			home: "/agmsg",
			onMessage: (m) => h.messages.push(m),
			onNotice: (n) => h.notices.push(n),
			spawnFn: h.spawnFn,
			scheduler: h.scheduler,
		});

		h.children[0].stdout.write("ts | t | bob → alice | worked for hours\n");
		h.children[0].emit("exit", 1, null);

		expect(h.timers).toHaveLength(1);
		h.timers[0].fn();
		expect(h.spawns).toHaveLength(2);
	});

	it("schedules only one retry when a failed spawn emits both error and exit", () => {
		const h = harness();
		startWatcher({
			project: "/repo",
			sessionId: "sid",
			pid: 1,
			home: "/agmsg",
			onMessage: (m) => h.messages.push(m),
			onNotice: (n) => h.notices.push(n),
			spawnFn: h.spawnFn,
			scheduler: h.scheduler,
		});

		h.children[0].emit("error", new Error("ENOENT"));
		h.children[0].emit("exit", null, "SIGKILL");

		expect(h.timers).toHaveLength(1);
	});

	it("retries a silent crash with backoff, then gives up loudly", () => {
		const h = harness();
		const stopped = vi.fn();
		startWatcher({
			project: "/repo",
			sessionId: "sid",
			pid: 1,
			home: "/agmsg",
			onMessage: (m) => h.messages.push(m),
			onNotice: (n) => h.notices.push(n),
			onStopped: stopped,
			spawnFn: h.spawnFn,
			scheduler: h.scheduler,
		});

		// Three crashes, each rescheduled at the next backoff step.
		for (const expected of [1_000, 5_000, 30_000]) {
			h.children[h.children.length - 1].emit("exit", 1, null);
			expect(h.timers[h.timers.length - 1].ms).toBe(expected);
			h.timers[h.timers.length - 1].fn();
		}

		// The fourth exhausts the schedule.
		h.children[h.children.length - 1].emit("exit", 1, null);
		expect(h.spawns).toHaveLength(4);
		expect(h.notices.at(-1)).toContain("gave up");
		expect(stopped).toHaveBeenCalledWith("failed");
	});

	it("stops with SIGTERM so agmsg can release the claim, and stays stopped", () => {
		const h = harness();
		const watcher = startWatcher({
			project: "/repo",
			sessionId: "sid",
			pid: 1,
			home: "/agmsg",
			onMessage: (m) => h.messages.push(m),
			onNotice: (n) => h.notices.push(n),
			spawnFn: h.spawnFn,
			scheduler: h.scheduler,
		});

		watcher.stop();
		expect(h.children[0].killed).toBe("SIGTERM");
		expect(watcher.running()).toBe(false);

		// A late exit event from the killed child must not resurrect it.
		h.children[0].emit("exit", 143, "SIGTERM");
		watcher.stop();
		expect(h.spawns).toHaveLength(1);
		expect(h.timers).toHaveLength(0);
	});
});
