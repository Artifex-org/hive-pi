/**
 * External-tool probes for suites that need real `git` (HIV-1238).
 *
 * Four suites drive real git — `agenda-gate-skip`, `harness-heldout`,
 * `guard-bypass-audit`, `hive-common-worktree-root` — and each had its own
 * copy of a `gitAvailable()` that returned false and let `describe.runIf`
 * quietly drop the whole block. The CI image (`node:*-alpine`) ships neither
 * git nor bash, so **in CI those suites did not run at all** while the gate
 * reported green.
 *
 * That is the failure class this repo keeps re-learning: a skip reads as a
 * pass, and the tests that silently vanished are the ones covering the worktree
 * guard and the held-out scanner — i.e. the safety surface.
 *
 * So the probe is unchanged for a developer machine that genuinely lacks git,
 * and **fatal wherever `PI_HOUSE_REQUIRE_TOOLS=1` is set** — which `.hive/main.star`
 * sets on the test step. If the image ever loses git again, CI says so instead
 * of shrinking.
 */

import { execSync } from "node:child_process";

function required(): boolean {
	return process.env.PI_HOUSE_REQUIRE_TOOLS === "1";
}

function probe(command: string): boolean {
	try {
		execSync(command, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function demand(tool: string, present: boolean): boolean {
	if (present || !required()) return present;
	throw new Error(
		`${tool} is required here but not on PATH. PI_HOUSE_REQUIRE_TOOLS=1 means this ` +
			`environment promised to provide it — suites that need ${tool} must FAIL rather than skip, ` +
			`because a skipped suite reads as a passing one. Fix the image (see .hive/main.star) ` +
			`rather than unsetting the variable.`,
	);
}

/** True when real git is usable. Throws instead of returning false in CI. */
export function gitAvailable(): boolean {
	return demand("git", probe("git --version"));
}

/**
 * True when a python3 the kernel would actually accept is usable (>= 3.10).
 *
 * The kernel's behavioural suite — every real-subprocess test, including the
 * reaping and env-allowlist ones — sits behind this. Without `demand` an image
 * variant without python3 would drop that entire block to zero and the gate
 * would still be green, which is the exact shape this module exists to prevent.
 * `node:22.19.0` (what `.hive/main.star` uses for the test step) ships 3.11.
 */
export function python3Available(): boolean {
	return demand("python3", probe("python3 -c \"import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)\""));
}

/** True when a real bash is usable. Throws instead of returning false in CI. */
export function realBashAvailable(): boolean {
	return demand("bash", probe("bash --version"));
}
