/**
 * The role state machine, and specifically `actas` — the verb a SPAWNED agent
 * runs as its first input.
 *
 * Two of its outcomes are refusals, and both must stay refusals. `held` means
 * another live session already answers as that name; a controller that shrugged
 * and proceeded would put two agents on one identity, which the sender cannot
 * detect and the roster cannot express. `not_registered` means the spawn was
 * mis-wired, and the honest report is what makes that a one-line fix instead of
 * a silent no-op.
 *
 * The third pinned behaviour is subtle and load-bearing: a claim SURVIVES a
 * later `refresh()`. whoami is a weaker statement than a claim ("these names
 * are registered here" vs "this session is bob"), so a refresh that overwrote
 * the role would quietly re-point a spawned agent at whatever whoami happened
 * to answer.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgmsgController } from "../extensions/agmsg/controller.ts";
import type { AgmsgMessage } from "../extensions/agmsg/message.ts";

let home: string;
let project: string;

function script(name: string, body: string): void {
	const path = join(home, "scripts", name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

function controller(overrides: { inject?: (m: AgmsgMessage) => void } = {}) {
	return new AgmsgController({
		cwd: project,
		sessionId: "sid",
		pid: 4242,
		home,
		inject: overrides.inject ?? (() => {}),
		notify: () => {},
		repaint: () => {},
	});
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "agmsg-home-"));
	project = mkdtempSync(join(tmpdir(), "agmsg-project-"));
	mkdirSync(join(home, "scripts"));
	script("whoami.sh", `echo "multiple=true agents=alice,bob teams=testteam type=pi project=$1"`);
	script("watch.sh", "sleep 5");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("AgmsgController.actas", () => {
	it("claims the role, recording the teams agmsg reported", () => {
		script("actas-claim.sh", 'echo "status=ok team=testteam team=other"');
		const c = controller();

		expect(c.actas("alice")).toEqual({ status: "ok", teams: ["testteam", "other"] });
		expect(c.role()).toEqual({ agent: "alice", teams: ["testteam", "other"], source: "actas" });
	});

	it("passes the composite instance id, so the claim and the watcher key on the same token", () => {
		script("actas-claim.sh", 'echo "status=ok team=t"; echo "$4" > "$(dirname "$0")/../claimed-sid"');
		controller().actas("alice");

		expect(readFileSync(join(home, "claimed-sid"), "utf8").trim()).toBe("sid.4242");
	});

	it("refuses a held name and claims nothing", () => {
		script("actas-claim.sh", 'echo "status=held team=testteam owner=other.99"; exit 1');
		const c = controller();

		expect(c.actas("alice")).toMatchObject({ status: "held", owner: "other.99" });
		expect(c.role()).toBeNull();
	});

	it("reports an unregistered name rather than joining one silently", () => {
		script("actas-claim.sh", 'echo "status=not_registered"; exit 2');
		const c = controller();

		expect(c.actas("nobody").status).toBe("not_registered");
		expect(c.role()).toBeNull();
	});

	it("keeps a claimed role across a refresh, which only knows about registrations", () => {
		script("actas-claim.sh", 'echo "status=ok team=testteam"');
		const c = controller();
		c.actas("alice");

		c.refresh();

		expect(c.role()).toEqual({ agent: "alice", teams: ["testteam"], source: "actas" });
	});
});

describe("AgmsgController role resolution", () => {
	it("takes an unambiguous registration as the role", () => {
		script("whoami.sh", `echo "agent=alice teams=testteam type=pi project=$1"`);
		const c = controller();
		c.refresh();

		expect(c.role()).toEqual({ agent: "alice", teams: ["testteam"], source: "registration" });
	});

	it("refuses to guess between several registrations, and says how to choose", () => {
		const c = controller();
		c.refresh();

		expect(c.role()).toBeNull();
		expect(c.roleProblem()).toContain("/agmsg actas <name>");
		expect(() => c.requireRole()).toThrow(/several agmsg identities/);
	});

	it("adopts agmsg's resolved project root, which is not necessarily cwd", () => {
		script("whoami.sh", `echo "agent=alice teams=t type=pi project=/resolved/root"`);
		const c = controller();
		c.refresh();

		expect(c.state().project).toBe("/resolved/root");
	});
});

describe("AgmsgController.pollInbox", () => {
	it("injects what check-inbox printed, in turn mode", () => {
		script("whoami.sh", `echo "agent=alice teams=testteam type=pi project=$1"`);
		script("check-inbox.sh", 'echo "1 new message(s):"; echo "  [ts] bob: ping"');
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "agmsg.json"), JSON.stringify({ mode: "turn" }));

		const inject = vi.fn();
		const c = controller({ inject });
		c.refresh();
		c.pollInbox();

		expect(inject).toHaveBeenCalledTimes(1);
		expect(inject.mock.calls[0][0].body).toContain("bob: ping");
	});

	it("does nothing in monitor mode — the watcher owns delivery there", () => {
		script("whoami.sh", `echo "agent=alice teams=testteam type=pi project=$1"`);
		script("check-inbox.sh", 'echo "should not be called"');
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "agmsg.json"), JSON.stringify({ mode: "monitor" }));

		const inject = vi.fn();
		const c = controller({ inject });
		c.refresh();
		c.pollInbox();
		c.stopWatcher();

		expect(inject).not.toHaveBeenCalled();
	});
});
