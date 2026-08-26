import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { guardTargets, guardWorkerCwd, workerCwdRefusal } from "../extensions/guards-common/capability.ts";
import { gitAvailable } from "./require-tools.ts";

/** A repo that has opted into the guard, the way a protected checkout does. */
function guardedRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "hive-pi-guarded-"));
	execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", {
		cwd: root,
		stdio: "ignore",
	});
	writeFileSync(join(root, ".worktree-guard"), "");
	return root;
}

function plainRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "hive-pi-plain-"));
	execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", {
		cwd: root,
		stdio: "ignore",
	});
	return root;
}

describe.runIf(gitAvailable())("guardWorkerCwd — the only guard delegated work has", () => {
	// The finding this encodes: a worker spawns with `--no-extensions`, which
	// strips guards-bridge along with everything else, so a worker has NO
	// worktree guard. Measured — a worker-shaped pi wrote into a repo for which
	// `decide()` returns block. The parent-side check is therefore the last
	// place a writer aimed at a protected checkout can be refused.
	it("refuses a guarded worktree", () => {
		const block = guardWorkerCwd(guardedRepo(), "subagent");
		expect(block).not.toBeNull();
		expect(block?.reason).toContain("worktree-protected");
	});

	it("allows an ordinary repo", () => {
		expect(guardWorkerCwd(plainRepo(), "subagent")).toBeNull();
	});

	it("allows a directory that is not a repo at all", () => {
		expect(guardWorkerCwd(mkdtempSync(join(tmpdir(), "hive-pi-norepo-")), "subagent")).toBeNull();
	});

	it("judges the cwd itself, not its parent", () => {
		// `decide()` locates a repo from the PARENT of the path it is handed, so
		// passing a bare directory would judge the directory's parent. A guarded
		// repo nested under an unguarded temp dir is the case that catches it.
		const guarded = guardedRepo();
		expect(guardWorkerCwd(guarded, "subagent")).not.toBeNull();
		expect(guardWorkerCwd(`${guarded}/`, "subagent"), "a trailing slash must not change the verdict").not.toBeNull();
	});
});

describe.runIf(gitAvailable())("guardTargets", () => {
	it("reports every blocked path and a reason", () => {
		const root = guardedRepo();
		const block = guardTargets([join(root, "a.ts"), join(root, "b.ts")], "rename_symbol");
		expect(block?.blocked).toHaveLength(2);
		expect(block?.reason).toContain("BLOCKED");
	});

	it("returns null when nothing is blocked", () => {
		expect(guardTargets([join(plainRepo(), "a.ts")], "rename_symbol")).toBeNull();
	});

	it("ignores empty entries rather than judging the cwd by accident", () => {
		expect(guardTargets(["", ""], "rename_symbol")).toBeNull();
	});
});

describe("workerCwdRefusal", () => {
	it("names the role, the cause and the remedy", () => {
		const text = workerCwdRefusal("test-fixer", "/repo", { blocked: ["/repo/x"], reason: "BLOCKED: because" });
		expect(text).toContain("test-fixer");
		expect(text).toContain("BLOCKED: because");
		expect(text).toContain("gwq add -b");
		// The reason the parent must refuse at all — a reader who does not know
		// this will assume the worker is protected like the interactive session.
		expect(text).toContain("without the guard extensions");
	});
});

describe.runIf(gitAvailable())("the subagent tool refuses a writer into a guarded worktree", () => {
	// The wiring, not just the decision function. The unit tests above prove
	// `guardWorkerCwd` says no; this proves the tool ASKS it — which is the half
	// that would silently rot, because a delegation into a guarded tree
	// otherwise looks like a normal successful run.
	async function runSubagent(cwd: string, agent: string) {
		const { createFakePi } = await import("./fake-pi.ts");
		const subagent = (await import("../extensions/subagent/index.ts")).default;
		const pi = createFakePi();
		// Pre-register the built-ins the shipped roles ask for. Without them the
		// role-tool validation added in HIV-1580 fires first and refuses for a
		// DIFFERENT reason — which would leave this test green while proving
		// nothing about the guard. In a real session the parent's registry is
		// complete, so validation passes and the guard is what speaks.
		for (const name of ["read", "grep", "find", "ls", "bash", "edit", "write"]) {
			pi.api.registerTool({ name, label: name, description: name, parameters: {}, execute: async () => ({}) } as never);
		}
		subagent(pi.api as never);
		const tool = pi.tools.find((t) => t.name === "subagent");
		expect(tool, "subagent tool must be registered").toBeDefined();
		const execute = (tool!.definition as { execute: Function }).execute;
		return (await execute("call-1", { agent, task: "do something", cwd }, undefined, undefined, {
			cwd,
			mode: "tui",
			hasUI: false,
			isProjectTrusted: () => true,
		})) as { content: { text: string }[]; details?: { results?: { stderr?: string }[] } };
	}

	it("refuses a writer-capable role, without spawning", async () => {
		const guarded = guardedRepo();
		const result = await runSubagent(guarded, "test-fixer");
		const text = result.content.map((c) => c.text).join("\n") + JSON.stringify(result.details ?? {});
		expect(text).toContain("worktree-protected");
		expect(text).toContain("gwq add -b");
	}, 30_000);

	it("still allows a READ-ONLY role there — refusing reads would break review work", async () => {
		const guarded = guardedRepo();
		const result = await runSubagent(guarded, "retriever");
		const text = result.content.map((c) => c.text).join("\n") + JSON.stringify(result.details ?? {});
		expect(text).not.toContain("worktree-protected");
	}, 120_000);
});

describe("every spawn path that takes the writer lock also asks the guard", () => {
	// The gap this closes: the first cut wired subagent and agenda's one-shot
	// worker and MISSED agenda/rpc-worker.ts — the durable RPC path, which keeps
	// a writer alive longest. Two of three is a bypass, not a partial fix.
	//
	// Asserted structurally rather than behaviourally: acquireWriterLock marks
	// exactly the places that are about to let something write, so any file
	// taking the lock must also call guardWorkerCwd. A new spawn path fails here
	// rather than being discovered later.
	it("has no writer-lock site without a guardWorkerCwd call", async () => {
		const { execSync } = await import("node:child_process");
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const repo = join(import.meta.dirname, "..");

		const files = execSync("git ls-files 'extensions/**/*.ts'", { cwd: repo, encoding: "utf8" })
			.split("\n")
			.filter(Boolean);

		const missing = files.filter((file) => {
			const source = readFileSync(join(repo, file), "utf8");
			if (!source.includes("acquireWriterLock(")) return false;
			// harness/writer.ts DEFINES the lock; it is not a spawn site.
			if (file.endsWith("harness/writer.ts")) return false;
			return !source.includes("guardWorkerCwd(");
		});

		expect(missing, "these take the writer lock but never ask the worktree guard").toEqual([]);
	});
});

describe.runIf(gitAvailable())("registerGuardedTool actually blocks", () => {
	async function auditTool(cwd: string) {
		const { createFakePi } = await import("./fake-pi.ts");
		const audit = (await import("../extensions/audit/index.ts")).default;
		const pi = createFakePi();
		audit(pi.api as never);
		const tool = pi.tools.find((t) => t.name === "audit_state_write");
		expect(tool).toBeDefined();
		return (tool!.definition as { execute: Function }).execute;
	}

	it("refuses an audit note inside a guarded worktree — a BEHAVIOUR CHANGE", async () => {
		// Previously permitted: audit_state_write had its own path containment (a
		// slug regex confining it to <cwd>/.pi/audit/) and never consulted the
		// worktree guard, so it wrote into protected checkouts. Now it does not.
		// Pinned so the change is deliberate rather than discovered.
		const execute = await auditTool(guardedRepo());
		const guarded = guardedRepo();
		const result = (await execute("id", { slug: "audit-1", name: "scope.md", content: "x" }, undefined, undefined, {
			cwd: guarded,
		})) as { isError?: boolean; content: { text: string }[] };
		expect(result.isError).toBe(true);
		expect(result.content.map((c) => c.text).join("")).toContain("worktree-protected");
	});

	it("still writes in an ordinary repo", async () => {
		const plain = plainRepo();
		const execute = await auditTool(plain);
		const result = (await execute("id", { slug: "audit-1", name: "scope.md", content: "hello" }, undefined, undefined, {
			cwd: plain,
		})) as { isError?: boolean; content: { text: string }[] };
		expect(result.isError).toBeUndefined();
		expect(result.content.map((c) => c.text).join("")).toContain("Wrote .pi/audit/audit-1/scope.md");
	});
});
