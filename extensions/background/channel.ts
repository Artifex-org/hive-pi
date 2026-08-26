/**
 * The seam between an extension that OWNS a long-running job and the one that
 * reports on it.
 *
 * ## Why a bus and not an import
 *
 * pi builds a fresh jiti instance per extension with `moduleCache: false`. Two
 * extensions importing the same registry module get two registries, and the
 * second would silently never see the first's jobs — the failure would look
 * like "background_list forgot my subagent" and point nowhere near the cause.
 * `pi.events` is the established cross-extension seam in this harness (deck ←
 * opmode/ask/agenda) precisely because it is the one channel that survives that
 * isolation.
 *
 * ## Why the owner keeps the process
 *
 * The alternative was for `background` to spawn subagents itself. It would have
 * had to reproduce role discovery, the project-trust gate and the writer lock —
 * a second copy of a security-relevant path, drifting from the first. Instead
 * the subagent extension runs its own worker exactly as it does today and
 * merely *narrates* it here, so `background_list` shows one list and the trust
 * gate keeps having exactly one implementation.
 *
 * This module is types and constants only. It is imported by both sides and
 * must stay free of state for the reason in the first paragraph.
 */

import type { JobKind, JobStatus } from "./jobs.ts";

/** Owner → registry: a job started, produced output, or finished. */
export const BACKGROUND_JOB_CHANNEL = "background.job";

/** Registry → owner: the model asked for this job to stop. */
export const BACKGROUND_CANCEL_CHANNEL = "background.cancel";

export type BackgroundJobEvent =
	| {
			action: "start";
			/**
			 * Allocated by the OWNER, and namespaced by it (`sub-1`, not `bg-1`).
			 * A shared counter would need a round trip the owner cannot await, and
			 * two owners minting `bg-3` would make `background_result bg-3`
			 * ambiguous — quietly returning the wrong job's output.
			 */
			id: string;
			what: string;
			kind: JobKind;
			detail: string;
	  }
	| { action: "output"; id: string; chunk: string }
	| {
			action: "finish";
			id: string;
			status: Exclude<JobStatus, "running">;
			exitCode?: number;
	  };

export interface BackgroundCancelEvent {
	id: string;
}
