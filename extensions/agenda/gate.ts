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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { treeStamp, type StampOptions } from "../harness/verify.ts";
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
export async function gateInputStamp(root: string, command: string, timeoutMs: number, options: StampOptions = {}): Promise<string | null> {
	const stamp = await treeStamp(root, "commit", options);
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
		const sameConfiguration = () => {
			const current = loadConfig(root);
			return current?.root === root && current.config.check === command &&
				(current.config.checkTimeoutMs ?? DEFAULT_TIMEOUT_MS) === timeoutMs &&
				(current.config.maxInjections ?? DEFAULT_MAX_INJECTIONS) === max;
		};

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
				let input: string | null = null;
				const startedAt = Date.now();
				// The host wall clock includes preparation. Capacity waits and execution
				// share a separate repository budget; free capacity leaves the command
				// its full configured execution window, not a fingerprint-shortened one.
				const hostDeadline = startedAt + Math.max(0, options.timeoutCapMs?.() ?? Infinity);
				let admissionDeadline = Infinity;
				const deadline = () => Math.min(admissionDeadline, hostDeadline, Date.now() + Math.max(0, options.timeoutCapMs?.() ?? Infinity));
				// Admission is mandatory even when Git cannot fingerprint the input
				// (e.g. an unborn HEAD). Only receipt reuse is optional.
				const leaseOptions = { ...options.leaseOptions, deferSlot: true };
				const lease = await acquireGateLease(root, deadline, signal, leaseOptions);
				if (!lease) return skipped();
				const preparationDeadline = () => Math.min(hostDeadline, lease.waitedForSlot ? admissionDeadline : Infinity, Date.now() + Math.max(0, options.timeoutCapMs?.() ?? Infinity));
				const fingerprint = () => {
					const end = preparationDeadline();
					return lease.signal.aborted || Date.now() >= end ? Promise.resolve(null)
						: gateInputStamp(root, command, timeoutMs, { signal: lease.signal, deadline: end });
				};
				// The lease is released before the host delivers a notice. Acknowledge
				// under a NEW root-only lease, and never overwrite a different input.
				const configuration = createHash("sha256").update(JSON.stringify([command, timeoutMs, max, process.execPath, process.version, process.env.PATH ?? ""])).digest("hex");
				const unboundNotice = async (content: string, chargeOnReplay = false) => {
					const notice = { id: randomUUID(), configuration, content, chargeOnReplay };
					await lease.writeNotice(notice); return notice;
				};
				const saveNotice = async (outcome: "incomplete" | "timeout" | "fail", notice: string) => {
					if (input === null) return (await unboundNotice(notice)).id;
					const noticeId = randomUUID();
					await lease.write({ input, outcome, notice, noticeId });
					await lease.writeNotice(undefined);
					return noticeId;
				};
				const publishRunning = async () => {
					if (input !== null) {
						await lease.writeNotice(undefined);
						await lease.write({ input, outcome: "running" });
					} else {
						await unboundNotice(`The previous automatic project gate \`${command}\` was interrupted before a verdict. Input identity is unavailable. This is NOT successful verification. Run quality_gate or a bounded background check; automatic warning continuations are bounded by maxInjections.`, true);
					}
				};
				const acknowledge = (fingerprint: string | null, notice: string, noticeId: string) => async () => {
					stamps?.set(id, fingerprint ?? undefined);
					try {
						const ackDeadline = Date.now() + 1_000;
						const ack = await acquireGateLease(root, () => ackDeadline, undefined, leaseOptions);
						if (!ack) return; // conservative replay is safer than losing a warning
						try {
							if (fingerprint === null) {
								const current = await ack.readNotice();
								if (current?.id === noticeId && current.configuration === configuration && current.content === notice) await ack.writeNotice(undefined);
							} else {
								const current = await ack.read();
								if (current?.noticeId === noticeId && current.input === fingerprint && current.notice === notice) await ack.write({ input: fingerprint, outcome: current.outcome });
							}
						} finally { await ack.release(); }
					} catch (error) {
						// The host already delivered the warning: an acknowledgement error
						// must not turn a printed block into a failed/open Stop hook.
						console.error("hive-pi: gate warning delivered but acknowledgement failed; it may replay:", String(error));
					}
				};
				try {
					// Unbound delivery/liveness state never identifies or suppresses an
					// attempt. Recover it even at the positive continuation cap.
					const pending = await lease.readNotice();
					if (pending?.configuration === configuration) {
						if (pending.chargeOnReplay) await lease.writeNotice({ ...pending, chargeOnReplay: false });
						return { ...skipped(), inject: `Previous automatic gate attempt (source identity was unavailable):\n${pending.content}`, delivered: acknowledge(null, pending.content, pending.id),
							...(pending.chargeOnReplay && !capped ? { ledger: (state: typeof ledger) => record(state, id) } : {}) };
					}
					if (pending) await lease.writeNotice(undefined); // obsolete configuration
					// Deduplicate before waiting for execution capacity.
					input = await fingerprint();
					const previous = await lease.read();
					if (input !== null && previous?.input === input) {
						let notice = previous.notice;
						let noticeId = previous.noticeId;
						if (previous.outcome === "running") {
							notice = `The previous automatic project gate \`${command}\` was interrupted. This input is NOT verified. Run quality_gate or a bounded background check to obtain a verdict; the Stop hook will not repeatedly restart this unchanged input.`;
							noticeId = await saveNotice("incomplete", notice);
						}
						if (notice) return { ...skipped(), inject: notice, delivered: acknowledge(input, notice, noticeId!) }; // read() validates paired notice identity
						if (stamps?.get(id) !== input) stamps?.set(id, input);
						return skipped(); // an acknowledged attempt, never cached green evidence
					}
					if (capped) return skipped();
					const admissionIncomplete = async (reason = "the host/admission budget ended before execution") => {
						// Never start more preparation after exhaustion; retain any known input
						// so a killed/expired waiter cannot silently repeat its whole budget.
						const left = remaining(record(ledger, id), id, max);
						const recovery = input !== null ? "The Stop hook will not wait again on unchanged input." : `Input identity is unavailable; input-bound attempt reuse is disabled. ${left > 0 ? `${left} automatic warning(s) remain.` : "This is the final automatic warning; stop and summarize what remains unverified."}`;
						const notice = `The automatic project gate \`${command}\` is INCOMPLETE: ${reason}. No check was executed. This input is NOT verified. Run quality_gate or a bounded background check with enough time. ${recovery}`;
						const noticeId = await saveNotice("incomplete", notice);
						return { metric: { outcome: "skip" as const, value: Date.now() - startedAt }, inject: notice, delivered: acknowledge(input, notice, noticeId),
							// Without input identity there is no attempt deduplication. Charge
							// the continuation, NOT an executed check, to stop warning loops.
							...(input === null ? { ledger: (state: typeof ledger) => record(state, id) } : {}) };
					};
					// Publish BEFORE waiting as well as spawning: an owner killed while
					// queued must not repeatedly consume its whole budget without notice.
					await publishRunning();
					admissionDeadline = Date.now() + timeoutMs;
					if (!await lease.admit()) {
						if (signal?.aborted || lease.signal.aborted) return skipped();
						return await admissionIncomplete();
					}
					if (!sameConfiguration()) return await admissionIncomplete("the gate configuration changed while queued; settle again to use the current configuration");
					const refreshed = await fingerprint();
					if (signal?.aborted || lease.signal.aborted) return skipped();
					if (Date.now() >= preparationDeadline()) return await admissionIncomplete();
					if (input !== null && refreshed === null) return await admissionIncomplete("input identity could not be revalidated before execution");
					input = refreshed;
					if (!sameConfiguration()) return await admissionIncomplete("the gate configuration changed during preparation; settle again to use the current configuration");
					// Refresh the input before spawn; charge metadata IO to the host clock.
					await publishRunning();
					const now = Date.now();
					const executionBudget = lease.waitedForSlot ? admissionDeadline - now : timeoutMs;
					const effectiveTimeoutMs = Math.max(0, Math.min(executionBudget, hostDeadline - now, options.timeoutCapMs?.() ?? Infinity));
					if (effectiveTimeoutMs <= 0) return await admissionIncomplete();
					const result = await runCheck(command, root, effectiveTimeoutMs, lease.signal);
					// Cancellation leaves a running receipt for recovery. It is never green.
					if (result.cancelled) return skipped();
					const configurationChanged = !sameConfiguration();
					const afterInput = input !== null && !configurationChanged ? await fingerprint() : null;
					const inputChanged = configurationChanged || (input !== null && afterInput !== null && afterInput !== input);
					const unvalidated = input !== null && !configurationChanged && afterInput === null;
					const elapsed = Date.now() - startedAt;
					const incomplete = inputChanged || unvalidated || (result.timedOut && effectiveTimeoutMs < timeoutMs);
					if (result.ok && !incomplete) {
						if (input !== null) { await lease.write({ input, outcome: "pass" }); stamps?.set(id, input); }
						else await lease.writeNotice(undefined); // raw success is not reusable verification
						return { metric: { outcome: "pass", value: elapsed }, ledger: (state) => clear(state, id) };
					}
					const header = inputChanged || (unvalidated && Date.now() < preparationDeadline())
						? `The automatic project gate \`${command}\` is INCOMPLETE: its input changed or could not be revalidated after execution. This result does NOT verify the current input. This is NOT successful verification. Settle again to check changed input; if input identity is unavailable, use quality_gate explicitly.`
						: incomplete
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
				const noticeId = await saveNotice(incomplete ? "incomplete" : result.timedOut ? "timeout" : "fail", notice);
				return {
					metric: { outcome: incomplete ? "skip" : result.timedOut ? "timeout" : "fail", value: elapsed },
					inject: notice,
					delivered: acknowledge(input, notice, noticeId),
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
