/**
 * The aux spool: the append-only JSONL file the Hive driver tails.
 *
 * One record per line, ONE write per record (`appendFileSync` opens with
 * O_APPEND), and every record under 4 KiB — so concurrent writers (the Stop
 * hook, the async settle hook, the MCP server and its background workers)
 * interleave whole lines, never fragments.
 *
 * A record that cannot be written is said on stderr, never thrown: the spool
 * reports work, it must not undo it.
 *
 * With no `HIVE_AUX_SPOOL` nothing is written, and the process says so once
 * on stderr: a missing spool is a launch misconfiguration the operator should
 * see, not a reason to fail the feature that produced the record.
 */

import { appendFileSync } from "node:fs";
import type { Usage } from "../extensions/harness/usage.ts";

/** The driver's per-line ceiling. */
export const MAX_RECORD_BYTES = 4096;
/** The driver's cap on a wake notice's text. */
export const MAX_WAKE_CHARS = 3500;

export type GateName = "goal" | "drift";
export type GateOutcome = "passed" | "failed" | "timed_out" | "skipped";

export interface Spool {
	usage(role: string, model: string, usage: Usage, ms: number, turns?: number): void;
	gate(gate: GateName, outcome: GateOutcome, ms: number): void;
	wake(job: string, text: string): void;
}

let warnedMissing = false;

/** The background-job id shape the driver accepts. */
export const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `<provider>/<non-empty id>` — the only model shape the driver accepts. */
const MODEL_SPEC = /^[^/\s]+\/\S+$/;

/** A token or call count: a non-negative safe integer (usage folds can carry fractions or NaN-free floats). */
function count(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)) : 0;
}

/** Byte length of one serialised line, newline included. */
function lineBytes(record: object): number {
	return Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
}

export function createSpool(path: string | undefined, stderr: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Spool {
	const write = (record: Record<string, unknown>) => {
		if (!path) {
			if (!warnedMissing) {
				warnedMissing = true;
				stderr("hive-pi: HIVE_AUX_SPOOL is unset; usage, gate and wake records are not reported");
			}
			return;
		}
		const line = `${JSON.stringify(record)}\n`;
		// The spool REPORTS work; it must never undo it. A record that cannot be
		// written (too large, a full disk, a removed file) is said on stderr and
		// the verdict, the worker's result or the hook's answer stands.
		if (Buffer.byteLength(line, "utf8") >= MAX_RECORD_BYTES) {
			stderr(`hive-pi: spool record not written: it exceeds ${MAX_RECORD_BYTES} bytes (kind ${String(record.kind)})`);
			return;
		}
		try {
			appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
		} catch (error) {
			stderr(`hive-pi: spool record not written (kind ${String(record.kind)}): ${(error as Error).message}`);
		}
	};
	const at = () => new Date().toISOString();
	return {
		usage(role, model, usage, ms, turns = 1) {
			// The driver drops a record whose model is not `<provider>/<id>` or whose
			// numbers are not what it expects; say so here, where the cause is known.
			if (!MODEL_SPEC.test(model)) {
				stderr(`hive-pi: usage record for ${role} not written: model ${JSON.stringify(model)} is not <provider>/<id>`);
				return;
			}
			if (!Number.isFinite(usage.cost) || usage.cost < 0) {
				stderr(`hive-pi: usage record for ${role} not written: cost ${String(usage.cost)} is not a finite non-negative number`);
				return;
			}
			write({
				v: 1,
				kind: "usage",
				role,
				model,
				input: count(usage.input),
				output: count(usage.output),
				cacheRead: count(usage.cacheRead),
				cacheWrite: count(usage.cacheWrite),
				cost: usage.cost,
				turns: Math.max(1, count(turns)),
				ms: count(ms),
				at: at(),
			});
		},
		gate(gate, outcome, ms) {
			write({ v: 1, kind: "gate", gate, outcome, ms: count(ms), at: at() });
		},
		wake(job, text) {
			// The driver matches a wake to the tool result that announced its job;
			// an id outside this shape could never match, so it is a bug here.
			if (!JOB_ID.test(job)) throw new Error(`wake job id ${JSON.stringify(job)} is not [A-Za-z0-9_-]{1,64}`);
			const record = { v: 1, kind: "wake", source: "subagent", job, text: fitWakeText(job, text), at: at() };
			write(record);
		},
	};
}

/**
 * The wake text, cut to the driver's character cap and then to whatever keeps
 * the whole line under the byte ceiling (multi-byte text and JSON escaping
 * can make 3,500 characters more than 4 KiB). Cut at the END with a marker:
 * the opening of a completion notice says what happened.
 */
export function fitWakeText(job: string, text: string): string {
	const marker = "\n… [truncated]";
	const fits = (candidate: string) =>
		lineBytes({ v: 1, kind: "wake", source: "subagent", job, text: candidate, at: new Date(0).toISOString() }) < MAX_RECORD_BYTES;
	let out = [...text].length > MAX_WAKE_CHARS ? [...text].slice(0, MAX_WAKE_CHARS - marker.length).join("") + marker : text;
	while (!fits(out)) {
		const chars = [...out.endsWith(marker) ? out.slice(0, -marker.length) : out];
		out = chars.slice(0, Math.floor(chars.length * 0.9)).join("") + marker;
	}
	return out;
}
