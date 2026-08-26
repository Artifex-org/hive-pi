/**
 * Build-level enforcement of the hardest idiom in README.md:
 *
 *   Never register `context`, `before_provider_request` or
 *   `before_provider_headers`.
 *
 * This is a prompt-cache hazard, not a style rule, and it is the single most
 * expensive silent failure available in this harness — nothing about a
 * cache-miss burst points at the extension that caused it. A grep is a blunt
 * instrument, but it fails the build at the moment the line is typed, which is
 * the only point where the cost is obvious.
 *
 * Scope note: `after_provider_response` is NOT banned. pi guards that path with
 * `hasHandlers`, so subscribing to it does not switch on a transform pi would
 * otherwise bypass. `hive-telemetry` may legitimately want it later.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDir = join(repoRoot, "extensions");

const FORBIDDEN = ["context", "before_provider_request", "before_provider_headers"] as const;

function walk(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			found.push(...walk(full));
		} else if (entry.endsWith(".ts")) {
			found.push(full);
		}
	}
	return found;
}

/**
 * Matches `pi.on("context", …)` and `pi.on('context', …)` with any receiver
 * name and any whitespace. Deliberately anchored on `.on(` + a quoted event
 * name so that the string "context" in prose, in a variable name, or in
 * `ExtensionContext` cannot trip it.
 */
function registersEvent(source: string, event: string): boolean {
	return new RegExp(`\\.on\\s*\\(\\s*["']${event}["']`).test(source);
}

describe("forbidden provider-path events", () => {
	const files = walk(extensionsDir);

	it("finds extension sources to check", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it.each(FORBIDDEN)("no extension registers %s", (event) => {
		const offenders = files
			.filter((file) => registersEvent(readFileSync(file, "utf-8"), event))
			.map((file) => relative(repoRoot, file));

		expect(
			offenders,
			`${offenders.join(", ")} registers "${event}". pi skips this transform path entirely when nothing ` +
				"subscribes; registering it switches on work pi would otherwise bypass, on every LLM call. " +
				"See README.md → Extension idioms.",
		).toEqual([]);
	});
});

describe("the guard itself", () => {
	it("detects a registration regardless of quote style or spacing", () => {
		expect(registersEvent('pi.on("context", handler)', "context")).toBe(true);
		expect(registersEvent("pi.on('context', handler)", "context")).toBe(true);
		expect(registersEvent('api.on( "context" , handler)', "context")).toBe(true);
	});

	it("does not fire on prose, type names, or unrelated identifiers", () => {
		expect(registersEvent("// never register context here", "context")).toBe(false);
		expect(registersEvent("import type { ExtensionContext } from 'x'", "context")).toBe(false);
		expect(registersEvent('pi.on("session_start", (e, context) => {})', "context")).toBe(false);
	});
});
