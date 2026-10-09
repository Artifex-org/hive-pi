import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as lensSymbols from "../extensions/lens/symbols.ts";
import { captureDeliveryDiff, citedOutsideDiff, reviewScopeFiles, reviewTaskWithDiff, outsideDiffWarning, withReviewCallers } from "../extensions/subagent/reviewdiff.ts";
import { CALLER_DECLARATION_CAP, CALLER_FILE_CAP, CALLER_GREP_BYTES, CALLER_SITE_CAP, CALLER_SYMBOL_CAP, changedFunctionNames, discoverCallers } from "../extensions/subagent/reviewcallers.ts";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const patch = "--- a/api.go\n+++ b/api.go\n@@ -1,4 +1,4 @@\n func PullFiles() error {\n- return nil\n+ return err\n }\n";
const source = "func PullFiles() error {\n return err\n}\n";

describe("caller-aware review scope", () => {
	it("includes unchanged callers of a body-only changed exported function, on the real delivery path", () => {
		const repo = mkdtempSync(join(tmpdir(), "review-callers-")); dirs.push(repo);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		git("init", "-b", "main"); git("config", "color.grep", "always"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
		const lines = "func (c *Client) PullFiles() error {\n" + " // unchanged\n".repeat(12);
		writeFileSync(join(repo, "api.go"), lines + " return nil\n}\n");
		for (const file of ["panel.go", "coverage.go", "migration.go"]) writeFileSync(join(repo, file), "package api\nfunc caller() { c.PullFiles() }\n");
		writeFileSync(join(repo, "unrelated.go"), "package api\nfunc Other() {}\n");
		git("add", "."); git("commit", "-m", "base"); git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-b", "work");
		writeFileSync(join(repo, "api.go"), lines + " return err\n}\n");
		git("add", "api.go"); git("commit", "-m", "change return contract");
		const captured = captureDeliveryDiff(repo)!;
		expect(captured.text).not.toContain("\n func (c *Client) PullFiles"); // declaration is outside ordinary diff context
		const review = withReviewCallers(captured);
		expect(review.callers?.sites.map((s) => s.path).sort()).toEqual(["coverage.go", "migration.go", "panel.go"]);
		const output = "panel.go:2 — broken caller\nunrelated.go:2 — irrelevant";
		expect(citedOutsideDiff(output, reviewScopeFiles(review))).toEqual(["unrelated.go"]);
		const task = reviewTaskWithDiff("review", review, true);
		expect(task).toContain("Callers of changed symbols"); expect(task).toContain("Check EACH listed caller's handling");
		for (const file of ["panel.go", "coverage.go", "migration.go"]) expect(task).toContain(`${file}:2 — PullFiles(`);
		const rows = Array.from({ length: 81 }, (_, n) => `caller${n}.go:2: PullFiles()`).join("\n");
		const capped = { ...review, callers: discoverCallers(repo, patch, ["api.go"], () => ({ text: rows }), () => source) };
		expect(capped.callers.sites).toHaveLength(80);
		expect(reviewTaskWithDiff("review", capped, true)).toContain("Independently verified affected callers are also in scope");
		const outside = citedOutsideDiff("caller80.go:2 — PullFiles() contract broken\nunrelated.go:2 — irrelevant", reviewScopeFiles(capped));
		expect(outside).toEqual(["caller80.go", "unrelated.go"]);
		expect(outsideDiffWarning(outside, reviewScopeFiles(capped).length)).toContain("independently verified affected callers are valid findings");
		expect(outsideDiffWarning(outside, reviewScopeFiles(capped).length)).toContain("unrelated paths are not");
	});
	it("uses each delivery layer's source coordinates after staged line insertions", () => {
		const repo = mkdtempSync(join(tmpdir(), "layered-callers-")); dirs.push(repo);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
		git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
		const body = "// initial header\n".repeat(10) + "impl Client {\n    pub fn fetch(&self) -> Result<T> {\n" + "        // body\n".repeat(30);
		writeFileSync(join(repo, "api.rs"), body + "        Ok(value)\n    }\n}\n");
		writeFileSync(join(repo, "caller.rs"), "client.fetch();\n");
		git("add", "."); git("commit", "-m", "base"); git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-b", "work");
		const committed = body + "        Err(error)\n    }\n}\n";
		writeFileSync(join(repo, "api.rs"), committed); git("add", "."); git("commit", "-m", "body change");
		writeFileSync(join(repo, "api.rs"), "// prefix\n".repeat(100) + committed); git("add", ".");
		const review = withReviewCallers(captureDeliveryDiff(repo)!);
		expect(review.callers?.sites).toEqual([{ symbol: "fetch", path: "caller.rs", line: 1 }]);
	});
	it("discovers a body-only public method change in an exported TypeScript class", () => {
		const repo = mkdtempSync(join(tmpdir(), "ts-method-callers-")); dirs.push(repo);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
		git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "test");
		const body = "export class Client {\n  public async fetch(options: { id: string; count: number }): Promise<{ id: string }> {\n" + "    // body\n".repeat(12);
		writeFileSync(join(repo, "api.ts"), body + "    return fallback;\n  }\n}\n");
		writeFileSync(join(repo, "caller.ts"), "client.fetch();\n");
		git("add", "."); git("commit", "-m", "base"); git("update-ref", "refs/remotes/origin/main", "HEAD"); git("checkout", "-b", "work");
		writeFileSync(join(repo, "api.ts"), body + "    throw new Error();\n  }\n}\n"); git("add", "."); git("commit", "-m", "method contract");
		expect(withReviewCallers(captureDeliveryDiff(repo)!).callers?.sites).toEqual([{ symbol: "fetch", path: "caller.ts", line: 1 }]);
	});
	it("discovers cross-file package-local Go callers after a body-only change", () => {
		const local = "func parseToken() error {\n" + " // unchanged\n".repeat(12) + " panic(err)\n}\n";
		const changed = "--- a/api.go\n+++ b/api.go\n@@ -14 +14 @@\n- return err\n+ panic(err)\n";
		expect(discoverCallers("/repo", changed, ["api.go"], () => ({ text: "caller.go:3: parseToken()" }), () => local).sites)
			.toEqual([{ symbol: "parseToken", path: "caller.go", line: 3 }]);
	});
	it("discovers body changes in functions exported through a separate list", () => {
		const source = "function fetchData() {\n" + "  // unchanged\n".repeat(12) + "  throw new Error();\n}\nexport { fetchData };\n";
		const changed = "--- a/api.ts\n+++ b/api.ts\n@@ -14 +14 @@\n-  return fallback;\n+  throw new Error();\n";
		expect(discoverCallers("/repo", changed, ["api.ts"], () => ({ text: "caller.ts:2: fetchData()" }), () => source).sites)
			.toEqual([{ symbol: "fetchData", path: "caller.ts", line: 2 }]);
	});
	it("retains a same-name forwarding call on its declaration line", () => {
		const changed = "--- a/api.ts\n+++ b/api.ts\n@@ -1 +1 @@\n-export function fetch() {}\n+export function fetch() { throw new Error(); }\n";
		const rows = "wrapper.ts:1:export function fetch() { return api.fetch(); }\nonly-declaration.ts:1:export function fetch() { return 1; }";
		expect(discoverCallers("/repo", changed, ["api.ts"], () => ({ text: rows }), () => "").sites)
			.toEqual([{ symbol: "fetch", path: "wrapper.ts", line: 1 }]);
	});
	it("discovers ordinary multiline class methods and generator body changes", () => {
		for (const [symbol, source, line] of [["fetch", "export class Client {\n  fetch(\n    options: string,\n  ) {\n" + "    // body\n".repeat(12) + "    throw new Error();\n  }\n}\n", 17],
			["records", "export function* records() {\n" + "  // body\n".repeat(12) + "  throw new Error();\n}\n", 14]] as const) {
			const changed = `--- a/api.ts\n+++ b/api.ts\n@@ -${line} +${line} @@\n- old\n+ new`;
			expect(discoverCallers("/repo", changed, ["api.ts"], () => ({ text: `caller.ts:2: ${symbol}()` }), () => source).sites)
				.toEqual([{ symbol, path: "caller.ts", line: 2 }]);
		}
		const generator = "--- a/api.ts\n+++ b/api.ts\n@@ -1 +1 @@\n-export function* records() {}\n+export function* records() { yield 1; }\n";
		expect(changedFunctionNames(generator, () => "").names).toEqual(["records"]);
	});
	it("rejects symlinked special files without a blocking or unbounded read", () => {
		const repo = mkdtempSync(join(tmpdir(), "special-callers-")); dirs.push(repo);
		symlinkSync("/dev/zero", join(repo, "api.ts"));
		const changed = "--- a/api.ts\n+++ b/api.ts\n@@ -1 +1 @@\n-old\n+new";
		expect(discoverCallers(repo, changed, ["api.ts"]).notes.join(" ")).toContain("Could not scan api.ts");
	});
	it("keeps caller-only outline entries out of the existing symbol-list workflow", () => {
		const source = "class Client {\n  fetch(\n    options: string,\n  ) {\n    return options;\n  }\n}\n";
		expect(lensSymbols.listSymbols(source, "api.ts").some((s) => s.signature.startsWith("fetch"))).toBe(false);
		expect(lensSymbols.listSymbols(source, "api.ts", 65, undefined, true).some((s) => s.signature.startsWith("fetch"))).toBe(true);
	});
	it("finds explicit generic callers in TypeScript, Go and Rust", () => {
		const repo = mkdtempSync(join(tmpdir(), "generic-callers-")); dirs.push(repo);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
		git("init", "-b", "main");
		writeFileSync(join(repo, "client.ts"), "Fetch<User>(input);\n");
		writeFileSync(join(repo, "client.go"), "Fetch[User](input)\n");
		writeFileSync(join(repo, "client.rs"), "Fetch::<User>(input);\n");
		git("add", ".");
		const changed = "--- a/api.ts\n+++ b/api.ts\n@@ -1 +1 @@\n-export function Fetch<T>() {}\n+export function Fetch<T>() { throw new Error(); }\n";
		expect(discoverCallers(repo, changed, ["api.ts"], undefined, () => "").sites.map((site) => site.path).sort())
			.toEqual(["client.go", "client.rs", "client.ts"]);
	});
	it("discovers a body-only Rust impl method when the hunk header names the impl", () => {
		const rust = "impl Client {\n    pub fn fetch(&self) -> &'static str {\n        let brace = '}';\n" + "        // body\n".repeat(12) + "        Err(error)\n    }\n}\n";
		const changed = "--- a/api.rs\n+++ b/api.rs\n@@ -16 +16 @@ impl Client {\n-        Ok(value)\n+        Err(error)\n";
		const grep = vi.fn(() => ({ text: "client.rs:4: client.fetch()" }));
		expect(discoverCallers("/repo", changed, ["api.rs"], grep, () => rust).sites).toEqual([{ symbol: "fetch", path: "client.rs", line: 4 }]);
		expect(grep).toHaveBeenCalledWith("fetch", "/repo", expect.any(Number));
	});
	it("prioritizes a changed final method before conservative earlier windows spend the symbol cap", () => {
		const rust = "impl Client {\n" + Array.from({ length: 18 }, (_, n) => `    pub fn fetch${n}(&self) {\n${"        // unchanged\n".repeat(12)}        ${n === 17 ? "changed();" : "unchanged();"}\n    }\n`).join("") + "}\n";
		const line = rust.split("\n").findIndex((row) => row.includes("changed();") && !row.includes("unchanged();")) + 1;
		const changed = `--- a/api.rs\n+++ b/api.rs\n@@ -${line} +${line} @@ impl Client {\n-        unchanged();\n+        changed();\n`;
		const second = "impl Other {\n    pub fn second(&self) {\n" + "        // body\n".repeat(12) + "        changed();\n    }\n}\n";
		const twoFiles = changed + "\n--- a/other.rs\n+++ b/other.rs\n@@ -15 +15 @@ impl Other {\n-        old();\n+        changed();\n";
		const result = discoverCallers("/repo", twoFiles, ["api.rs", "other.rs"], (symbol) => ({ text: ["fetch17", "second"].includes(symbol) ? `caller.rs:4: client.${symbol}()` : "" }), (file) => file === "api.rs" ? rust : second);
		expect(result.sites).toEqual([{ symbol: "fetch17", path: "caller.rs", line: 4 }, { symbol: "second", path: "caller.rs", line: 4 }]);
		expect(result.notes.join(" ")).toContain(`capped at ${CALLER_SYMBOL_CAP} functions`);
	});
	it("discovers body-only Rust changes after a multiline where clause", () => {
		const rust = "impl Client {\n    pub fn fetch<T>(&self, value: T) -> Result<T, Error>\n    where\n        T: Clone,\n    {\n" + "        // body\n".repeat(12) + "        Err(error)\n    }\n}\n";
		const changed = "--- a/api.rs\n+++ b/api.rs\n@@ -18 +18 @@ impl Client {\n-        Ok(value)\n+        Err(error)\n";
		expect(discoverCallers("/repo", changed, ["api.rs"], () => ({ text: "caller.rs:4: client.fetch(value)" }), () => rust).sites)
			.toEqual([{ symbol: "fetch", path: "caller.rs", line: 4 }]);
	});
	it("discovers multiline exported arrows from body-only edits and removed declarations", () => {
		const arrow = "export const fetchData = (\n  id: string,\n) => {\n" + "  // unchanged\n".repeat(12) + "  return updated;\n};\n";
		const changed = "--- a/api.ts\n+++ b/api.ts\n@@ -16 +16 @@\n-  return old;\n+  return updated;\n";
		const grep = vi.fn(() => ({ text: "caller.ts:4: fetchData(id)" }));
		expect(discoverCallers("/repo", changed, ["api.ts"], grep, () => arrow).sites).toEqual([{ symbol: "fetchData", path: "caller.ts", line: 4 }]);
		const removed = "--- a/api.ts\n+++ b/api.ts\n@@ -1,5 +0,0 @@\n-export const fetchData = (\n-  id: string,\n-) => {\n-  return old;\n-};\n";
		expect(changedFunctionNames(removed, () => "").names).toEqual(["fetchData"]);
	});
	it("recognises generic exported arrows for declaration and body edits", () => {
		const generic = "export const fetchData = <T>(id: string) => {\n" + "  // unchanged\n".repeat(12) + "  return updated;\n};\n";
		const bodyPatch = "--- a/api.ts\n+++ b/api.ts\n@@ -14 +14 @@\n-  return old;\n+  return updated;\n";
		const grep = () => ({ text: "caller.ts:4: fetchData(id)" });
		expect(discoverCallers("/repo", bodyPatch, ["api.ts"], grep, () => generic).sites).toHaveLength(1);
		const declPatch = "--- a/api.ts\n+++ b/api.ts\n@@ -1 +1 @@\n-export const fetchData = <T>(id: string) => 1;\n+export const fetchData = <T>(id: string) => 2;\n";
		expect(changedFunctionNames(declPatch, () => generic).names).toEqual(["fetchData"]);
	});
	it("recognises Go methods, TS exports and Python functions but not call expressions", () => {
		const p = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-export function Fetch() {}", "+export async function Fetch() { return 1; }", "+obj.Unrelated()", "+func (c *Client) PullFiles() error {", "+def fetch_data():", "+func private() {}", "+export const CONSTANT = 1;", "+export const arrow = (x) => x;"].join("\n");
		expect(changedFunctionNames(p, () => "").names).toEqual(["Fetch", "PullFiles", "fetch_data", "private", "arrow"]);
	});
	it("caps symbols, source files, call sites and per-grep output, and reports the limits", () => {
		const wide = Array.from({ length: CALLER_FILE_CAP + 4 }, (_, n) => `--- a/f${n}.go\n+++ b/f${n}.go\n@@ -1 +1 @@\n-old\n+new`).join("\n");
		const read = vi.fn(() => source);
		expect(changedFunctionNames(wide, read).notes.join(" ")).toContain(`capped at ${CALLER_FILE_CAP} files`);
		expect(read).toHaveBeenCalledTimes(CALLER_FILE_CAP);
		const many = patch + Array.from({ length: 30 }, (_, n) => `\n+func F${n}() {}`).join("");
		const grep = vi.fn(() => ({ text: "" }));
		expect(discoverCallers("/repo", many, ["api.go"], grep, () => source).notes.join(" ")).toContain(`capped at ${CALLER_SYMBOL_CAP}`);
		expect(grep).toHaveBeenCalledTimes(CALLER_SYMBOL_CAP);
		const rows = Array.from({ length: 100 }, (_, n) => `caller${n}.go:2: PullFiles()`).join("\n");
		const inventory = discoverCallers("/repo", patch, ["api.go"], () => ({ text: rows }), () => source);
		expect(inventory.sites).toHaveLength(CALLER_SITE_CAP); expect(inventory.notes.join(" ")).toContain(`capped at ${CALLER_SITE_CAP}`);
		const huge = "x".repeat(CALLER_GREP_BYTES) + "\nlate.go:1: PullFiles()";
		expect(discoverCallers("/repo", patch, ["api.go"], () => ({ text: huge }), () => source).sites).toHaveLength(0);
	});
	it("stops grep work at the shared wall-clock budget", () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const grep = vi.fn(() => { vi.setSystemTime(2001); return { text: "caller.go:1: PullFiles()" }; });
		const result = discoverCallers("/repo", patch + "\n+func Another() {}", [], grep, () => source);
		expect(grep).toHaveBeenCalledTimes(1);
		expect(result.notes.join(" ")).toContain("2000ms budget");
	});
	it("caps one outline pass and avoids repeated whole-file symbol scans", () => {
		for (const dense of [Array.from({ length: 3000 }, (_, n) => `export function F${n}() { return ${n}; }`).join("\n"),
			"export function Same() { return 1; }\n".repeat(500)]) {
			const changed = "--- a/dense.ts\n+++ b/dense.ts\n@@ -500 +500 @@\n-old\n+new";
			const scan = vi.spyOn(lensSymbols, "findSymbol");
			const outline = vi.spyOn(lensSymbols, "listSymbols");
			try {
				const result = changedFunctionNames(changed, () => dense);
				expect(scan).not.toHaveBeenCalled();
				expect(outline).toHaveBeenCalledExactlyOnceWith(dense, "dense.ts", CALLER_DECLARATION_CAP + 1, expect.any(Function), true);
				expect(outline.mock.results[0].value).toHaveLength(CALLER_DECLARATION_CAP + 1);
				expect(result.notes.join(" ")).toContain(`capped at ${CALLER_DECLARATION_CAP} declarations`);
			} finally { scan.mockRestore(); outline.mockRestore(); }
		}
	});
	it("bounds rejected declaration-like template contents as well as accepted symbols", () => {
		const template = "const text = `\n" + "const x = 1;\n".repeat(5000) + "`;\nexport function Late() {}\n";
		let capped = false;
		const outline = lensSymbols.listSymbols(template, "api.ts", CALLER_DECLARATION_CAP + 1, () => { capped = true; });
		expect(capped).toBe(true); expect(outline).toHaveLength(1);
		const changed = "--- a/api.ts\n+++ b/api.ts\n@@ -5003 +5003 @@\n-old\n+new";
		expect(changedFunctionNames(changed, () => template).notes.join(" ")).toContain("declarations/candidates");
	});
	it("preserves Go bodies after receive-only and send-only channel parameters", () => {
		for (const channel of ["<-chan int", "chan<- int"]) {
			const go = `func Consume(ch ${channel}) {\n log.Println(\"starting\")\n process(ch)\n}\n`;
			const span = lensSymbols.findSymbol(go, "api.go", "Consume")[0];
			expect(span.endLine).toBe(4); expect(span.text).toContain("process(ch)");
		}
	});
	it("preserves callback-wrapped arrow and function initializer bodies", () => {
		for (const callback of ["() =>", "function ()"]) {
			const source = `const handler = wrap(${callback} {\n first();\n second();\n});\n`;
			const span = lensSymbols.findSymbol(source, "api.ts", "handler")[0];
			expect(span.endLine).toBe(4); expect(span.text).toContain("second()");
		}
	});
	it("preserves existing IIFE and comparison-default symbol reads", () => {
		for (const [name, source] of [["value", "const value = (() => {\n first();\n return second();\n})();\n"],
			["choose", "function choose(enabled = count < 3) {\n first();\n return second();\n}\n"]]) {
			const span = lensSymbols.findSymbol(source, "api.ts", name)[0];
			expect(span.endLine).toBe(4); expect(span.text).toContain("return second()");
		}
	});
	it("includes source discovery in the shared wall-clock budget", () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const grep = vi.fn(() => ({ text: "" }));
		const result = discoverCallers("/repo", patch, [], grep, () => { vi.setSystemTime(2001); return source; });
		expect(grep).not.toHaveBeenCalled();
		expect(result.notes.join(" ")).toContain("shared");
	});
	it("reports unavailable source and grep failures without exempting unrelated files", () => {
		const removedBody = patch.replace("@@ -1,4 +1,4 @@", "@@ -1,4 +1,4 @@ func PullFiles() error {");
		const result = discoverCallers("/repo", removedBody, [], () => ({ text: "", incomplete: "grep failed" }), () => null);
		expect(result.notes).toContain("Could not scan api.go (missing or over 131072 bytes).");
		// Header/declaration extraction still establishes a changed symbol, but not its callers.
		expect(result.notes).toContain("grep failed"); expect(result.sites).toEqual([]);
	});
});
