import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

// THE WIRING.
//
// `gate.test.ts` proves render says the right thing when handed a count, and
// `gate-uncommitted-count.test.ts` proves the count is right. Neither proves the
// tool ever ASKS for it — and a negative control reverting only the call site
// (`uncommitted: undefined`) left all 3165 tests passing. A counter nobody calls
// is the same silent "Nothing to check" this change exists to explain.
//
// So this drives the registered `quality_gate` tool end to end against a real
// repository with a real dirty tree and a stub gate that short-circuits exactly
// the way quality-gate does ("No files changed", exit 0), and reads what the
// agent would actually be told.

const run = promisify(execFile);

type Tool = {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: Array<{ text: string }> }>;
};

let repo: string;

async function gateTool(): Promise<Tool> {
	const tools = new Map<string, Tool>();
	const fakePi = {
		registerTool: (t: Tool) => tools.set(t.name, t),
		// publishDeck emits on this channel; it is wrapped in try/catch, but a
		// working emitter keeps the test honest about the normal path.
		events: { emit: () => {} },
	};
	const mod = await import("../extensions/gate/index.ts");
	(mod.default as unknown as (pi: typeof fakePi) => void)(fakePi);
	const tool = tools.get("quality_gate");
	if (!tool) throw new Error("quality_gate did not register");
	return tool;
}

/**
 * A repository whose baseline is COMMITTED — including the stub gate.
 *
 * The stub has to be in the initial commit, not added afterwards: an untracked
 * `vendor/` is itself uncommitted work, which both inflates the count and makes
 * the "clean" case not clean. (It did, on the first run of this test.)
 */
async function repoWithStubGate(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	await run("git", ["init", "-q", dir]);
	await writeFile(join(dir, "tracked.py"), "x = 1\n");
	// A stub standing in for quality-gate's short-circuit: it prints the same
	// line and exits 0 without a --json trailer, which is what drives render's
	// zero-check branch. Found through the real findGate path
	// (vendor/quality-gate/quality-gate is its first candidate).
	await mkdir(join(dir, "vendor", "quality-gate"), { recursive: true });
	const stub = join(dir, "vendor", "quality-gate", "quality-gate");
	await writeFile(stub, "#!/bin/sh\necho 'No files changed - skipping quality gate'\nexit 0\n");
	await chmod(stub, 0o755);
	await run("git", ["-C", dir, "add", "."]);
	await run("git", ["-C", dir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"]);
	return dir;
}

beforeAll(async () => {
	repo = await repoWithStubGate("gate-wiring-");
	// UNCOMMITTED work — the whole point. Committed changes would be visible to
	// `--changed` and would not reproduce the papercut.
	await writeFile(join(repo, "tracked.py"), "x = 2\n");
	await writeFile(join(repo, "untracked.py"), "y = 3\n");
});

describe("quality_gate names uncommitted work when it checked nothing", () => {
	it("asks for the count and puts it in the message", async () => {
		const tool = await gateTool();
		const out = await tool.execute("t1", { mode: "quick", scope: "changed", cwd: repo }, undefined, undefined, {
			cwd: repo,
		});
		const body = out.content.map((c) => c.text).join("\n");

		expect(body).toContain("Nothing to check");
		expect(body).toContain("NOT a pass");
		// The count had to come from a real `git status` in `repo`: two paths,
		// one modified and one untracked.
		expect(body).toContain("2 uncommitted paths");
		expect(body).toContain("merge-base");
		// And the advice that was wrong for this cause must not be what it says.
		expect(body).not.toContain("different checkout");
	});

	// The other half of the same wiring: a CLEAN tree must still get the
	// wrong-checkout reading, so the count is genuinely being consulted rather
	// than the new branch being taken unconditionally.
	it("keeps the old reading when the same tree is clean", async () => {
		const clean = await repoWithStubGate("gate-wiring-clean-");

		const tool = await gateTool();
		const out = await tool.execute("t2", { mode: "quick", scope: "changed", cwd: clean }, undefined, undefined, {
			cwd: clean,
		});
		const body = out.content.map((c) => c.text).join("\n");

		expect(body).toContain("Nothing to check");
		expect(body).toContain("different checkout");
		expect(body).not.toContain("uncommitted path");
	});
});
