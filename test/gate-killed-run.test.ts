import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// A KILLED GATE IS NOT AN EMPTY SCOPE.
//
// Node's `close` event delivers `code === null` whenever the child died from a
// SIGNAL rather than exiting. `streamGate` coerced that with `?? 0`, so every
// terminated run — the tool's own 300s ceiling in `quick` mode, or an aborted
// call's SIGTERM — arrived at `render` wearing exit code 0 and no trailer, i.e.
// exactly the shape of quality-gate's "No files changed" short-circuit. The
// agent was then told "Nothing to check — the gate found no files to run
// against <cwd>", followed by a paragraph of merge-base/exclusions advice about
// a scope that was never the problem, followed by hundreds of lines of the
// checks that had in fact been running when the gate was killed (HIV-2687).
//
// This drives the registered tool end to end against a stub gate that kills
// ITSELF, which is the cheapest way to produce the real kernel event
// (`close(null, "SIGKILL")`) without waiting out a five-minute ceiling.

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

async function gateTool(): Promise<Tool> {
	const tools = new Map<string, Tool>();
	const fakePi = {
		registerTool: (t: Tool) => tools.set(t.name, t),
		events: { emit: () => {} },
	};
	const mod = await import("../extensions/gate/index.ts");
	(mod.default as unknown as (pi: typeof fakePi) => void)(fakePi);
	const tool = tools.get("quality_gate");
	if (!tool) throw new Error("quality_gate did not register");
	return tool;
}

/**
 * A repo whose stub gate prints plausible check output and then dies on SIGKILL.
 *
 * `kill -9 $$` inside the script is the child's OWN pid (env(1) execs into it),
 * so the parent observes precisely what the ceiling produces: `close` with
 * `code === null` and `signal === "SIGKILL"`, and no `--json` trailer.
 *
 * The tree is left DIRTY on purpose: the misleading uncommitted-work advice
 * only fires when `git status` finds something, and asserting it is absent is
 * meaningless if there was nothing for it to report.
 */
async function repoWithSuicidalGate(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "gate-killed-"));
	await run("git", ["init", "-q", dir]);
	await writeFile(join(dir, "tracked.py"), "x = 1\n");
	await mkdir(join(dir, "vendor", "quality-gate"), { recursive: true });
	const stub = join(dir, "vendor", "quality-gate", "quality-gate");
	await writeFile(
		stub,
		"#!/bin/sh\n" +
			"echo 'Ruff: checking 18 files'\n" +
			"echo 'basedpyright: analysing…'\n" +
			"kill -9 $$\n",
	);
	await chmod(stub, 0o755);
	await run("git", ["-C", dir, "add", "."]);
	await run("git", ["-C", dir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"]);
	// Uncommitted work, so uncommittedAdvice would have something to say.
	await writeFile(join(dir, "tracked.py"), "x = 2\n");
	return dir;
}

describe("quality_gate on a gate that was killed mid-run", () => {
	it("renders NO VERDICT, not an empty scope", async () => {
		const repo = await repoWithSuicidalGate();
		const tool = await gateTool();
		const out = await tool.execute("t1", { mode: "quick", scope: "changed", cwd: repo }, undefined, undefined, {
			cwd: repo,
		});
		const body = out.content.map((c) => c.text).join("\n");

		// The whole defect in one assertion: a signalled run must never be
		// described as a scope that resolved to nothing.
		expect(body).not.toContain("Nothing to check");
		// …and must not drag the agent through the merge-base / exclusions
		// diagnosis that sent P0240/P0256/P0266/P0284/P0421 down dead ends.
		expect(body).not.toContain("uncommitted path");
		expect(body).not.toContain("different checkout");

		expect(body).toContain("NO VERDICT");
		expect(body).toContain("SIGKILL");
		expect(body).toContain("not a pass");
		// The output it DID produce is still worth reading — that is the tail
		// whose presence under "Nothing to check" gave the bug away.
		expect(body).toContain("Ruff: checking 18 files");
	});
});
