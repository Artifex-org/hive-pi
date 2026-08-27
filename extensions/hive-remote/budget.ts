/**
 * hive-remote — serializing a tool payload into a fixed byte budget.
 *
 * ## The bug this exists to fix
 *
 * Hive caps a transcript event's fields (`internal/store/agent_session_events.go`):
 * 256 KB for a tool result, 64 KB for tool arguments. Over the cap the server
 * TRUNCATES on insert, silently. Truncating JSON cuts it mid-token, so what
 * lands in the database no longer parses — and every consumer that wanted the
 * structured payload gets nothing, with no indication why.
 *
 * The payloads that hit this are exactly the ones worth reading: a `subagent`
 * result carries the full nested `messages[]` of every agent it ran.
 *
 * ## The fix
 *
 * Drop the LARGEST sub-trees and say so, rather than truncating the tail. The
 * output stays valid JSON and stays honest: a reader sees `"[dropped: 1.4 MB]"`
 * where the bulk was, instead of guessing why parsing failed.
 *
 * Deliberately generic rather than `subagent`-aware. The transport should not
 * need to know which tools are large, and the next tool that returns a big
 * payload should not have to rediscover this bug.
 *
 * ## The constraint
 *
 * This runs inside `foldToolEnd`, called from a pi event handler, and pi awaits
 * handlers serially — a slow handler IS the agent loop. So it is synchronous,
 * allocation-light, and bounded twice over: by a recursion depth cap and by
 * HOPELESS_BYTES, above which nothing is walked at all.
 */

/** Server caps, mirrored from internal/store/agent_session_events.go. */
export const RESULT_BUDGET = 262144;
export const ARGS_BUDGET = 65536;

/**
 * Fraction of the cap actually targeted.
 *
 * The server redacts secrets (`secretscan.Redact`) BEFORE it truncates, and a
 * redaction can lengthen a string — a matched credential becomes a longer
 * placeholder. Aiming slightly under the cap means the common case survives
 * that rewrite instead of being cut by the few bytes redaction added.
 */
const SAFETY = 0.95;

/** Deepest we will walk while pruning. */
const MAX_DEPTH = 8;

/**
 * Bytes held back when handing a budget to a child.
 *
 * Covers the punctuation the parent adds around a value it did not measure —
 * the comma, the newline, the indentation. Without it a child spends its whole
 * allowance and then overruns by the separator it never knew about.
 */
const MARGIN = 16;

/**
 * Fraction of what remains that a child may spend.
 *
 * A child measured on its own is written back INDENTED, two more spaces per
 * line per level, so a sub-tree that fills its allowance exactly overruns once
 * it is nested. Leaving a margin matters more than it sounds: a parent that
 * finds its only child slightly too big drops that child ENTIRELY, so an
 * accounting slop of a few bytes cost the whole subagent result rather than
 * some of its messages.
 */
const HEADROOM = 0.85;

/** childRoom is what a nested value may spend out of `remaining` bytes. */
function childRoom(remaining: number): number {
	return Math.max(64, Math.floor((remaining - MARGIN) * HEADROOM));
}

/**
 * Beyond this, pruning is not attempted at all.
 *
 * Pruning re-serializes as it descends, so its cost scales with the payload.
 * A pathological result must not turn into tens of megabytes of string work on
 * the agent loop, so past this size the payload is replaced wholesale by a
 * marker naming what was lost. That is a worse transcript than a pruned one and
 * a far better one than a stalled agent.
 */
const HOPELESS_BYTES = 8 * 1024 * 1024;

/**
 * budgeted renders a value as JSON that fits `budget` UTF-8 bytes.
 *
 * Returns undefined for a value that has nothing to show (null/undefined),
 * matching the caller's existing contract.
 */
export function budgeted(v: unknown, budget: number): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v === "string") return fitString(v, target(budget));

	const full = stringify(v);
	if (full === undefined) return "[unserializable]";

	const limit = target(budget);
	if (byteLength(full) <= limit) return full;
	if (byteLength(full) > HOPELESS_BYTES) return `"[dropped: ${size(byteLength(full))} — too large to summarize]"`;

	/**
	 * Prune, then VERIFY, then prune harder.
	 *
	 * The pruner budgets by measuring each sub-tree on its own, but the value it
	 * returns is serialized nested — where pretty-printing indents every line by
	 * two more spaces per level. So a sub-tree that measured just inside its
	 * allowance can land just outside it once it is written in place.
	 *
	 * Rather than model the indentation (which would have to track the parent's
	 * depth through every branch, and be re-derived whenever the formatting
	 * changes), the result is measured and the budget halved until it fits.
	 * Halving converges in a couple of passes and cannot loop.
	 */
	let allowance = limit;
	for (let attempt = 0; attempt < 5; attempt++) {
		const out = stringify(prune(v, allowance, 0));
		if (out !== undefined && byteLength(out) <= limit) return out;
		allowance = Math.floor(allowance / 2);
	}
	return `"[dropped: ${size(byteLength(full))} — could not be summarized]"`;
}

function target(budget: number): number {
	return Math.max(64, Math.floor(budget * SAFETY));
}

/**
 * prune returns a value whose serialization fits `limit`.
 *
 * Objects keep their SMALLEST fields first. That ordering is the whole design:
 * the small fields of a large payload are the identifying ones — a subagent
 * result's `agent`, `exitCode`, `usage`, `model` — and the single huge field is
 * the transcript nobody can read at this size anyway. Dropping in arrival order
 * instead would keep whichever fields happened to come first and lose the rest.
 */
function prune(v: unknown, limit: number, depth: number): unknown {
	if (v === null || typeof v === "number" || typeof v === "boolean") return v;
	if (typeof v === "string") return fitRaw(v, limit);

	const serialized = stringify(v);
	if (serialized === undefined) return "[unserializable]";
	if (byteLength(serialized) <= limit) return v;

	// Out of depth: there is nothing left to descend into, so say what is going.
	if (depth >= MAX_DEPTH) return dropMarker(byteLength(serialized));

	if (Array.isArray(v)) return pruneArray(v, limit, depth);
	if (typeof v === "object") return pruneObject(v as Record<string, unknown>, limit, depth);
	return dropMarker(byteLength(serialized));
}

/**
 * An array keeps a PREFIX and reports the tail.
 *
 * Prefix rather than "smallest elements first", unlike an object: an array is
 * usually ordered — a message log, a list of steps — and a sample of arbitrary
 * elements from the middle is less use than the beginning plus a count.
 */
function pruneArray(items: unknown[], limit: number, depth: number): unknown[] {
	const out: unknown[] = [];
	// Reserve room for the marker element that reports what was cut.
	let used = 2 + 64;
	for (let i = 0; i < items.length; i++) {
		const pruned = prune(items[i], childRoom(limit - used), depth + 1);
		const cost = byteLength(stringify(pruned) ?? "") + 2;
		if (used + cost > limit) {
			out.push(`[dropped: ${items.length - i} more items]`);
			return out;
		}
		used += cost;
		out.push(pruned);
	}
	return out;
}

function pruneObject(obj: Record<string, unknown>, limit: number, depth: number): Record<string, unknown> {
	const entries = Object.entries(obj)
		.map(([k, val]) => ({ k, val, bytes: byteLength(stringify(val) ?? "") }))
		.sort((a, b) => a.bytes - b.bytes);

	const out: Record<string, unknown> = {};
	let used = 2;
	for (let i = 0; i < entries.length; i++) {
		const { k, val, bytes } = entries[i];
		const overhead = byteLength(k) + 6;
		const remaining = limit - used - overhead;
		if (remaining <= MARGIN) {
			// No room even to describe it. Keeping the KEY with a marker still
			// tells a reader the field existed, which is the point — an absent
			// key reads as "the tool did not return one".
			out[k] = dropMarker(bytes);
			used += overhead + 32;
			continue;
		}
		const room = childRoom(remaining);
		const pruned = bytes <= room ? val : prune(val, room, depth + 1);
		out[k] = pruned;
		used += overhead + byteLength(stringify(pruned) ?? "");
	}
	return out;
}

/** fitString bounds a bare string result, which is not JSON to begin with. */
function fitString(s: string, limit: number): string {
	return byteLength(s) <= limit ? s : `${sliceBytes(s, limit - 32)}\n[dropped: ${size(byteLength(s))}]`;
}

/** fitRaw bounds a string NESTED in a payload, where the marker must stay inline. */
function fitRaw(s: string, limit: number): string {
	// -2 for the quotes JSON will add around it, -32 for the marker.
	return byteLength(s) <= limit - 2 ? s : `${sliceBytes(s, Math.max(0, limit - 34))}…[dropped: ${size(byteLength(s))}]`;
}

function dropMarker(bytes: number): string {
	return `[dropped: ${size(bytes)}]`;
}

/** size renders a byte count the way a human reads one. */
export function size(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/**
 * stringify is the one place JSON.stringify is called.
 *
 * A cycle or a BigInt throws, and this runs inside a pi event handler where a
 * throw surfaces as an agent-loop error — so it degrades to undefined and the
 * caller substitutes a marker.
 */
function stringify(v: unknown): string | undefined {
	try {
		return JSON.stringify(v, null, 2);
	} catch {
		return undefined;
	}
}

/**
 * byteLength measures UTF-8 bytes, because the server's cap is in bytes.
 *
 * A JS string's `.length` is UTF-16 code units, so a transcript full of CJK or
 * emoji is up to four bytes per unit — budgeting by `.length` would sail past
 * the cap on exactly the payloads most likely to be near it.
 */
function byteLength(s: string): number {
	// Fast path: ASCII-only strings, which is nearly all of them. Scanning is
	// cheaper than the encoder's allocation, and bails on the first wide char.
	for (let i = 0; i < s.length; i++) {
		if (s.charCodeAt(i) > 127) return Buffer.byteLength(s, "utf8");
	}
	return s.length;
}

/** sliceBytes cuts to at most n UTF-8 bytes without splitting a code point. */
function sliceBytes(s: string, n: number): string {
	if (n <= 0) return "";
	if (byteLength(s) <= n) return s;
	// Start from an upper bound in code units and walk back until it fits. A
	// character is at most 4 bytes, so this converges immediately in practice.
	let end = Math.min(s.length, n);
	while (end > 0 && byteLength(s.slice(0, end)) > n) end -= Math.max(1, Math.ceil((byteLength(s.slice(0, end)) - n) / 4));
	// Never split a surrogate pair — half of one is an invalid string.
	const code = s.charCodeAt(end - 1);
	if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
	return s.slice(0, Math.max(0, end));
}
