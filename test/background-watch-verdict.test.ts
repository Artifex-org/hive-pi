/**
 * A watch that ends without the run's verdict must not read as a red run
 * (HIV-3110).
 *
 * `hive watch` exits with the run's result — 0 passed, 1 did not — and with 4
 * when it lost the stream and does not know. Two paths reported a run that was
 * still going as `failed (exit ?)`:
 *
 *   - any non-zero exit was `failed`, so a dropped stream (exit 4) was red;
 *   - the job's own clock killed the watcher and then awaited a lookup of the
 *     run's state before settling `timeout`, so the kill's `close` won the race
 *     and settled `failed` with no exit code first.
 *
 * Real processes: a fake `hive` on PATH, and a fake Hive API that answers the
 * run lookup slowly, which is what makes the race reproducible.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import background from "../extensions/background/index.ts";
import { parseResultHeader, resultHeader, createJob, finishJob, statusForWatchExit } from "../extensions/background/jobs.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";
import { realBashAvailable } from "./require-tools.ts";

const RUN = "1d363f69-ed6d-40c3-80b1-55bf40cc8640";

describe("statusForWatchExit", () => {
	it("trusts 0 and 1, and reads everything else as no verdict", () => {
		expect(statusForWatchExit(0)).toBe("done");
		expect(statusForWatchExit(1)).toBe("failed");
		expect(statusForWatchExit(4)).toBe("unconfirmed");
		expect(statusForWatchExit(3)).toBe("unconfirmed");
		expect(statusForWatchExit(null)).toBe("unconfirmed");
	});

	it("round-trips through the result header, so evidence readers see it", () => {
		const job = finishJob(createJob({ id: "bg-1", what: "w", kind: "watch", detail: "hive watch x", startedAtMs: 0, cwd: "/" }), {
			status: "unconfirmed",
			exitCode: 4,
			endedAtMs: 1,
		});
		expect(parseResultHeader(resultHeader(job, 1))).toEqual({ id: "bg-1", status: "unconfirmed" });
	});
});

let dir = "";
let server: Server;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "watch-verdict-"));
	// Answers the run lookup after 600ms: long enough that a process `close`
	// would beat it, which is the race under test.
	server = createServer((_req, res) => {
		setTimeout(() => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ run: { state: "running", started_at: "2026-10-04T00:00:00Z", tasks_summary: { total: 6, succeeded: 2, running: 1 } } }));
		}, 600);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	for (const key of ["PATH", "HIVE_TELEMETRY_URL", "HIVE_TELEMETRY_TOKEN", "HIVE_LAUNCH_ID", "FAKE_HIVE_MODE"]) saved[key] = process.env[key];
	process.env.PATH = `${dir}:${process.env.PATH}`;
	process.env.HIVE_TELEMETRY_URL = `http://127.0.0.1:${port}`;
	process.env.HIVE_TELEMETRY_TOKEN = "t";
	delete process.env.HIVE_LAUNCH_ID;
});

afterAll(async () => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(dir, { recursive: true, force: true });
});

/** A `hive` that behaves as told: `exit:N` or `hang`. */
function fakeHive(behaviour: string): void {
	const body = behaviour === "hang" ? "exec sleep 30" : `echo "watching"; exit ${behaviour.split(":")[1]}`;
	writeFileSync(join(dir, "hive"), `#!/usr/bin/env bash\n${body}\n`);
	chmodSync(join(dir, "hive"), 0o755);
}

async function watch(pi: FakePi, timeoutSeconds?: number): Promise<void> {
	await pi.emit({ type: "session_start" }, { mode: "tui", cwd: dir });
	const tool = pi.tools.find((entry) => entry.name === "hive_watch_run");
	if (!tool) throw new Error("hive_watch_run not registered");
	const execute = (tool.definition as { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }).execute;
	const out = await execute("c", { run: RUN, what: "watching the PR run", timeout_seconds: timeoutSeconds }, undefined, undefined, {
		mode: "tui",
		cwd: dir,
	});
	expect(out.content[0].text).toContain("Started background job");
}

async function settled(pi: FakePi): Promise<{ status?: string; content: string }> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const message = pi.messages[0];
		if (message) return { status: (message.details as { status?: string })?.status, content: String(message.content) };
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("the watch never settled");
}

describe.runIf(realBashAvailable())("hive_watch_run verdicts", () => {
	it("reports a lost stream (exit 4) as unconfirmed, with what the run is doing now", async () => {
		fakeHive("exit:4");
		const pi = createFakePi();
		background(pi.api);
		await watch(pi);
		const result = await settled(pi);
		expect(result.status).toBe("unconfirmed");
		expect(result.content).toContain("NOT a failure");
		expect(result.content).toContain("the run was running");
	}, 20_000);

	it("still reports a run that did not pass (exit 1) as failed", async () => {
		fakeHive("exit:1");
		const pi = createFakePi();
		background(pi.api);
		await watch(pi);
		expect((await settled(pi)).status).toBe("failed");
	}, 20_000);

	it("reports a watch its own clock stopped as timeout, not `failed (exit ?)`", async () => {
		fakeHive("hang");
		const pi = createFakePi();
		background(pi.api);
		await watch(pi, 1);
		const result = await settled(pi);
		expect(result.status).toBe("timeout");
		expect(result.content).not.toContain("failed (exit");
		// Exactly one account of the run: the kill's own exit must not settle the
		// job, or annotate it a second time, behind the clock's back. Read the
		// retained output once both lookups would have answered (600ms each).
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const tool = pi.tools.find((entry) => entry.name === "background_result");
		const execute = (tool?.definition as { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }).execute;
		const retained = (await execute("r", { id: "bg-1" }, undefined, undefined, { mode: "tui", cwd: dir })).content[0].text;
		expect(retained.split("When the watch gave up").length - 1).toBe(1);
	}, 20_000);
});
