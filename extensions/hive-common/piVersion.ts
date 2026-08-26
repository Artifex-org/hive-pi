/**
 * Which pi this is, resolved rather than restated.
 *
 * `agent_version` is the one column that lets a behaviour change be correlated
 * with a pin bump — which is exactly what the eval work needs from it. It was a
 * hand-maintained `const PI_VERSION = "0.83.0"` in hive-telemetry, and hive-pi
 * has been pinned to 0.84.0 since #108, so every session reported a version it
 * was not running (HIV-1627). A constant that must be edited in lockstep with a
 * dependency bump is a constant that will be wrong; the only fix that holds is
 * to stop writing it down.
 *
 * Two sources, in order of what they actually mean:
 *
 *  1. The INSTALLED package, via `createRequire`. This is the version really
 *     running, which is the thing telemetry is reporting.
 *  2. Our own pinned devDependency, as a fallback.
 *
 * It reads `pi-agent-core`'s manifest, not `pi-coding-agent`'s: the latter's
 * `exports` map does not expose `./package.json`, so requiring it throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. The four `@earendil-works/pi-*` packages are
 * pinned and released in lockstep, so agent-core's version IS pi's version.
 * `test/pi-version.test.ts` asserts the resolved value against the pin, so if
 * upstream ever un-exports this manifest too, the fallback shows up as a failing
 * test rather than as a silently frozen number in the database.
 */

import { createRequire } from "node:module";

const UNKNOWN = "unknown";

/** Resolved once — the answer cannot change inside a process. */
let cached: string | undefined;

export function piVersion(): string {
	if (cached === undefined) cached = resolve();
	return cached;
}

function resolve(): string {
	const require = createRequire(import.meta.url);

	// The running pi.
	const installed = versionOf(() => require("@earendil-works/pi-agent-core/package.json"));
	if (installed) return installed;

	// What we pinned, if the manifest is not reachable. Wrong only if someone
	// runs these extensions under a pi other than the pinned one — which is worth
	// distinguishing from "we never looked", hence never a hardcoded literal.
	const pinned = pinnedPiVersion();
	if (pinned !== UNKNOWN) return pinned;

	// Never throw and never guess: this is called on the telemetry path, and an
	// honest "unknown" is a queryable value. A stale literal is not.
	return UNKNOWN;
}

/**
 * The version hive-pi DECLARES, as opposed to the one it happens to be running.
 *
 * A different question from `piVersion()` and it has a different caller: the
 * eval runner installs pi inside a container, so it needs the pin — the version
 * this repo was tested against — not whatever is resolvable on the host it is
 * launched from. It carried its own hand-maintained copy of the same literal,
 * with a comment promising to keep it in step by hand.
 */
export function pinnedPiVersion(): string {
	return versionOf(() => createRequire(import.meta.url)("../../package.json"), "devDependencies") ?? UNKNOWN;
}

function versionOf(load: () => unknown, from?: "devDependencies"): string | null {
	try {
		const pkg = load() as Record<string, unknown>;
		const raw = from
			? (pkg[from] as Record<string, string> | undefined)?.["@earendil-works/pi-coding-agent"]
			: (pkg.version as string | undefined);
		const value = typeof raw === "string" ? raw.trim() : "";
		return value ? value : null;
	} catch {
		return null;
	}
}
