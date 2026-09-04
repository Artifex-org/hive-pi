import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withPathAlias } from "../extensions/lens/index.ts";
import { cwdRelativeGrepResult, explainPathFailure, explainRegexFailure } from "../extensions/pretty-tools.ts";

/**
 * The two busiest tools in the harness had no failure handling at all.
 *
 * Measured 2026-08-22..24: 52 read ENOENT/ENOTDIR and 23 grep Path-not-found,
 * none carrying any explanation; 8 grep regex rejections, every one a literal
 * paren the model meant as text; and 13 `list_symbols` calls that sent `path`
 * where the tool declares `file`.
 *
 * These tests deliberately drive the REAL pi tools to produce the REAL errors
 * before handing them to the matchers. The failure mode that matters here is
 * not "the matcher logic is wrong" — it is "upstream words it differently and
 * the matcher silently never fires", which only a real error can catch.
 */
describe("path and regex failures explain themselves", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "file-diag-"));
		writeFileSync(join(dir, "readiness.go"), "package main\n", "utf8");
		writeFileSync(join(dir, "readiness_test.go"), "package main\n", "utf8");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const fail = async (fn: () => Promise<unknown>): Promise<unknown> => {
		try {
			await fn();
		} catch (err) {
			return err;
		}
		throw new Error("expected the tool to fail, and it did not");
	};

	it("a real read ENOENT is recognised and answered with the directory's contents", async () => {
		const read = createReadTool(dir);
		const err = await fail(() =>
			read.execute("r", { path: "readines.go" } as never, new AbortController().signal, undefined as never),
		);
		const detail = await explainPathFailure(err, "readines.go", dir);
		expect(detail).toBeTruthy();
		// The near-miss must be offered — this is the whole point of the wiring.
		expect(detail).toContain("readiness.go");
	});

	it("a real grep Path-not-found is recognised", async () => {
		const grep = createGrepTool(dir);
		const err = await fail(() =>
			grep.execute(
				"g",
				{ pattern: "package", path: "no-such-dir" } as never,
				new AbortController().signal,
				undefined as never,
			),
		);
		const detail = await explainPathFailure(err, "no-such-dir", dir);
		expect(detail).toBeTruthy();
	});

	it("a real invalid regex is answered by naming literal: true", async () => {
		const grep = createGrepTool(dir);
		const err = await fail(() =>
			grep.execute(
				"g",
				{ pattern: "CreateAttempt(ctx", path: "." } as never,
				new AbortController().signal,
				undefined as never,
			),
		);
		const detail = explainRegexFailure(err);
		expect(detail).toBeTruthy();
		expect(detail).toContain("literal: true");
	});

	// A glob in `path` is a different mistake wearing the same error. Listing a
	// directory's neighbours would answer a question nobody asked, so this case
	// must be caught BEFORE describeMissingFile runs.
	it("a glob in path is told about the glob parameter, not shown a listing", async () => {
		const detail = await explainPathFailure(
			new Error("Path not found: internal/store/migrations/202608*.sql"),
			"internal/store/migrations/202608*.sql",
			dir,
		);
		expect(detail).toContain("`glob`");
		expect(detail).toContain("internal/store/migrations");
		expect(detail).toContain("202608*.sql");
	});

	// Never convert a failure into a success, and never fire on an unrelated
	// error: a diagnostic that attaches itself to everything is noise.
	it("stays silent on an error that is not about the path", async () => {
		expect(await explainPathFailure(new Error("Operation aborted"), "readiness.go", dir)).toBeNull();
		expect(explainRegexFailure(new Error("Path not found: x"))).toBeNull();
	});

	it("never throws, whatever it is handed", async () => {
		expect(await explainPathFailure(new Error("ENOENT"), undefined, dir)).toBeNull();
		expect(await explainPathFailure(null, "\0", dir)).toBeNull();
	});
});

/**
 * A path grep just printed must be readable by `read`, with nothing in between.
 *
 * grep formats output paths relative to its own `path` parameter
 * (`grep.js:116-124`); read resolves relative to the session cwd
 * (`read.js:161`). 22 distinct sessions copied a path from one into the other
 * and got an ENOENT. These tests drive the REAL `createGrepTool` and the REAL
 * `createReadTool` — the assertion is the round trip itself, not the shape of
 * a string, because the thing that breaks is the RELATIONSHIP between two
 * tools' private conventions, and only both of them together can show it.
 *
 * NOTE (HIV-3277): these need ripgrep, which pi downloads on demand. CI installs
 * with `--ignore-scripts` and has no `rg`, so they can fail there for reasons
 * that have nothing to do with the rewrite.
 */
describe("a path grep printed can be handed to read unchanged", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "grep-base-"));
		mkdirSync(join(dir, "pkg"));
		writeFileSync(join(dir, "pkg", "readiness.go"), "package main\n\nfunc Ready() bool {\n\treturn true\n}\n", "utf8");
		writeFileSync(join(dir, "pkg", "readiness_test.go"), "package main\n\nfunc TestReady() {}\n", "utf8");
		// A path token that itself starts with "[" — the Next.js/SvelteKit route
		// shape. A rewrite that skips lines beginning with "[" to protect grep's
		// trailing notice would leave this one stripped and unreadable.
		writeFileSync(join(dir, "pkg", "[id].go"), "package main\n", "utf8");
		writeFileSync(join(dir, "top.go"), "package main\n", "utf8");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const grepText = async (params: Record<string, unknown>): Promise<string> => {
		const grep = createGrepTool(dir);
		const raw = await grep.execute("g", params as never, new AbortController().signal, undefined as never);
		const fixed = await cwdRelativeGrepResult(raw, params.path, dir);
		return (fixed.content as Array<{ type: string; text?: string }>).find((p) => p.type === "text")?.text ?? "";
	};

	// The test's OWN parser, deliberately not the one under test: grep emits
	// `<p>:<n>: ` for a match and `<p>-<n>- ` for a context line. `[` starts the
	// trailing notice block and our footer, neither of which is a path line.
	const pathsIn = (text: string): string[] =>
		text
			.split("\n")
			.filter((line) => line && !line.startsWith("["))
			.map((line) => /^(.*?)[:-]\d+[:-] /.exec(line)?.[1])
			.filter((p): p is string => typeof p === "string");

	const readable = async (path: string): Promise<string> => {
		const read = createReadTool(dir);
		const result = await read.execute("r", { path } as never, new AbortController().signal, undefined as never);
		return (result.content as Array<{ type: string; text?: string }>).find((p) => p.type === "text")?.text ?? "";
	};

	// Directory search: formatPath returns path.relative(searchPath, filePath),
	// so `pkg/readiness.go` is printed as `readiness.go`.
	it("resolves every path from a directory search, context lines included", async () => {
		const text = await grepText({ pattern: "package main", path: "pkg", context: 1 });
		const paths = pathsIn(text);
		expect(paths.length).toBeGreaterThan(0);
		// The read goes FIRST, before any assertion about the shape of the string.
		// The ENOENT is the failure this exists to prevent, and a shape assertion
		// in front of it would swallow it: the negative control has to show a real
		// read blowing up on a path grep had just printed, not a regex mismatch.
		for (const path of new Set(paths)) {
			expect(await readable(path)).toContain("package main");
			expect(path.startsWith("pkg/"), `${path} is not cwd-relative`).toBe(true);
		}
		// Both emitted shapes must be present, or the context branch went untested.
		expect(text).toMatch(/^pkg\/readiness\S*\.go:\d+: /m);
		expect(text).toMatch(/^pkg\/readiness\S*\.go-\d+- /m);
		// And the bracket-named file is rewritten like any other, not mistaken
		// for grep's trailing notice block.
		expect(text).toMatch(/^pkg\/\[id]\.go:\d+: /m);
		expect(await readable("pkg/[id].go")).toContain("package main");
	});

	// Single-file search: isDirectory is false, so formatPath falls through to
	// path.basename — the reported bare `file.py:510`, unresolvable by construction.
	it("resolves the bare basename a single-file search prints", async () => {
		const text = await grepText({ pattern: "package main", path: "pkg/readiness.go" });
		const paths = pathsIn(text);
		expect(await readable(paths[0])).toContain("package main");
		expect(paths).toEqual(["pkg/readiness.go"]);
	});

	it("names the base it rewrote against, so a changed formatPath cannot go silent", async () => {
		const text = await grepText({ pattern: "package main", path: "pkg" });
		expect(text).toContain("[harness]");
		expect(text).toContain("pkg/");
	});

	// The already-correct case. Identity, not just equal text: a search whose base
	// is the cwd must not be copied, re-serialised or footnoted.
	it("returns a cwd search completely untouched", async () => {
		const grep = createGrepTool(dir);
		const params = { pattern: "package main", path: "." };
		const raw = await grep.execute("g", params as never, new AbortController().signal, undefined as never);
		expect(await cwdRelativeGrepResult(raw, params.path, dir)).toBe(raw);
		expect(await cwdRelativeGrepResult(raw, undefined, dir)).toBe(raw);
	});

	// grep appends its notices as "\n\n[" + notices + "]" (grep.js:279-280). A
	// limit notice wearing a directory prefix would be a fabricated path.
	it("leaves the truncation notice alone", async () => {
		const text = await grepText({ pattern: "package main", path: "pkg", limit: 1 });
		expect(text).toContain("[1 matches limit reached");
		expect(text).not.toMatch(/^pkg\/\[\d+ matches/m);
	});

	it("says so out loud when it cannot resolve the base, instead of returning stripped paths", async () => {
		const raw = { content: [{ type: "text", text: "locate.ts:66: hit" }] };
		const out = await cwdRelativeGrepResult(raw, "no/such/dir", dir);
		const text = (out.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
		expect(text).toContain("locate.ts:66: hit");
		expect(text).toContain("could not resolve");
	});

	// No matches is not a path problem, and a footer about path bases on it is noise.
	it("adds nothing to a search that found nothing", async () => {
		const text = await grepText({ pattern: "zzz-no-such-token", path: "pkg" });
		expect(text).toBe("No matches found");
	});
});

/**
 * `list_symbols` declares `file`; every other file tool in the harness takes
 * `path`. 13 of its 79 calls in the window sent `{"path": ...}` and were
 * rejected by schema validation — 16.5%, worst on the most recent day.
 */
describe("the symbol tools accept the name the rest of the surface uses", () => {
	it("maps path and file_path onto file", () => {
		expect(withPathAlias<{ file?: string }>({ path: "a.go" }).file).toBe("a.go");
		expect(withPathAlias<{ file?: string }>({ file_path: "b.go" }).file).toBe("b.go");
	});

	it("never overrides an explicit file", () => {
		expect(withPathAlias<{ file?: string }>({ file: "real.go", path: "other.go" }).file).toBe("real.go");
	});

	it("leaves anything else alone", () => {
		expect(withPathAlias<{ file?: string }>({ symbol: "Foo" } as never).file).toBeUndefined();
		expect(withPathAlias<{ file?: string }>({ path: 7 } as never).file).toBeUndefined();
	});
});
