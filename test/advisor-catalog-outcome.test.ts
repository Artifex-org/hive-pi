import { afterEach, describe, expect, it, vi } from "vitest";
import { advisorFailureMessage, fetchAgentModeOutcome, resetModeCatalogCache } from "../extensions/advisor/modes.ts";

// The catalog fetch has to say WHICH of three things went wrong, because they
// need three different actions.
//
// Measured on 2026-08-18: a five-second timeout against /agent-modes surfaced to
// an agent as "the Hive server has no agent modes configured". The server was
// configured correctly — three codex modes, HTTP 200 when asked from the host —
// and /agent-modes was simply slow, because it derives fallback chains from a
// 30-day corpus aggregate measured at 89.9s cold against production (0.10s warm). The session
// filed a papercut against the wrong component, and running the false claim to
// ground took a walk through the server env, the token, the sandbox network and
// the installed build. A message that names the wrong cause is worse than one
// that admits it does not know.

const AUTH = { token: "t", url: "https://hive.example" };

afterEach(() => {
	vi.unstubAllGlobals();
	resetModeCatalogCache();
});

function stubFetch(impl: () => Promise<Response> | never) {
	vi.stubGlobal("fetch", impl);
}

describe("fetchAgentModeOutcome", () => {
	it("reports a failed request as unreachable, never as unconfigured", async () => {
		stubFetch(async () => {
			throw new Error("boom");
		});
		const out = await fetchAgentModeOutcome(AUTH);
		expect(out.kind).toBe("unreachable");
		// The distinction that cost the investigation: this must not read as a
		// statement about server configuration.
		if (out.kind === "unreachable") expect(out.detail).toBeTruthy();
	});

	it("reports a timeout as unreachable and says so", async () => {
		stubFetch(async () => {
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		});
		const out = await fetchAgentModeOutcome(AUTH);
		expect(out.kind).toBe("unreachable");
		if (out.kind === "unreachable") expect(out.detail).toContain("timeout");
	});

	it("reports a 5xx as unreachable, with the status", async () => {
		stubFetch(async () => new Response("nope", { status: 503 }));
		const out = await fetchAgentModeOutcome(AUTH);
		expect(out.kind).toBe("unreachable");
		if (out.kind === "unreachable") expect(out.detail).toContain("503");
	});

	it("reports a 200 with no modes as empty — the one case that IS a config problem", async () => {
		stubFetch(async () => new Response(JSON.stringify({ version: "v", modes: [] }), { status: 200 }));
		expect((await fetchAgentModeOutcome(AUTH)).kind).toBe("empty");
	});

	it("returns the catalog when the server has one", async () => {
		stubFetch(async () =>
			new Response(JSON.stringify({ version: "v", modes: [{ key: "high", model: "openai-codex/gpt-5.6-sol" }] }), {
				status: 200,
			}),
		);
		const out = await fetchAgentModeOutcome(AUTH);
		expect(out.kind).toBe("ok");
		if (out.kind === "ok") expect(out.catalog.modes).toHaveLength(1);
	});

	// A failure must NOT be cached: the dominant cause is transient (a cold
	// server cache, a slow moment on the tailnet), so the next consultation has
	// to be allowed to succeed rather than inherit a stuck negative answer.
	it("does not cache a failure", async () => {
		let calls = 0;
		stubFetch(async () => {
			calls++;
			if (calls === 1) throw new Error("boom");
			return new Response(JSON.stringify({ modes: [{ key: "high", model: "openai-codex/gpt-5.6-sol" }] }), {
				status: 200,
			});
		});
		expect((await fetchAgentModeOutcome(AUTH)).kind).toBe("unreachable");
		expect((await fetchAgentModeOutcome(AUTH)).kind).toBe("ok");
		expect(calls).toBe(2);
	});

	// The catalog call gets a budget matched to what the endpoint can cost, not
	// the 5s every other Hive call uses.
	//
	// The stub HONOURS the abort signal, which is the whole test. A stub that
	// merely sleeps and then resolves passes at any budget — the first version of
	// this test did exactly that and stayed green with the timeout put back to
	// 5s, proving nothing.
	it("allows the catalog call more than the default 5s", async () => {
		vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
			new Promise<Response>((resolve, reject) => {
				const timer = setTimeout(
					() =>
						resolve(
							new Response(JSON.stringify({ modes: [{ key: "high", model: "openai-codex/gpt-5.6-sol" }] }), {
								status: 200,
							}),
						),
					6_000,
				);
				init.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				});
			}),
		);
		// Six seconds: a timeout under the old 5s budget, comfortable under this one.
		expect((await fetchAgentModeOutcome(AUTH)).kind).toBe("ok");
	}, 20_000);
});

// The sentence a human reads is the artifact that was wrong, so it is asserted
// directly. Each branch must state only what its input proves — and must not
// borrow another branch's explanation, which is the exact defect: a timeout
// wearing "the Hive server has no agent modes configured".
describe("advisorFailureMessage", () => {
	it("blames configuration ONLY when the server actually answered with no modes", () => {
		expect(advisorFailureMessage({ kind: "empty" })).toContain("no agent modes configured");
	});

	it("never blames configuration for a failed request", () => {
		const msg = advisorFailureMessage({ kind: "unreachable", detail: "timeout" });
		expect(msg).not.toContain("no agent modes configured");
		expect(msg).toContain("could not read");
		expect(msg).toContain("timeout");
	});

	it("never blames configuration for missing auth", () => {
		expect(advisorFailureMessage("no-auth")).not.toContain("no agent modes configured");
		expect(advisorFailureMessage("no-auth")).toContain("/hive-login");
	});

	it("distinguishes an unusable catalog from an absent one", () => {
		const unusable = advisorFailureMessage("no-usable-model");
		expect(unusable).not.toContain("no agent modes configured");
		expect(unusable).toContain("no usable model");
	});

	// Every branch has to leave the reader with something to do; an error that
	// only reports a state is how the original one got filed against the wrong
	// component instead of retried.
	it("always offers an action", () => {
		for (const m of [
			advisorFailureMessage("no-auth"),
			advisorFailureMessage("no-usable-model"),
			advisorFailureMessage({ kind: "empty" }),
			advisorFailureMessage({ kind: "unreachable", detail: "HTTP 503" }),
		]) {
			expect(m).toContain("PI_ADVISOR_MODEL");
		}
	});

	// All four are distinct sentences. If two collapse, the distinction this
	// whole change exists to make has quietly stopped existing.
	it("gives each cause its own sentence", () => {
		const all = [
			advisorFailureMessage("no-auth"),
			advisorFailureMessage("no-usable-model"),
			advisorFailureMessage({ kind: "empty" }),
			advisorFailureMessage({ kind: "unreachable", detail: "HTTP 503" }),
		];
		expect(new Set(all).size).toBe(all.length);
	});
});
