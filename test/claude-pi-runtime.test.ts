/**
 * The adapter's pinned-pi loader. A harness repair swaps `bin/pi` onto a new
 * graph while the MCP server keeps running; the loader must pick that up
 * instead of replaying the first failure for the rest of the session.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const REPO = join(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.resetModules(); });

/** One installed graph: a pi package whose public entry is `entry`. */
function graph(root: string, name: string, entry: string): string {
	const pkg = join(root, name, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(join(pkg, "dist", "bundle"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", exports: { ".": { import: "./index.mjs" } } }));
	writeFileSync(join(pkg, "index.mjs"), entry);
	writeFileSync(join(pkg, "dist", "bundle", "cli.js"), "");
	return join(pkg, "dist", "bundle", "cli.js");
}

function harness() {
	const root = mkdtempSync(join(tmpdir(), "hive-pi-runtime-"));
	roots.push(root);
	// The floated graph: a named import its dependency no longer provides, as pi-codemode 1.3.0 under pi 1.1.0.
	const broken = graph(root, "broken", 'import { MCP_TYPESCRIPT_PREAMBLE } from "node:path";\nexport { MCP_TYPESCRIPT_PREAMBLE };\n');
	const realEntry = pathToFileURL(join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href;
	const locked = graph(root, "locked", `export * from ${JSON.stringify(realEntry)};\n`);
	mkdirSync(join(root, "bin"));
	const piBin = join(root, "bin", "pi");
	symlinkSync(broken, piBin);
	return { root, piBin, locked };
}

describe("loadPinnedPi", () => {
	it("names the install and its repair when the public entry cannot be imported", async () => {
		const { piBin } = harness();
		const { loadPinnedPi } = await import("../claude/pi-runtime.ts");
		await expect(loadPinnedPi(piBin, "/agent")).rejects.toThrow(
			/the pinned pi at .*broken.* cannot be imported \(.*MCP_TYPESCRIPT_PREAMBLE.*\); repair the harness with `hive-agent workstation harness install`/);
	});

	it("loads the repaired graph after bin/pi is swapped, without a restart", async () => {
		const { piBin, locked } = harness();
		const { loadPinnedPi } = await import("../claude/pi-runtime.ts");
		await expect(loadPinnedPi(piBin, "/agent")).rejects.toThrow(/cannot be imported/);
		unlinkSync(piBin);
		symlinkSync(locked, piBin);
		const pi = await loadPinnedPi(piBin, "/agent");
		expect(pi.root).toContain("locked");
		expect(typeof pi.serializeConversation).toBe("function");
		expect(pi.roles.agentDir()).toBe("/agent");
	});

	it("keeps a successful load for the life of the process", async () => {
		const { piBin, locked } = harness();
		unlinkSync(piBin);
		symlinkSync(locked, piBin);
		const { loadPinnedPi } = await import("../claude/pi-runtime.ts");
		const first = loadPinnedPi(piBin, "/agent");
		expect(loadPinnedPi(piBin, "/other")).toBe(first);
		await first;
		expect(loadPinnedPi(piBin, "/other")).toBe(first);
	});
});
