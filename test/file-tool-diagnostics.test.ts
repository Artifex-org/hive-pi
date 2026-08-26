import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withPathAlias } from "../extensions/lens/index.ts";
import { explainPathFailure, explainRegexFailure } from "../extensions/pretty-tools.ts";

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
