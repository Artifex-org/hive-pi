/**
 * Commands this package spawns see the session's PATH, not a login profile's.
 *
 * Both the background job and the agenda gate ran `bash -lc`. A login shell
 * reads /etc/profile, and Debian's REPLACES PATH — so on a Debian workstation
 * every directory the launch put in front (the harness Node, the `hive` CLI)
 * was gone, and `hive watch` died 127 inside a job reported as "no verdict".
 * Arch's /etc/profile appends instead, so it never reproduced there.
 *
 * To fail on every OS rather than only on Debian, HOME points at a directory
 * whose `.bash_profile` resets PATH the way Debian's /etc/profile does: a
 * login shell reads it, the `-c` shell pi's own bash tool uses does not.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCheck } from "../extensions/agenda/gate.ts";
import background from "../extensions/background/index.ts";
import { createFakePi } from "./fake-pi.ts";
import { realBashAvailable } from "./require-tools.ts";

const TOOL = "zz-session-only-tool";

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "non-login-shell-"));
	const bin = join(dir, "bin");
	const home = join(dir, "home");
	mkdirSync(bin);
	mkdirSync(home);
	writeFileSync(join(bin, TOOL), "#!/bin/sh\necho found-the-session-tool\n");
	chmodSync(join(bin, TOOL), 0o755);
	writeFileSync(join(home, ".bash_profile"), "PATH=/usr/bin:/bin\nexport PATH\n");
	for (const key of ["PATH", "HOME"]) saved[key] = process.env[key];
	process.env.PATH = `${bin}:${process.env.PATH}`;
	process.env.HOME = home;
});

afterAll(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe.runIf(realBashAvailable())("spawned commands keep the session PATH", () => {
	it("the agenda gate finds a tool only the session PATH has", async () => {
		const result = await runCheck(TOOL, dir, 10_000);
		expect(result.output).toContain("found-the-session-tool");
		expect(result.ok).toBe(true);
	});

	it("a background job finds a tool only the session PATH has", async () => {
		const pi = createFakePi();
		background(pi.api);
		await pi.emit({ type: "session_start" }, { mode: "tui", cwd: dir });
		const tool = pi.tools.find((entry) => entry.name === "background_bash");
		if (!tool) throw new Error("background_bash not registered");
		const execute = (tool.definition as { execute: (...args: unknown[]) => Promise<unknown> }).execute;
		await execute("c", { command: TOOL, what: "running a session-only tool" }, undefined, undefined, {
			mode: "tui",
			cwd: dir,
		});
		const deadline = Date.now() + 10_000;
		while (pi.messages.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		const message = pi.messages[0];
		expect((message?.details as { status?: string } | undefined)?.status).toBe("done");
		expect(String(message?.content)).toContain("found-the-session-tool");
	});
});
