/**
 * A watch on a PR gate tells the agent about the first failed test/lint shard
 * while the rest of the run continues, and still delivers the verdict.
 *
 * Measured: a background watch reported nothing for 50 minutes after its
 * `test-2` shard had failed, because other shards were still queued. Real
 * processes: a fake `hive` on PATH printing what `hive watch` prints.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import background from "../extensions/background/index.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";
import { realBashAvailable } from "./require-tools.ts";

const RUN = "1d363f69-ed6d-40c3-80b1-55bf40cc8640";
let dir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "watch-first-failure-"));
	for (const key of ["PATH", "HIVE_TELEMETRY_URL", "HIVE_TELEMETRY_TOKEN", "HIVE_LAUNCH_ID"]) saved[key] = process.env[key];
	process.env.PATH = `${dir}:${process.env.PATH}`;
	process.env.HIVE_TELEMETRY_URL = "http://127.0.0.1:9";
	process.env.HIVE_TELEMETRY_TOKEN = "t";
	delete process.env.HIVE_LAUNCH_ID;
});

afterAll(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

/** A `hive watch` that prints these lines, sleeping where a line is a number. */
function fakeHive(script: (string | number)[], exit: number): void {
	const body = script.map((step) => typeof step === "number" ? `sleep ${step}` : `printf '%s\\n' ${JSON.stringify(step)}`).join("\n");
	writeFileSync(join(dir, "hive"), `#!/usr/bin/env bash\n${body}\nexit ${exit}\n`);
	chmodSync(join(dir, "hive"), 0o755);
}

async function watch(pi: FakePi): Promise<string> {
	await pi.emit({ type: "session_start" }, { mode: "tui", cwd: dir });
	const tool = pi.tools.find((entry) => entry.name === "hive_watch_run");
	const execute = (tool?.definition as { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }).execute;
	const out = await execute("c", { run: RUN, what: "waiting for the PR gate" }, undefined, undefined, { mode: "tui", cwd: dir });
	return out.content[0].text;
}

async function until(pi: FakePi, count: number): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (pi.messages.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
	expect(pi.messages.length).toBeGreaterThanOrEqual(count);
}

const failedLine = `${"task.failed".padEnd(22)} test-2: exit status 1`;

describe.runIf(realBashAvailable())("hive_watch_run's first failed gate task", () => {
	it("is told at once, with the task key, while the run continues; the verdict still follows", async () => {
		fakeHive([`${"task.started".padEnd(22)} test-1`, failedLine, 5, `${"task.failed".padEnd(22)} lint`, "run failed"], 1);
		const pi = createFakePi();
		background(pi.api);
		expect(await watch(pi)).toContain("you are also told at once");
		await until(pi, 1);
		const early = pi.messages[0];
		expect(early.customType).toBe("background-progress");
		expect(early.details).toMatchObject({ id: "bg-1", runID: RUN, task: "test-2", event: "task.failed" });
		expect(String(early.content)).toContain("task `test-2` failed while run");
		expect(String(early.content)).toContain("decides whether this failure counts");
		expect(String(early.content)).toContain("NOT cancelled");
		expect(String(early.content)).toContain(failedLine);
		await until(pi, 2);
		expect(pi.messages[1].customType).toBe("background");
		expect(pi.messages[1].details).toMatchObject({ id: "bg-1", status: "failed" });
		// The second failure (lint) is the verdict's news, not another notice.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(pi.messages).toHaveLength(2);
	}, 30_000);

	it("says nothing early when the watched run had already ended (a replayed backlog)", async () => {
		fakeHive([failedLine, "run failed"], 1);
		const pi = createFakePi();
		background(pi.api);
		await watch(pi);
		await until(pi, 1);
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(pi.messages.map((message) => message.customType)).toEqual(["background"]);
		expect(pi.messages[0].details).toMatchObject({ status: "failed" });
	}, 30_000);

	it("never announces a build failure or a retried attempt as the early notice", async () => {
		fakeHive([`${"task.failed".padEnd(22)} build`, `${"task.retrying".padEnd(22)} test-2`, 3, "run succeeded"], 0);
		const pi = createFakePi();
		background(pi.api);
		await watch(pi);
		await until(pi, 1);
		expect(pi.messages.map((message) => message.customType)).toEqual(["background"]);
	}, 30_000);
});
