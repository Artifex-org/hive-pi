/**
 * What we are allowed to import from pi — enforced, not documented.
 *
 * Wave 5's diagnosis applied to the dependency boundary. An inventory of all 73
 * `@earendil-works` imports found the coupling is far smaller than feared:
 * nearly everything is documented, root-exported, type-only surface. Two things
 * are not, and both are scheduled breakage rather than style:
 *
 * 1. A NON-ROOT subpath import. `@earendil-works/pi-ai/compat`'s own header says
 *    *"Temporary compatibility entrypoint … This module is deleted with the
 *    coding-agent ModelManager migration"*, and several of its members are
 *    already `@deprecated`. It resolves today and will stop, without that
 *    counting as a breaking change to anything documented.
 * 2. `uuidv7` — root-exported but with zero mentions across the 30 files in
 *    pi's docs. Removed in this PR (`crypto.randomUUID()`).
 *
 * A comment saying "don't do this again" is exactly the kind of guidance the
 * house has measured to be ignored. These tests are the version that works.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..");

/** Every `from "@earendil-works/…"` in the extension sources, with its file. */
function piImports(): { file: string; specifier: string }[] {
	const files = execSync("git ls-files 'extensions/**/*.ts'", { cwd: REPO, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
	const found: { file: string; specifier: string }[] = [];
	for (const file of files) {
		const source = readFileSync(join(REPO, file), "utf8");
		for (const match of source.matchAll(/from\s+"(@earendil-works\/[^"]+)"/g)) {
			found.push({ file, specifier: match[1] });
		}
	}
	return found;
}

/**
 * Subpath imports we have not yet paid off, with the reason.
 *
 * Adding an entry here is a deliberate act that shows up in review. An empty
 * list is the goal; a growing one is the signal.
 */
const KNOWN_SUBPATH_DEBT: Record<string, string> = {};
// pi 1.0 native provider factories are public package exports, not /compat debt.
// Exact exception only: this factory is not available from the package root.
const PUBLIC_PROVIDER_ENTRY = "@earendil-works/pi-ai/providers/meta";

describe("pi API surface", () => {
	it("imports roots or the verified public native Meta provider, not private subpaths", () => {
		const subpath = piImports().filter(({ specifier }) => specifier.split("/").length > 2);
		const unexpected = subpath.filter(({ specifier }) => specifier !== PUBLIC_PROVIDER_ENTRY && !(specifier in KNOWN_SUBPATH_DEBT));
		expect(
			unexpected.map((u) => `${u.file} → ${u.specifier}`),
			"an unverified non-root pi import may be private: it can vanish without a breaking-change note. " +
				"Import from the package root, or add it to KNOWN_SUBPATH_DEBT with the reason.",
		).toEqual([]);
	});

	it("verifies the exact native Meta exception against the installed package export map", () => {
		const pkg = JSON.parse(readFileSync(join(REPO, "node_modules/@earendil-works/pi-ai/package.json"), "utf8"));
		expect(pkg.exports["./providers/*"]).toEqual({ types: "./dist/providers/*.d.ts", import: "./dist/providers/*.js" });
		expect(readFileSync(join(REPO, "node_modules/@earendil-works/pi-ai/dist/providers/meta.d.ts"), "utf8")).toContain("metaProvider");
	});

	it("has no caller of /compat at all — the debt is paid, not merely capped", () => {
		// Was: "exactly one caller, extensions/advisor/index.ts". HIV-1585 expected
		// paying it off to be a Provider/stream refactor, because `complete()`
		// appeared to exist only in /compat. It does not — `ModelRegistry` carries
		// the same `complete(model, context, options)` and pi hands that registry
		// to every extension on `ctx`, so it was a direct swap.
		//
		// Asserting ZERO rather than deleting the test: /compat still resolves, so
		// nothing else stops a future caller reaching for it, and its deletion
		// upstream would then be a surprise rather than a no-op.
		const compat = piImports().filter((i) => i.specifier === "@earendil-works/pi-ai/compat");
		expect(compat.map((c) => c.file)).toEqual([]);
	});

	it("keeps KNOWN_SUBPATH_DEBT empty, so adding to it is a visible decision", () => {
		// The list is the review surface. An empty one means the next non-root
		// import cannot be waved through as "consistent with what is already there".
		expect(Object.keys(KNOWN_SUBPATH_DEBT)).toEqual([]);
	});

	it("does not import undocumented root symbols we have already replaced", () => {
		// `uuidv7` is root-exported and appears in NONE of pi's 30 doc files —
		// public by accident of the barrel file. Replaced with crypto.randomUUID().
		// Match the IMPORT, not the word: this file and advisor/index.ts both
		// explain why uuidv7 is avoided, and a bare word match flags the
		// explanation as the offence.
		const offenders = piImports()
			.filter((i) => i.specifier.startsWith("@earendil-works/pi-ai"))
			.filter(({ file }) =>
				/import\s*\{[^}]*\buuidv7\b[^}]*\}\s*from\s*"@earendil-works/.test(readFileSync(join(REPO, file), "utf8")),
			);
		expect(offenders.map((o) => o.file)).toEqual([]);
	});

	it("prefers pi-coding-agent's re-export over reaching into pi-agent-core", () => {
		// `AgentToolResult` is re-exported by pi-coding-agent; importing it from
		// pi-agent-core adds a package boundary for nothing, and the deeper
		// package is the one more likely to move.
		const reachThrough = piImports().filter(
			({ file, specifier }) =>
				specifier === "@earendil-works/pi-agent-core" &&
				/import\s+type\s*\{[^}]*\bAgentToolResult\b[^}]*\}\s*from\s*"@earendil-works\/pi-agent-core"/.test(
					readFileSync(join(REPO, file), "utf8"),
				),
		);
		expect(reachThrough.map((r) => r.file)).toEqual([]);
	});
});
