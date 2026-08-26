/**
 * brief — parsing the worker's answer and rendering the brief.
 *
 * The rendering half is modelled directly on Hive's `internal/factorycontext`
 * (HIV-690/691), which solved this exact problem for the Code Factory: ordered
 * named sections, each with a drop priority, assembled against a token budget,
 * with a report of what was dropped. Two of its framing decisions are carried
 * over deliberately, because both were paid for:
 *
 *  - Retrieved material is stated as HINTS, not instructions. An agent
 *    pattern-matching a superficially similar retrieval and acting on it with
 *    confidence is worse than giving it nothing.
 *  - Every ranked file carries the REASON it was ranked. An unexplained file
 *    list reads as a restriction, and a wrong prior that forecloses search is
 *    more expensive than no prior at all.
 *
 * Parsing is deliberately tolerant in shape and strict in outcome: anything we
 * cannot turn into a draft returns null, and the caller passes the original
 * prompt through untouched. There is no partial-credit path — a half-parsed
 * brief is how invented facts get in.
 */

export interface BriefRef {
	ref: string;
	note: string;
}

export interface BriefCandidate {
	ref: string;
	reason: string;
}

export interface BriefDraft {
	goal: string;
	facts: BriefRef[];
	startHere: BriefCandidate[];
	refs: BriefRef[];
	unknowns: string[];
	nextMoves: string[];
	/**
	 * Recent history of the files the task names — measured from git, never from
	 * a model (HIV-1806). No parse path fills this: a model asked for commit
	 * hashes produces plausible ones, and a plausible hash is worse than none.
	 */
	history: BriefRef[];
}

/** True when the pass found nothing worth saying — do not render an empty brief. */
export function draftIsEmpty(draft: BriefDraft): boolean {
	return (
		!draft.goal.trim() &&
		draft.facts.length === 0 &&
		draft.startHere.length === 0 &&
		draft.refs.length === 0 &&
		draft.unknowns.length === 0 &&
		draft.nextMoves.length === 0 &&
		draft.history.length === 0
	);
}

/**
 * Caps applied at parse time, matching the numbers stated in the role prompt.
 *
 * Enforced here as well as asked for there, because a cheap model treats a cap
 * in a prompt as a suggestion, and the budget should bind on content we chose
 * to keep rather than on a tail the worker padded.
 */
export const MAX_FACTS = 8;
export const MAX_START_HERE = 5;
export const MAX_REFS = 5;
export const MAX_UNKNOWNS = 5;
export const MAX_MOVES = 5;
/** Files whose history is worth carrying. Lower than the rest: it is a pointer, not the payload. */
export const MAX_HISTORY = 4;

/**
 * Extract the worker's JSON object from its stdout.
 *
 * Takes the LAST fenced `json` block: a model that narrates before complying
 * leaves the real answer at the end, and taking the first would pick up an
 * example it quoted from its own instructions.
 */
export function parseBriefDraft(text: string): BriefDraft | null {
	const raw = extractJsonObject(text);
	if (!raw) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const o = parsed as Record<string, unknown>;

	const draft: BriefDraft = {
		goal: typeof o.goal === "string" ? o.goal.trim() : "",
		facts: refList(o.facts, "note", MAX_FACTS) as BriefRef[],
		startHere: refList(o.start_here, "reason", MAX_START_HERE).map((e) => ({
			ref: e.ref,
			reason: (e as unknown as { note: string }).note,
		})),
		refs: refList(o.refs, "note", MAX_REFS) as BriefRef[],
		unknowns: stringList(o.unknowns, MAX_UNKNOWNS),
		nextMoves: stringList(o.next_moves, MAX_MOVES),
		// Deliberately not read off the worker's answer even if it invented the
		// key: history is measured, and accepting a model's version of it here
		// would let a hallucinated commit hash into a section whose entire value
		// is that it is checkable.
		history: [],
	};
	return draft;
}

function extractJsonObject(text: string): string | null {
	const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
	if (fences.length > 0) return fences[fences.length - 1]?.[1]?.trim() ?? null;
	// Unfenced fallback: the outermost braces. A model that ignored the fence
	// instruction usually still emitted the object.
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	return text.slice(start, end + 1);
}

/** Coerce `[{ref, <noteKey>}]`, dropping anything without a usable ref. */
function refList(value: unknown, noteKey: string, max: number): BriefRef[] {
	if (!Array.isArray(value)) return [];
	const out: BriefRef[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const ref = typeof e.ref === "string" ? e.ref.trim() : "";
		if (!ref) continue;
		const note = typeof e[noteKey] === "string" ? (e[noteKey] as string).trim() : "";
		out.push({ ref, note });
		if (out.length >= max) break;
	}
	return out;
}

function stringList(value: unknown, max: number): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
		.map((v) => v.trim())
		.slice(0, max);
}

/* ------------------------------------------------------------------ render */

/** Lower survives longer. `REQUIRED` is never dropped. */
export const PRIORITY = {
	REQUIRED: 0,
	/** The payoff: what the worker actually established. */
	FACTS: 1,
	/** Ranked entry points. Recoverable by searching, unlike a fact. */
	START: 2,
	/**
	 * Who last changed these files and why. Below the ranked entry points because
	 * it is orientation rather than direction, and above the admitted gaps because
	 * it is measured ground truth that costs a `git log` to rediscover.
	 */
	HISTORY: 3,
	/** Admitted gaps. Above the conveniences: an unbounded confidence is expensive. */
	UNKNOWNS: 4,
	/** Suggested first searches — useful, but derivable. */
	MOVES: 5,
	/** External pointers — the cheapest to lose, the model can search the KB itself. */
	REFS: 6,
} as const;

export interface BriefSection {
	name: string;
	title: string;
	priority: number;
	body: string;
}

export interface BriefReport {
	tokens: number;
	budget: number;
	sections: { name: string; tokens: number }[];
	dropped: string[];
}

export interface CompileInput {
	/** The caller's prompt, minus any appended protocol block. */
	original: string;
	draft: BriefDraft;
	budgetTokens: number;
	/**
	 * Render the verbatim original inside the brief.
	 *
	 * TRUE when the brief becomes the prompt (`/brief` writes it to the editor
	 * and the original is otherwise lost). FALSE when the brief is injected
	 * alongside a prompt that is already being sent — repeating it there is pure
	 * duplication, which is the opposite of what this feature is for.
	 */
	includeOriginal: boolean;
	model: string;
	elapsedMs: number;
}

/**
 * ~4 chars per token. Deliberately not a real tokenizer: the budget exists to
 * bound growth and make it visible, and pulling in a per-model tokenizer to
 * make a soft budget 15% more accurate is a bad trade (factorycontext's
 * `EstimateTokens` says the same).
 */
export function estimateTokens(s: string): number {
	return s ? Math.ceil(s.length / 4) : 0;
}

export function compileBrief(input: CompileInput): { text: string; report: BriefReport } {
	const sections = buildSections(input);
	const report: BriefReport = { tokens: 0, budget: input.budgetTokens, sections: [], dropped: [] };

	// Fit: drop whole lowest-value sections, never partially, never a required
	// one. A half-truncated fact list reads as a complete one.
	const kept = sections.filter((s) => s.body.trim() !== "");
	for (;;) {
		const total = kept.reduce((n, s) => n + estimateTokens(s.body), 0);
		if (total <= input.budgetTokens) {
			report.tokens = total;
			break;
		}
		let victim = -1;
		let worst: number = PRIORITY.REQUIRED;
		for (const [i, s] of kept.entries()) {
			if (s.priority > worst) {
				worst = s.priority;
				victim = i;
			}
		}
		if (victim < 0) {
			report.tokens = total; // only required sections left — ship it over budget
			break;
		}
		report.dropped.push(kept[victim]!.name);
		kept.splice(victim, 1);
	}

	const parts: string[] = [];
	for (const s of kept) {
		parts.push(s.title ? `## ${s.title}\n\n${s.body.trimEnd()}` : s.body.trimEnd());
		report.sections.push({ name: s.name, tokens: estimateTokens(s.body) });
	}
	const header = `${BRIEF_HEADER_OPEN} model=${input.model} elapsed_ms=${input.elapsedMs} -->`;
	return { text: `${header}\n\n${parts.join("\n\n")}`, report };
}

const BRIEF_HEADER_OPEN = "<!-- brief:v1";

function buildSections(input: CompileInput): BriefSection[] {
	const { draft } = input;
	const out: BriefSection[] = [];

	if (draft.goal) {
		out.push({
			name: "goal",
			title: "Goal",
			priority: PRIORITY.REQUIRED,
			body: draft.goal,
		});
	}

	// The original, verbatim. It is REQUIRED and it is last-word: a cheap model
	// restating a task is the one way this feature can lose the user's intent,
	// and the only defence that always works is keeping what they actually
	// wrote where the next model can compare.
	if (input.includeOriginal) {
		out.push({
			name: "task",
			title: "Task, as given (verbatim — this is the ground truth if the two differ)",
			priority: PRIORITY.REQUIRED,
			body: input.original.trim(),
		});
	}

	if (draft.facts.length > 0) {
		out.push({
			name: "facts",
			title: "Established, with references",
			priority: PRIORITY.FACTS,
			body: draft.facts.map((f) => (f.note ? `- \`${f.ref}\` — ${f.note}` : `- \`${f.ref}\``)).join("\n"),
		});
	}

	if (draft.startHere.length > 0) {
		out.push({
			name: "start_here",
			title: "Where to start looking",
			priority: PRIORITY.START,
			body: [
				"Ranked, and derived from a fast search — it is not exhaustive and it can be wrong, so look elsewhere if what you need is not here:",
				"",
				...draft.startHere.map((c) => (c.reason ? `- \`${c.ref}\` — ${c.reason}` : `- \`${c.ref}\``)),
			].join("\n"),
		});
	}

	if (draft.history.length > 0) {
		out.push({
			name: "history",
			title: "Recently changed",
			priority: PRIORITY.HISTORY,
			body: [
				"Read from git, not from a model — these are the last commits to touch the files the task names:",
				"",
				...draft.history.map((h) => (h.note ? `- \`${h.ref}\` — ${h.note}` : `- \`${h.ref}\``)),
			].join("\n"),
		});
	}

	if (draft.unknowns.length > 0) {
		out.push({
			name: "unknowns",
			title: "Not determined",
			priority: PRIORITY.UNKNOWNS,
			body: draft.unknowns.map((u) => `- ${u}`).join("\n"),
		});
	}

	if (draft.nextMoves.length > 0) {
		out.push({
			name: "next_moves",
			title: "Worth running first",
			priority: PRIORITY.MOVES,
			body: draft.nextMoves.map((m) => `- ${m}`).join("\n"),
		});
	}

	if (draft.refs.length > 0) {
		out.push({
			name: "refs",
			title: "Related material",
			priority: PRIORITY.REFS,
			body: draft.refs.map((r) => (r.note ? `- ${r.ref} — ${r.note}` : `- ${r.ref}`)).join("\n"),
		});
	}

	return out;
}
