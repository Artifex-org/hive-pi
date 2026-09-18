/**
 * typesafe-common — the typed client for the TypeSafe ("Jev") System One API.
 *
 * Jev is a classifier, not a model you converse with. You hand it a state and
 * one or more QUESTIONS and it hands back structured answers. Measured against
 * jev-1.13.0 from this workstation on 2026-09-18; every number quoted below is
 * from that run, not from the vendor's page.
 *
 * ## The one fact this file exists to encode
 *
 * A `noul` answer has EXACTLY two keys: `type` and `noul`. There is no
 * `confidence` and no `probabilities`. That is a trap with a perfect disguise:
 * a decoder that reads `.confidence` off a noul gets `undefined`, every
 * threshold comparison against it is false, the caller reads "uncertain", the
 * deterministic fallback fires 100% of the time — and nothing anywhere looks
 * broken. So `NoulAnswer` carries `confidence?: never`, which makes
 * `answer.confidence > 0.7` a TYPE ERROR rather than a silent always-false, and
 * `certaintyOf` is the only sanctioned way to ask "how sure was it": for a noul
 * the signal is `|noul - 0.5| * 2`.
 *
 * ## Second tier, advisory, never a gate
 *
 * Nothing here suppresses, closes, merges, deletes or kills. The outcome union
 * is built so a caller CANNOT accidentally treat an error as an answer, and so
 * that "Jev was never called" is a distinguishable state — see `liveness.ts`
 * and HIV-712, where 48 fallback log lines were all present and nobody read
 * them.
 *
 * ## `malformed` is an error, not an answer
 *
 * An HTTP 200 whose body has no `answers` map, is missing the question key,
 * answers a different type than was asked, or names a choice outside the
 * criteria we supplied is `malformed` — counted separately from timeout,
 * rate_limited and disabled. This house has been bitten three times by
 * success-shaped nothing; folding it into "no answer" would be the fourth.
 *
 * ## Keep-alive
 *
 * The 299ms median is a WARM number and only exists on a reused connection;
 * cold including TLS is 1.4–2.1s. Node's global `fetch` (undici) pools per
 * origin and keeps connections alive by default, so reusing ONE client instance
 * is what buys it — but undici's idle timeout is a few seconds, so a caller
 * that asks once a minute pays the cold cost every time and should expect
 * ~2s, not ~0.3s. This cannot be asserted in a unit test (it is a property of a
 * real socket), so it is written down here instead of pretended about.
 */

import { classify, parseRetryAfterMs, redact, withTimeout } from "../hive-common/http.ts";
import type { TypesafeConfig } from "./config.ts";

/** What `state` and `instructions` accept, per the measured request shape. */
export type JevState = string | Record<string, unknown> | readonly unknown[];

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface ChoiceQuestion {
	readonly type: "choice";
	readonly instructions: JevState;
	/** A MAP of optionKey -> description. Order is not meaningful. */
	readonly criteria: Readonly<Record<string, string>>;
}

export interface ScoreQuestion {
	readonly type: "score";
	readonly instructions: JevState;
	/** An ORDERED ARRAY of level descriptions, at least two. */
	readonly criteria: readonly string[];
}

export interface NoulQuestion {
	readonly type: "noul";
	readonly instructions: JevState;
	readonly criteria?: { readonly true: string; readonly false: string };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/**
 * Hard server limit, measured: a choice with 256 options comes back HTTP 400
 * `{"detail":"Too many choices. Must have at most 255 choices."}`. Refused
 * client-side so the caller gets a typed `rejected` instead of paying a round
 * trip to be told something we already knew.
 */
export const MAX_CHOICE_OPTIONS = 255;

/**
 * Observed practical ceiling on the criteria block, in estimated tokens.
 *
 * THE TOKEN BUDGET BINDS FIRST, and by a wide margin — which is why refusing
 * only at 255 options would be a guard that never fires in practice. The total
 * context is 64k with 32k reserved for state, so criteria share what is left
 * with instructions and the answer; at a realistic ~30 tokens per option
 * description the wall arrives around 100 options, not 255. Past that, the
 * measured behaviour is not an error but something worse: "large irrelevant
 * state degrades answers badly", i.e. the call succeeds and is wrong.
 */
export const MAX_CRITERIA_TOKENS = 3_000;

/** Documented state ceiling: 32k of the 64k total context. */
export const MAX_STATE_TOKENS = 32_000;

/**
 * Four characters per token. A heuristic, and deliberately a cheap one: the
 * server's 422 is the real authority and this only has to fire EARLY enough to
 * turn a wasted round trip into a typed refusal. Erring low would defeat that,
 * so callers near the line should shrink their criteria rather than tune this.
 */
export function estimateTokens(value: JevState): number {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.ceil((text?.length ?? 0) / 4);
}

export function choiceQuestion(instructions: JevState, criteria: Record<string, string>): ChoiceQuestion {
	return { type: "choice", instructions, criteria };
}

export function scoreQuestion(instructions: JevState, criteria: readonly string[]): ScoreQuestion {
	return { type: "score", instructions, criteria };
}

export function noulQuestion(
	instructions: JevState,
	criteria?: { true: string; false: string },
): NoulQuestion {
	return criteria === undefined ? { type: "noul", instructions } : { type: "noul", instructions, criteria };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface ChoiceAnswer {
	readonly type: "choice";
	readonly choice: string;
	readonly confidence: number;
	readonly probabilities: Readonly<Record<string, number>>;
}

export interface ScoreAnswer {
	readonly type: "score";
	readonly score: number;
	readonly confidence: number;
	readonly legend?: Readonly<Record<string, string>>;
	readonly probabilities?: Readonly<Record<string, number>>;
}

export interface NoulAnswer {
	readonly type: "noul";
	/** 0..1. The ONLY numeric field a noul carries. */
	readonly noul: number;
	/**
	 * A tripwire, not a field. The wire format has no `confidence` on a noul;
	 * typing it `never` turns the mistake that reads it into a compile error
	 * instead of a comparison that is silently always false. Do not "fix" this
	 * by widening it — use `certaintyOf`.
	 */
	readonly confidence?: never;
	readonly probabilities?: never;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerFor<Q extends Question> = Q["type"] extends "choice"
	? ChoiceAnswer
	: Q["type"] extends "score"
		? ScoreAnswer
		: NoulAnswer;

export type AnswersFor<QS extends Record<string, Question>> = { [K in keyof QS]: AnswerFor<QS[K]> };

/**
 * How sure the classifier was, on one 0..1 scale, whatever the question type.
 *
 * For choice and score that is the reported `confidence`. For a noul there is
 * no such field and there never was: 0.5 is maximal ignorance and both ends are
 * certainty, so the signal is `|noul - 0.5| * 2`. Callers must go through here.
 * A threshold read off `.confidence` would be `undefined > 0.7` — false for
 * every noul the API has ever returned, which is a fallback that fires 100% of
 * the time while looking exactly like a classifier that works.
 */
export function certaintyOf(answer: Answer): number {
	if (answer.type === "noul") return Math.abs(answer.noul - 0.5) * 2;
	return answer.confidence;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export interface JevUsage {
	inputTokens: number;
	outputTokens: number;
}

/**
 * Every way a call can end, as one closed union.
 *
 * `kind` is the liveness surface. A seam that records only "used Jev / used the
 * heuristic" cannot tell a classifier that agreed from a classifier that was
 * never reached — the HIV-712 shape. `liveness.ts` tallies these kinds so the
 * difference is visible without reading a log.
 */
export type Outcome<T> =
	| { kind: "ok"; answers: T; usage: JevUsage; latencyMs: number; model: string }
	/** Never reached the network, and deliberately so. */
	| { kind: "disabled"; reason: "config" | "no_key" }
	/** Refused before the network, or refused permanently by the server (4xx). */
	| { kind: "rejected"; reason: string; status?: number }
	/** HTTP 200 carrying nothing usable. An ERROR, never an answer. */
	| { kind: "malformed"; reason: string; latencyMs: number }
	| { kind: "timeout"; timeoutMs: number }
	| { kind: "rate_limited"; status: number; retryAfterMs: number | null }
	| { kind: "auth_failed"; status: number }
	| { kind: "transport_error"; error: string };

export type OutcomeKind = Outcome<unknown>["kind"];

export const OUTCOME_KINDS: readonly OutcomeKind[] = [
	"ok",
	"disabled",
	"rejected",
	"malformed",
	"timeout",
	"rate_limited",
	"auth_failed",
	"transport_error",
];

// ---------------------------------------------------------------------------
// Validation and decoding
// ---------------------------------------------------------------------------

/** Client-side refusal, or null when the request is worth sending. */
export function validateRequest(state: JevState, questions: Record<string, Question>): string | null {
	const keys = Object.keys(questions);
	if (keys.length === 0) return "no questions";
	if (estimateTokens(state) > MAX_STATE_TOKENS) return `state exceeds ${MAX_STATE_TOKENS} tokens`;

	for (const key of keys) {
		const q = questions[key];
		if (q.type === "choice") {
			const options = Object.keys(q.criteria);
			if (options.length < 2) return `choice "${key}" needs at least 2 options`;
			if (options.length > MAX_CHOICE_OPTIONS) {
				return `choice "${key}" has ${options.length} options; the server accepts at most ${MAX_CHOICE_OPTIONS}`;
			}
		} else if (q.type === "score" && q.criteria.length < 2) {
			return `score "${key}" needs at least 2 ordered levels`;
		}
		const criteriaTokens = q.criteria === undefined ? 0 : estimateTokens(q.criteria as JevState);
		if (criteriaTokens > MAX_CRITERIA_TOKENS) {
			return `criteria for "${key}" is ~${criteriaTokens} tokens; the observed ceiling is ${MAX_CRITERIA_TOKENS}`;
		}
	}
	return null;
}

export function buildRequestBody(
	state: JevState,
	questions: Record<string, Question>,
	model: string,
): Record<string, unknown> {
	const wire: Record<string, unknown> = {};
	for (const [key, q] of Object.entries(questions)) {
		wire[key] =
			q.criteria === undefined
				? { type: q.type, instructions: q.instructions }
				: { type: q.type, instructions: q.instructions, criteria: q.criteria };
	}
	return { state, model, questions: wire };
}

type DecodeResult = { ok: true; answer: Answer } | { ok: false; reason: string };

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * One answer, checked against the question that was ASKED.
 *
 * The asked question is the authority for two checks that a shape-only decoder
 * would miss and that are exactly the "success-shaped nothing" cases: a choice
 * key the server invented (not in the criteria we supplied), and an answer
 * whose `type` is not the type of the question under that key.
 */
export function decodeAnswer(asked: Question, raw: unknown): DecodeResult {
	if (!raw || typeof raw !== "object") return { ok: false, reason: "answer is not an object" };
	const body = raw as Record<string, unknown>;
	if (body.type !== asked.type) {
		return { ok: false, reason: `answered "${String(body.type)}" for a ${asked.type} question` };
	}

	if (asked.type === "choice") {
		const choice = body.choice;
		if (typeof choice !== "string") return { ok: false, reason: "choice is not a string" };
		if (!Object.prototype.hasOwnProperty.call(asked.criteria, choice)) {
			return { ok: false, reason: `choice "${choice}" is not one of the supplied criteria` };
		}
		// A missing confidence is malformed, NOT zero. Defaulting it would
		// recreate the noul trap on the one question type that does report it.
		if (!finite(body.confidence)) return { ok: false, reason: "choice answer has no numeric confidence" };
		const probabilities =
			body.probabilities && typeof body.probabilities === "object"
				? (body.probabilities as Record<string, number>)
				: {};
		return { ok: true, answer: { type: "choice", choice, confidence: body.confidence, probabilities } };
	}

	if (asked.type === "score") {
		if (!finite(body.score)) return { ok: false, reason: "score is not a finite number" };
		const top = asked.criteria.length - 1;
		if (body.score < 0 || body.score > top) {
			return { ok: false, reason: `score ${body.score} is outside the 0..${top} levels supplied` };
		}
		if (!finite(body.confidence)) return { ok: false, reason: "score answer has no numeric confidence" };
		const answer: ScoreAnswer = {
			type: "score",
			score: body.score,
			confidence: body.confidence,
			...(body.legend && typeof body.legend === "object" ? { legend: body.legend as Record<string, string> } : {}),
			...(body.probabilities && typeof body.probabilities === "object"
				? { probabilities: body.probabilities as Record<string, number> }
				: {}),
		};
		return { ok: true, answer };
	}

	// noul. Two keys, and we check the only one that carries information. There
	// is deliberately NO confidence check here: demanding a field the API does
	// not send would make every real noul malformed.
	if (!finite(body.noul)) return { ok: false, reason: "noul is not a finite number" };
	if (body.noul < 0 || body.noul > 1) return { ok: false, reason: `noul ${body.noul} is outside 0..1` };
	return { ok: true, answer: { type: "noul", noul: body.noul } };
}

export interface DecodedEnvelope {
	answers: Record<string, Answer>;
	usage: JevUsage;
	model: string;
}

/** The whole 200 body. Any shortfall is `malformed`, with the reason kept. */
export function decodeEnvelope(
	body: unknown,
	questions: Record<string, Question>,
): { ok: true; value: DecodedEnvelope } | { ok: false; reason: string } {
	if (!body || typeof body !== "object") return { ok: false, reason: "body is not an object" };
	const env = body as Record<string, unknown>;
	const rawAnswers = env.answers;
	// The canonical success-shaped nothing: 200, well-formed JSON, no answers.
	if (!rawAnswers || typeof rawAnswers !== "object") return { ok: false, reason: "no answers map" };

	const answers: Record<string, Answer> = {};
	for (const [key, asked] of Object.entries(questions)) {
		const raw = (rawAnswers as Record<string, unknown>)[key];
		if (raw === undefined) return { ok: false, reason: `no answer for question "${key}"` };
		const decoded = decodeAnswer(asked, raw);
		if (!decoded.ok) return { ok: false, reason: `question "${key}": ${decoded.reason}` };
		answers[key] = decoded.answer;
	}

	const usage = env.usage && typeof env.usage === "object" ? (env.usage as Record<string, unknown>) : {};
	return {
		ok: true,
		value: {
			answers,
			usage: {
				inputTokens: finite(usage.input_tokens) ? usage.input_tokens : 0,
				outputTokens: finite(usage.output_tokens) ? usage.output_tokens : 0,
			},
			model: typeof env.model === "string" ? env.model : "unknown",
		},
	};
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TypesafeClientOptions {
	config: TypesafeConfig;
	/** Read once, by the caller, outside any event handler. Null is a supported state. */
	apiKey: string | null;
	/** Injected so the tests never depend on a socket. Default: global fetch. */
	fetchImpl?: FetchLike;
	now?: () => number;
}

export class TypesafeClient {
	private readonly config: TypesafeConfig;
	private readonly apiKey: string | null;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;

	constructor(options: TypesafeClientOptions) {
		this.config = options.config;
		this.apiKey = options.apiKey;
		// Bound to globalThis rather than captured bare: an unbound `fetch`
		// throws "Illegal invocation" on some hosts.
		this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
		this.now = options.now ?? (() => Date.now());
	}

	/** True when a call would reach the network. The liveness question, answered cheaply. */
	get live(): boolean {
		return this.config.enabled && this.apiKey !== null;
	}

	async ask<QS extends Record<string, Question>>(
		state: JevState,
		questions: QS,
	): Promise<Outcome<AnswersFor<QS>>> {
		if (!this.config.enabled) return { kind: "disabled", reason: "config" };
		if (!this.apiKey) return { kind: "disabled", reason: "no_key" };

		const refusal = validateRequest(state, questions);
		if (refusal) return { kind: "rejected", reason: refusal };

		const started = this.now();
		let res: Response;
		try {
			res = await withTimeout(this.config.timeoutMs, (signal) =>
				this.fetchImpl(this.config.endpoint, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify(buildRequestBody(state, questions, this.config.model)),
					signal,
				}),
			);
		} catch (err) {
			// `redact` because a fetch error can embed the request URL, and a URL
			// can carry a token. It maps AbortError to "timeout", which is the
			// only way we learn the deadline fired.
			const error = redact(err);
			return error === "timeout"
				? { kind: "timeout", timeoutMs: this.config.timeoutMs }
				: { kind: "transport_error", error };
		}

		if (!res.ok) return this.failure(res);

		let body: unknown;
		try {
			body = await res.json();
		} catch {
			// A 200 that is not JSON is success-shaped nothing, same as a 200
			// with no answers map. It is NOT a transport error: the round trip
			// worked and we were billed for it.
			return { kind: "malformed", reason: "200 body is not JSON", latencyMs: this.now() - started };
		}

		const decoded = decodeEnvelope(body, questions);
		if (!decoded.ok) return { kind: "malformed", reason: decoded.reason, latencyMs: this.now() - started };
		return {
			kind: "ok",
			answers: decoded.value.answers as AnswersFor<QS>,
			usage: decoded.value.usage,
			model: decoded.value.model,
			latencyMs: this.now() - started,
		};
	}

	/**
	 * A non-2xx, classified with `hive-common/http.ts`'s own rules so this
	 * client and every Hive-facing one agree about what is retryable.
	 *
	 * 529 ("overloaded") is NOT in `classify`'s 4xx range and is not an auth or
	 * rate-limit status, so it lands in `transport_error` — correct, because it
	 * is the one server status that means "ask again later" without telling us
	 * when. Folding it into `rate_limited` would imply a Retry-After that is
	 * not there.
	 */
	private failure<T>(res: Response): Outcome<T> {
		const { authFailed, permanent } = classify(res.status);
		if (authFailed) return { kind: "auth_failed", status: res.status };
		if (res.status === 429) {
			return { kind: "rate_limited", status: 429, retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")) };
		}
		if (permanent) return { kind: "rejected", reason: `server refused with ${res.status}`, status: res.status };
		return { kind: "transport_error", error: `status ${res.status}` };
	}
}
