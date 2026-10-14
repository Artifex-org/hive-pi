/**
 * The repo-gate policy — `verification-loop.ts`, absorbed.
 *
 * Legacy failure wording, caps and metrics are pinned by verification-loop.test.
 * Automatic attempts now share worktree/host admission and input receipts:
 * unchanged attempts do not re-spawn, and host/admission cutoffs are incomplete
 * rather than repo timeouts or successful verification. Explicit checks remain
 * available; an attempt receipt is never reusable green evidence.
 *
 * Opt-in BY PRESENCE of `.pi/harness.json` at the repo root:
 *
 *   { "check": "hive check --step lint",
 *     "checkTimeoutMs": 900000,      // optional, default 10min
 *     "maxInjections": 3 }           // optional, default 3
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { treeStamp } from "../harness/verify.ts";
import { killTree, trackTree, treeSpawnOptions, TREE_TOKEN } from "../hive-common/child-tree.ts";
import { acquireGateLease, type GateLeaseOptions } from "./gate-lease.ts";
import { repoRoot } from "../hive-common/git.ts";
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
export { repoRoot };

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
	cancelled?: boolean;
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

export function runCheck(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckResult> {
	if (signal?.aborted) return Promise.resolve({ ok: false, output: "Check cancelled before starting.", timedOut: false, cancelled: true });
	return new Promise((resolve) => {
		// Every gate owns its group, including interactive pi (not only Claude
		// helpers). `-c` preserves the session PATH; a login shell resets it.
		const grouped = process.platform !== "win32";
		const tree = treeSpawnOptions();
		const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], ...tree, detached: grouped });
		trackTree(child, grouped, tree.env[TREE_TOKEN]);
		let out = "";
		let timedOut = false;
		let cancelled = false;
		let settled = false;
		let drain: ReturnType<typeof setTimeout> | undefined;
		const finish = (code: number | null, error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(drain);
			signal?.removeEventListener("abort", abort);
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({ ok: code === 0 && !timedOut && !cancelled, output: error ?? out.slice(-OUTPUT_TAIL_CHARS), timedOut, ...(cancelled ? { cancelled: true } : {}) });
		};
		const stop = () => {
			killTree(child, "SIGKILL", grouped);
			// A descendant retaining a pipe must not extend the caller's deadline.
			drain ??= setTimeout(() => finish(null), 250);
		};
		const abort = () => { cancelled = true; stop(); };
		const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(0, timeoutMs));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const collect = (d: Buffer) => {
			out += d.toString();
			if (out.length > OUTPUT_TAIL_CHARS * 4) out = out.slice(-OUTPUT_TAIL_CHARS * 2);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("close", (code) => finish(code));
		child.on("error", (err) => finish(null, String(err)));
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
 * Attempt stamps owned by the caller. An unchanged input is not automatically
 * retried, even after success or cancellation. Durable, cross-session receipts
 * live under the gate lease as well; these stamps preserve session diagnostics.
 */
export interface GateStampStore {
	get(id: string): string | undefined;
	set(id: string, stamp: string | undefined): void;
}

export interface GatePolicyOptions {
	/**
	 * A ceiling on the check's timeout, read when the check starts. A host
	 * whose settle has a hard wall clock (the Claude adapter's Stop hook)
	 * passes what is left of it; absent, the repo's own `checkTimeoutMs` (or
	 * the default) stands. A host-cutoff is incomplete, not a repo failure or
	 * green verification. It is reported once and is NOT restarted unchanged.
	 */
	timeoutCapMs?: () => number;
	/** Isolated lock directory/slot count for integration tests. */
	leaseOptions?: GateLeaseOptions;
}

/** Input identity includes HEAD (via treeStamp), gate command/budget and runtime. */
export async function gateInputStamp(root: string, command: string, timeoutMs: number): Promise<string | null> {
	const stamp = await treeStamp(root, "commit");
	if (stamp === null) return null;
	return createHash("sha256").update(JSON.stringify([stamp, command, timeoutMs, process.version, process.execPath, process.env.PATH])).digest("hex");
}

export function createGatePolicy(stamps?: GateStampStore, options: GatePolicyOptions = {}): Policy {
	return {
	name: "verification-loop",
	// A red gate is worth hearing while the agent waits on its own CI watcher;
	// never under a question or a decision put to a person.
	proceedsDespite: ["machine"],

	decide({ cwd, ledger, signal }: PolicyContext): PolicyWork | null {
		const loaded = loadConfig(cwd);
		if (!loaded) return null; // no .pi/harness.json → feature is off for this repo

		const command = loaded.config.check as string;
		const root = loaded.root;
		const id = gateItemId(root);
		const max = loaded.config.maxInjections ?? DEFAULT_MAX_INJECTIONS;
		const timeoutMs = loaded.config.checkTimeoutMs ?? DEFAULT_TIMEOUT_MS;

		// Explicitly disabled items do nothing. A spent execution budget must
		// still recover warnings from its final, potentially undelivered attempt.
		const capped = atCap(ledger, id, max);
		if (max <= 0) {
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
			status: capped ? "" : `running: ${command}`,
			run: async () => {
				const skipped = () => ({ metric: { outcome: "skip" as const, value: 0 } });
				let input = await gateInputStamp(root, command, timeoutMs);
				if (input !== null && stamps?.get(id) === input) return skipped();
				const startedAt = Date.now();
				// Admission wait spends the SAME budget as execution, not another
				// timeout in front of the hook's already-short wall clock.
				const admissionDeadline = startedAt + Math.max(0, Math.min(timeoutMs, options.timeoutCapMs?.() ?? timeoutMs));
				const deadline = () => Math.min(admissionDeadline, Date.now() + Math.max(0, options.timeoutCapMs?.() ?? timeoutMs));
				// Admission is mandatory even when Git cannot fingerprint the input
				// (e.g. an unborn HEAD). Only receipt reuse is optional.
				const leaseOptions = { ...options.leaseOptions, deferSlot: true };
				const lease = await acquireGateLease(root, deadline, signal, leaseOptions);
				if (!lease) return skipped();
				// The lease is released before the host delivers a notice. Acknowledge
				// under a NEW root-only lease, and never overwrite a different input.
				const acknowledge = (fingerprint: string, notice: string) => async () => {
					stamps?.set(id, fingerprint);
					try {
						const ackDeadline = Date.now() + 1_000;
						const ack = await acquireGateLease(root, () => ackDeadline, undefined, leaseOptions);
						if (!ack) return; // conservative replay is safer than losing a warning
						try {
							const current = await ack.read();
							if (current?.input === fingerprint && current.notice === notice) {
								await ack.write({ input: fingerprint, outcome: current.outcome });
							}
						} finally { await ack.release(); }
					} catch (error) {
						// The host already delivered the warning: an acknowledgement error
						// must not turn a printed block into a failed/open Stop hook.
						console.error("hive-pi: gate warning delivered but acknowledgement failed; it may replay:", String(error));
					}
				};
				try {
					// Deduplicate before waiting for execution capacity.
					input = await gateInputStamp(root, command, timeoutMs);
					const previous = await lease.read();
					if (input !== null && previous?.input === input) {
						let notice = previous.notice;
						if (previous.outcome === "running") {
							notice = `The previous automatic project gate \`${command}\` was interrupted. This input is NOT verified. Run quality_gate or a bounded background check to obtain a verdict; the Stop hook will not repeatedly restart this unchanged input.`;
							await lease.write({ input, outcome: "incomplete", notice });
						}
						if (notice) return { ...skipped(), inject: notice, delivered: acknowledge(input, notice) };
						stamps?.set(id, input);
						return skipped(); // an acknowledged attempt, never cached green evidence
					}
					if (capped || !await lease.admit()) return skipped();
					input = await gateInputStamp(root, command, timeoutMs);
					const cap = options.timeoutCapMs?.();
					const effectiveTimeoutMs = Math.max(0, Math.min(timeoutMs, deadline() - Date.now(), cap ?? timeoutMs));
					if (effectiveTimeoutMs <= 0 || signal?.aborted) return skipped();
					// Publish BEFORE spawn. An external kill must not reset eligibility.
					if (input !== null) await lease.write({ input, outcome: "running" });
					const result = await runCheck(command, root, effectiveTimeoutMs, lease.signal);
					const elapsed = Date.now() - startedAt;
					const incomplete = result.cancelled || (result.timedOut && (lease.waitedForSlot || (cap !== undefined && cap < timeoutMs)));
					// Cancellation leaves a running receipt for recovery. It is never green.
					if (result.cancelled) return skipped();
					if (result.ok) {
						if (input !== null) { await lease.write({ input, outcome: "pass" }); stamps?.set(id, input); }
						return { metric: { outcome: "pass", value: elapsed }, ledger: (state) => clear(state, id) };
					}
					const header = incomplete
						? `The automatic project gate \`${command}\` is INCOMPLETE: the host/admission budget ended before a verdict. This is NOT successful verification. Run quality_gate or a bounded background check with enough time; the Stop hook will not restart unchanged input.`
						: result.timedOut
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

				const notice = `${header}\n\nOutput (tail):\n\`\`\`\n${result.output.trim()}\n\`\`\`\n\n${footer}`;
				if (input !== null) await lease.write({ input, outcome: incomplete ? "incomplete" : result.timedOut ? "timeout" : "fail", notice });
				return {
					metric: { outcome: incomplete ? "skip" : result.timedOut ? "timeout" : "fail", value: elapsed },
					inject: notice,
					...(input !== null ? { delivered: acknowledge(input, notice) } : {}),
					ledger: (state) => record(state, id),
				};
				} finally { await lease.release(); }
			},
		};
	},
	};
}

/**
 * The storeless instance still shares cross-process admission and receipts.
 * A repo without a usable input stamp cannot reuse receipts. The live
 * extension additionally keeps session diagnostics (agenda/index.ts).
 */
export const gatePolicy: Policy = createGatePolicy();
