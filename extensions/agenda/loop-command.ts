/**
 * `/loop` argument grammar — pure.
 *
 *   /loop <n>{s|m|h|d} <prompt>   fixed interval
 *   /loop <prompt>                self-paced (the model re-arms via agenda_wake)
 *   /loop                         .pi/loop.md, or a built-in maintenance prompt
 *   /loop stop
 *
 * The interval is only an interval when the FIRST token looks like one AND
 * something follows it. `/loop 5m` alone is a mistake worth naming rather than
 * silently treating "5m" as the prompt, and `/loop 3 retries left before we
 * give up` is a prompt, not a 3-something interval.
 */

import { MAX_LIFETIME_MS, MIN_DELAY_MS } from "./loop-state.ts";

export type LoopCommand =
	| { kind: "status" }
	| { kind: "stop" }
	| { kind: "start"; mode: "fixed"; intervalMs: number; prompt: string; rounded: boolean }
	| { kind: "start"; mode: "self-paced"; prompt: string }
	| { kind: "default" }
	| { kind: "error"; message: string };

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30s` → 30000, `5m` → 300000. Null when the token is not an interval at all. */
export function parseInterval(token: string): number | null {
	const match = token.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([smhd])$/);
	if (!match) return null;
	const value = Number.parseFloat(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	return Math.round(value * UNIT_MS[match[2]]);
}

export function parseLoopCommand(args: string): LoopCommand {
	const trimmed = args.trim();
	if (trimmed.length === 0) return { kind: "default" };

	const lowered = trimmed.toLowerCase();
	if (lowered === "stop" || lowered === "off" || lowered === "cancel") return { kind: "stop" };
	if (lowered === "status") return { kind: "status" };

	const [first, ...rest] = trimmed.split(/\s+/);
	const interval = parseInterval(first);

	if (interval !== null) {
		const prompt = rest.join(" ").trim();
		if (!prompt) {
			return { kind: "error", message: `"${first}" is an interval but there is no prompt after it` };
		}
		if (interval > MAX_LIFETIME_MS) {
			return { kind: "error", message: `interval ${first} is longer than the 7-day maximum lifetime` };
		}
		// Sub-minute intervals round UP rather than being refused: the user's
		// intent ("often") is clear, and a busy-wait is the only thing being
		// declined.
		const rounded = interval < MIN_DELAY_MS;
		return {
			kind: "start",
			mode: "fixed",
			intervalMs: rounded ? MIN_DELAY_MS : interval,
			prompt,
			rounded,
		};
	}

	return { kind: "start", mode: "self-paced", prompt: trimmed };
}

/**
 * The built-in bare-`/loop` prompt.
 *
 * The scope sentence is the whole safety design: an unattended loop with no
 * task list will otherwise invent initiatives. It continues existing work,
 * tends the current branch, and is explicitly barred from starting anything
 * new — and irreversible actions are allowed only where they continue something
 * the transcript already authorized.
 */
export const DEFAULT_LOOP_PROMPT = [
	"Continue the work already in progress in this session.",
	"",
	"In priority order: finish anything left incomplete; then tend the current",
	"branch's pull request (failing checks, review comments, conflicts); then make",
	"a small, obviously-correct cleanup pass over what you have already touched.",
	"",
	"Do NOT start new initiatives outside that scope. Irreversible actions such as",
	"pushing, merging, deleting or deploying may only proceed where they continue",
	"something this conversation has already authorized.",
	"",
	"If there is genuinely nothing to do, call agenda_wake with noop:true rather",
	"than inventing work.",
].join("\n");

/** Bytes of `loop.md` we will read. Past this the task list is not a task list. */
export const MAX_LOOP_FILE_BYTES = 25_000;

export function truncateLoopFile(content: string): { text: string; truncated: boolean } {
	if (Buffer.byteLength(content, "utf8") <= MAX_LOOP_FILE_BYTES) {
		return { text: content, truncated: false };
	}
	const text = Buffer.from(content, "utf8").subarray(0, MAX_LOOP_FILE_BYTES).toString("utf8");
	return {
		text: `${text}\n\n> WARNING: loop.md was truncated to ${MAX_LOOP_FILE_BYTES} bytes. Keep the task list concise.`,
		truncated: true,
	};
}
