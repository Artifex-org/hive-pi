/**
 * The background extension, running for real.
 *
 * These tests spawn actual processes. That is deliberate and it is the point:
 * every claim this feature makes is about what happens ACROSS the boundary the
 * fold cannot see — that the job outlives the tool call, that the completion
 * message is delivered with the right delivery options, that a killed job takes
 * its children with it. A pure test of the fold cannot fail on any of those,
 * and those are the ones that would ship broken.
 *
 * The commands are `sleep`/`echo`/`exit`, so the suite costs about a second.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createFakePi, type FakePi } from "./fake-pi.ts";
import { realBashAvailable } from "./require-tools.ts";
import background from "../extensions/background/index.ts";

function boot(): FakePi {
	const pi = createFakePi();
	background(pi.api);
	return pi;
}

async function call(
	pi: FakePi,
	name: string,
	params: Record<string, unknown>,
	ctx: Record<string, unknown> = { mode: "tui", cwd: process.cwd() },
): Promise<string> {
	const tool = pi.tools.find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool registered named "${name}"`);
	const execute = (tool.definition as { execute: (...args: unknown[]) => Promise<unknown> }).execute;
	const result = (await execute("call-id", params, undefined, undefined, ctx)) as
		| { content?: { text?: string }[]; isError?: boolean }
		| undefined;
	return result?.content?.[0]?.text ?? "";
}

/** Wait until `predicate` holds, or fail the test. Never a bare sleep. */
async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition never held");
}

describe("registration", () => {
	it("registers five tools and the /background command", () => {
		const pi = boot();
		expect(pi.tools.map((tool) => tool.name).sort()).toEqual([
			"background_bash",
			"background_cancel",
			"background_list",
			"background_result",
			// Registered HERE rather than beside the other Hive extensions: pi
			// gives each extension its own module instance (`moduleCache: false`),
			// so a tool that starts a background job must be registered by the
			// extension that owns the job registry — see watch-run.ts.
			"hive_watch_run",
		]);
		expect(pi.commands.has("background")).toBe(true);
	});

	it("makes `what` a REQUIRED parameter, not an optional nicety", () => {
		// This is the narration half of the feature. Optional, it would be
		// omitted exactly when a session is busy — which is when the human most
		// needs to know what the silent tool call is doing.
		const pi = boot();
		const tool = pi.tools.find((entry) => entry.name === "background_bash");
		const params = (tool?.definition as { parameters?: { required?: string[] } }).parameters;
		expect(params?.required).toContain("what");
		expect(params?.required).toContain("command");
	});
});

describe.runIf(realBashAvailable())("the mode gate", () => {
	it("refuses in headless mode, where a completion message has nowhere to land", async () => {
		const pi = boot();
		const out = await call(pi, "background_bash", { command: "echo hi", what: "saying hi" }, { mode: "headless", cwd: process.cwd() });
		expect(out).toContain("not available in headless mode");
		// And it must not have started anything.
		expect(await call(pi, "background_list", {})).toBe("No background jobs.");
	});

	it("allows tui and rpc", async () => {
		for (const mode of ["tui", "rpc"]) {
			const pi = boot();
			const out = await call(pi, "background_bash", { command: "true", what: "a no-op" }, { mode, cwd: process.cwd() });
			expect(out).toContain("Started background job");
		}
	});
});

describe.runIf(realBashAvailable())("a job that finishes", () => {
	it("returns IMMEDIATELY, then delivers its result as a notification", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });

		const started = Date.now();
		const out = await call(pi, "background_bash", {
			command: "sleep 0.4; echo finished-later",
			what: "a slow echo",
		});
		const returnedAfter = Date.now() - started;

		// The tool call did not wait for the work. This is the entire feature.
		expect(out).toContain("Started background job `bg-1`");
		expect(returnedAfter).toBeLessThan(300);
		expect(pi.messages).toHaveLength(0);

		await until(() => pi.messages.length > 0);

		const message = pi.messages[0];
		expect(message.customType).toBe("background");
		expect(message.content).toContain("finished-later");
		expect(message.content).toContain("a slow echo");
		// followUp so it never cuts between a tool call and its result;
		// triggerTurn so an IDLE session actually acts on it.
		expect(message.options?.deliverAs).toBe("followUp");
		expect(message.options?.triggerTurn).toBe(true);
	});

	it("reports a failing command as failed, with its exit code", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		await call(pi, "background_bash", { command: "echo oops >&2; exit 3", what: "a failing command" });

		await until(() => pi.messages.length > 0);
		expect(pi.messages[0].content).toContain("exit 3");
		// stderr is captured too — a failure whose only output is on stderr is
		// the common case, and dropping it would make the notification useless.
		expect(pi.messages[0].content).toContain("oops");
		expect((pi.messages[0].details as { status?: string })?.status).toBe("failed");
	});

	it("announces each job exactly once", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		await call(pi, "background_bash", { command: "true", what: "one" });
		await until(() => pi.messages.length > 0);
		// Give any duplicate delivery a chance to land before asserting.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(pi.messages).toHaveLength(1);
	});
});

describe.runIf(realBashAvailable())("the footer", () => {
	it("shows a running count and clears it when the job lands", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		await call(pi, "background_bash", { command: "sleep 0.3", what: "waiting" });

		expect(pi.statuses.at(-1)).toEqual({ key: "background", text: "1 bg job" });
		await until(() => pi.statuses.at(-1)?.text === undefined);
	});
});

describe.runIf(realBashAvailable())("background_result", () => {
	it("returns output for a job that is still running", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		await call(pi, "background_bash", { command: "echo early; sleep 2", what: "a long one" });

		let out = "";
		await until(() => {
			void call(pi, "background_result", { id: "bg-1" }).then((text) => {
				out = text;
			});
			return out.includes("early");
		}, 4_000);
		expect(out).toContain("early");
		expect(out).toContain("running");
		await call(pi, "background_cancel", { id: "bg-1" });
	});

	it("names the known jobs when given an unknown id", async () => {
		const pi = boot();
		const out = await call(pi, "background_result", { id: "bg-99" });
		expect(out).toContain("No background job");
		expect(out).toContain("none");
	});
});

describe.runIf(realBashAvailable())("cancel", () => {
	it("stops a running job and records it as canceled, not failed", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		await call(pi, "background_bash", { command: "sleep 30", what: "a long sleep" });

		const out = await call(pi, "background_cancel", { id: "bg-1" });
		expect(out).toContain("Canceled");

		await until(() => pi.messages.length > 0);
		// The SIGTERM we sent produces an exit code of its own; the record must
		// still say the human canceled it rather than that it crashed.
		expect((pi.messages[0].details as { status?: string })?.status).toBe("canceled");
		expect(pi.messages[0].content).toContain("canceled");

		// And no late `close` event may overwrite that or double-announce.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(pi.messages).toHaveLength(1);
	});

	it("declines to cancel a job that already finished", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		await call(pi, "background_bash", { command: "true", what: "quick" });
		await until(() => pi.messages.length > 0);
		expect(await call(pi, "background_cancel", { id: "bg-1" })).toContain("nothing to cancel");
	});
});

describe.runIf(realBashAvailable())("reaping on shutdown", () => {
	it("kills the whole process tree, not just the shell", async () => {
		// The orphan is the thing being tested. `bash -lc 'sleep 30 & wait'`
		// leaves a grandchild that survives a naive kill of the shell alone —
		// which is how a background feature quietly accumulates stray processes
		// that outlive every session that started them.
		// A FRESH path per run, and the file must not exist when we start.
		//
		// The first version of this test reused one fixed path and only deleted it
		// at the END. A leftover file from an earlier run made the test read a
		// stale pid, whose process was long dead, so `kill(pid, 0)` threw
		// immediately and the test reported "the tree was reaped" without having
		// reaped anything. It passed with the process-group kill deliberately
		// broken — a check that could not fail, guarding the exact defect this
		// feature could otherwise industrialise.
		const pidFile = join(tmpdir(), `hive-pi-bg-${process.pid}-${Date.now()}.pid`);
		rmSync(pidFile, { force: true });

		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		await call(pi, "background_bash", {
			command: `sleep 30 & echo $! > ${pidFile}; wait`,
			what: "a job with a grandchild",
		});

		await until(() => existsSync(pidFile));
		const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
		expect(Number.isFinite(grandchildPid)).toBe(true);
		expect(grandchildPid).toBeGreaterThan(0);

		// The grandchild must be alive BEFORE we reap, or "it is gone afterwards"
		// proves nothing at all.
		expect(() => process.kill(grandchildPid, 0)).not.toThrow();

		await pi.emit({ type: "session_shutdown" }, { mode: "tui" });

		// The deadline is what makes this test DISCRIMINATE, and it is short on
		// purpose. Reaping the group with SIGTERM kills the grandchild within a
		// few hundred milliseconds (measured ~200ms). Killing only the shell
		// leaves it running until the SIGKILL sweep at KILL_GRACE_MS, and it was
		// then dying late for reasons that have nothing to do with the group
		// kill — so a generous timeout here passed with the group kill
		// deliberately broken. Anything comfortably below KILL_GRACE_MS separates
		// the two; 1.5s is that with room for a loaded CI box.
		await until(() => {
			try {
				process.kill(grandchildPid, 0);
				return false; // still alive
			} catch {
				return true; // gone
			}
		}, 1_500);
		rmSync(pidFile, { force: true });
	});
});

describe.runIf(realBashAvailable())("limits", () => {
	it("refuses past the concurrency cap rather than forking without bound", async () => {
		const pi = boot();
		await pi.emit({ type: "session_start" }, { mode: "tui" });
		for (let i = 0; i < 8; i += 1) {
			await call(pi, "background_bash", { command: "sleep 5", what: `job ${i}` });
		}
		const refused = await call(pi, "background_bash", { command: "sleep 5", what: "one too many" });
		expect(refused).toContain("the limit");

		for (let i = 1; i <= 8; i += 1) await call(pi, "background_cancel", { id: `bg-${i}` });
	});

	it("rejects a blank `what` rather than showing the human an empty label", async () => {
		const pi = boot();
		const out = await call(pi, "background_bash", { command: "true", what: "   " });
		expect(out).toContain("what");
	});
});
