/**
 * Wire compatibility is deliberately versioned at both seams.
 *
 * Pi supplies the provider object we wrap, while Anthropic validates the
 * Claude Code request shape. A green typecheck against a new Pi release says
 * nothing about either runtime contract, so every version is admitted only
 * after a fake-transport suite and one operator-run live probe.
 *
 * WHAT IS ADMITTED IS NO LONGER WRITTEN DOWN TWICE.
 *
 * This file used to carry `["0.84.1", "0.84.2"]` as a literal beside a
 * devDependency pin that said the same thing — the exact shape hive-common's
 * piVersion.ts was written to kill: "a constant that must be edited in lockstep
 * with a dependency bump is a constant that will be wrong". It went wrong on
 * 2026-08-26, when a workstation resolved pi from mise `latest` (0.84.3) and
 * this list still said 0.84.2.
 *
 * The repo's own pin IS the reviewed statement of which pi we are tested
 * against: bumping it is a PR that runs the suite. Deriving from it is therefore
 * not the speculative allowlist bump the policy forbids — it is the policy,
 * enforced from one place instead of two.
 *
 * EXTRA_VALIDATED stays for the case the policy actually describes: a version
 * revalidated ahead of, or behind, the pin. It is an explicit act with a date
 * and a reason, not a list that drifts.
 */

import { pinnedPiVersion } from "../hive-common/piVersion.ts";

/**
 * Versions validated against this wire contract beyond the repo's pin.
 *
 * Each entry needs the fake-transport suite AND an operator-run live probe, and
 * should say when and by whom. Empty is the normal state.
 */
export const EXTRA_VALIDATED_PI_VERSIONS: readonly string[] = [];

/** Every pi this extension will wrap: the repo's pin, plus anything revalidated. */
export function supportedPiVersions(): readonly string[] {
	const pinned = pinnedPiVersion();
	const all = pinned === "unknown" ? [] : [pinned];
	for (const extra of EXTRA_VALIDATED_PI_VERSIONS) {
		if (!all.includes(extra)) all.push(extra);
	}
	return all;
}

export function isSupportedPiVersion(version: string): boolean {
	return supportedPiVersions().includes(version.trim());
}
