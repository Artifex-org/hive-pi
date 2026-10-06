/**
 * lens rename/move over TypeScript 7's native language server (HIV-3816).
 *
 * The resolver and framing are graded on fixtures. The rest runs the REAL
 * server: hive-pi pins `typescript` 7 as a devDependency, so its platform
 * binary is installed wherever this suite runs (CI's `npm ci` included) and
 * these tests do not skip. A missing binary is a failure here, not a skip —
 * a skip would turn "the tool cannot work" into a green suite.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { findNativeServer, frame, NativeServer, readFrames, requestRename } from "../extensions/lens/lsp.ts";
import { moveFile, renameSymbol } from "../extensions/lens/operations.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM_PACKAGE = `@typescript/typescript-${process.platform}-${process.arch}`;

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/** A fake `node_modules/typescript` of `version`, with a platform binary when `native`. */
function fakeTypescript(dir: string, version: string, native: boolean): void {
	write(join(dir, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version }));
	if (native) {
		write(join(dir, "node_modules", PLATFORM_PACKAGE, "package.json"), JSON.stringify({ name: PLATFORM_PACKAGE, version }));
		write(join(dir, "node_modules", PLATFORM_PACKAGE, "lib", "tsc"), "");
	}
}

describe("findNativeServer", () => {
	let root: string;
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "lens-resolve-")));
	});

	it("walks past a nearer 5.x install to the 7.x one above it", () => {
		// pyERP's shape: frontend/storefront carries 5.9.3, the repo root 7.0.2.
		const repo = join(root, "walk");
		fakeTypescript(repo, "7.0.2", true);
		fakeTypescript(join(repo, "frontend", "storefront"), "5.9.3", false);
		write(join(repo, "frontend", "storefront", "src", "a.ts"), "");
		const found = findNativeServer(join(repo, "frontend", "storefront", "src", "a.ts"));
		expect(found).toEqual({
			ok: true,
			exe: join(repo, "node_modules", PLATFORM_PACKAGE, "lib", "tsc"),
			root: repo,
			version: "7.0.2",
		});
	});

	it("refuses a tree with only 5.x, naming what it found", () => {
		const repo = join(root, "old");
		fakeTypescript(repo, "5.9.3", false);
		write(join(repo, "src", "a.ts"), "");
		const found = findNativeServer(join(repo, "src", "a.ts"), repo);
		expect(found.ok).toBe(false);
		expect(!found.ok && found.reason).toContain("Found only TypeScript 5.9.3 at");
		expect(!found.ok && found.reason).toContain("no native language server");
	});

	it("refuses a tree with no TypeScript at all", () => {
		const repo = join(root, "none");
		write(join(repo, "src", "a.ts"), "");
		const found = findNativeServer(join(repo, "src", "a.ts"), repo);
		expect(!found.ok && found.reason).toContain("Found no `node_modules/typescript`");
	});

	it("names the platform package when a 7.x install lacks its binary", () => {
		const repo = join(root, "noplatform");
		fakeTypescript(repo, "7.0.2", false);
		const found = findNativeServer(repo, repo);
		expect(!found.ok && found.reason).toContain(PLATFORM_PACKAGE);
	});

	it("finds the binary under pnpm's isolated layout, where typescript is a symlink into .pnpm", () => {
		const repo = join(root, "pnpm");
		const store = join(repo, "node_modules", ".pnpm", "typescript@7.0.2", "node_modules");
		write(join(store, "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "7.0.2" }));
		write(join(store, PLATFORM_PACKAGE, "package.json"), JSON.stringify({ name: PLATFORM_PACKAGE }));
		write(join(store, PLATFORM_PACKAGE, "lib", "tsc"), "");
		symlinkSync(join(store, "typescript"), join(repo, "node_modules", "typescript"));
		const found = findNativeServer(repo, repo);
		expect(found).toMatchObject({ ok: true, exe: join(store, PLATFORM_PACKAGE, "lib", "tsc"), root: repo });
	});

	it("resolves hive-pi's own TypeScript 7 — lens works on this repo", () => {
		const found = findNativeServer(join(REPO, "extensions", "lens", "lsp.ts"));
		expect(found.ok).toBe(true);
		if (found.ok) {
			expect(Number.parseInt(found.version, 10)).toBeGreaterThanOrEqual(7);
			expect(existsSync(found.exe)).toBe(true);
		}
	});
});

describe("framing", () => {
	it("frames by BYTES, so a non-ASCII body is not cut short", () => {
		const encoded = Buffer.from(frame({ id: 1, result: "naïve — ✓" }) + frame({ id: 2, result: null }), "utf8");
		// Split mid-way through a multi-byte character.
		const cut = encoded.indexOf(Buffer.from("✓")) + 1;
		const first = readFrames(encoded.subarray(0, cut));
		expect(first.messages).toEqual([]);
		const second = readFrames(Buffer.concat([first.rest, encoded.subarray(cut)]));
		expect(second.messages.map((m) => m.result)).toEqual(["naïve — ✓", null]);
		expect(second.rest.length).toBe(0);
	});

	it("drops bodies that are valid JSON but not messages, instead of handing them on", () => {
		const stream = Buffer.from(`Content-Length: 4\r\n\r\nnullContent-Length: 2\r\n\r\n[]${frame({ id: 2, result: "ok" })}`, "utf8");
		expect(readFrames(stream).messages.map((m) => m.id)).toEqual([2]);
	});
});

// ── The real server ─────────────────────────────────────────────────────────

/**
 * A small project with a barrel, a shorthand property, a relative import in
 * the file to be moved, and an importer in a subdirectory — the cases where a
 * rename or move has to change a file that grep would not find.
 */
function makeProject(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "lens-lsp-")));
	// The project's own TypeScript is hive-pi's: link both the package and its
	// platform binary, which is resolved FROM the typescript package.
	mkdirSync(join(dir, "node_modules", "@typescript"), { recursive: true });
	symlinkSync(join(REPO, "node_modules", "typescript"), join(dir, "node_modules", "typescript"));
	symlinkSync(join(REPO, "node_modules", PLATFORM_PACKAGE), join(dir, "node_modules", PLATFORM_PACKAGE));
	write(
		join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext", noEmit: true, target: "es2022" },
			include: ["src"],
		}),
	);
	write(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	write(join(dir, "src", "util.ts"), "export const helper = 1;\n");
	write(
		join(dir, "src", "a.ts"),
		'import { helper } from "./util.js";\nexport function foo(): number { return helper; }\nexport const obj = { foo };\n',
	);
	write(join(dir, "src", "index.ts"), 'export { foo } from "./a.js";\n');
	write(join(dir, "src", "sub", "c.ts"), 'import { foo } from "../index.js";\nimport { obj } from "../a.js";\nexport const v = foo() + obj.foo();\n');
	return dir;
}

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");

describe("rename_symbol on the native server", () => {
	it("renames through the barrel to every importer", async () => {
		const dir = makeProject();
		const outcome = await renameSymbol({ file: join(dir, "src", "a.ts"), line: 2, offset: 17, newName: "bar", cwd: dir });
		expect(outcome.isError).toBe(false);
		expect(outcome.text).toContain("Renamed `foo` → `bar`");
		// Not `export { bar as foo }`: useAliasesForRenames is off, so the rename
		// propagates through the re-export instead of preserving the old name.
		expect(read(dir, "src/index.ts")).toBe('export { bar } from "./a.js";\n');
		expect(read(dir, "src/sub/c.ts")).toContain('import { bar } from "../index.js";');
		expect(read(dir, "src/sub/c.ts")).toContain("export const v = bar() +");
		expect(read(dir, "src/a.ts")).toContain("export function bar(): number");
	}, 60_000);

	it("keeps a byte-order mark and renames at the right columns in a file that has one", async () => {
		const dir = makeProject();
		write(join(dir, "src", "bom.ts"), '\uFEFFimport { helper } from "./util.js";\nexport const q = helper;\n');
		const outcome = await renameSymbol({ file: join(dir, "src", "util.ts"), line: 1, offset: 14, newName: "renamed", cwd: dir });
		expect(outcome.isError).toBe(false);
		expect(read(dir, "src/bom.ts")).toBe('\uFEFFimport { renamed } from "./util.js";\nexport const q = renamed;\n');
	}, 60_000);

	it("refuses a position that is not on the identifier, naming the one the server would pick", async () => {
		const dir = makeProject();
		// Column 3 of line 1 is inside the `import` keyword; the server snaps it
		// to `helper`, which the caller did not point at.
		const outcome = await renameSymbol({ file: join(dir, "src", "a.ts"), line: 1, offset: 3, newName: "zz", cwd: dir });
		expect(outcome.isError).toBe(false);
		expect(outcome.text).toContain("nearest renameable symbol is `helper` at 1:10");
		expect(read(dir, "src/a.ts")).toContain('import { helper } from "./util.js";');
	}, 60_000);

	it("says when there is nothing to rename", async () => {
		const dir = makeProject();
		// Line 2, column 33 is the `return` keyword.
		const outcome = await renameSymbol({ file: join(dir, "src", "a.ts"), line: 2, offset: 34, newName: "zz", cwd: dir });
		expect(outcome.text).toMatch(/^Cannot rename at 2:34: /);
	}, 60_000);

	it("refuses cleanly where no TypeScript 7 is installed", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "lens-nots-")));
		write(join(dir, "a.ts"), "export const x = 1;\n");
		const outcome = await renameSymbol({ file: join(dir, "a.ts"), line: 1, offset: 14, newName: "y", cwd: dir });
		expect(outcome.isError).toBe(false);
		expect(outcome.text).toContain("No TypeScript 7+ install found above");
		expect(read(dir, "a.ts")).toBe("export const x = 1;\n");
	});
});

describe("move_file on the native server", () => {
	it("moves the file and fixes importers, the barrel, and the file's own relative imports", async () => {
		const dir = makeProject();
		const outcome = await moveFile({ from: join(dir, "src", "a.ts"), to: join(dir, "src", "lib", "a.ts"), cwd: dir });
		expect(outcome.isError).toBe(false);
		expect(existsSync(join(dir, "src", "a.ts"))).toBe(false);
		// The moved file's own import — the edit the tsserver client dropped.
		expect(read(dir, "src/lib/a.ts")).toContain('import { helper } from "../util.js";');
		expect(read(dir, "src/index.ts")).toBe('export { foo } from "./lib/a.js";\n');
		expect(read(dir, "src/sub/c.ts")).toContain('import { obj } from "../lib/a.js";');
		expect(outcome.text).toContain("src/lib/a.ts (1)");
		expect(outcome.text).toContain("`grep` for `a` to find any left behind");
	}, 60_000);

	it("refuses a target under a path that is a file, before rewriting any importer", async () => {
		const dir = makeProject();
		const outcome = await moveFile({ from: join(dir, "src", "a.ts"), to: join(dir, "src", "util.ts", "a.ts"), cwd: dir });
		expect(outcome.isError).toBe(true);
		expect(outcome.text).toContain("is a file");
		expect(read(dir, "src/index.ts")).toBe('export { foo } from "./a.js";\n');
	});

	it("refuses to overwrite an existing target", async () => {
		const dir = makeProject();
		const outcome = await moveFile({ from: join(dir, "src", "a.ts"), to: join(dir, "src", "util.ts"), cwd: dir });
		expect(outcome.isError).toBe(true);
		expect(outcome.text).toContain("already exists");
	});
});

describe("the native server on hive-pi itself", () => {
	let server: NativeServer;
	afterAll(() => server?.dispose());

	it("answers a rename across this repo's own sources without writing anything", async () => {
		const lookup = findNativeServer(join(REPO, "extensions", "lens", "index.ts"));
		if (!lookup.ok) throw new Error(lookup.reason);
		server = await NativeServer.start(lookup.exe, lookup.root);
		const file = join(REPO, "extensions", "lens", "index.ts");
		server.open(file);
		const line = readFileSync(file, "utf8").split("\n").findIndex((l) => l.startsWith("export function withPathAlias"));
		const answer = await requestRename(server, file, { line, character: "export function ".length }, "withPathAliasRenamed");
		expect(answer.ok).toBe(true);
		if (answer.ok) {
			expect(answer.name).toBe("withPathAlias");
			expect(Object.keys(answer.edit.changes ?? {}).length).toBeGreaterThan(0);
		}
	}, 60_000);
});

describe("a server that goes away", () => {
	it("rejects outstanding and later requests instead of crashing the agent", async () => {
		const lookup = findNativeServer(join(REPO, "extensions", "lens", "lsp.ts"));
		if (!lookup.ok) throw new Error(lookup.reason);
		const server = await NativeServer.start(lookup.exe, lookup.root);
		const inFlight = server.request("workspace/symbol", { query: "x" }, 10_000);
		server.dispose();
		await expect(inFlight).rejects.toThrow(/language server/);
		await expect(server.request("workspace/symbol", { query: "x" }, 10_000)).rejects.toThrow(/language server/);
	}, 30_000);

	it("a call aborted before it starts writes nothing", async () => {
		const dir = makeProject();
		const controller = new AbortController();
		controller.abort();
		await expect(
			renameSymbol({ file: join(dir, "src", "a.ts"), line: 2, offset: 17, newName: "bar", cwd: dir, signal: controller.signal }),
		).rejects.toThrow(/aborted before anything was written/);
		expect(read(dir, "src/index.ts")).toBe('export { foo } from "./a.js";\n');
	}, 30_000);

	it("an abort that lands after the server answered still stops the writes", async () => {
		const dir = makeProject();
		const controller = new AbortController();
		const original = NativeServer.prototype.request;
		const spy = vi.spyOn(NativeServer.prototype, "request").mockImplementation(async function (this: NativeServer, method, params, timeout) {
			const answer = await original.call(this, method, params, timeout);
			if (method === "textDocument/rename") controller.abort();
			return answer;
		});
		try {
			await expect(
				renameSymbol({ file: join(dir, "src", "a.ts"), line: 2, offset: 17, newName: "bar", cwd: dir, signal: controller.signal }),
			).rejects.toThrow(/aborted before anything was written/);
		} finally {
			spy.mockRestore();
		}
		expect(read(dir, "src/index.ts")).toBe('export { foo } from "./a.js";\n');
		expect(read(dir, "src/a.ts")).toContain("export function foo(");
	}, 30_000);
});
