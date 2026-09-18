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

import { describe, expect, it } from "vitest";

import {
	MAX_CHOICE_OPTIONS,
	TypesafeClient,
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
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, configFrom } from "../extensions/typesafe-common/config.ts";
import { formatTally, newTally, record, totalCalls } from "../extensions/typesafe-common/liveness.ts";

const ON = configFrom({ enabled: true, timeoutMs: 1_000 });

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
		expect(outcome).toEqual({ kind: "disabled", reason: "config" });
		expect(impl.calls).toHaveLength(0);
		expect(client.live).toBe(false);
	});

	it("an enabled client with no key is disabled for a DIFFERENT reason, and says so", async () => {
		// "no_key" and "config" must not collapse into one state: the operator
		// fixes them in different places.
		const impl = fakeFetch(() => jsonResponse({}));
		const client = new TypesafeClient({ config: ON, apiKey: null, fetchImpl: impl });
		expect(await client.ask("q", { q: NOUL_Q })).toEqual({ kind: "disabled", reason: "no_key" });
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
			record(agreed, { kind: "ok", answers: {}, usage: { inputTokens: 10, outputTokens: 1 }, latencyMs: 300, model: "jev" }, true);
		}
		const dead = newTally();
		for (let i = 0; i < 3; i++) record(dead, { kind: "malformed", reason: "no answers map", latencyMs: 300 });

		expect(formatTally(agreed)).toContain("ok 3/3");
		expect(formatTally(agreed)).toContain("agreed 3");
		expect(formatTally(dead)).toContain("ok 0/3");
		expect(formatTally(dead)).toContain("malformed 3");
		// The load-bearing negative: the two reports are not the same sentence.
		expect(formatTally(agreed)).not.toBe(formatTally(dead));
	});

	it("`ok 0` is printed even when nothing succeeded", () => {
		const tally = newTally();
		record(tally, { kind: "timeout", timeoutMs: 3_000 });
		expect(formatTally(tally)).toContain("ok 0/1");
	});

	it("counts every outcome kind separately — no bucket absorbs another", () => {
		const tally = newTally();
		record(tally, { kind: "timeout", timeoutMs: 1 });
		record(tally, { kind: "rate_limited", status: 429, retryAfterMs: null });
		record(tally, { kind: "malformed", reason: "x", latencyMs: 1 });
		record(tally, { kind: "disabled", reason: "config" });
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
		expect(await client.ask("q", { q: NOUL_Q })).toEqual({ kind: "disabled", reason: "config" });
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
