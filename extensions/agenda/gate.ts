/**
 * The repo-gate policy — `verification-loop.ts`, absorbed.
 *
 * Behaviour is deliberately unchanged: the injected text, the cap wording, the
 * silence conditions and the `hive.metric` payload are all pinned by
 * `test/verification-loop.test.ts`, whose assertions this refactor is not
 * allowed to touch. That suite was written in HIV-1095 precisely so this move
 * could be proved rather than eyeballed.
 *
 * One deliberate CHANGE, carried from the HIV-1095 verification pass: an
 * exhausted budget now reports `outcome:"skip"` instead of returning in
 * silence. Before, a spent loop emitted nothing and was indistinguishable
 * downstream from a loop that never armed — the "success-shaped nothing" class.
 *
 * Opt-in BY PRESENCE of `.pi/harness.json` at the repo root:
 *
 *   { "check": "hive check --step lint",
 *     "checkTimeoutMs": 900000,      // optional, default 10min
 *     "maxInjections": 3 }           // optional, default 3
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { gateStamp } from "../harness/verify.ts";
import { atCap, clear, record, remaining } from "./ledger.ts";
import type { Policy, PolicyContext, PolicyWork } from "./policy.ts";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_INJECTIONS = 3;
const OUTPUT_TAIL_CHARS = 4000;

export interface HarnessConfig {
	check?: string;
	checkTimeoutMs?: number;
	maxInjections?: number;
	/**
	 * Delivery-level check the CONDUCTOR runs once at its verify stage (e.g.
	 * `gh pr checks --fail-level all`). Deliberately not run by this per-settle
	 * gate: a PR check hits the network and grades the pushed branch, not the
	 * working tree.
	 */
	prCheck?: string;
	prCheckTimeoutMs?: number;
}

/** `.pi/harness.json` is read from the git root, not cwd — pi's own `.pi/` is cwd-only. */
export function repoRoot(cwd: string): string | null {
	let dir = cwd;
	for (let i = 0; i < 64; i++) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export function loadHarnessConfig(cwd: string): { config: HarnessConfig; root: string } | null {
	return loadConfig(cwd);
}

function loadConfig(cwd: string): { config: HarnessConfig; root: string } | null {
	const root = repoRoot(cwd);
	if (!root) return null;
	const path = join(root, ".pi", "harness.json");
	if (!existsSync(path)) return null;
	try {
		const config = JSON.parse(readFileSync(path, "utf8")) as HarnessConfig;
		if (!config.check?.trim()) return null;
		return { config, root };
	} catch {
		return null;
	}
}

interface CheckResult {
	ok: boolean;
	output: string;
	timedOut: boolean;
}

/**
 * Is there a `bash` to run the gate with?
 *
 * The CI image this package is built against (`node:22.19.0-alpine3.22`) has
 * none, and neither does any other minimal container — which matters because
 * the Hive Code Factory and the planned Aurora in-app agent are both consumers.
 *
 * Without this check `spawn` fails with ENOENT, the error path reports
 * `ok:false`, and the policy tells the model "the project gate FAILED" with
 * `Error: spawn bash ENOENT` pasted in as the output tail — for a gate that
 * never ran. The model then tries to fix a build that is fine and burns its
 * whole injection budget doing it, while `hive.metric` records `fail` so the
 * telemetry agrees with the wrong story.
 *
 * The general rule this belongs to: **a tool that could not run must never be
 * reported as a tool that ran and failed.**
 */
function bashAvailable(): boolean {
	const path = process.env.PATH ?? "";
	return path
		.split(delimiter)
		.some((dir) => dir && existsSync(join(dir, "bash")));
}

export function runCheck(command: string, cwd: string, timeoutMs: number): Promise<CheckResult> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		const collect = (d: Buffer) => {
			out += d.toString();
			if (out.length > OUTPUT_TAIL_CHARS * 4) out = out.slice(-OUTPUT_TAIL_CHARS * 2);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0 && !timedOut, output: out.slice(-OUTPUT_TAIL_CHARS), timedOut });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ ok: false, output: String(err), timedOut: false });
		});
	});
}

/**
 * The ledger key. One budget per repo root rather than per session, so moving
 * between worktrees in one session does not hand each of them a fresh budget.
 */
export function gateItemId(root: string): string {
	return `gate:${root}`;
}

export { bashAvailable };

/**
 * Failure stamps for gate-retry throttling, owned by the caller (session
 * scoped, cleared on session_start). Optional: without a store the gate
 * behaves exactly as it always has — which is what keeps the pinned
 * `verification-loop` suite byte-identical through the plain `gatePolicy`
 * export below.
 */
export interface GateStampStore {
	get(id: string): string | undefined;
	set(id: string, stamp: string | undefined): void;
}

export function createGatePolicy(stamps?: GateStampStore): Policy {
	return {
	name: "verification-loop",

	decide({ cwd, ledger }: PolicyContext): PolicyWork | null {
		const loaded = loadConfig(cwd);
		if (!loaded) return null; // no .pi/harness.json → feature is off for this repo

		const command = loaded.config.check as string;
		const root = loaded.root;
		const id = gateItemId(root);
		const max = loaded.config.maxInjections ?? DEFAULT_MAX_INJECTIONS;
		const timeoutMs = loaded.config.checkTimeoutMs ?? DEFAULT_TIMEOUT_MS;

		// Budget spent: report it once and do no work. Reporting rather than
		// returning silently is the one behavioural change in this move.
		if (atCap(ledger, id, max)) {
			return {
				name: "verification-loop",
				status: "",
				run: async () => ({ metric: { outcome: "skip", value: 0 } }),
			};
		}

		// A gate we cannot execute is a misconfiguration for the human, never a
		// task for the model. Report it and inject nothing.
		if (!bashAvailable()) {
			return {
				name: "verification-loop",
				status: "",
				run: async () => ({ metric: { outcome: "skip", value: 0 } }),
			};
		}

		return {
			name: "verification-loop",
			status: `running: ${command}`,
			run: async () => {
				// Retry throttling (prime-agent's gate-skip): after a failure, do not
				// re-run the gate until the tree actually changed — a settle where the
				// model only talked has not earned another (possibly minutes-long)
				// check. Content-aware stamp (see harness/verify.ts gateStamp); a null
				// stamp on either side disables the skip. The skip is silent — no
				// injection, no ledger charge — so the pinned three-failures-three-
				// injections contract holds whenever the model edits between settles.
				if (stamps) {
					const failedStamp = stamps.get(id);
					if (failedStamp !== undefined) {
						const current = await gateStamp(root);
						if (current !== null && current === failedStamp) {
							return { metric: { outcome: "skip", value: 0 } };
						}
					}
				}

				const startedAt = Date.now();
				const result = await runCheck(command, root, timeoutMs);
				const elapsed = Date.now() - startedAt;

				if (result.ok) {
					stamps?.set(id, undefined);
					return {
						metric: { outcome: "pass", value: elapsed },
						ledger: (state) => clear(state, id),
					};
				}
				stamps?.set(id, (await gateStamp(root)) ?? undefined);

				const header = result.timedOut
					? `The project gate \`${command}\` TIMED OUT.`
					: `The project gate \`${command}\` FAILED.`;

				// Charge the injection first so the "attempts left" count reflects
				// THIS injection, matching the original's `injections++` placement.
				const charged = record(ledger, id);
				const left = remaining(charged, id, max);
				const footer =
					left > 0
						? `Fix the cause and the gate will re-run when you settle again (${left} attempt(s) left before this stops and hands back to the user).`
						: `This was the final automatic attempt — stop, summarize what is still failing, and hand back to the user.`;

				return {
					metric: { outcome: result.timedOut ? "timeout" : "fail", value: elapsed },
					inject: `${header}\n\nOutput (tail):\n\`\`\`\n${result.output.trim()}\n\`\`\`\n\n${footer}`,
					ledger: (state) => record(state, id),
				};
			},
		};
	},
	};
}

/**
 * The storeless instance — behaviour identical to the pre-factory policy, and
 * the one `test/verification-loop.test.ts` pins. The live extension passes a
 * session-scoped store instead (agenda/index.ts).
 */
export const gatePolicy: Policy = createGatePolicy();
