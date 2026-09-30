/**
 * typesafe-common/client — the decisions made before and after the round trip.
 *
 * The round trip itself is not exercised against the real API here, for the
 * same reason `test/compaction.test.ts` gives: doing so means sending data to a
 * third party, which is the exact act the `enabled === true` gate exists to
 * hold. What IS covered is every way a call can end, because those are the
 * cases that decide whether a silent wrong answer is possible.
 *
 * Each test below is written to FAIL if the behaviour regresses, not to restate
 * the implementation. The two that matter most:
 *
 *   - "certainty does not come from a confidence field" fails the moment anyone
 *     reads `.confidence` off a noul, which is the bug that makes a fallback
 *     fire 100% of the time while looking like a classifier that works.
 *   - "a 200 with no answers map is malformed" fails the moment success-shaped
 *     nothing is folded into "no answer".
 */

import { describe, expect, it, vi } from "vitest";

import {
	ACCOUNT_TRIP_MS,
	MAX_CHOICE_OPTIONS,
	OUTCOME_KINDS,
	RouteBreaker,
	TRANSIENT_TRIP_MS,
	TypesafeClient,
	failureClass,
	certaintyOf,
	choiceQuestion,
	decodeAnswer,
	decodeEnvelope,
	estimateTokens,
	noulQuestion,
	scoreQuestion,
	validateRequest,
	type Answer,
	type FetchLike,
	type NoulAnswer,
} from "../extensions/typesafe-common/client.ts";
import {
	DEFAULT_ENDPOINT,
	DEFAULT_MODEL,
	DEFAULT_OPENROUTER_ENDPOINT,
	JEV_ROUTES_ENV,
	configFrom,
	type JevRoute,
} from "../extensions/typesafe-common/config.ts";
import { formatTally, newTally, record, totalCalls } from "../extensions/typesafe-common/liveness.ts";

const ON = configFrom({ enabled: true, timeoutMs: 1_000 });

/** RouteMeta for a hand-built outcome: served by the primary, or tried no route. */
const VIA_TYPESAFE = { route: "typesafe", failover: false } as const;
const NO_ROUTE = { route: null, failover: false } as const;

/** A fetch that records its calls and returns whatever is handed to it. */
function fakeFetch(respond: () => Response | Promise<Response>): FetchLike & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	const impl = (async (input: string, init: RequestInit) => {
		calls.push([input, init]);
		return respond();
	}) as FetchLike & { calls: unknown[][] };
	impl.calls = calls;
	return impl;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

const NOUL_Q = noulQuestion("is this urgent?", { true: "urgent", false: "not urgent" });
const CHOICE_Q = choiceQuestion("pick one", { alpha: "the first", beta: "the second" });

describe("noul certainty — the single most important fact in this package", () => {
	// MEASURED: a noul answer carries EXACTLY {"type","noul"}. No confidence,
	// no probabilities. This test dies if anyone adds one.
	it("a decoded noul has no confidence and no probabilities field at all", () => {
		const decoded = decodeAnswer(NOUL_Q, { type: "noul", noul: 0.93 });
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(Object.keys(decoded.answer).sort()).toEqual(["noul", "type"]);
		expect("confidence" in decoded.answer).toBe(false);
	});

	it("certainty is |noul - 0.5| * 2, and is NOT a confidence field", () => {
		const sure: NoulAnswer = { type: "noul", noul: 0.95 };
		const surelyNot: NoulAnswer = { type: "noul", noul: 0.05 };
		const ignorant: NoulAnswer = { type: "noul", noul: 0.5 };
		expect(certaintyOf(sure)).toBeCloseTo(0.9, 10);
		// Both ENDS are certainty. A "confidence" reading would have to invent
		// this, and a naive one gets it backwards for a confident false.
		expect(certaintyOf(surelyNot)).toBeCloseTo(0.9, 10);
		expect(certaintyOf(ignorant)).toBe(0);
	});

	it("reproduces the exact bug this guards against, and proves they differ", () => {
		// THE BUG: `.confidence ?? 0` on a noul. Every threshold then reads
		// "uncertain", the deterministic fallback fires on 100% of calls, and
		// nothing in any log looks wrong (HIV-712). The assertion is that the
		// sanctioned accessor and the bug do not agree — if someone "simplifies"
		// certaintyOf into a confidence read, this line fails.
		const answer: Answer = { type: "noul", noul: 0.95 };
		const buggy = (a: Answer) => (a as { confidence?: number }).confidence ?? 0;
		expect(buggy(answer)).toBe(0);
		expect(certaintyOf(answer)).toBeGreaterThan(0.7);
	});

	it("still reads confidence for the two types that actually send it", () => {
		expect(certaintyOf({ type: "choice", choice: "alpha", confidence: 0.91, probabilities: {} })).toBe(0.91);
		expect(certaintyOf({ type: "score", score: 2, confidence: 0.4 })).toBe(0.4);
	});
});

describe("decodeEnvelope — success-shaped nothing is an ERROR", () => {
	it("a 200 with an absent answers map is malformed, not an empty answer", () => {
		const result = decodeEnvelope({ model: "jev-1.13.0", usage: {} }, { q: NOUL_Q });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("no answers map");
	});

	it("a missing question key is malformed", () => {
		const result = decodeEnvelope({ answers: { other: { type: "noul", noul: 0.5 } } }, { q: NOUL_Q });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('no answer for question "q"');
	});

	it("a choice outside the supplied criteria is malformed", () => {
		// The server naming an option we never offered is the case a shape-only
		// decoder waves through — and it would then be routed to.
		const result = decodeEnvelope(
			{ answers: { q: { type: "choice", choice: "gamma", confidence: 0.9, probabilities: {} } } },
			{ q: CHOICE_Q },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("not one of the supplied criteria");
	});

	it("an answer of the wrong type is malformed", () => {
		const result = decodeEnvelope({ answers: { q: { type: "noul", noul: 0.9 } } }, { q: CHOICE_Q });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("answered \"noul\" for a choice question");
	});

	it("a choice with no numeric confidence is malformed rather than confidence 0", () => {
		// Defaulting it would recreate the noul trap on the one type that does
		// report confidence: every threshold false, forever, silently.
		const result = decodeEnvelope(
			{ answers: { q: { type: "choice", choice: "alpha", probabilities: {} } } },
			{ q: CHOICE_Q },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("no numeric confidence");
	});

	it("a noul outside 0..1 and a score outside its levels are malformed", () => {
		expect(decodeEnvelope({ answers: { q: { type: "noul", noul: 1.4 } } }, { q: NOUL_Q }).ok).toBe(false);
		const score = scoreQuestion("how bad", ["fine", "bad", "terrible"]);
		expect(
			decodeEnvelope({ answers: { q: { type: "score", score: 7, confidence: 0.9 } } }, { q: score }).ok,
		).toBe(false);
	});

	it("accepts the measured wire shapes verbatim", () => {
		const questions = { c: CHOICE_Q, s: scoreQuestion("how bad", ["fine", "bad"]), n: NOUL_Q };
		const result = decodeEnvelope(
			{
				model: "jev-1.13.0",
				answers: {
					c: { type: "choice", choice: "beta", confidence: 0.91, probabilities: { alpha: 0.09, beta: 0.91 } },
					s: { type: "score", score: 0.4, confidence: 0.8, legend: { "0": "fine", "1": "bad" }, probabilities: { "0": 0.6 } },
					n: { type: "noul", noul: 0.9 },
				},
				usage: { input_tokens: 120, output_tokens: 8 },
			},
			questions,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
		expect(result.value.model).toBe("jev-1.13.0");
		expect(certaintyOf(result.value.answers.n)).toBeCloseTo(0.8, 10);
	});
});

describe("client-side refusal", () => {
	it("refuses a choice with more than 255 options WITHOUT a round trip", () => {
		const criteria: Record<string, string> = {};
		for (let i = 0; i <= MAX_CHOICE_OPTIONS; i++) criteria[`opt${i}`] = "x";
		expect(Object.keys(criteria)).toHaveLength(MAX_CHOICE_OPTIONS + 1);
		const refusal = validateRequest("q", { q: choiceQuestion("pick", criteria) });
		expect(refusal).toContain("at most 255");
	});

	it("the refusal is client-side: the network is never touched", async () => {
		// The discriminating assertion. The server answers 256 options with an
		// HTTP 400; a client that learned that by asking has not implemented the
		// refusal, it has implemented a round trip.
		const criteria: Record<string, string> = {};
		for (let i = 0; i <= MAX_CHOICE_OPTIONS; i++) criteria[`opt${i}`] = "x";
		const impl = fakeFetch(() => jsonResponse({}));
		const client = new TypesafeClient({ config: ON, apiKey: "sk-test", fetchImpl: impl });
		const outcome = await client.ask("q", { q: choiceQuestion("pick", criteria) });
		expect(outcome.kind).toBe("rejected");
		expect(impl.calls).toHaveLength(0);
	});

	it("refuses criteria over the observed token ceiling before the option cap bites", () => {
		// The token budget binds FIRST: 60 options of ~55 tokens each is well
		// under 255 options and well over 3000 tokens. A guard that only checked
		// the option count would never fire here.
		const criteria: Record<string, string> = {};
		for (let i = 0; i < 60; i++) criteria[`opt${i}`] = "a description long enough to matter ".repeat(6);
		expect(Object.keys(criteria).length).toBeLessThan(MAX_CHOICE_OPTIONS);
		expect(estimateTokens(criteria)).toBeGreaterThan(3_000);
		expect(validateRequest("q", { q: choiceQuestion("pick", criteria) })).toContain("observed ceiling");
	});

	it("refuses a choice with fewer than two options and a score with fewer than two levels", () => {
		expect(validateRequest("q", { q: choiceQuestion("pick", { only: "one" }) })).toContain("at least 2 options");
		expect(validateRequest("q", { q: scoreQuestion("how bad", ["only"]) })).toContain("at least 2 ordered levels");
	});
});

describe("the enabled gate", () => {
	it("defaults to false when config is absent — an absent config is a SUPPORTED state", () => {
		expect(configFrom(null).enabled).toBe(false);
		expect(configFrom(undefined).enabled).toBe(false);
		expect(configFrom({}).enabled).toBe(false);
	});

	it("is `=== true`, so a truthy non-boolean does not switch it on", () => {
		// This is the whole difference between `=== true` and `!== false`, and
		// the reason compaction/index.ts:50-60 spells it out. A config written
		// by hand with "true" as a string must NOT send anything anywhere.
		expect(configFrom({ enabled: "true" }).enabled).toBe(false);
		expect(configFrom({ enabled: 1 }).enabled).toBe(false);
		expect(configFrom({ enabled: {} }).enabled).toBe(false);
		expect(configFrom({ enabled: true }).enabled).toBe(true);
	});

	it("fills every other field, so nothing downstream has to cope with undefined", () => {
		const cfg = configFrom(null);
		expect(cfg.endpoint).toBe(DEFAULT_ENDPOINT);
		expect(cfg.model).toBe(DEFAULT_MODEL);
		expect(cfg.timeoutMs).toBeGreaterThan(0);
		// A non-https endpoint is ignored rather than honoured: this client
		// carries a bearer token.
		expect(configFrom({ endpoint: "http://evil.example" }).endpoint).toBe(DEFAULT_ENDPOINT);
	});

	it("a disabled client never touches the network, even with a key in hand", async () => {
		const impl = fakeFetch(() => jsonResponse({}));
		const client = new TypesafeClient({ config: configFrom({}), apiKey: "sk-test", fetchImpl: impl });
		const outcome = await client.ask("q", { q: NOUL_Q });
		expect(outcome).toEqual({ kind: "disabled", reason: "config", ...NO_ROUTE });
		expect(impl.calls).toHaveLength(0);
		expect(client.live).toBe(false);
	});

	it("an enabled client with no key is disabled for a DIFFERENT reason, and says so", async () => {
		// "no_key" and "config" must not collapse into one state: the operator
		// fixes them in different places.
		const impl = fakeFetch(() => jsonResponse({}));
		const client = new TypesafeClient({ config: ON, apiKey: null, fetchImpl: impl });
		expect(await client.ask("q", { q: NOUL_Q })).toEqual({ kind: "disabled", reason: "no_key", ...NO_ROUTE });
		expect(impl.calls).toHaveLength(0);
	});
});

describe("outcome classification", () => {
	const ask = async (respond: () => Response | Promise<Response>) => {
		const client = new TypesafeClient({ config: ON, apiKey: "sk-test", fetchImpl: fakeFetch(respond) });
		return client.ask("q", { q: NOUL_Q });
	};

	it("200 with a usable answer is ok, and carries usage", async () => {
		const outcome = await ask(() =>
			jsonResponse({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 50, output_tokens: 3 } }),
		);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") return;
		expect(outcome.usage.inputTokens).toBe(50);
		expect(certaintyOf(outcome.answers.q)).toBeCloseTo(0.8, 10);
	});

	it("200 with no answers map is malformed — counted apart from every failure", async () => {
		const outcome = await ask(() => jsonResponse({ model: "jev-1.13.0", usage: {} }));
		expect(outcome.kind).toBe("malformed");
	});

	it("200 that is not JSON is malformed, NOT a transport error", async () => {
		// The round trip worked and we were billed for it. Calling that a
		// transport error would hide a server-side change behind "the network".
		const outcome = await ask(() => new Response("<html>nope", { status: 200 }));
		expect(outcome.kind).toBe("malformed");
	});

	it("401 is auth_failed, 429 is rate_limited with the Retry-After honoured", async () => {
		expect((await ask(() => new Response("", { status: 401 }))).kind).toBe("auth_failed");
		const limited = await ask(() => new Response("", { status: 429, headers: { "retry-after": "30" } }));
		expect(limited.kind).toBe("rate_limited");
		if (limited.kind === "rate_limited") expect(limited.retryAfterMs).toBe(30_000);
	});

	it("a 4xx validation refusal is `rejected`, never `malformed`", async () => {
		// 422 means the request was wrong. Folding it into malformed would make
		// "our bug" and "their bug" the same counter.
		const outcome = await ask(() => new Response("", { status: 422 }));
		expect(outcome.kind).toBe("rejected");
	});

	it("529 overloaded is a transport error — retryable, with no Retry-After to honour", async () => {
		expect((await ask(() => new Response("", { status: 529 }))).kind).toBe("transport_error");
	});

	it("an aborted request is a timeout, distinguishable from any other failure", async () => {
		const client = new TypesafeClient({
			config: configFrom({ enabled: true, timeoutMs: 250 }),
			apiKey: "sk-test",
			fetchImpl: (_input, init) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						const err = new Error("aborted");
						err.name = "AbortError";
						reject(err);
					});
				}),
		});
		expect((await client.ask("q", { q: NOUL_Q })).kind).toBe("timeout");
	});

	it("sends the measured request shape: bearer auth, json, model and questions", async () => {
		const impl = fakeFetch(() => jsonResponse({ answers: { q: { type: "noul", noul: 0.5 } } }));
		const client = new TypesafeClient({ config: ON, apiKey: "sk-test", fetchImpl: impl });
		await client.ask({ ticket: "HIV-1" }, { q: NOUL_Q });
		const [url, init] = impl.calls[0] as [string, RequestInit];
		expect(url).toBe(DEFAULT_ENDPOINT);
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
		const body = JSON.parse(String(init.body)) as { model: string; state: unknown; questions: Record<string, unknown> };
		expect(body.model).toBe(DEFAULT_MODEL);
		expect(body.state).toEqual({ ticket: "HIV-1" });
		expect(body.questions.q).toEqual({ type: "noul", instructions: "is this urgent?", criteria: { true: "urgent", false: "not urgent" } });
	});

	it("omits criteria entirely when a noul question has none", async () => {
		const impl = fakeFetch(() => jsonResponse({ answers: { q: { type: "noul", noul: 0.5 } } }));
		const client = new TypesafeClient({ config: ON, apiKey: "sk-test", fetchImpl: impl });
		await client.ask("state", { q: noulQuestion("urgent?") });
		const body = JSON.parse(String((impl.calls[0] as [string, RequestInit])[1].body)) as {
			questions: { q: Record<string, unknown> };
		};
		expect("criteria" in body.questions.q).toBe(false);
	});
});

describe("liveness — telling 'agreed' apart from 'never called'", () => {
	it("an untouched tally says so, rather than reporting a clean zero", () => {
		// HIV-712: the shape that hid a dead feature for weeks was a report that
		// looked fine because nothing had failed — because nothing had run.
		const tally = newTally();
		expect(totalCalls(tally)).toBe(0);
		expect(formatTally(tally)).toBe("jev: never called");
	});

	it("distinguishes a classifier that agreed from one that was never reached", () => {
		const agreed = newTally();
		for (let i = 0; i < 3; i++) {
			record(agreed, { kind: "ok", answers: {}, usage: { inputTokens: 10, outputTokens: 1 }, latencyMs: 300, model: "jev", ...VIA_TYPESAFE }, true);
		}
		const dead = newTally();
		for (let i = 0; i < 3; i++) record(dead, { kind: "malformed", reason: "no answers map", latencyMs: 300, ...VIA_TYPESAFE });

		expect(formatTally(agreed)).toContain("ok 3/3");
		expect(formatTally(agreed)).toContain("agreed 3");
		expect(formatTally(dead)).toContain("ok 0/3");
		expect(formatTally(dead)).toContain("malformed 3");
		// The load-bearing negative: the two reports are not the same sentence.
		expect(formatTally(agreed)).not.toBe(formatTally(dead));
	});

	it("`ok 0` is printed even when nothing succeeded", () => {
		const tally = newTally();
		record(tally, { kind: "timeout", timeoutMs: 3_000, ...VIA_TYPESAFE });
		expect(formatTally(tally)).toContain("ok 0/1");
	});

	it("counts every outcome kind separately — no bucket absorbs another", () => {
		const tally = newTally();
		record(tally, { kind: "timeout", timeoutMs: 1, ...VIA_TYPESAFE });
		record(tally, { kind: "rate_limited", status: 429, retryAfterMs: null, ...VIA_TYPESAFE });
		record(tally, { kind: "malformed", reason: "x", latencyMs: 1, ...VIA_TYPESAFE });
		record(tally, { kind: "disabled", reason: "config", ...NO_ROUTE });
		expect(tally.counts.timeout).toBe(1);
		expect(tally.counts.rate_limited).toBe(1);
		expect(tally.counts.malformed).toBe(1);
		expect(tally.counts.disabled).toBe(1);
		expect(totalCalls(tally)).toBe(4);
	});
});

describe("the key is a source, not a consent signal", () => {
	it("reads TYPESAFE_API_KEY from the environment it is handed", async () => {
		const { readApiKey, TYPESAFE_API_KEY_ENV } = await import("../extensions/typesafe-common/key.ts");
		expect(readApiKey({ [TYPESAFE_API_KEY_ENV]: "sk-from-env" })).toBe("sk-from-env");
	});

	it("a key alone enables nothing — `enabled` is the only switch", async () => {
		const { readApiKey, TYPESAFE_API_KEY_ENV } = await import("../extensions/typesafe-common/key.ts");
		const key = readApiKey({ [TYPESAFE_API_KEY_ENV]: "sk-present" });
		const impl = fakeFetch(() => jsonResponse({}));
		const client = new TypesafeClient({ config: configFrom({}), apiKey: key, fetchImpl: impl });
		expect(await client.ask("q", { q: NOUL_Q })).toEqual({ kind: "disabled", reason: "config", ...NO_ROUTE });
		expect(impl.calls).toHaveLength(0);
	});

	it("refuses an unresolved shell-form credential reference", async () => {
		// Shared with compaction: a leading `!` or a `$` means the stored value
		// is a COMMAND or an env reference, and handing one to fetch would put a
		// 1Password command line into an Authorization header.
		const { apiKeyFromCredential } = await import("../extensions/hive-common/identity.ts");
		expect(apiKeyFromCredential({ type: "api_key", key: "!op read op://v/typesafe/key" })).toBeNull();
		expect(apiKeyFromCredential({ type: "api_key", key: "${TYPESAFE_API_KEY}" })).toBeNull();
		expect(apiKeyFromCredential({ type: "oauth", access: "ya29" })).toBeNull();
		expect(apiKeyFromCredential({ type: "api_key", key: "sk-literal" })).toBe("sk-literal");
	});
});

describe("this package is not an extension", () => {
	it("has no index.ts, so pi cannot load it as one", async () => {
		// `hive-common` and `mcp-common` follow the same rule, and README.md
		// states why: a directory with an index.ts IS an extension. Adding one
		// here would silently turn a library into loaded code — and this library
		// holds a network client and a credential reader.
		const { existsSync } = await import("node:fs");
		const { dirname, join, resolve } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		expect(existsSync(join(root, "extensions", "typesafe-common", "index.ts"))).toBe(false);
	});

	it("registers nothing with pi — the library changes the agent loop only through a consumer", async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		const { dirname, join, resolve } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "typesafe-common");
		const offenders = readdirSync(dir)
			.filter((f) => f.endsWith(".ts"))
			// Every pi surface that reaches the agent loop, not only event handlers:
			// a registered tool, command, shortcut or flag, an injected message, a
			// persisted entry. The first version grepped `.on(` alone, and a
			// `registerTool` would have walked straight past it.
			.filter((f) =>
				/\.on\s*\(\s*["']|\b(registerTool|registerGuardedTool|registerCommand|registerShortcut|registerFlag|sendMessage|sendUserMessage|appendEntry)\s*\(/.test(
					readFileSync(join(dir, f), "utf8"),
				),
			);
		expect(offenders).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Routes: typesafe.ai primary, OpenRouter fallback
// ---------------------------------------------------------------------------

type Responder = () => Response | Promise<Response>;

/** Two fake servers behind one fetch, dispatched on the endpoint. Records who was dialed. */
function twoServers(typesafe: Responder, openrouter: Responder) {
	const dialed: { route: JevRoute; auth: string }[] = [];
	const impl: FetchLike = async (input, init) => {
		const route: JevRoute = input === DEFAULT_OPENROUTER_ENDPOINT ? "openrouter" : "typesafe";
		expect(input).toBe(route === "openrouter" ? DEFAULT_OPENROUTER_ENDPOINT : DEFAULT_ENDPOINT);
		dialed.push({ route, auth: (init.headers as Record<string, string>).Authorization });
		return route === "openrouter" ? openrouter() : typesafe();
	};
	const count = (route: JevRoute) => dialed.filter((d) => d.route === route).length;
	return { impl, dialed, count };
}

const NOUL_OK = { model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } };
/** OpenRouter's measured shape: a different model spelling, plus id, provider and usage.cost. */
const OPENROUTER_OK = {
	id: "gen-123",
	provider: "TypeSafe",
	model: "typesafe/jev-1.13-20260917",
	answers: { q: { type: "noul", noul: 0.9 } },
	usage: { input_tokens: 376, output_tokens: 0, cost: 0.0000158 },
};

/** A controllable clock, a fresh breaker on it, and a collector for its warnings. */
function harness(config = ON) {
	let t = 1_000_000;
	const warnings: string[] = [];
	const clock = { now: () => t, advance: (ms: number) => (t += ms) };
	const breaker = new RouteBreaker({ now: clock.now, warn: (m) => warnings.push(m) });
	const client = (impl: FetchLike, keys: { typesafe?: string | null; openrouter?: string | null } = {}) =>
		new TypesafeClient({
			config,
			apiKey: keys.typesafe === undefined ? "sk-typesafe" : keys.typesafe,
			openrouterApiKey: keys.openrouter === undefined ? "sk-or" : keys.openrouter,
			fetchImpl: impl,
			now: clock.now,
			breaker,
		});
	return { clock, breaker, warnings, client };
}

function abortError(): Error {
	const err = new Error("aborted");
	err.name = "AbortError";
	return err;
}

describe("route failover: a route-class failure on the primary is answered by openrouter", () => {
	const primaryFailures: [string, Responder][] = [
		["402 payment required", () => new Response("", { status: 402 })],
		["403 forbidden", () => new Response("", { status: 403 })],
		["401 unauthorized", () => new Response("", { status: 401 })],
		["429 rate limited", () => new Response("", { status: 429 })],
		["500 server error", () => new Response("", { status: 500 })],
		["529 overloaded", () => new Response("", { status: 529 })],
		["404 bad endpoint", () => new Response("", { status: 404 })],
		["timeout", () => Promise.reject(abortError())],
		["connection refused", () => Promise.reject(new TypeError("fetch failed"))],
	];

	for (const [label, fail] of primaryFailures) {
		it(`primary ${label} → openrouter answers, route=openrouter, failover=true`, async () => {
			const { client } = harness();
			const servers = twoServers(fail, () => jsonResponse(OPENROUTER_OK));
			const outcome = await client(servers.impl).ask("q", { q: NOUL_Q });
			expect(outcome.kind).toBe("ok");
			expect(outcome.route).toBe("openrouter");
			expect(outcome.failover).toBe(true);
			expect(servers.dialed.map((d) => d.route)).toEqual(["typesafe", "openrouter"]);
			// Each route gets ITS OWN key: the TypeSafe key must never reach OpenRouter.
			expect(servers.dialed.map((d) => d.auth)).toEqual(["Bearer sk-typesafe", "Bearer sk-or"]);
		});
	}

	it("402 is its own outcome kind, not a transport error and not a permanent rejection", async () => {
		const { client } = harness();
		const servers = twoServers(() => new Response("", { status: 402 }), () => new Response("", { status: 402 }));
		const outcome = await client(servers.impl).ask("q", { q: NOUL_Q });
		expect(outcome.kind).toBe("payment_required");
		expect(failureClass(outcome)).toBe("account");
		// The last route tried is the one reported when none answered.
		expect(outcome.route).toBe("openrouter");
	});
});

describe("route failover: a request fault is NOT retried on the other route", () => {
	const requestFaults: [string, Responder, string][] = [
		["400", () => new Response("", { status: 400 }), "rejected"],
		["422", () => new Response("", { status: 422 }), "rejected"],
		["malformed 200", () => jsonResponse({ model: "jev-1.13.0", usage: {} }), "malformed"],
	];
	for (const [label, fault, kind] of requestFaults) {
		it(`primary ${label} → no call to openrouter`, async () => {
			const { client } = harness();
			const servers = twoServers(fault, () => jsonResponse(OPENROUTER_OK));
			const c = client(servers.impl);
			const outcome = await c.ask("q", { q: NOUL_Q });
			expect(outcome.kind).toBe(kind);
			expect(outcome.route).toBe("typesafe");
			expect(outcome.failover).toBe(false);
			expect(servers.count("openrouter")).toBe(0);
			// Nor does it open the breaker: the next call still goes to the primary.
			await c.ask("q", { q: NOUL_Q });
			expect(servers.count("typesafe")).toBe(2);
		});
	}

	it("a client-side refusal tries no route at all", async () => {
		const { client } = harness();
		const servers = twoServers(() => jsonResponse(NOUL_OK), () => jsonResponse(OPENROUTER_OK));
		const outcome = await client(servers.impl).ask("q", { q: choiceQuestion("pick", { only: "one" }) });
		expect(outcome).toMatchObject({ kind: "rejected", route: null, failover: false });
		expect(servers.dialed).toHaveLength(0);
	});
});

describe("route breaker", () => {
	it("after a 402 the next call goes straight to openrouter; after 1h the primary is tried again", async () => {
		const { client, clock } = harness();
		let primary: Responder = () => new Response("", { status: 402 });
		const servers = twoServers(() => primary(), () => jsonResponse(OPENROUTER_OK));
		const c = client(servers.impl);

		await c.ask("q", { q: NOUL_Q });
		expect(servers.count("typesafe")).toBe(1);

		const second = await c.ask("q", { q: NOUL_Q });
		expect(second).toMatchObject({ kind: "ok", route: "openrouter", failover: true });
		// The discriminating assertion: the primary saw NO request for this call.
		expect(servers.count("typesafe")).toBe(1);

		clock.advance(ACCOUNT_TRIP_MS - 1);
		await c.ask("q", { q: NOUL_Q });
		expect(servers.count("typesafe")).toBe(1);

		// Credit topped up; the window passes; one call probes and closes it.
		primary = () => jsonResponse(NOUL_OK);
		clock.advance(1);
		const probed = await c.ask("q", { q: NOUL_Q });
		expect(probed).toMatchObject({ kind: "ok", route: "typesafe", failover: false });
		expect(servers.count("typesafe")).toBe(2);
		await c.ask("q", { q: NOUL_Q });
		expect(servers.count("typesafe")).toBe(3);
	});

	it("a probe that fails again re-opens the route", async () => {
		const { client, clock } = harness();
		const servers = twoServers(() => new Response("", { status: 402 }), () => jsonResponse(OPENROUTER_OK));
		const c = client(servers.impl);
		await c.ask("q", { q: NOUL_Q });
		clock.advance(ACCOUNT_TRIP_MS);
		await c.ask("q", { q: NOUL_Q });
		expect(servers.count("typesafe")).toBe(2);
		await c.ask("q", { q: NOUL_Q });
		expect(servers.count("typesafe")).toBe(2);
	});

	it("a transient trip lasts 5 minutes, not an hour", async () => {
		const { client, clock } = harness();
		const servers = twoServers(() => new Response("", { status: 503 }), () => jsonResponse(OPENROUTER_OK));
		const c = client(servers.impl);
		await c.ask("q", { q: NOUL_Q });
		clock.advance(TRANSIENT_TRIP_MS - 1);
		await c.ask("q", { q: NOUL_Q });
		expect(servers.count("typesafe")).toBe(1);
		clock.advance(1);
		await c.ask("q", { q: NOUL_Q });
		expect(servers.count("typesafe")).toBe(2);
	});

	it("with every route open it still tries them all, in configured order", async () => {
		const { client, breaker } = harness();
		const servers = twoServers(() => new Response("", { status: 500 }), () => new Response("", { status: 500 }));
		const c = client(servers.impl);
		await c.ask("q", { q: NOUL_Q });
		expect(breaker.isOpen("typesafe") && breaker.isOpen("openrouter")).toBe(true);
		servers.dialed.length = 0;
		await c.ask("q", { q: NOUL_Q });
		expect(servers.dialed.map((d) => d.route)).toEqual(["typesafe", "openrouter"]);
	});

	it("warns exactly once, on the first ACCOUNT-class trip, naming both routes", async () => {
		const { client, clock, warnings } = harness();
		let status = 503;
		const servers = twoServers(() => new Response("", { status }), () => jsonResponse(OPENROUTER_OK));
		const c = client(servers.impl);
		await c.ask("q", { q: NOUL_Q });
		// Transient trips are routine and do not warn.
		expect(warnings).toEqual([]);
		status = 402;
		clock.advance(TRANSIENT_TRIP_MS);
		await c.ask("q", { q: NOUL_Q });
		clock.advance(ACCOUNT_TRIP_MS);
		await c.ask("q", { q: NOUL_Q });
		expect(warnings).toEqual(["jev: route typesafe tripped (payment_required); using openrouter"]);
	});

	it("never exceeds the call's deadline: a primary that hangs to the deadline gets no fallback attempt", async () => {
		let t = 0;
		const or = vi.fn(() => jsonResponse(OPENROUTER_OK));
		const c = new TypesafeClient({
			config: configFrom({ enabled: true, timeoutMs: 250 }),
			apiKey: "sk-typesafe",
			openrouterApiKey: "sk-or",
			now: () => t,
			breaker: new RouteBreaker({ now: () => t, warn: () => {} }),
			fetchImpl: (input, init) =>
				input === DEFAULT_OPENROUTER_ENDPOINT
					? Promise.resolve(or())
					: new Promise((_resolve, reject) => {
							init.signal?.addEventListener("abort", () => {
								t += 250; // the whole budget went on the primary
								reject(abortError());
							});
						}),
		});
		const first = await c.ask("q", { q: NOUL_Q });
		expect(first).toMatchObject({ kind: "timeout", route: "typesafe", failover: false });
		expect(or).not.toHaveBeenCalled();
		// The breaker is what rescues the NEXT call.
		const second = await c.ask("q", { q: NOUL_Q });
		expect(second).toMatchObject({ kind: "ok", route: "openrouter", failover: true });
	});
});

describe("route configuration", () => {
	it("defaults to typesafe then openrouter, with the documented endpoints", () => {
		const cfg = configFrom(null);
		expect(cfg.routes).toEqual(["typesafe", "openrouter"]);
		expect(cfg.endpoint).toBe(DEFAULT_ENDPOINT);
		expect(cfg.openrouterEndpoint).toBe("https://openrouter.ai/api/v1/systemone");
		expect(cfg.routeError).toBeNull();
	});

	it("the openrouter endpoint is https-only, like the typesafe one", () => {
		expect(configFrom({ openrouterEndpoint: "http://evil.example" }).openrouterEndpoint).toBe(DEFAULT_OPENROUTER_ENDPOINT);
		expect(configFrom({ openrouterEndpoint: "https://proxy.example/systemone" }).openrouterEndpoint).toBe(
			"https://proxy.example/systemone",
		);
	});

	it("reads routes from the file as a list or a comma string, and JEV_ROUTES outranks the file", () => {
		expect(configFrom({ routes: ["openrouter"] }).routes).toEqual(["openrouter"]);
		expect(configFrom({ routes: "openrouter, typesafe" }).routes).toEqual(["openrouter", "typesafe"]);
		expect(configFrom({ routes: ["typesafe"] }, { [JEV_ROUTES_ENV]: "openrouter" }).routes).toEqual(["openrouter"]);
		expect(configFrom({ routes: ["typesafe"] }, { [JEV_ROUTES_ENV]: "" }).routes).toEqual(["typesafe"]);
	});

	it("an unknown, duplicated or empty route list fails CLOSED — disabled, nothing dialed", async () => {
		for (const bad of [["openruoter"], ["typesafe", "typesafe"], [], 42]) {
			const cfg = configFrom({ enabled: true, routes: bad });
			expect(cfg.routeError).not.toBeNull();
			const servers = twoServers(() => jsonResponse(NOUL_OK), () => jsonResponse(OPENROUTER_OK));
			const c = new TypesafeClient({ config: cfg, apiKey: "a", openrouterApiKey: "b", fetchImpl: servers.impl });
			expect(c.live).toBe(false);
			expect(await c.ask("q", { q: NOUL_Q })).toEqual({ kind: "disabled", reason: "bad_routes", ...NO_ROUTE });
			expect(servers.dialed).toHaveLength(0);
		}
		expect(configFrom({ enabled: true }, { [JEV_ROUTES_ENV]: "typesafe,bogus" }).routeError).toContain("bogus");
	});

	it("routes=openrouter only: the typesafe server is never dialed, even with its key present", async () => {
		const { client } = harness(configFrom({ enabled: true, routes: ["openrouter"] }));
		const servers = twoServers(() => jsonResponse(NOUL_OK), () => new Response("", { status: 500 }));
		const c = client(servers.impl);
		expect(c.routes).toEqual(["openrouter"]);
		const outcome = await c.ask("q", { q: NOUL_Q });
		expect(outcome).toMatchObject({ kind: "transport_error", route: "openrouter", failover: false });
		expect(servers.count("typesafe")).toBe(0);
	});

	it("a route with no key is skipped, not an error: openrouter alone serves as the primary", async () => {
		const { client } = harness();
		const servers = twoServers(() => jsonResponse(NOUL_OK), () => jsonResponse(OPENROUTER_OK));
		const c = client(servers.impl, { typesafe: null });
		const outcome = await c.ask("q", { q: NOUL_Q });
		expect(outcome).toMatchObject({ kind: "ok", route: "openrouter", failover: false });
		expect(servers.count("typesafe")).toBe(0);
	});

	it("no keys at all → disabled, no dial", async () => {
		const { client } = harness();
		const servers = twoServers(() => jsonResponse(NOUL_OK), () => jsonResponse(OPENROUTER_OK));
		const c = client(servers.impl, { typesafe: null, openrouter: null });
		expect(c.live).toBe(false);
		expect(await c.ask("q", { q: NOUL_Q })).toEqual({ kind: "disabled", reason: "no_key", ...NO_ROUTE });
		expect(servers.dialed).toHaveLength(0);
	});

	it("an openrouter key alone still enables nothing without `enabled: true`", async () => {
		const servers = twoServers(() => jsonResponse(NOUL_OK), () => jsonResponse(OPENROUTER_OK));
		const c = new TypesafeClient({ config: configFrom({}), apiKey: null, openrouterApiKey: "sk-or", fetchImpl: servers.impl });
		expect(await c.ask("q", { q: NOUL_Q })).toEqual({ kind: "disabled", reason: "config", ...NO_ROUTE });
		expect(servers.dialed).toHaveLength(0);
	});
});

describe("the OpenRouter response shape", () => {
	it("decodes despite the different model spelling and extra fields, and surfaces usage.cost", async () => {
		const { client } = harness(configFrom({ enabled: true, routes: ["openrouter"] }));
		const servers = twoServers(() => jsonResponse(NOUL_OK), () => jsonResponse(OPENROUTER_OK));
		const outcome = await client(servers.impl).ask("q", { q: NOUL_Q });
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") return;
		expect(outcome.model).toBe("typesafe/jev-1.13-20260917");
		expect(outcome.usage).toEqual({ inputTokens: 376, outputTokens: 0, costUsd: 0.0000158 });

		const tally = record(newTally(), outcome, true);
		expect(tally.costUsd).toBeCloseTo(0.0000158, 12);
		expect(formatTally(tally)).toContain("cost $0.000016");
	});

	it("the direct shape reports no cost at all rather than a cost of zero", () => {
		const result = decodeEnvelope(NOUL_OK, { q: NOUL_Q });
		expect(result.ok && "costUsd" in result.value.usage).toBe(false);
	});
});

describe("liveness carries the route", () => {
	it("splits counts by route, keeps the aggregate, and counts failovers", () => {
		const tally = newTally();
		const ok = { kind: "ok", answers: {}, usage: { inputTokens: 1, outputTokens: 0 }, latencyMs: 300, model: "jev" } as const;
		record(tally, { ...ok, ...VIA_TYPESAFE }, true);
		record(tally, { ...ok, route: "openrouter", failover: true }, true);
		record(tally, { kind: "payment_required", status: 402, ...VIA_TYPESAFE });
		record(tally, { kind: "disabled", reason: "no_key", ...NO_ROUTE });
		expect(tally.counts.ok).toBe(2);
		expect(tally.byRoute.typesafe.ok).toBe(1);
		expect(tally.byRoute.openrouter.ok).toBe(1);
		expect(tally.byRoute.typesafe.payment_required).toBe(1);
		expect(tally.failovers).toBe(1);
		// `disabled` tried no route, so no route claims it.
		expect(tally.byRoute.typesafe.disabled + tally.byRoute.openrouter.disabled).toBe(0);
		const line = formatTally(tally);
		expect(line).toContain("ok 2/4");
		expect(line).toContain("payment_required 1");
		expect(line).toContain("via typesafe 2 / openrouter 1");
		expect(line).toContain("failover 1");
	});

	it("OUTCOME_KINDS lists every kind, including payment_required", () => {
		expect(OUTCOME_KINDS).toContain("payment_required");
		expect(new Set(OUTCOME_KINDS).size).toBe(OUTCOME_KINDS.length);
	});
});

describe("the fallback key never comes from the plain `openrouter` credential (HIV-3617)", () => {
	it("reads TYPESAFE_OPENROUTER_API_KEY, then the `typesafe-openrouter` credential", async () => {
		const { readOpenrouterApiKey, TYPESAFE_OPENROUTER_API_KEY_ENV, TYPESAFE_OPENROUTER_CREDENTIAL } = await import(
			"../extensions/typesafe-common/key.ts"
		);
		expect(TYPESAFE_OPENROUTER_CREDENTIAL).toBe("typesafe-openrouter");
		expect(readOpenrouterApiKey({ [TYPESAFE_OPENROUTER_API_KEY_ENV]: "sk-or-env" }, () => undefined)).toBe("sk-or-env");
		const store: Record<string, unknown> = { "typesafe-openrouter": { type: "api_key", key: "sk-or-leased" } };
		expect(readOpenrouterApiKey({}, (id) => store[id])).toBe("sk-or-leased");
	});

	it("ignores a plain `openrouter` credential, and never even asks for it", async () => {
		const { readOpenrouterApiKey } = await import("../extensions/typesafe-common/key.ts");
		const asked: string[] = [];
		// A pi PROVIDER credential: the thing that made openrouter/* chat models
		// routable. Its presence must not become Jev's fallback key.
		const store: Record<string, unknown> = { openrouter: { type: "api_key", key: "sk-or-chat" } };
		const key = readOpenrouterApiKey({ OPENROUTER_API_KEY: "sk-or-chat-env" }, (id) => {
			asked.push(id);
			return store[id];
		});
		expect(key).toBeNull();
		expect(asked).toEqual(["typesafe-openrouter"]);
	});

	it("refuses an unresolved reference in the leased credential, like the typesafe key", async () => {
		const { readOpenrouterApiKey } = await import("../extensions/typesafe-common/key.ts");
		expect(readOpenrouterApiKey({}, () => ({ type: "api_key", key: "!op read op://Hive/openrouter/credential" }))).toBeNull();
		expect(readOpenrouterApiKey({}, () => ({ type: "api_key", key: "$OPENROUTER_API_KEY" }))).toBeNull();
	});
});
