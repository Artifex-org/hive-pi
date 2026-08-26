import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { piVersion, pinnedPiVersion } from "../extensions/hive-common/piVersion.ts";

/**
 * `agent_version` was a hand-maintained literal that said 0.83.0 while hive-pi
 * had been pinned to 0.84.0 since #108 — so every session in the database
 * misreported the one field that lets a behaviour change be attributed to a pin
 * bump (HIV-1627).
 *
 * The failure mode is a constant DRIFTING from the pin, so these must compare
 * against the pin itself. Asserting `toBe("0.84.0")` would reproduce the bug in
 * the test: both literals would need the same hand-edit, and the next bump would
 * leave them agreeing with each other and with nothing else.
 */
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
	devDependencies: Record<string, string>;
};
const PIN = pkg.devDependencies["@earendil-works/pi-coding-agent"];

describe("pi version resolution", () => {
	it("has an exact pin to resolve against", () => {
		// A range (`^0.84.0`) would make "the version we run" unanswerable from the
		// manifest, and this whole module assumes it is answerable.
		expect(PIN).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("reports the version actually installed, which is the pinned one", () => {
		expect(piVersion()).toBe(PIN);
	});

	it("reads the pin rather than restating it", () => {
		expect(pinnedPiVersion()).toBe(PIN);
	});

	// The runtime path resolves `@earendil-works/pi-agent-core/package.json`,
	// which is exported today while `pi-coding-agent`'s is not. If upstream ever
	// withdraws that export too, `piVersion()` silently falls back to the pin and
	// stops reporting what is really running — this is what says so out loud.
	it("resolves from the installed package, not only from the fallback", async () => {
		const { createRequire } = await import("node:module");
		const require = createRequire(import.meta.url);
		expect(() => require("@earendil-works/pi-agent-core/package.json")).not.toThrow();
	});

	it("never reports an empty version", () => {
		// The telemetry path must produce something queryable even when nothing
		// resolves; "" in that column is indistinguishable from a missing write.
		for (const value of [piVersion(), pinnedPiVersion()]) {
			expect(value.length).toBeGreaterThan(0);
		}
	});

	it("is not the literal the bug shipped with", () => {
		expect(piVersion()).not.toBe("0.83.0");
	});
});
