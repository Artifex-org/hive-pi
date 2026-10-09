import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addedGoTests, boundedFile, codemodeTruncationHint, excludedGoTests, goRunPatterns, goTestHint, SCAN_BYTES, socketTimeoutHint } from "../extensions/toolhints/contextual.ts";
import toolhints from "../extensions/toolhints/index.ts";
import { createFakePi } from "./fake-pi.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "hints-")); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const diff = "+func TestLinearDiagnosis(t *testing.T) {}\n+func TestLinearFinalReportUnknown(t *testing.T) {}\n-func TestDeleted(t *testing.T) {}\n+// func TestComment(t *testing.T) {}";
const selected = "go test ./... -run '^Test(LinearDiagnosis|EveryFactorycapRefusalCodeIsMapped|CapabilityEnvelope)'";

describe("added Go tests vs the selected run", () => {
	it("names the eval's excluded final-report test, not deleted/commented tests", async () => {
		const git = vi.fn(async (args: string[]) => args[0] === "ls-files" ? "" : diff);
		expect(await goTestHint(selected, "/repo", git)).toContain("TestLinearFinalReportUnknown");
		expect(addedGoTests(diff)).toEqual(["TestLinearDiagnosis", "TestLinearFinalReportUnknown"]);
		expect(addedGoTests("+func Testhelper(t *testing.T) {}\n+func Test(t *testing.T) {}\n+func TestÄ(t *testing.T) {}\n+func Testé(t *testing.T) {}")).toEqual(["Test", "TestÄ"]);
		expect(git.mock.calls).toHaveLength(4);
	});
	it("handles quotes, equals flags, and the last repeated -run; not echo or -args", () => {
		expect(goRunPatterns("cd api && go test -run='^TestA$' -run \"TestB\" ./...")).toEqual(["^TestA$", "TestB"]);
		expect(goRunPatterns("echo 'go test -run TestA'; go test -args -run Nope")).toEqual([]);
		expect(goRunPatterns("go test -run $PATTERN")).toEqual([]);
	});
	it("stays quiet without -run, additions, or exclusions", async () => {
		const git = vi.fn(async (args: string[]) => args[0] === "ls-files" ? "" : diff);
		expect(await goTestHint("go test ./...", "/repo", git)).toBeNull();
		expect(git).not.toHaveBeenCalled();
		expect(await goTestHint("go test -run '^TestLinear'", "/repo", git)).toBeNull();
		expect(await goTestHint(selected, "/repo", async (args) => args[0] === "ls-files" ? "" : "-func TestOld(t *testing.T) {}" )).toBeNull();
	});
	it("does not guess unsupported/dynamic regexps or hide scan failures", async () => {
		for (const pattern of ["(?i)test", "(a+)+$", "[", "Test/Sub", "a{500}", "x".repeat(257)]) expect(excludedGoTests(pattern, ["TestA"])).toBeNull();
		expect(await goTestHint(selected, "/repo", async () => { throw new Error("budget"); })).toContain("NOT checked");
	});
	it("does not scan the wrong repository after a dynamic cd", async () => {
		const git = vi.fn();
		expect(await goTestHint('cd "$REPO" && go test -run TestFoo', "/repo", git)).toContain("NOT checked");
		expect(git).not.toHaveBeenCalled();
	});
	it("reports scan caps instead of silently dropping added names", async () => {
		const many = Array.from({ length: 101 }, (_, i) => `+func TestAdded${i}(t *testing.T) {}`).join("\n");
		expect(await goTestHint(selected, "/repo", async (args) => args[0] === "ls-files" ? "" : many)).toContain("NOT checked");
	});
	it("uses the merge-base including committed, staged and working-tree additions", async () => {
		const cwd = temp();
		const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
		git("init", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
		writeFileSync(join(cwd, "base.txt"), "base"); git("add", "."); git("commit", "-m", "base");
		git("update-ref", "refs/remotes/origin/main", "HEAD"); git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		writeFileSync(join(cwd, "a_test.go"), "package x\nfunc TestCommitted(t *testing.T) {}\n"); git("add", "."); git("commit", "-m", "test");
		writeFileSync(join(cwd, "b_test.go"), "package x\nfunc TestStaged(t *testing.T) {}\n"); git("add", ".");
		writeFileSync(join(cwd, "a_test.go"), "package x\nfunc TestCommitted(t *testing.T) {}\nfunc TestWorking(t *testing.T) {}\n");
		const hint = await goTestHint("go test -run '^TestOther$'", cwd);
		for (const name of ["TestCommitted", "TestStaged", "TestWorking"]) expect(hint).toContain(name);
		writeFileSync(join(cwd, "c_test.go"), "package x\nfunc TestUntracked(t *testing.T) {}\n");
		expect(await goTestHint("go test -run '^TestOther$'", cwd)).toContain("TestUntracked");
		// Two invocations: each uses its own last flag, never the final command's
		// regex for the whole shell batch. Both run against a real merge-base.
		git("config", "color.diff", "always");
		git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
		expect(await goTestHint("go test -run '^TestOther$'", cwd)).toContain("TestUntracked");
		const batch = await goTestHint(`cd '${cwd}' && go test -run '^TestCommitted$' && go test -run '^TestStaged$'`, "/tmp");
		expect(batch).toContain('-run "^TestCommitted$"'); expect(batch).toContain('-run "^TestStaged$"');
	});
});

describe("timeout with socket source", () => {
	const output = "FAIL test/transport.test.ts > exchange\nError: Test timed out in 5000ms";
	it("requires timeout, the SAME failing file's socket path, and a sandbox", async () => {
		expect(await socketTimeoutHint(output, "/repo", true, async () => "const socket = '/tmp/hc.sock'")).toContain("test/transport.test.ts");
		expect(await socketTimeoutHint(output, "/repo", true, async () => "listen(8080)")).toBeNull();
		expect(await socketTimeoutHint(output, "/repo", false, async () => "'/tmp/x.sock'")).toBeNull();
		expect(await socketTimeoutHint("FAIL test/transport.test.ts\nAssertion failed", "/repo", true, async () => "'/tmp/x.sock'")).toBeNull();
		const read = vi.fn(async () => "'/tmp/x.sock'");
		expect(await socketTimeoutHint(output.replace("test/transport", "../transport"), "/repo", true, read)).toBeNull();
		expect(read).not.toHaveBeenCalled();
	});
	it("does not attribute A's timeout to an unrelated socket assertion in B", async () => {
		const mixed = "FAIL test/a.test.ts > waits\nTest timed out in 5000ms\n FAIL test/b.test.ts > asserts\nAssertionError: unequal";
		const read = vi.fn(async (path: string) => path.endsWith("b.test.ts") ? "'/tmp/x.sock'" : "listen(8080)");
		expect(await socketTimeoutHint(mixed, "/repo", true, read)).toBeNull();
		expect(read.mock.calls).toEqual([["/repo/test/a.test.ts"]]);
	});
	it("bounds source reads and reports failures", async () => {
		const file = join(temp(), "big"); writeFileSync(file, "x".repeat(SCAN_BYTES + 1));
		await expect(boundedFile(file)).rejects.toThrow("scan budget");
		expect(await socketTimeoutHint(output, "/repo", true, async () => { throw new Error("unreadable"); })).toContain("NOT checked");
	});
});

describe("codemode's combined output budget", () => {
	const marker = "Warning: truncated output (original token count: 12345)\nfirst…500 tokens truncated…last";
	it("attributes cut reads, but not reads still visible or filtered before printing", async () => {
		const hint = await codemodeTruncationHint(marker, "/tmp/spill", [{ path: "a", text: "first" }, { path: "b", text: "middle" }, { path: "c", text: "last" }, { path: "filtered", text: "not printed" }], async () => "first\nmiddle\nlast");
		expect(hint).toContain("Reads cut: b."); expect(hint).toContain("one bounded read per call");
		expect(hint).not.toContain("Reads cut: a");
	});
	it("does not confuse a nested read cap or TUI preview with script truncation", async () => {
		for (const text of ["[2000 lines truncated]", "... (10 earlier calls, to expand)", "Script completed\nnormal", "readiness reports truncated output"]) expect(await codemodeTruncationHint(text, undefined, [])).toBeNull();
	});
	it("states when attribution cannot be established, rather than inventing lost reads", async () => {
		expect(await codemodeTruncationHint(marker + "\n[Could not save the full output: disk error]", undefined, [{ path: "a", text: "abc" }])).toContain("attribution NOT checked");
		expect(await codemodeTruncationHint(marker, undefined, [])).toBeNull();
	});
	it("annotates a SUCCESSFUL codemode result via the real nested-read event seam", async () => {
		vi.stubEnv("PI_TOOLHINTS", "1"); const pi = createFakePi(); toolhints(pi.api);
		const spill = join(temp(), "out"); writeFileSync(spill, "first\nmiddle\nlast");
		await pi.emit({ type: "tool_call", toolName: "codemode", toolCallId: "p", input: { code: "" } });
		await pi.emit({ type: "tool_result", toolName: "read", toolCallId: "p/1", parentToolCallId: "p", input: { path: "server.ts" }, isError: false, content: [{ type: "text", text: "middle" }] });
		const [patch] = await pi.emit({ type: "tool_result", toolName: "codemode", toolCallId: "p", input: {}, isError: false, details: { fullOutputPath: spill }, content: [{ type: "text", text: marker }] });
		expect(patch).toMatchObject({ content: [{ text: expect.stringContaining("Reads cut: server.ts") }] });
	});
});
