import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Catastrophic regex backtracking on tool-call text (2026-10-09/10).
 *
 * `deliveryTargets` stripped leading `NAME=value` words with
 * `(?:[^\s'"\\]+|'…'|"…")*\s+`: a nested quantifier that splits an N-character
 * unquoted value 2^(N-1) ways when no whitespace follows it. Every bash call
 * passes through it on the main thread, so `src=/a/long/path; git -C "$src" …`
 * spun the event loop forever, starved the Hive heartbeat and ended five pi
 * sessions in `heartbeat_timeout`. The siblings below had the same shape.
 *
 * A synchronous regex cannot be interrupted by a Vitest timeout, so each case
 * runs in a child process the parent kills at a deadline. Before the fix every
 * case here runs for hours; after it, each takes milliseconds.
 */
const ROOT = join(import.meta.dirname, "..");
const mod = (rel: string) => JSON.stringify(pathToFileURL(join(ROOT, rel)).href);

function run(imports: string, body: string): { value: unknown; ms: number } {
	const script = `${imports}\nconst started = performance.now();\nconst value = (() => { ${body} })();\n` +
		`process.stdout.write(JSON.stringify({ value, ms: performance.now() - started }));`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8", timeout: 15_000 });
	expect(child.signal, `child killed at the deadline (catastrophic backtracking)\n${child.stderr}`).toBeNull();
	expect(child.status, child.stderr).toBe(0);
	return JSON.parse(child.stdout) as { value: unknown; ms: number };
}

const delivery = `import { deliveryTargets } from ${mod("extensions/subagent/delivery.ts")};`;

describe("regexes on tool-call text cannot backtrack catastrophically", () => {
	it.each([
		// The fresh session's first codemode bash call, paths anonymised.
		'src=/home/user/repos/project__worktrees/eval-task-0123456789abcdef; git -C "$src" rev-parse HEAD; ' +
			'git -C "$src" diff --binary > /tmp/transfer.patch; git apply --check /tmp/transfer.patch',
		// The resumed session's heredoc: every Python line is a segment.
		"git apply /tmp/transfer.patch && python3 - <<'PY'\nfrom pathlib import Path\n" +
			"old=Path('/home/user/repos/project__worktrees/eval-task-0123456789abcdef');new=Path.cwd()\n" +
			"extra=Path('/tmp/transfer-untracked').read_text().splitlines()\nPY",
		`X=${"a".repeat(4096)}`,
		`X=${"a'b'".repeat(1024)}`,
	])("deliveryTargets returns promptly for a non-delivery assignment: %#", (command) => {
		const { value, ms } = run(delivery, `return deliveryTargets(${JSON.stringify(command)}, "/repo");`);
		expect(value).toEqual([]);
		expect(ms).toBeLessThan(1000);
	});

	it("deliveryTargets still strips long assignments before a delivery verb", () => {
		const command = `A=${"a".repeat(4096)} B='x y' C="p q" git push origin HEAD`;
		const { value, ms } = run(delivery, `return deliveryTargets(${JSON.stringify(command)}, "/repo");`);
		expect(value).toEqual(["/repo"]);
		expect(ms).toBeLessThan(1000);
	});

	it("plan mode's git-fetch hint is linear in the number of options", () => {
		const { value, ms } = run(`import { classifyCommand } from ${mod("extensions/plan/policy.ts")};`, `
			const many = "git" + " -a".repeat(64);
			return [classifyCommand(many + " > out").reason, classifyCommand(many + " fetch origin").reason];`);
		const [plain, fetch] = value as string[];
		expect(plain).not.toContain("git fetch writes refs");
		expect(fetch).toContain("git fetch writes refs");
		expect(ms).toBeLessThan(1000);
	});

	it("the PR-attachment shape key is linear in the number of --flag=value words", () => {
		const { value, ms } = run(`import { commandShapeKey } from ${mod("extensions/pr-attachments/logic.ts")};`, `
			return [commandShapeKey("gh" + " --a=b".repeat(64) + " x"), commandShapeKey("gh --repo=o/r pr comment 5")];`);
		expect(value).toEqual([`gh${" --a=b".repeat(64)} x`, "gh pr comment 5"]);
		expect(ms).toBeLessThan(1000);
	});

	it("lens bracket counting is linear in a run of backslashes inside an unterminated string", () => {
		const source = `def f(a, b="${"\\".repeat(80)},\n      c=1):\n    return a\n\nx = 1\n`;
		const { value, ms } = run(`import { findSymbol } from ${mod("extensions/lens/symbols.ts")};`,
			`return findSymbol(${JSON.stringify(source)}, "m.py", "f").map((s) => [s.startLine, s.endLine]);`);
		expect(value).toEqual([[1, 3]]);
		expect(ms).toBeLessThan(1000);
	});
});
