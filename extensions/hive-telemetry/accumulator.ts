/**
 * hive-telemetry — the accumulator. Pure state plus total, synchronous folds.
 * No I/O, no awaits, no imports beyond types.
 *
 * WHY ACCUMULATE FROM EVENTS rather than re-scan the session:
 * `status-footer.ts` sums `ctx.sessionManager.getBranch()`, which is correct for
 * a live display and WRONG for telemetry. After a compaction the summarized
 * entries leave the branch, so branch-derived totals DECREASE — money already
 * spent simply vanishes. Branch navigation drops the abandoned side the same
 * way, and a fork copies entries into a new file so the same tokens would be
 * counted twice across two runs.
 *
 * `message_end` fires exactly once per LLM call actually issued and
 * `tool_execution_end` exactly once per tool actually run, so folding events
 * makes compaction, tree navigation and fork structurally incapable of double-
 * or under-counting. We never look back at the session tree.
 *
 * EVERY function here must stay synchronous. pi awaits each extension handler
 * serially (dist/core/extensions/runner.js), so a slow handler IS the agent loop.
 */

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ErrorClass, HiveGateMetricEvent, NestedUsageMetric, ProjectIdentity, ToolErrorKind } from "./types.ts";

/** Cardinality caps. Overflow is dropped, never unbounded. */
export const MAX_MODELS = 16;
export const MAX_TOOLS = 64;
export const MAX_GATES = 32;
export const MAX_PENDING_TOOLS = 256;

export interface ModelBucket {
	model: string;
	provider: string;
	authMode: "api_key" | "subscription" | "unknown";
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/**
	 * Reasoning/thinking tokens. A SUBSET of `output` — pi's Usage type states
	 * "output already includes these tokens" — so it is a breakdown, never added.
	 *
	 * undefined when NO turn in this bucket reported a breakdown, which is a
	 * different fact from 0 ("the provider reported one and the model did not
	 * think"). The server stores the distinction, so we must not flatten it here.
	 */
	reasoning?: number;
	cost: number;
}

export interface ToolBucket {
	calls: number;
	errors: number;
	/**
	 * Counts per ToolErrorKind. Absent until this tool actually errors, so a
	 * tool that never failed sends no map at all rather than a row of zeroes —
	 * on the server side a NULL means NOT REPORTED, which must stay
	 * distinguishable from "reported, and there were none".
	 */
	errorKinds?: Map<ToolErrorKind, number>;
}

export interface GateBucket {
	passed: number;
	failed: number;
	timedOut: number;
	skipped: number;
	durationMs: number;
}

export interface RunAccumulator {
	readonly runId: string;
	readonly sessionId: string;
	readonly parentSessionId: string;
	readonly startedAtMs: number;
	readonly source: "workstation" | "eval" | "ci" | "cloud";
	project: ProjectIdentity | null;

	status: "active" | "ended";
	outcome: string;
	endedAtMs: number | null;

	turns: number;
	toolCalls: number;
	toolErrors: number;

	/**
	 * Context compactions. `compactionOverflows` counts only reason==="overflow"
	 * — the session ran OUT of context rather than crossing a housekeeping
	 * threshold — which is the one that indicates a problem and would be
	 * invisible inside a single total.
	 *
	 * compactionTokensBefore sums the context size at each compaction — how
	 * large it had grown before it had to be compacted. NOT "tokens saved":
	 * the extension API's CompactionEntry exposes tokensBefore but NOT
	 * estimatedTokensAfter, so a saved figure is not derivable here.
	 * undefined means no compaction reported a size, never 0.
	 */
	compactions: number;
	compactionOverflows: number;
	compactionTokensBefore?: number;

	models: Map<string, ModelBucket>;
	tools: Map<string, ToolBucket>;
	gates: Map<string, GateBucket>;

	/** toolCallId -> tool name. Bounded; an aborted tool may never emit its end. */
	pending: Map<string, string>;

	seq: number;
	dirty: number;
	inFlight: boolean;
	/** When a flush was last ATTEMPTED — set before the POST, so it says nothing about arrival. */
	lastFlushMs: number;
	/**
	 * When a flush was last ACKNOWLEDGED by the server, and 0 until one is.
	 *
	 * Distinct from `lastFlushMs` because the two diverge exactly when it
	 * matters. A flush is "contact" only if it ARRIVED, and the interval tick
	 * used to suppress the heartbeat on `lastFlushMs` — i.e. on having tried.
	 * A session whose flushes stall then reports nothing at all, and the server
	 * reaps it for silence while it is working. See the tick in index.ts.
	 */
	lastFlushOkMs: number;
	consecutiveFailures: number;
	backoffUntilMs: number;

	/**
	 * The credential was refused (401/403). Usage flushes stop; the HEARTBEAT
	 * does not — see takeHeartbeatSlot for why silence is the worse failure.
	 */
	authFailed: boolean;
	/**
	 * How far the auth-rejected heartbeat has backed off. 0 while the credential
	 * is good. Separate from `consecutiveFailures` because the two count
	 * different things: that one counts *transient* flush failures, and a 5xx
	 * must never slow the heartbeat down — a server having a bad minute is not a
	 * reason to let its own fleet view conclude this session died.
	 */
	authBackoffStep: number;
	heartbeatBackoffUntilMs: number;
}

/** Retry backoff, shared by the usage flush and the auth-rejected heartbeat. */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;

/**
 * backoffMs is the ONE backoff curve in this extension: 1min, 2, 4, 8 … capped
 * at 30min, jittered ±20% so a six-pane workmux layout does not re-attempt in
 * lockstep.
 *
 * Exported and jitter-injectable rather than inlined at each call site because
 * it now has two callers with very different failure modes (transient flush
 * failure, rejected credential) and a second hand-rolled copy is how the two
 * drift into disagreeing about the cap.
 */
export function backoffMs(attempt: number, jitter: number = Math.random()): number {
	// 2 ** large is Infinity, which Math.min resolves to the cap — so a session
	// left running for days lands on 30min rather than on a NaN date.
	const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
	return Math.round(base * (0.8 + jitter * 0.4));
}

/**
 * latchAuthFailure records that hive refused this credential, and answers
 * whether this is the TRANSITION — the caller tells the human exactly once, not
 * once per attempt.
 *
 * It also arms the heartbeat's backoff, because latching is the moment we learn
 * the token is bad and every heartbeat after it is presented on that same bad
 * token.
 */
export function latchAuthFailure(a: RunAccumulator, nowMs: number, jitter?: number): boolean {
	if (a.authFailed) return false;
	a.authFailed = true;
	a.authBackoffStep = 1;
	a.heartbeatBackoffUntilMs = nowMs + backoffMs(1, jitter);
	return true;
}

/** The credential was accepted again (a repaired /hive-login, a manual flush that landed). */
export function clearAuthFailure(a: RunAccumulator): void {
	a.authFailed = false;
	a.authBackoffStep = 0;
	a.heartbeatBackoffUntilMs = 0;
}

/**
 * takeHeartbeatSlot decides whether a keepalive may go out now, and consumes
 * the slot when it may.
 *
 * BACK OFF, DO NOT GO SILENT. The obvious reading of "stop hammering a revoked
 * token" is `if (authFailed) return`, and it is the wrong one: silence is
 * precisely how the server concludes a session is dead, so a session whose
 * token is repaired mid-flight may already have been reaped, and a bad-token
 * session disappears from the fleet view instead of showing up there as
 * unauthenticated — the state an operator needs to see to fix it.
 *
 * So the heartbeat decays onto the same curve the flush uses instead of
 * stopping. Measured before this (HIV-1639, test/hive-telemetry-wiring): usage
 * posts froze at 3 while heartbeats reached 33 over 30 simulated seconds — a
 * revoked credential presented once per interval for the life of the process,
 * which is what hive's authMiddleware (it writes api_tokens.last_used_at on
 * every call) records as credential stuffing.
 */
/**
 * Whether this tick must send a liveness heartbeat, given that it may already
 * have queued a usage flush.
 *
 * ## The bug this replaces, which cost a live agent
 *
 * The tick used to read `if (dirty > 0 && queueFlush()) return;` — skip the
 * heartbeat whenever a flush had been QUEUED. `dirty > 0` is true on every tick
 * of a working session, so a busy run took that branch from its first tick and
 * never once reached the heartbeat: `last_seen_at` was NULL for the whole of a
 * 22-turn session (a78c92ef, 2026-08-17). Liveness rested entirely on the
 * flush — and when the flush loop stopped at 18:11:28, the server's 5-minute
 * sweep ended the session `heartbeat_timeout` while the agent kept working.
 * Hive recorded 22 turns and $1.57 against the pane's 59 and $6.11, and every
 * `only_live` view hid it (HIV-1996).
 *
 * ## The rule
 *
 * "Reporting usage IS contact" is right and stays. What it now requires is that
 * the flush ARRIVED: a queued POST proves nothing, and a queue that never
 * drains is exactly the failure being guarded against. So silence is permitted
 * only while an ACKNOWLEDGED flush is recent.
 *
 * A pure function, and separate from the tick, because the tick is a timer
 * inside a closure over live network state — the only way to test the decision
 * itself is to be able to call it. That is the same reason `takeHeartbeatSlot`
 * below and `effectiveWaitTimeout` in hive both sit where they do.
 *
 * `lastFlushOkMs` is 0 until the first acknowledged flush, so a session
 * heartbeats from tick one and can never begin life invisible.
 */
export function shouldHeartbeat(
	a: Pick<RunAccumulator, "lastFlushOkMs">,
	flushing: boolean,
	nowMs: number,
	intervalMs: number,
): boolean {
	if (!flushing) return true;
	// NEVER LANDED is its own case, not a very old one. Left to the arithmetic
	// below, `lastFlushOkMs === 0` reads as "acknowledged at the epoch", which
	// is only ≥ two intervals ago once the clock has run two intervals — so a
	// session busy from its first tick stayed silent for the first two minutes
	// of its life at the real 60s interval. That is the measured bug in
	// miniature, and the test for it failed against exactly this line.
	if (a.lastFlushOkMs === 0) return true;
	// TWO intervals, not one: a flush in flight legitimately occupies about one,
	// so a single slow POST must not be read as a stall and start double-posting.
	return nowMs - a.lastFlushOkMs >= intervalMs * 2;
}

export function takeHeartbeatSlot(a: RunAccumulator, nowMs: number, jitter?: number): boolean {
	if (!a.authFailed) return true;
	if (nowMs < a.heartbeatBackoffUntilMs) return false;
	a.authBackoffStep += 1;
	a.heartbeatBackoffUntilMs = nowMs + backoffMs(a.authBackoffStep, jitter);
	return true;
}

export function createRun(
	runId: string,
	sessionId: string,
	parentSessionId: string,
	source: "workstation" | "eval" | "ci" | "cloud",
	nowMs: number,
): RunAccumulator {
	return {
		runId,
		sessionId,
		parentSessionId,
		startedAtMs: nowMs,
		source,
		project: null,
		status: "active",
		outcome: "",
		endedAtMs: null,
		turns: 0,
		toolCalls: 0,
		toolErrors: 0,
		compactions: 0,
		compactionOverflows: 0,
		models: new Map(),
		tools: new Map(),
		gates: new Map(),
		pending: new Map(),
		seq: 0,
		dirty: 0,
		inFlight: false,
		lastFlushMs: 0,
		lastFlushOkMs: 0,
		consecutiveFailures: 0,
		backoffUntilMs: 0,
		authFailed: false,
		authBackoffStep: 0,
		heartbeatBackoffUntilMs: 0,
	};
}

/**
 * classifyError maps a provider error string to one of eight enum values AND
 * DISCARDS THE STRING. An error message can quote a prompt, a file path or a
 * request body, so it must never reach the accumulator — only its class does.
 *
 * Currently the class is folded into nothing (v1 has no column for it) but the
 * classification lives here so adding one later never tempts anyone to store
 * the raw text.
 */
export function classifyError(message: string | undefined): ErrorClass {
	if (!message) return "unknown";
	const m = message.toLowerCase();
	if (m.includes("rate limit") || m.includes("429")) return "rate_limit";
	if (m.includes("overloaded") || m.includes("503")) return "overloaded";
	if (m.includes("context length") || m.includes("too many tokens")) return "context_length";
	if (m.includes("unauthorized") || m.includes("401") || m.includes("403")) return "auth";
	if (m.includes("timeout") || m.includes("timed out")) return "timeout";
	if (m.includes("econnrefused") || m.includes("enotfound") || m.includes("network")) return "network";
	if (m.includes("abort")) return "aborted";
	return "unknown";
}

/**
 * classifyToolError maps a tool failure to one of eight kinds AND DISCARDS THE
 * INPUT, exactly as classifyError does for provider errors.
 *
 * This is the ONE place in the extension that inspects a tool result, and it is
 * a deliberate, reviewed narrowing of the older "no code path reads .result"
 * rule — see the README, which now states the exception rather than a guarantee
 * that would no longer be true. The narrowing holds only while three things
 * remain true, so change any of them and you have changed the privacy contract:
 *
 *   1. It is called at the EVENT BOUNDARY (index.ts), never from the
 *      accumulator, so no result text is ever stored in run state.
 *   2. It returns a ToolErrorKind and nothing else. There is no overload, no
 *      "sample", no first-N-characters — the string is unreachable after the
 *      last `return`.
 *   3. It matches on lowercase substrings only. It never extracts a path, a
 *      command, an identifier or a capture group, so no fragment of the result
 *      can survive inside the value.
 *
 * Ordering is deliberate: the most specific and most confidently-identified
 * causes are tested first, because several of these phrases co-occur. A guard
 * refusal often also says "permission", and a killed command often also says
 * "exit status", so whichever is tested first wins — and the first test should
 * be the one that names the actual remedy.
 */
export function classifyToolError(message: string | undefined): ToolErrorKind {
	if (!message) return "other";
	const m = message.toLowerCase();

	// Tested first and deliberately: this is the house's own guard, it is by far
	// the most common tool failure on a workstation, and it is the one whose
	// count is actionable (it means the agent is fighting the worktree rules).
	// Several of its messages also contain "permission" or "not allowed".
	if (
		m.includes("worktree guard") ||
		m.includes("guard blocked") ||
		// The guard's own shout, which the substring list somehow never had:
		// "BLOCKED: command operates in the main worktree of hive-pi".
		m.includes("blocked:") ||
		m.includes("blocked by") ||
		m.includes("refusing to") ||
		m.includes("is blocked")
	) {
		return "guard_blocked";
	}
	if (m.includes("interrupted") || m.includes("cancell") || m.includes("aborted")) {
		return "interrupted";
	}
	if (m.includes("timed out") || m.includes("timeout")) return "timeout";

	// A stale or ambiguous EDIT ANCHOR, before the argument rules, because the
	// call typechecked — `bad_args` would be the wrong owner. The distinction
	// is not academic: bad_args means the tool's schema and the caller disagree
	// (fix the schema or the call site), no_match means the file on disk is not
	// what the model last read (read before you edit). These phrases are pi's
	// edit-tool wording, matched specifically rather than by a generic "found N
	// occurrences", because a bash result quoting "found 3 occurrences of" in
	// someone's grep output must not land here.
	if (
		m.includes("could not find the exact text") ||
		m.includes("could not find edits[") ||
		m.includes("occurrences of the text in") ||
		m.includes("occurrences of edits[") ||
		m.includes("oldtext must be unique") ||
		m.includes("the text must be unique") ||
		m.includes("must match exactly including") ||
		m.includes("replacement produced identical content")
	) {
		return "no_match";
	}

	if (
		m.includes("no such file") ||
		m.includes("not found") ||
		m.includes("enoent") ||
		m.includes("does not exist")
	) {
		return "not_found";
	}
	if (
		m.includes("permission denied") ||
		m.includes("eacces") ||
		m.includes("read-only") ||
		m.includes("not permitted")
	) {
		return "permission";
	}
	// Argument problems before exit codes: a tool that rejects its own input
	// usually says so AND returns non-zero, and "you called it wrong" is the
	// more useful of the two facts.
	//
	// The second group is the wording that actually appears in the fleet and
	// that the first group never matched: pi's own tool-schema validator
	// ("Validation failed for tool \"list_symbols\": - file: must have required
	// properties file"), hive's MCP argument validator ("validating
	// \"arguments\": ... unexpected additional properties [\"limit\"]", and the
	// "Expected parameters:" block it appends), and two read-tool misuses that
	// are argument errors wearing an errno.
	if (
		m.includes("invalid argument") ||
		m.includes("unknown flag") ||
		m.includes("unrecognized") ||
		m.includes("required parameter") ||
		m.includes("required: missing properties") ||
		m.includes("invalid input") ||
		m.includes("usage:") ||
		m.includes("validation failed for tool") ||
		m.includes("must have required propert") ||
		m.includes("unexpected additional properties") ||
		m.includes('validating "arguments"') ||
		m.includes("expected parameters:") ||
		m.includes("is beyond end of file") ||
		m.includes("eisdir")
	) {
		return "bad_args";
	}
	// The network refused or would not resolve. Neither the model's fault nor a
	// schema problem, so it must not fall through to `other` and be read as one.
	if (
		m.includes("econnrefused") ||
		m.includes("err_connection_refused") ||
		m.includes("err_name_not_resolved") ||
		m.includes("enotfound") ||
		m.includes("ehostunreach") ||
		m.includes("econnreset") ||
		m.includes("socket hang up")
	) {
		return "unreachable";
	}
	// Last, and the single biggest miss in the original list: pi's bash tool
	// says "Command exited with code 2". It says neither "exit code" nor "exit
	// status", so 547 of the fleet's ~1,850 weekly tool errors — the largest
	// bucket there is — were reported as `other` over one absent phrase.
	if (
		m.includes("exit status") ||
		m.includes("exit code") ||
		m.includes("non-zero") ||
		m.includes("exited with code") ||
		m.includes("exited with status")
	) {
		return "nonzero_exit";
	}
	return "other";
}

/**
 * toolErrorText pulls the classifiable text out of a tool result without
 * letting the caller keep it: it is used only as the argument to
 * classifyToolError, on one line, in one handler.
 *
 * A result may be a string, an Error, or an object with a message/content
 * field, so this normalises those shapes. It bounds the input because a result
 * can be a whole file: matching a fixed set of substrings against 2KB costs
 * nothing and cannot be turned into an exfiltration path by a large payload.
 *
 * The 2KB is taken from BOTH ENDS, not the head. A shell result puts its
 * diagnostic last — "Command exited with code 2" is the final line under
 * however much stdout came first — so a head-only window throws away the one
 * sentence worth classifying on exactly the results that are too big to read.
 * Measured over a 1,854-error corpus: 191 results exceed 2KB, and 134 of them
 * are classifiable ONLY in the tail. Head+tail recovers all 134 and loses
 * nothing, because no rule here depends on the two halves being contiguous.
 *
 * The budget is unchanged at 2048 characters total, so this widens what can be
 * classified without widening what is read.
 */
export function toolErrorText(result: unknown): string | undefined {
	if (result == null) return undefined;
	let text: string | undefined;
	if (typeof result === "string") text = result;
	else if (result instanceof Error) text = result.message;
	else if (typeof result === "object") {
		const r = result as Record<string, unknown>;
		for (const key of ["message", "error", "stderr", "content", "text"]) {
			if (typeof r[key] === "string") {
				text = r[key] as string;
				break;
			}
		}
		// Pi tool results normally carry their display text in content blocks.
		// Read only a text block, never stringify the envelope or its details.
		if (text === undefined && Array.isArray(r.content)) {
			for (const block of r.content) {
				if (typeof block === "object" && block !== null && typeof block.text === "string") {
					text = block.text;
					break;
				}
			}
		}
	}
	return text === undefined ? undefined : boundForClassification(text);
}

/**
 * boundForClassification keeps the first and last kilobyte of an oversized
 * result and drops the middle.
 *
 * The two halves are joined by a newline and nothing else — no marker, no
 * ellipsis, no byte count. A separator would be a substring the rules could
 * accidentally match, and a byte count would be a fact about the payload
 * surviving into a value that is supposed to carry none.
 */
export function boundForClassification(text: string, budget = 2048): string {
	if (text.length <= budget) return text;
	const head = Math.floor(budget / 2);
	return `${text.slice(0, head)}\n${text.slice(-(budget - head))}`;
}

function modelKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

/** Metric-only child usage supplied by the subagent producer. */
export type NestedUsageModel = NestedUsageMetric;

function addModelUsage(a: RunAccumulator, usage: NestedUsageModel): void {
	const key = modelKey(usage.provider, usage.model);
	let bucket = a.models.get(key);
	if (!bucket) {
		if (a.models.size >= MAX_MODELS) return;
		bucket = {
			model: usage.model,
			provider: usage.provider,
			// The client only ever states HOW it authenticated. Whether that
			// spend is money is the server's call (internal/factorybilling), and
			// this field is advisory input to it, never the verdict.
			authMode: usage.authMode,
			turns: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		};
		a.models.set(key, bucket);
	}
	bucket.input += usage.input;
	bucket.output += usage.output;
	bucket.cacheRead += usage.cacheRead;
	bucket.cacheWrite += usage.cacheWrite;
	if (usage.reasoning !== undefined) bucket.reasoning = (bucket.reasoning ?? 0) + usage.reasoning;
	if (Number.isFinite(usage.cost) && usage.cost > 0) bucket.cost += usage.cost;
	bucket.turns += usage.turns;
	a.dirty += 1;
}

/**
 * foldMessageEnd is the money hook: one assistant message = one LLM call that
 * was actually issued and billed.
 *
 * Buckets are keyed on the RESPONSE model where the provider reports one, so an
 * OpenRouter routing change is visible rather than hidden behind the requested
 * id. This is the same per-model-attribution point migration 0131 makes about
 * factory_spend: a single model field on a multi-model run credits everything to
 * whichever model finished.
 */
export function foldMessageEnd(a: RunAccumulator, msg: AssistantMessage, notionalCost: boolean): void {
	const provider = String(msg.provider ?? "");
	const model = String(msg.responseModel ?? msg.model ?? "");
	if (!model) return;
	const usage: Usage | undefined = msg.usage;
	addModelUsage(a, {
		provider,
		model,
		authMode: notionalCost ? "subscription" : "api_key",
		turns: 1,
		input: usage?.input ?? 0,
		output: usage?.output ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		cacheWrite: usage?.cacheWrite ?? 0,
		reasoning: usage?.reasoning,
		// pi computes this client-side from a bundled price table and mutates
		// usage.cost in place before this event fires. For an OAuth provider it
		// is notional, which is exactly what authMode above tells the server.
		cost: usage?.cost?.total ?? 0,
	});
}

function validNestedUsage(usage: NestedUsageModel): boolean {
	return (
		typeof usage.provider === "string" &&
		typeof usage.model === "string" &&
		usage.provider.length > 0 &&
		usage.model.length > 0 &&
		["api_key", "subscription", "unknown"].includes(usage.authMode) &&
		Number.isInteger(usage.turns) && usage.turns > 0 &&
		[usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost]
			.every((value) => Number.isFinite(value) && value >= 0) &&
		(usage.reasoning === undefined || (Number.isFinite(usage.reasoning) && usage.reasoning >= 0))
	);
}

function reconcilesToolUsage(usage: Usage, models: readonly NestedUsageModel[]): boolean {
	if (models.length === 0 || !models.every(validNestedUsage)) return false;
	const totals = models.reduce(
		(sum, model) => ({
			input: sum.input + model.input,
			output: sum.output + model.output,
			cacheRead: sum.cacheRead + model.cacheRead,
			cacheWrite: sum.cacheWrite + model.cacheWrite,
			cost: sum.cost + model.cost,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);
	const sameCost = Math.abs(totals.cost - (usage.cost?.total ?? 0)) <= 1e-9 * Math.max(1, totals.cost);
	return (
		totals.input === (usage.input ?? 0) &&
		totals.output === (usage.output ?? 0) &&
		totals.cacheRead === (usage.cacheRead ?? 0) &&
		totals.cacheWrite === (usage.cacheWrite ?? 0) &&
		sameCost
	);
}

/**
 * foldToolUsage preserves a nested subagent's per-model facts when its narrow
 * metric contract reconciles with the tool aggregate. Old or malformed details
 * stay in the explicit nested/subagent unknown bucket rather than acquiring a
 * plausible identity.
 */
export function foldNestedUsageModels(a: RunAccumulator, models: readonly NestedUsageModel[]): boolean {
	if (models.length === 0 || !models.every(validNestedUsage)) return false;
	for (const model of models) addModelUsage(a, model);
	return true;
}

export function foldToolUsage(
	a: RunAccumulator,
	usage: Usage | undefined,
	usageByModel?: readonly NestedUsageModel[],
): void {
	if (!usage) return;
	if (usageByModel && reconcilesToolUsage(usage, usageByModel)) {
		foldNestedUsageModels(a, usageByModel);
		return;
	}
	addModelUsage(a, {
		provider: "nested",
		model: "subagent",
		authMode: "unknown",
		turns: 1,
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		reasoning: usage.reasoning,
		cost: usage.cost?.total ?? 0,
	});
}

/** Records a tool NAME against its call id. Never the arguments. */
export function foldToolStart(a: RunAccumulator, toolCallId: string, toolName: string): void {
	if (!toolCallId || !toolName) return;
	// An aborted tool may never emit its end event, so this map is bounded and
	// evicts oldest-first rather than growing for the life of the session.
	if (a.pending.size >= MAX_PENDING_TOOLS) {
		const oldest = a.pending.keys().next();
		if (!oldest.done) a.pending.delete(oldest.value);
	}
	a.pending.set(toolCallId, toolName);
}

/**
 * Records a tool's outcome. Never the result.
 *
 * `kind` is an already-classified ToolErrorKind, not a message: the caller
 * classifies at the event boundary so no result text reaches run state. Passing
 * a string here would be a bug of exactly the kind the type prevents.
 */
export function foldToolEnd(
	a: RunAccumulator,
	toolCallId: string,
	toolName: string,
	isError: boolean,
	kind?: ToolErrorKind,
): void {
	const name = toolName || a.pending.get(toolCallId) || "";
	a.pending.delete(toolCallId);
	if (!name) return;

	let bucket = a.tools.get(name);
	if (!bucket) {
		if (a.tools.size >= MAX_TOOLS) return;
		bucket = { calls: 0, errors: 0 };
		a.tools.set(name, bucket);
	}
	bucket.calls += 1;
	a.toolCalls += 1;
	if (isError) {
		bucket.errors += 1;
		a.toolErrors += 1;
		// Created lazily, so a tool that never errored sends no map — see
		// ToolBucket.errorKinds on why absent must differ from all-zero.
		const k = kind ?? "other";
		if (!bucket.errorKinds) bucket.errorKinds = new Map();
		bucket.errorKinds.set(k, (bucket.errorKinds.get(k) ?? 0) + 1);
	}
	a.dirty += 1;
}

export function foldTurnEnd(a: RunAccumulator): void {
	// Counted here rather than from turn_start.turnIndex, which resets to 0 on
	// every agent_start and is therefore a per-run counter, not a session total.
	a.turns += 1;
	a.dirty += 1;
}

/** Bus input is untrusted: clamp the name, cap the cardinality, ignore the rest. */
export function foldGate(a: RunAccumulator, event: HiveGateMetricEvent): void {
	const name = sanitizeName(event.name);
	if (!name) return;

	let bucket = a.gates.get(name);
	if (!bucket) {
		if (a.gates.size >= MAX_GATES) return;
		bucket = { passed: 0, failed: 0, timedOut: 0, skipped: 0, durationMs: 0 };
		a.gates.set(name, bucket);
	}
	switch (event.outcome) {
		case "pass":
			bucket.passed += 1;
			break;
		case "fail":
			bucket.failed += 1;
			break;
		case "timeout":
			bucket.timedOut += 1;
			break;
		case "skip":
			bucket.skipped += 1;
			break;
		default:
			return;
	}
	const ms = event.value;
	if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
		bucket.durationMs += Math.round(ms);
	}
	a.dirty += 1;
}

/**
 * sanitizeName clamps a bus-supplied gate name. A future extension that emits a
 * file path as a gate name must not turn this into a data leak, so anything
 * outside [a-z0-9_.-] becomes an underscore and the result is length-bounded.
 */
export function sanitizeName(raw: string): string {
	if (typeof raw !== "string") return "";
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "_")
		.slice(0, 64);
}

/**
 * Decide the session's recorded outcome from what pi reports and what an
 * extension announced.
 *
 * pi's `session_shutdown` reason says HOW the process stopped — "quit",
 * "reload", "new", "resume", "fork" — and a graceful stop is "quit" whatever
 * caused it. That is fine for a user typing /quit and wrong for everything
 * else: a kill from the Hive agents workspace also shuts down gracefully, so
 * before this it was booked as `completed` and counted as a success in every
 * fleet aggregate.
 *
 * So an ANNOUNCED reason wins. Nothing announces one unless it knows something
 * the shutdown event cannot express, and "the operator stopped this" is a
 * better fact than "the process quit".
 *
 * Pure and exported so the mapping is testable without an extension harness —
 * the wiring in index.ts then has no decision left in it.
 */
export function resolveEndOutcome(announced: string | undefined, shutdownReason: string): string {
	if (announced) return announced;
	return shutdownReason === "quit" ? "completed" : String(shutdownReason);
}

export function markEnded(a: RunAccumulator, outcome: string, nowMs: number): void {
	a.status = "ended";
	a.outcome = outcome.slice(0, 32);
	a.endedAtMs = nowMs;
	a.dirty += 1;
}

/**
 * Record a pi `session_compact`. Fired only AFTER a compaction completes, so
 * every call is a real compaction — there is no aborted case to filter at this
 * layer.
 */
export function recordCompaction(
	a: RunAccumulator,
	reason: "manual" | "threshold" | "overflow",
	tokensBefore?: number,
): void {
	a.compactions += 1;
	if (reason === "overflow") a.compactionOverflows += 1;
	if (typeof tokensBefore === "number" && tokensBefore > 0) {
		a.compactionTokensBefore = (a.compactionTokensBefore ?? 0) + tokensBefore;
	}
	a.dirty += 1;
}
