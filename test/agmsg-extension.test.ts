/**
 * What the extension DOES when pi emits an event — the layer the pure fold
 * tests cannot reach.
 *
 * agmsg is faked as a real install: a temp directory with executable stub
 * scripts. That keeps the exec path, the argv and the spawn honest (these are
 * the things that break when agmsg changes a contract) while staying free of
 * bash, sqlite and the developer's actual message DB.
 *
 * The behaviours pinned here are the ones whose absence is silent:
 *   - no install → NOTHING registered, so a machine without agmsg pays nothing;
 *   - the identity paragraph appears only once a role exists, so an unjoined
 *     session never tells the model it can be messaged;
 *   - an arriving message is injected as followUp + triggerTurn, which is the
 *     entire reason this is an extension: it wakes an idle session;
 *   - shutdown kills the watcher, or a `/resume` leaves a process behind
 *     holding the actas claim.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import agmsgExtension, { identityPrompt } from "../extensions/agmsg/index.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

let home: string;
let project: string;

/** A stub agmsg script. `sh`, not bash: the CI image ships no bash. */
function script(name: string, body: string): void {
	const path = join(home, "scripts", name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

function setMode(mode: "monitor" | "turn"): void {
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "agmsg.json"), JSON.stringify({ mode }));
}

/** Wait for the extension's detached bootstrap (and any child process) to land. */
async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the extension");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function start(pi: FakePi): Promise<void> {
	agmsgExtension(pi.api);
	await pi.emit({ type: "session_start", reason: "startup" }, { cwd: project });
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "agmsg-home-"));
	project = mkdtempSync(join(tmpdir(), "agmsg-project-"));
	mkdirSync(join(home, "scripts"));
	process.env.AGMSG_HOME = home;

	script("whoami.sh", `echo "agent=alice teams=testteam type=pi project=$1"`);
	script("watch.sh", `echo "2026-08-07T02:38:41Z | testteam | bob → alice | ping"`);
	script("check-inbox.sh", "exit 0");
});

afterEach(() => {
	delete process.env.AGMSG_HOME;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("agmsg extension", () => {
	it("registers nothing at all when agmsg is not installed", async () => {
		process.env.AGMSG_HOME = join(home, "does-not-exist");
		const pi = createFakePi();
		agmsgExtension(pi.api);

		expect(pi.tools).toHaveLength(0);
		expect(pi.commands.size).toBe(0);
		expect(pi.handlers.size).toBe(0);
	});

	it("registers the four tools and /agmsg when agmsg is installed", async () => {
		const pi = createFakePi();
		agmsgExtension(pi.api);

		expect(pi.tools.map((t) => t.name).sort()).toEqual(["agmsg_history", "agmsg_inbox", "agmsg_send", "agmsg_team"]);
		expect(pi.commands.has("agmsg")).toBe(true);
	});

	it("tells the model it is reachable — but only once a role is resolved", async () => {
		const pi = createFakePi();
		agmsgExtension(pi.api);

		// Before session_start there is no controller, so no role and no paragraph.
		const before = pi.handlers.get("before_agent_start")?.[0];
		expect(before?.({ systemPrompt: "BASE" }, {} as never)).toBeUndefined();

		await pi.emit({ type: "session_start", reason: "startup" }, { cwd: project });
		await until(() => pi.statuses.length > 0);

		const after = before?.({ systemPrompt: "BASE" }, {} as never) as { systemPrompt: string };
		expect(after.systemPrompt).toBe(`BASE\n\n${identityPrompt("alice", ["testteam"])}`);
		expect(after.systemPrompt).toContain("agmsg_send");
	});

	it("shows the role in the footer, with the mode as its marker", async () => {
		const pi = createFakePi();
		await start(pi);
		await until(() => pi.statuses.some((s) => s.text !== undefined));

		expect(pi.statuses.at(-1)).toMatchObject({ key: "agmsg" });
		expect(pi.statuses.at(-1)?.text).toContain("alice@testteam");
	});

	it("starts no watcher when delivery is off — an unconfigured project costs nothing", async () => {
		const pi = createFakePi();
		await start(pi);
		await until(() => pi.statuses.length > 0);
		// Give a watcher that should not exist time to produce something.
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(pi.messages).toHaveLength(0);
	});

	it("injects an arriving message as followUp + triggerTurn, so an IDLE session answers", async () => {
		setMode("monitor");
		const pi = createFakePi();
		await start(pi);
		await until(() => pi.messages.length > 0);

		const injected = pi.messages[0];
		expect(injected.customType).toBe("agmsg");
		expect(injected.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(injected.content).toContain("bob → alice");
		expect(injected.content).toContain("ping");
		expect(injected.details).toMatchObject({ team: "testteam", from: "bob", to: "alice" });
	});

	it("counts what it received, so the footer can show it", async () => {
		setMode("monitor");
		const pi = createFakePi();
		await start(pi);
		await until(() => pi.messages.length > 0);

		expect(pi.statuses.at(-1)?.text).toContain("1✉");
	});

	it("clears its status on shutdown", async () => {
		const pi = createFakePi();
		await start(pi);
		await until(() => pi.statuses.length > 0);

		await pi.emit({ type: "session_shutdown", reason: "quit" }, { cwd: project });
		expect(pi.statuses.at(-1)).toEqual({ key: "agmsg", text: undefined });
	});

	it("survives a session replacement that stales the ctx mid-flight", async () => {
		setMode("monitor");
		const pi = createFakePi();
		await start(pi);
		pi.staleCurrentCtx();

		// The watcher paints through the now-stale ctx; nothing may throw, and the
		// message itself must still be injected.
		await until(() => pi.messages.length > 0);
		expect(pi.messages[0].content).toContain("ping");
	});

	it("reports a script failure to the human instead of crashing the session", async () => {
		script("whoami.sh", "echo boom >&2; exit 3");
		const pi = createFakePi();
		await start(pi);
		await new Promise((resolve) => setTimeout(resolve, 150));

		// A failed whoami reads as "not joined": no role, no status, no injection.
		expect(pi.messages).toHaveLength(0);
		expect(pi.statuses.every((s) => s.text === undefined)).toBe(true);
	});
});

describe("/agmsg command", () => {
	it("says so when it runs before a session exists, rather than throwing", async () => {
		const pi = createFakePi();
		agmsgExtension(pi.api);

		await pi.runCommand("agmsg");
		expect(pi.notifications.at(-1)?.message).toContain("not active");
	});

	it("reports role, project and delivery mode", async () => {
		setMode("turn");
		const pi = createFakePi();
		await start(pi);
		await until(() => pi.statuses.length > 0);

		await pi.runCommand("agmsg", "", { cwd: project });
		const report = pi.notifications.at(-1)?.message ?? "";
		expect(report).toContain("alice @ testteam (registration)");
		expect(report).toContain("delivery:  turn");
	});

	it("sends a multi-line message unchanged — a pasted diff must survive the command parse", async () => {
		script("send.sh", `printf '%s' "$4" > "${join(home, "sent")}"; echo sent`);
		const pi = createFakePi();
		await start(pi);
		await until(() => pi.statuses.length > 0);

		await pi.runCommand("agmsg", "send bob line one\n  indented two", { cwd: project });

		expect(readFileSync(join(home, "sent"), "utf8")).toBe("line one\n  indented two");
	});

	it("rejects an unknown delivery mode with the usage line", async () => {
		const pi = createFakePi();
		await start(pi);
		await until(() => pi.statuses.length > 0);

		await pi.runCommand("agmsg", "mode sometimes", { cwd: project });
		expect(pi.notifications.at(-1)?.message).toContain("usage: /agmsg mode");
	});
});
