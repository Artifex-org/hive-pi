/**
 * Checkpoint commits during a long execute phase.
 *
 * Measured 2026-10-10 (session 8bbc4b22): an agent executed an approved plan
 * for 5 h 45 m, changed 70 files and made ZERO commits. A local commit runs the
 * repo's commit hook — which would have caught a complexity failure hours
 * earlier — and leaves a recoverable point when a later turn hangs or dies.
 * Nothing asked for one.
 *
 * The rule, at a tool-bearing turn boundary while the session is executing:
 *
 *   - on ENTERING execute (the first probe after plan approval), a tree that is
 *     already dirty gets a checkpoint request at once; a clean one just starts
 *     the clock — there is nothing to commit, so nothing is demanded;
 *   - after that, a request once the tree is dirty and nothing has reset the
 *     clock for CHECKPOINT_INTERVAL_MS (default 90 min,
 *     `PI_AGENDA_CHECKPOINT_MINUTES`, 0 turns it off).
 *
 * The clock is the LATEST of: when executing was first observed, the last
 * request, the last time the tree was seen clean, and HEAD's commit time. A
 * months-old HEAD on a freshly dirtied checkout therefore does not read as
 * months of uncommitted work, and a commit (HEAD moves) restarts it.
 *
 * `decide()` only compares timestamps; the git probe runs in `run()`, and only
 * when the clock could be due — about one probe per interval, never one per turn.
 *
 * A checkpoint commit is NOT the delivery milestone. delivery-progress.ts reads
 * the first successful commit as execute→verify and spends the one final-review
 * reminder on it. Every commit between a delivered checkpoint request and the
 * end of that run is read as a checkpoint instead (`outstanding`), so asking
 * for checkpoints never fakes the end of execution — a split commit or a hook
 * fix-up included. A PR opening still marks delivery, so a real delivery commit
 * in that window costs at most the advice arriving at the PR instead.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { uncommittedCount } from "../gate/tool.ts";
import { GIT_NO_OPTIONAL_LOCKS } from "../hive-common/git.ts";
import type { ConductorStage } from "./conductor-state.ts";
import { record } from "./ledger.ts";
import type { Policy, PolicyContext } from "./policy.ts";
import type { PlanSignal } from "./signals.ts";

const execFileAsync = promisify(execFile);

export const CHECKPOINT_LEDGER_ID = "conductor:checkpoint";

export const DEFAULT_CHECKPOINT_MINUTES = 90;

/** The interval, from `PI_AGENDA_CHECKPOINT_MINUTES`. 0 disables the rule. */
export function checkpointIntervalMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.PI_AGENDA_CHECKPOINT_MINUTES?.trim();
	const minutes = raw ? Number(raw) : DEFAULT_CHECKPOINT_MINUTES;
	return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : DEFAULT_CHECKPOINT_MINUTES * 60_000;
}

/** Never probe more often than this, however the clock falls. */
export const MIN_PROBE_GAP_MS = 5 * 60_000;

/** What git says about the working tree. */
export interface CheckpointProbe {
	/** `git status --porcelain` paths, untracked included. */
	dirty: number;
	/** HEAD's commit time in ms, or null when there is no commit yet. */
	headAt: number | null;
}

export interface CheckpointClock {
	watchingSince: number;
	/** No probe yet since execution started: a dirty tree is due at once. */
	entering: boolean;
	requestedAt: number | null;
	cleanAt: number | null;
	nextProbeAt: number;
}

export interface CheckpointDue {
	dirty: number;
	entering: boolean;
	/** How long the tree has been uncommitted, as far as the clock can tell. */
	sinceMs: number;
}

export function startClock(now: number): CheckpointClock {
	return { watchingSince: now, entering: true, requestedAt: null, cleanAt: null, nextProbeAt: now };
}

/** Is this session executing approved work? Conductor stage first, an approved plan when it tracks no lifecycle. */
export function isExecuting(stage: ConductorStage | null, plan: PlanSignal | undefined): boolean {
	if (stage === "execute" || stage === "verify") return true;
	return (stage === null || stage === "idle") && plan?.phase === "approved";
}

/** Fold one probe into the clock. Pure: every rule above is decided here. */
export function foldProbe(
	clock: CheckpointClock,
	probe: CheckpointProbe | null,
	now: number,
	intervalMs: number,
): { clock: CheckpointClock; due: CheckpointDue | null } {
	// Not a git checkout, or git could not answer: nothing to ask for. Look again
	// an interval later rather than every turn.
	if (!probe) return { clock: { ...clock, entering: false, nextProbeAt: now + intervalMs }, due: null };
	if (probe.dirty === 0) {
		return { clock: { ...clock, entering: false, cleanAt: now, nextProbeAt: now + intervalMs }, due: null };
	}
	const since = Math.max(clock.watchingSince, clock.requestedAt ?? 0, clock.cleanAt ?? 0, probe.headAt ?? 0);
	if (clock.entering || now - since >= intervalMs) {
		return {
			clock: { ...clock, entering: false, requestedAt: now, nextProbeAt: now + intervalMs },
			due: { dirty: probe.dirty, entering: clock.entering, sinceMs: Math.max(0, now - since) },
		};
	}
	return { clock: { ...clock, nextProbeAt: Math.max(since + intervalMs, now + MIN_PROBE_GAP_MS) }, due: null };
}

/**
 * The rule as the plan-approval kick states it. It announces the request and
 * does not make one: at approval nothing has changed yet, and the first probe
 * asks for a commit only if the tree is already dirty.
 */
export const CHECKPOINT_RULE =
	"Long stretches of uncommitted work get a checkpoint request from the conductor: when it asks, commit on your working branch " +
	"(the commit hook attests it). A checkpoint is not a push.";

export function checkpointInjection(due: CheckpointDue): string {
	const paths = due.dirty === 1 ? "1 uncommitted path" : `${due.dirty} uncommitted paths`;
	const situation = due.entering
		? `Conductor: execution starts with ${paths} in the working tree.`
		: `Conductor: ${paths} and no commit for ${Math.round(due.sinceMs / 60_000)} min in this execute phase.`;
	return [
		situation,
		"Commit a checkpoint of this task's changes on your working branch now (the commit hook attests it, so a failing check surfaces now rather than at delivery);",
		"leave changes that are not this task's uncommitted.",
		"A checkpoint is not a push: do not push or open a PR for it, then carry on with the plan.",
	].join(" ");
}

/** git's view of the tree, or null when it cannot be read. */
export async function probeCheckpoint(cwd: string, signal?: AbortSignal): Promise<CheckpointProbe | null> {
	const dirty = await uncommittedCount(cwd, signal);
	if (dirty === undefined) return null;
	let headAt: number | null = null;
	try {
		const { stdout } = await execFileAsync("git", [GIT_NO_OPTIONAL_LOCKS, "log", "-1", "--format=%ct", "HEAD"], {
			cwd,
			signal,
			timeout: 5000,
		});
		const seconds = Number(stdout.trim());
		headAt = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
	} catch (error) {
		// An unborn branch has no HEAD commit, and the other clock terms still
		// hold. Any other failure (a timeout, an abort) leaves the tree unknown.
		const stderr = String((error as { stderr?: unknown }).stderr ?? "");
		if (!/does not have any commits yet|unknown revision|bad default revision/.test(stderr)) return null;
	}
	return { dirty, headAt };
}

export interface CheckpointHooks {
	enabled(): boolean;
	stage(): ConductorStage | null;
	probe?(cwd: string, signal?: AbortSignal): Promise<CheckpointProbe | null>;
	now?(): number;
	intervalMs?: number;
}

export interface Checkpoint {
	/** The turn policy. */
	policy: Policy;
	/** Is the rule in force at all (interval > 0 and the conductor on)? */
	active(): boolean;
	/** A DELIVERED checkpoint request is open: commits in this run are checkpoints, not delivery. */
	outstanding(): boolean;
	/**
	 * Reconcile a request with the session, at the next turn start or settle.
	 * The driver applies a policy's ledger before its live may-inject check, so
	 * a request can be dropped after `run()`; only its text on the branch proves
	 * the agent was asked. A dropped request restores the clock, so the next
	 * boundary asks again rather than an interval later.
	 */
	observe(branch: readonly unknown[]): void;
	/** The run ended; a later commit is the agent's own again. */
	settled(branch: readonly unknown[]): void;
}

function delivered(branch: readonly unknown[], text: string): boolean {
	return branch.some((raw) => {
		const entry = raw as { type?: string; customType?: string; content?: unknown };
		return entry.type === "custom_message" && entry.customType === "agenda" && entry.content === text;
	});
}

export function createCheckpoint(hooks: CheckpointHooks): Checkpoint {
	const now = hooks.now ?? Date.now;
	const probe = hooks.probe ?? probeCheckpoint;
	const intervalMs = hooks.intervalMs ?? checkpointIntervalMs();
	let clock: CheckpointClock | null = null;
	/** A request run() produced, not yet seen on the branch, and the clock to restore if it never is. */
	let requested: { text: string; before: CheckpointClock } | null = null;
	let outstanding = false;
	const active = () => intervalMs > 0 && hooks.enabled();

	const skip = { metric: { outcome: "skip" as const, value: 0, name: "checkpoint" } };
	const policy: Policy = {
		name: "conductor-checkpoint",
		decide(context: PolicyContext) {
			if (!active() || !isExecuting(hooks.stage(), context.signals?.plan)) {
				clock = null;
				return null;
			}
			clock ??= startClock(now());
			if (requested || now() < clock.nextProbeAt) return null;
			return {
				name: "conductor",
				status: "",
				run: async () => {
					const observed = await probe(context.cwd, context.signal);
					if (!clock) return skip;
					const before = clock;
					const folded = foldProbe(before, observed, now(), intervalMs);
					clock = folded.clock;
					if (!folded.due) return skip;
					const text = checkpointInjection(folded.due);
					requested = { text, before };
					return {
						metric: { outcome: "pass" as const, value: folded.due.dirty, name: "checkpoint" },
						inject: text,
						ledger: (state) => record(state, CHECKPOINT_LEDGER_ID),
					};
				},
			};
		},
	};

	const observe = (branch: readonly unknown[]) => {
		if (!requested) return;
		if (delivered(branch, requested.text)) outstanding = true;
		else if (clock) clock = requested.before;
		requested = null;
	};

	return {
		policy,
		active,
		outstanding: () => outstanding,
		observe,
		settled: (branch) => {
			observe(branch);
			outstanding = false;
		},
	};
}
