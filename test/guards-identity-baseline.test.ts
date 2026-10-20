/**
 * The git identity guard (block) and the gate-baseline note (warn), from the
 * HIV-3906 eval: one arm committed as a colleague, another raised a
 * codemetrics baseline entry to get past a pre-existing failure.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { identityVerdict, type IdentityProbe } from "../extensions/guards-common/identity-guard.ts";
import { baselineCandidates, baselineNote, isGateBaseline, loosenedEntries, snapshotBaselines } from "../extensions/guards-common/baseline-guard.ts";
import { createFakePi } from "./fake-pi.ts";

const ROOT = "/work/repo";
const probe = (identity = { name: "Joan", email: "joan@example.com" }): IdentityProbe => ({
	configured: () => identity,
	toplevel: (dir) => (dir.startsWith(ROOT) ? ROOT : null),
});
const verdict = (command: string, identity?: { name?: string; email?: string }) => identityVerdict(command, ROOT, probe(identity as { name: string; email: string }));

describe("identity guard", () => {
	it.each([
		'git -c user.name="Someone" -c user.email=x commit -m m',
		"git -c user.email=someone@example.com commit --amend --no-edit",
		"git -C sub -c user.name=Other merge feature",
		"git -c user.name=Other cherry-pick abc123",
		"git -c user.name=Other rebase main",
		'git commit --author="Someone <someone@example.com>" -m m',
		"git commit --author Someone -m m",
		"GIT_AUTHOR_NAME=Someone git commit -m m",
		'GIT_COMMITTER_EMAIL="x@y" git commit -m m',
		"export GIT_AUTHOR_EMAIL=x@y && git commit -m m",
		"env GIT_AUTHOR_NAME=Someone git commit -m m",
		'git config user.name "Someone"',
		"git config --global user.email someone@example.com",
		"git config set user.name Someone",
		"git config --unset user.email",
		'git -c user.name="$OTHER" commit -m m',
		"cd sub && git -c user.name=Other commit -m m",
		"git -C ../other-worktree -c user.name=Bob commit -m m",
		"cd /home/someone/repos/x && git -c user.name=Bob commit -m m",
		"GIT_AUTHOR_NAME=Bob; export GIT_AUTHOR_NAME; git commit -m x",
		"env -u FOO GIT_AUTHOR_NAME=Bob git commit -m x",
	])("blocks writing another identity: %s", (command) => {
		const result = verdict(command);
		expect(result.kind).toBe("block");
		expect(result.kind === "block" && result.reason).toContain("Never borrow or invent an identity");
	});

	it.each([
		"git config user.name",
		"git config --get user.email",
		"git config get user.name",
		"git log --author=x",
		"git shortlog -sn --author=someone",
		"git -c user.name=Other log",
		"git -c user.name=Joan -c user.email=joan@example.com commit -m m",
		'git commit --author="Joan <joan@example.com>" -m m',
		"GIT_AUTHOR_DATE=2026-01-01T00:00:00Z git commit -m m",
		"git config user.name Joan",
		"git commit -m 'mention user.name in prose'",
		"cd /tmp/fixture && git -c user.name=t -c user.email=t@t commit -m seed",
		"git -C /tmp/fixture config user.name t",
		'cd "$(mktemp -d)" && git init -q && git -c user.name=t commit --allow-empty -m seed',
		"GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=t@t go test ./...",
		"GIT_COMMITTER_NAME=x git log -1",
	])("allows reads, the session's own identity and scratch repos: %s", (command) => {
		expect(verdict(command)).toEqual({ kind: "allow" });
	});

	it("tells a session with no identity to stop and report, not to set one", () => {
		for (const command of ["git config user.name Someone", "git -c user.name=Someone -c user.email=s@x commit -m m"]) {
			const result = verdict(command, {});
			expect(result.kind).toBe("block");
			expect(result.kind === "block" && result.reason).toContain("no git identity configured");
			expect(result.kind === "block" && result.reason).toContain("Stop and report");
		}
	});

	it("does not probe git for commands that cannot touch identity", () => {
		const counting: IdentityProbe = { configured: () => { throw new Error("probed"); }, toplevel: () => { throw new Error("probed"); } };
		expect(identityVerdict("git push origin HEAD 2>&1 && gh pr create --title t --body b", ROOT, counting)).toEqual({ kind: "allow" });
	});
});

describe("baseline guard", () => {
	const baseline = "# debt\ncognitive 107.00 internal/api/create_run.go::Server.createRun\ncognitive 22.00 cmd/x/main.go::run\n";

	it("recognises gate baseline data files, not source or prose", () => {
		for (const path of ["scripts/metrics/codemetrics-baseline.txt", "coverage-floor.json", ".coverage-threshold", "lint-ratchet.yaml"]) expect(isGateBaseline(path), path).toBe(true);
		for (const path of ["internal/api/run_baseline.go", "cmd/hive-agent/reap_disk_floor.go", "docs/baseline.md", "README.md"]) expect(isGateBaseline(path), path).toBe(false);
	});

	it("reports a raised debt entry and a new one, not a lowered one", () => {
		const raised = baseline.replace("107.00", "112.00");
		expect(loosenedEntries("codemetrics-baseline.txt", baseline, raised)).toEqual(["`cognitive 112.00 internal/api/create_run.go::Server.createRun` (was `cognitive 107.00 internal/api/create_run.go::Server.createRun`)"]);
		expect(loosenedEntries("codemetrics-baseline.txt", baseline, `${baseline}cognitive 31.00 internal/new.go::f\n`)).toEqual(["new entry `cognitive 31.00 internal/new.go::f`"]);
		expect(loosenedEntries("codemetrics-baseline.txt", baseline, baseline.replace("107.00", "90.00"))).toEqual([]);
	});

	it("reads a coverage floor the other way round", () => {
		const floor = '{\n  "lines": 80,\n  "branches": 70\n}\n';
		expect(loosenedEntries("coverage-floor.json", floor, floor.replace("80", "75"))).toHaveLength(1);
		expect(loosenedEntries("coverage-floor.json", floor, floor.replace("80", "85"))).toEqual([]);
		expect(loosenedEntries("coverage-floor.json", floor, floor.replace('  "branches": 70\n', ""))).toEqual(['removed `"branches": 70`']);
	});

	const dirs: string[] = [];
	afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

	it("snapshots only calls that can touch a baseline and warns after the change", () => {
		const dir = mkdtempSync(join(tmpdir(), "baseline-")); dirs.push(dir);
		mkdirSync(join(dir, "scripts", "metrics"), { recursive: true });
		const file = join(dir, "scripts", "metrics", "codemetrics-baseline.txt");
		writeFileSync(file, baseline);
		const none = () => [];
		expect(baselineCandidates("bash", { command: "go test ./..." }, dir, none)).toEqual([]);
		expect(baselineCandidates("edit", { path: "code.ts" }, dir, none)).toEqual([]);
		expect(baselineCandidates("bash", { command: "go run ./scripts/codemetrics -update-baseline" }, dir, () => [file])).toEqual([file]);
		const paths = baselineCandidates("bash", { command: "sed -i 's/107.00/112.00/' scripts/metrics/codemetrics-baseline.txt" }, dir, none);
		expect(paths).toEqual([file]);
		const snapshot = snapshotBaselines(paths);
		expect(baselineNote(snapshot)).toBeNull();
		writeFileSync(file, baseline.replace("107.00", "112.00"));
		const note = baselineNote(snapshot);
		expect(note).toContain("loosened a gate baseline");
		expect(note).toContain("report the failure");
	});
});

describe("guards-bridge wiring", () => {
	const home = mkdtempSync(join(tmpdir(), "guards-home-"));
	const originalHome = process.env.HOME;
	process.env.HOME = home; // no ~/.claude/hooks: only the native guards run
	afterAll(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(home, { recursive: true, force: true });
	});

	function sessionRepo() {
		const cwd = mkdtempSync(join(tmpdir(), "identity-repo-"));
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
		execFileSync("git", ["config", "user.name", "Joan"], { cwd });
		execFileSync("git", ["config", "user.email", "joan@example.com"], { cwd });
		return cwd;
	}

	it("blocks a borrowed identity and warns on a loosened baseline edit", async () => {
		const guards = (await import("../extensions/guards-bridge.ts")).default;
		const cwd = sessionRepo();
		try {
			const pi = createFakePi(); guards(pi.api);
			const [blocked] = await pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: 'git -c user.name="Someone" -c user.email=x commit -m m' } }, { cwd });
			expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("Never borrow") });
			const [allowed] = await pi.emit({ type: "tool_call", toolName: "bash", toolCallId: "c2", input: { command: "git log --author=x" } }, { cwd });
			expect(allowed).toBeUndefined();

			const file = join(cwd, "codemetrics-baseline.txt");
			writeFileSync(file, "cognitive 20.00 a.go::f\n");
			await pi.emit({ type: "tool_call", toolName: "edit", toolCallId: "e1", input: { path: file, edits: [] } }, { cwd });
			writeFileSync(file, "cognitive 25.00 a.go::f\n");
			const [result] = await pi.emit({ type: "tool_result", toolName: "edit", toolCallId: "e1", input: {}, isError: false, content: [{ type: "text", text: "edited" }] }, { cwd });
			expect(JSON.stringify(result)).toContain("loosened a gate baseline");
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
});
