/**
 * `bash` has no `cwd`, so a caller that passes one gets its command run in the
 * session's checkout instead — silently. Eleven papercuts in 48 hours, two of
 * which turned a passing command into false evidence (an unexecuted negative
 * control; a `ruff format` report about files in another worktree).
 */

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import toolcwdExtension from "../extensions/toolcwd/index.ts";
import { repairBashCwd, shellQuote } from "../extensions/toolcwd/cwd.ts";
import { createFakePi } from "./fake-pi.ts";

describe("repairBashCwd", () => {
	it("relocates a command that named a directory it cannot reach", () => {
		const repair = repairBashCwd({ command: "uv run pytest tests/", cwd: "/home/dev/.hive/scratch/s/asf-3685" });
		expect(repair.command).toBe("cd '/home/dev/.hive/scratch/s/asf-3685' && uv run pytest tests/");
		expect(repair.note).toContain("no `cwd` parameter");
	});

	// `cd a && cd b` lands in `a/b` when b is relative, so a command that already
	// located itself must never be prefixed. It still earns the sentence: the
	// caller should stop sending an argument nothing reads.
	it("never prefixes a command that already begins with cd", () => {
		for (const command of ["cd /elsewhere && ls", "  cd /elsewhere && ls", "(cd /elsewhere && ls)"]) {
			const repair = repairBashCwd({ command, cwd: "/somewhere" });
			expect(repair.command).toBeNull();
			expect(repair.note).toContain("already began with `cd`");
		}
	});

	it("stays out of the way when there is nothing to honour", () => {
		expect(repairBashCwd({ command: "ls" }).note).toBeNull();
		expect(repairBashCwd({ command: "ls", cwd: "" }).note).toBeNull();
		expect(repairBashCwd({ command: "ls", cwd: "   " }).note).toBeNull();
		expect(repairBashCwd({ command: "ls", cwd: 7 }).note).toBeNull();
		expect(repairBashCwd({ cwd: "/somewhere" }).note).toBeNull();
		expect(repairBashCwd(undefined).note).toBeNull();
	});

	// A worktree path is attacker-free but not shell-free, and the failure mode
	// of quoting it wrong is a command that runs somewhere else — the exact bug.
	it("quotes a directory the shell would otherwise split or eat", () => {
		expect(shellQuote("/a/b c")).toBe("'/a/b c'");
		// The POSIX form is close-quote, escaped-quote, reopen. NOT a backslash
		// inside the quotes: single quotes have no escapes in sh, so `'it\'s'`
		// would end the string early and hand `cd` a different path — the exact
		// class of failure this file exists to prevent.
		expect(shellQuote("/a/it's")).toBe("'/a/it'\\''s'");
		const repair = repairBashCwd({ command: "ls", cwd: "/a/b c" });
		expect(repair.command).toBe("cd '/a/b c' && ls");
	});

	// The property that actually matters, checked against a real shell rather
	// than against my idea of one.
	it("survives a round trip through sh", () => {
		for (const dir of ["/a/b c", "/a/it's", "/a/$HOME", "/a/b;rm -rf x", "/a/*"]) {
			const out = execFileSync("sh", ["-c", `printf %s ${shellQuote(dir)}`], { encoding: "utf8" });
			expect(out).toBe(dir);
		}
	});
});

describe("the toolcwd extension", () => {
	function boot() {
		const fake = createFakePi();
		toolcwdExtension(fake.api as unknown as ExtensionAPI);
		return fake;
	}

	it("rewrites the command before it runs, and drops the stray argument", async () => {
		const fake = boot();
		const input: Record<string, unknown> = { command: "git status --short", cwd: "/scratch/wt" };
		await fake.emit({ type: "tool_call", toolCallId: "c1", toolName: "bash", input });

		expect(input.command).toBe("cd '/scratch/wt' && git status --short");
		// Dropped so a later handler cannot repair it a second time.
		expect("cwd" in input).toBe(false);
	});

	// The repair must never be invisible: a harness that silently fixes calls is
	// the same class of bug as one that silently breaks them.
	it("appends the explanation to that call's result, and only that call's", async () => {
		const fake = boot();
		await fake.emit({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "bash",
			input: { command: "ls", cwd: "/scratch/wt" },
		});
		await fake.emit({ type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "ls" } });

		const [repaired] = await fake.emit({
			type: "tool_result",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "file.txt" }],
			isError: false,
			input: {},
		});
		const text = JSON.stringify((repaired as { content?: unknown } | undefined)?.content ?? "");
		expect(text).toContain("file.txt");
		expect(text).toContain("no `cwd` parameter");

		// The untouched call gets nothing at all.
		const [plain] = await fake.emit({
			type: "tool_result",
			toolCallId: "c2",
			toolName: "bash",
			content: [{ type: "text", text: "file.txt" }],
			isError: false,
			input: {},
		});
		expect(plain).toBeUndefined();
	});

	// Delivered once. A note that re-appended on every later result would follow
	// the session around.
	it("owes the note exactly once", async () => {
		const fake = boot();
		await fake.emit({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "bash",
			input: { command: "ls", cwd: "/scratch/wt" },
		});
		const result = { type: "tool_result", toolCallId: "c1", toolName: "bash", content: [], isError: false, input: {} };
		expect((await fake.emit(result))[0]).toBeDefined();
		expect((await fake.emit(result))[0]).toBeUndefined();
	});

	it("ignores every tool that is not bash", async () => {
		const fake = boot();
		const input: Record<string, unknown> = { command: "ls", cwd: "/scratch/wt" };
		await fake.emit({ type: "tool_call", toolCallId: "c1", toolName: "background_bash", input });
		// background_bash HAS a cwd and honours it; touching that would break it.
		expect(input.cwd).toBe("/scratch/wt");
		expect(input.command).toBe("ls");
	});
});
