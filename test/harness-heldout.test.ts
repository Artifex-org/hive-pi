/**
 * Held-out scan (HIV-1230) — pure diff scanning plus one real-git round trip.
 *
 * Every directive literal in this file is built by CONCATENATION, for the same
 * reason the scanner's own patterns are: a test fixture containing the raw
 * directive would be flagged by the scanner when it walks the diff that adds
 * this very file.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { gitAvailable } from "./require-tools.ts";
import {
	collectWorkDiff,
	hasFindings,
	renderFindings,
	runHeldOutScan,
	scanDiff,
} from "../extensions/harness/heldout.ts";

const TYPE_IGNORE = "# type: " + "ignore";
const NOQA = "no" + "qa";
const ESLINT_OFF = "eslint-" + "disable";
const TS_IGNORE = "@ts-" + "ignore";
const CAST = "as " + "unknown as";
const SKIP_CALL = "it." + "skip" + "(";
const SETATTR = "set" + "attr(";

/** A one-file unified diff whose hunk adds the given lines at new-line 11. */
function diffAdding(path: string, added: string[]): string {
	return [
		`diff --git a/${path} b/${path}`,
		"index 0000000..1111111 100644",
		`--- a/${path}`,
		`+++ b/${path}`,
		"@@ -10,2 +10,5 @@",
		" context",
		...added.map((line) => `+${line}`),
		" more context",
	].join("\n");
}

describe("scanDiff — evasion tells", () => {
	it("flags suppression directives on ADDED lines with the right path and line", () => {
		const findings = scanDiff(diffAdding("src/mod.py", [`x = f()  ${TYPE_IGNORE}`, "y = 2"]));
		expect(findings.tells).toHaveLength(1);
		expect(findings.tells[0]).toMatchObject({ path: "src/mod.py", line: 11, tell: "type-suppression" });
	});

	it.each([
		["lint-suppression", `import os  # ${NOQA}`],
		["lint-suppression", `// ${ESLINT_OFF}-next-line`],
		["type-suppression", `// ${TS_IGNORE}`],
		["cast-evasion", `const v = x ${CAST} Y;`],
		["attr-evasion", `${SETATTR}request, "user_id", value)`],
		["test-skip", `${SKIP_CALL}"flaky thing", () => {})`],
	])("recognises the %s class", (tell, line) => {
		const findings = scanDiff(diffAdding("src/a.ts", [line]));
		expect(findings.tells.map((t) => t.tell)).toEqual([tell]);
	});

	it("ignores directives on CONTEXT and REMOVED lines — pre-existing sins are not this work's", () => {
		const diff = [
			"diff --git a/src/a.py b/src/a.py",
			"--- a/src/a.py",
			"+++ b/src/a.py",
			"@@ -1,3 +1,3 @@",
			` old = 1  ${TYPE_IGNORE}`,
			`-gone = 2  ${TYPE_IGNORE}`,
			"+clean = 3",
		].join("\n");
		expect(scanDiff(diff).tells).toHaveLength(0);
	});
});

describe("scanDiff — test damage", () => {
	it("flags a deleted test file", () => {
		const diff = [
			"diff --git a/tests/test_foo.py b/tests/test_foo.py",
			"deleted file mode 100644",
			"index 1111111..0000000",
			"--- a/tests/test_foo.py",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-def test_x():",
			"-    assert f() == 1",
		].join("\n");
		const findings = scanDiff(diff);
		expect(findings.testDamage).toEqual([{ path: "tests/test_foo.py", deleted: true, removedAssertions: 0 }]);
		expect(hasFindings(findings)).toBe(true);
	});

	it("counts assertions removed from a surviving test file", () => {
		const diff = [
			"diff --git a/test/foo.test.ts b/test/foo.test.ts",
			"--- a/test/foo.test.ts",
			"+++ b/test/foo.test.ts",
			"@@ -5,7 +5,5 @@",
			" context",
			"-\texpect(x).toBe(1);",
			"-\texpect(y).toBe(2);",
			" more",
		].join("\n");
		const findings = scanDiff(diff);
		expect(findings.testDamage).toEqual([{ path: "test/foo.test.ts", deleted: false, removedAssertions: 2 }]);
	});

	it("does not count assertion churn in NON-test files", () => {
		const diff = [
			"diff --git a/src/logic.ts b/src/logic.ts",
			"--- a/src/logic.ts",
			"+++ b/src/logic.ts",
			"@@ -5,3 +5,2 @@",
			" context",
			"-\tassert(invariant);",
		].join("\n");
		expect(scanDiff(diff).testDamage).toHaveLength(0);
	});
});

describe("renderFindings", () => {
	it("lists each finding with location and names the house rule", () => {
		const findings = scanDiff(diffAdding("src/mod.py", [`x = f()  ${TYPE_IGNORE}`]));
		const text = renderFindings(findings);
		expect(text).toContain("src/mod.py:11");
		expect(text).toContain("type-suppression");
		expect(text).toContain("house rules ban these constructs");
	});
});

describe.runIf(gitAvailable())("collectWorkDiff / runHeldOutScan — real git", () => {
	it("sees uncommitted work against HEAD and reports a clean scan for clean work", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hive-pi-heldout-"));
		execSync(
			"git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init",
			{ cwd, stdio: "ignore" },
		);
		writeFileSync(join(cwd, "clean.ts"), "export const x = 1;\n");
		execSync("git add clean.ts", { cwd, stdio: "ignore" });

		const diff = await collectWorkDiff(cwd);
		expect(diff).toContain("clean.ts");

		const findings = await runHeldOutScan(cwd);
		expect(findings).not.toBeNull();
		expect(hasFindings(findings!)).toBe(false);
	});

	it("returns null (scan disabled) outside a git repo", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "hive-pi-heldout-nogit-"));
		expect(await runHeldOutScan(cwd)).toBeNull();
	});
});
