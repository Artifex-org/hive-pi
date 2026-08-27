/**
 * compaction — pure logic.
 *
 * Everything here except the HTTP round trip. The round trip is deliberately
 * untested: exercising it means sending real conversation data to OpenAI, which
 * is the exact act the whole feature is gated behind. What these tests DO cover
 * is every decision made before and after that call — which model is eligible,
 * what the body contains, what happens to a malformed response, and when a
 * stored artifact must be thrown away.
 */

import { describe, expect, it } from "vitest";

import { createFakePi } from "./fake-pi.ts";
import { wireCompaction, type CompactionConfig } from "../extensions/compaction/index.ts";
import {
	CLEAR_ON_EVENTS,
	INERT_REASON,
	apiKeyFromCredential,
	buildCompactionRequest,
	canReplay,
	extractCompaction,
	shouldClearContinuation,
	supportFor,
	supportReason,
	type RemoteCompaction,
} from "../extensions/compaction/support.ts";

const OPENAI = { provider: "openai", id: "gpt-5.6-sol" };
const CODEX = { provider: "openai-codex", id: "gpt-5.6-terra" };

describe("supportFor", () => {
	it("direct openai/* is the supported path", () => {
		expect(supportFor(OPENAI, false)).toBe("direct");
	});

	it("openai-codex is reported unsupported rather than silently doing nothing", () => {
		// This workstation's DEFAULT model is openai-codex, so this is the
		// experience most people will have on first enable. Getting a clear
		// reason instead of silence is the whole point of the distinct level.
		expect(supportFor(CODEX, false)).toBe("codex-unsupported");
		expect(supportReason("codex-unsupported")).toContain("API key");
	});

	it("azure only when explicitly included", () => {
		const azure = { provider: "azure-openai", id: "gpt-5" };
		expect(supportFor(azure, false)).toBe("unsupported");
		expect(supportFor(azure, true)).toBe("direct");
	});

	it("non-openai providers are unsupported", () => {
		expect(supportFor({ provider: "openrouter", id: "deepseek" }, true)).toBe("unsupported");
		expect(supportFor({ provider: "anthropic", id: "claude" }, true)).toBe("unsupported");
	});

	it("is case-insensitive about the provider", () => {
		expect(supportFor({ provider: "OpenAI", id: "x" }, false)).toBe("direct");
	});

	it("a missing model is unsupported, not a crash", () => {
		expect(supportFor(null, true)).toBe("unsupported");
		expect(supportFor(undefined, true)).toBe("unsupported");
	});

	it("every level has a reason string", () => {
		for (const level of ["direct", "codex-unsupported", "unsupported"] as const) {
			expect(supportReason(level).length).toBeGreaterThan(0);
		}
	});
});

describe("buildCompactionRequest", () => {
	const messages = [
		{ role: "user", content: "one" },
		{ role: "assistant", content: "two" },
	];

	it("always sets store:true — the endpoint needs server state", () => {
		// Also the privacy decision, which is why the setting is opt-in. If this
		// assertion ever needs relaxing, the warning text needs revisiting too.
		expect(buildCompactionRequest({ model: "m", messages }).store).toBe(true);
	});

	it("appends the compaction_trigger LAST", () => {
		const body = buildCompactionRequest({ model: "m", messages });
		expect(body.input).toHaveLength(3);
		expect(body.input[2]).toEqual({ type: "compaction_trigger" });
	});

	it("preserves message order ahead of the trigger", () => {
		const body = buildCompactionRequest({ model: "m", messages });
		expect(body.input.slice(0, 2)).toEqual(messages);
	});

	it("mirrors the surrounding request config rather than using endpoint defaults", () => {
		// A compaction produced under different settings than the conversation it
		// summarizes is a silent fidelity loss.
		const body = buildCompactionRequest({
			model: "m",
			messages,
			systemPrompt: "sys",
			tools: [{ name: "read" }],
			reasoning: { effort: "high" },
			text: { verbosity: "low" },
		});
		expect(body.instructions).toBe("sys");
		expect(body.tools).toEqual([{ name: "read" }]);
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body.text).toEqual({ verbosity: "low" });
	});

	it("omits optional fields rather than sending empty ones", () => {
		const body = buildCompactionRequest({ model: "m", messages, tools: [] });
		expect("instructions" in body).toBe(false);
		expect("tools" in body).toBe(false);
		expect("reasoning" in body).toBe(false);
	});

	it("does not mutate the caller's message array", () => {
		const original = [...messages];
		buildCompactionRequest({ model: "m", messages });
		expect(messages).toEqual(original);
	});
});

describe("extractCompaction", () => {
	const ok = { id: "resp_1", output: [{ type: "message" }, { type: "compaction", data: "opaque" }] };

	it("finds the compaction item among other output", () => {
		const result = extractCompaction(ok, OPENAI, 1000);
		expect(result).toMatchObject({ model: "gpt-5.6-sol", provider: "openai", createdAtMs: 1000, responseId: "resp_1" });
		expect(result?.item).toEqual({ type: "compaction", data: "opaque" });
	});

	it("returns null when no compaction item is present", () => {
		expect(extractCompaction({ output: [{ type: "message" }] }, OPENAI, 0)).toBeNull();
	});

	// A changed response format must degrade to "pi's summary only", never take
	// down the compaction it was trying to improve.
	it.each([
		["null", null],
		["a string", "nope"],
		["no output field", { id: "x" }],
		["output not an array", { output: "x" }],
		["output of nulls", { output: [null, undefined] }],
		["output of primitives", { output: [1, "two"] }],
	])("returns null rather than throwing for %s", (_label, payload) => {
		expect(() => extractCompaction(payload, OPENAI, 0)).not.toThrow();
		expect(extractCompaction(payload, OPENAI, 0)).toBeNull();
	});

	it("tolerates a missing response id", () => {
		const result = extractCompaction({ output: [{ type: "compaction" }] }, OPENAI, 0);
		expect(result?.responseId).toBeUndefined();
	});

	it("ignores a non-string id rather than storing a bogus continuation handle", () => {
		const result = extractCompaction({ id: 42, output: [{ type: "compaction" }] }, OPENAI, 0);
		expect(result?.responseId).toBeUndefined();
	});
});

describe("canReplay — the cross-model contamination guard", () => {
	const artifact: RemoteCompaction = {
		item: {},
		model: "gpt-5.6-sol",
		provider: "openai",
		createdAtMs: 0,
	};

	it("replays for the exact model that produced it", () => {
		expect(canReplay(artifact, OPENAI)).toBe(true);
	});

	it("refuses a different model id", () => {
		expect(canReplay(artifact, { provider: "openai", id: "gpt-4" })).toBe(false);
	});

	it("refuses the same id under a different provider", () => {
		// openai/x and openai-codex/x are the same weights behind different
		// transports and still must not share an artifact.
		expect(canReplay({ ...artifact, provider: "openai-codex" }, OPENAI)).toBe(false);
	});

	it("refuses when there is no artifact or no model", () => {
		expect(canReplay(null, OPENAI)).toBe(false);
		expect(canReplay(artifact, null)).toBe(false);
		expect(canReplay(artifact, undefined)).toBe(false);
	});
});

describe("shouldClearContinuation", () => {
	it("clears on every event where the server's view can diverge from ours", () => {
		for (const event of CLEAR_ON_EVENTS) {
			expect(shouldClearContinuation(event), event).toBe(true);
		}
	});

	it("covers fork, switch, tree navigation, model change and compaction itself", () => {
		// Named individually so deleting one from CLEAR_ON_EVENTS fails here
		// rather than passing a loop over a shortened list.
		for (const event of [
			"session_before_fork",
			"session_before_switch",
			"session_before_tree",
			"session_tree",
			"model_select",
			"session_compact",
			"session_start",
			"session_shutdown",
		]) {
			expect(shouldClearContinuation(event), event).toBe(true);
		}
	});

	it("does not clear on ordinary turn traffic", () => {
		for (const event of ["message_end", "turn_end", "tool_call", "agent_settled"]) {
			expect(shouldClearContinuation(event), event).toBe(false);
		}
	});
});

/* -------------------------------------------------------------------------- */
/* Wiring — the opt-in gate                                                    */
/* -------------------------------------------------------------------------- */

const cfg = (enabled: boolean): CompactionConfig => ({
	enabled,
	includeAzure: false,
	timeoutMs: 30_000,
	keepRecent: 4,
});

describe("the opt-in gate", () => {
	// The single most important property of this extension. A disabled config
	// must leave NO handler and NO command registered — not a handler that
	// declines to act. A registered no-op still turns on the path it hangs from,
	// and here that path reads an API key and opens a socket.
	it("registers absolutely nothing when disabled", () => {
		const pi = createFakePi();
		wireCompaction(pi.api, cfg(false), "sk-test");
		expect(pi.handlers.size).toBe(0);
		expect(pi.commands.size).toBe(0);
	});

	it("registers the compaction hook and command when enabled", () => {
		const pi = createFakePi();
		wireCompaction(pi.api, cfg(true), "sk-test");
		expect(pi.handlers.has("session_compact")).toBe(true);
		expect(pi.commands.has("compaction")).toBe(true);
	});

	it("subscribes to every clear-on event, so no artifact outlives a boundary", () => {
		const pi = createFakePi();
		wireCompaction(pi.api, cfg(true), "sk-test");
		for (const event of CLEAR_ON_EVENTS) {
			expect(pi.handlers.has(event), `no handler for ${event}`).toBe(true);
		}
	});

	it("still registers with no API key, so /compaction can explain why it is inert", () => {
		// Silence would be the wrong failure here: the user has explicitly opted
		// in and deserves to be told the key is missing rather than guess.
		const pi = createFakePi();
		wireCompaction(pi.api, cfg(true), null);
		expect(pi.commands.has("compaction")).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */
/* The auth-store fallback                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `auth.json` is pi's file and pi's shape. This extension shipped reading
 * `credential.apiKey`, a field pi has never written — so the fallback was dead
 * and `/compaction` told anyone whose key lives in auth.json (rather than in
 * `$OPENAI_API_KEY`) that their key was MISSING. The real field is `key`, under
 * `type: "api_key"`.
 */
describe("apiKeyFromCredential", () => {
	it("reads the field pi actually writes", () => {
		expect(apiKeyFromCredential({ type: "api_key", key: "sk-live" })).toBe("sk-live");
	});

	it("does not read the field the first version looked for", () => {
		// The regression guard. `apiKey` is not part of pi's Credential union.
		expect(apiKeyFromCredential({ type: "api_key", apiKey: "sk-live" })).toBeNull();
	});

	it("refuses an oauth credential rather than mining it for a key", () => {
		// This workstation's real auth.json holds exactly this: an `openai-codex`
		// oauth entry. Its `access` token is not an API key for /v1/responses.
		expect(apiKeyFromCredential({ type: "oauth", access: "ya29", refresh: "r", expires: 1 })).toBeNull();
	});

	it("refuses a shell-command reference instead of sending it as a Bearer token", () => {
		// pi supports `"key": "!op read op://…"` and resolves it with a shell.
		// We cannot resolve it (`resolveConfigValue` is not exported), and putting
		// the unresolved string in an Authorization header would ship someone's
		// secret-manager command line to OpenAI.
		expect(apiKeyFromCredential({ type: "api_key", key: "!op read op://vault/openai/key" })).toBeNull();
	});

	it("refuses an env-var template for the same reason", () => {
		expect(apiKeyFromCredential({ type: "api_key", key: "$OPENAI_API_KEY" })).toBeNull();
		expect(apiKeyFromCredential({ type: "api_key", key: "${OPENAI_API_KEY}" })).toBeNull();
	});

	it.each([
		["nothing", undefined],
		["null", null],
		["a string", "sk-loose"],
		["an empty key", { type: "api_key", key: "" }],
		["a non-string key", { type: "api_key", key: 42 }],
		["a credential with no type", { key: "sk-live" }],
	])("returns null rather than throwing for %s", (_label, credential) => {
		expect(() => apiKeyFromCredential(credential)).not.toThrow();
		expect(apiKeyFromCredential(credential)).toBeNull();
	});
});

/* -------------------------------------------------------------------------- */
/* Structural inertness — reported, not hidden                                 */
/* -------------------------------------------------------------------------- */

/**
 * This build cannot deliver the feature, for two reasons neither of which this
 * extension can fix (see `INERT_REASON`). What it CAN do is say so, in the one
 * place someone who enabled the setting will look. These tests pin that.
 */
describe("the inert path tells the truth", () => {
	/**
	 * The handlers are driven directly rather than through `pi.emit`, because
	 * `FakeCtxOptions` cannot carry a `model` and this whole path turns on one:
	 * with `model: undefined` the handler exits at the support check and never
	 * reaches the message extraction under test. A local ctx stub is the smaller
	 * lie than a test that passes for the wrong reason.
	 */
	const notifications: string[] = [];
	const ctx = {
		model: { provider: "openai", id: "gpt-5.6-sol" },
		getSystemPrompt: () => "sys",
		ui: { notify: (message: string) => void notifications.push(message) },
	};

	/** A REAL pi 0.84.1 CompactionEntry. Note what it does not have: messages. */
	const compactEvent = {
		type: "session_compact",
		compactionEntry: { type: "compaction", id: "c1", parentId: "e0", timestamp: "", summary: "…", firstKeptEntryId: "e1", tokensBefore: 100 },
		fromExtension: false,
		reason: "threshold",
		willRetry: false,
	};

	async function compactOnce(): Promise<ReturnType<typeof createFakePi>> {
		notifications.length = 0;
		const pi = createFakePi();
		wireCompaction(pi.api, cfg(true), "sk-test");
		for (const handler of pi.handlers.get("session_compact") ?? []) {
			await handler(compactEvent, ctx as never);
		}
		return pi;
	}

	it("names both gaps, not just the symptom", () => {
		// "no messages on the compaction entry" reads as bad luck on one
		// boundary. It is in fact every boundary, and the round trip would be
		// pointless even if it fired.
		expect(INERT_REASON).toContain("no messages");
		expect(INERT_REASON).toContain("replay");
	});

	it("an eligible model, a key, and a real compaction still send nothing", async () => {
		// The honest statement of where this feature stands: opted in, supported
		// model, key present — and `fetch` is never reached, because pi's
		// CompactionEntry has no `messages` field to read. If this ever starts
		// failing, the extraction was repointed and the replay gap (which makes
		// the upload pointless) needs closing in the same change.
		const original = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (() => {
			calls++;
			return Promise.reject(new Error("no network in tests"));
		}) as unknown as typeof fetch;
		try {
			await compactOnce();
			expect(calls).toBe(0);
		} finally {
			globalThis.fetch = original;
		}
	});

	it("/compaction surfaces the reason afterwards, not a shrug", async () => {
		const pi = await compactOnce();
		await pi.commands.get("compaction")?.handler("", ctx as never);
		const status = notifications.at(-1) ?? "";
		expect(status).toContain("INERT");
		expect(status).toContain("replay");
	});

	it("says nothing about inertness before a compaction has happened", () => {
		// The warning must be earned. Printing it unconditionally would make it
		// furniture, which is how a real warning stops being read.
		notifications.length = 0;
		const pi = createFakePi();
		wireCompaction(pi.api, cfg(true), "sk-test");
		void pi.commands.get("compaction")?.handler("", ctx as never);
		expect(notifications.at(-1) ?? "").not.toContain("INERT");
	});
});
