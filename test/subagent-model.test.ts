/**
 * Which model a delegated worker runs on, and what a caller is told about it.
 *
 * Pure, spawning nothing. The two measured failures this guards (the strings
 * are the real ones from the papercut corpus, seven days to 2026-09-10):
 *
 *   `No API key found for xai.`            — delegation default unconfigured here
 *   `429 {"code":"1302","message":"Rate limit reached for requests"}`
 *                                          — the default's account throttled
 */

import { describe, expect, it } from "vitest";

import {
	chooseWorkerModel,
	continuationTask,
	isAccountRefusal,
	pickAlternateAccount,
	stoppedMidWork,
	type CatalogMode,
	type WorkerModelEnv,
} from "../extensions/subagent/model.ts";
import { delegationOutcome } from "../extensions/subagent/background.ts";
import { resultNotes, type SingleResult } from "../extensions/subagent/index.ts";
import { isQuotaExhaustedText } from "../extensions/hive-common/quota.ts";

/** The fleet catalog, highest class first — the shape /agent-modes returns. */
const CATALOG: CatalogMode[] = [
	{ key: "high", model: "openai-codex/gpt-5.6-terra" },
	{ key: "mid", model: "openai-codex/gpt-5.6-luna" },
	{ key: "low", model: "zai/glm-5.3-flash" },
];

function env(configured: string[], overrides: Partial<WorkerModelEnv> = {}): WorkerModelEnv & { fetches: number } {
	const e = {
		fetches: 0,
		isConfigured: (spec: string) => configured.includes(spec),
		sessionModel: "openai-codex/gpt-5.6-terra",
		catalog: async () => {
			e.fetches += 1;
			return CATALOG;
		},
		...overrides,
	};
	return e;
}

describe("chooseWorkerModel — before the spawn", () => {
	it("uses a configured default without touching the catalog", async () => {
		const e = env(["xai/grok-4"]);
		const choice = await chooseWorkerModel({ preferred: "xai/grok-4", roleName: "research" }, e);
		expect(choice).toEqual({ spec: "xai/grok-4" });
		// The catalog is 89.9s cold against production; the happy path never pays it.
		expect(e.fetches).toBe(0);
	});

	it("falls back to the CHEAPEST configured fleet mode when the default is not configured, and says so", async () => {
		const e = env(["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-luna", "zai/glm-5.3-flash"]);
		const choice = await chooseWorkerModel({ preferred: "xai/grok-4", roleName: "verifier" }, e);
		expect(choice.spec).toBe("zai/glm-5.3-flash");
		expect(choice.refusal).toBeUndefined();
		// The note names the role, what ran, why, and the fix.
		expect(choice.note).toContain('role "verifier" ran on zai/glm-5.3-flash');
		expect(choice.note).toContain("xai/grok-4 is not configured on this machine");
		expect(choice.note).toContain('provider "xai"');
		expect(choice.note).toContain("PI_SUBAGENT_MODEL");
	});

	it("uses the session's own model only when no fleet mode is configured, and says it is NOT the cheap lane", async () => {
		const e = env(["openai-codex/gpt-5.6-terra"], { catalog: async () => [] });
		const choice = await chooseWorkerModel({ preferred: "xai/grok-4", roleName: "research" }, e);
		expect(choice.spec).toBe("openai-codex/gpt-5.6-terra");
		expect(choice.note).toContain("THIS SESSION'S model");
	});

	it("refuses, naming the provider, when nothing configured can stand in", async () => {
		const e = env([], { sessionModel: undefined, catalog: async () => [] });
		const choice = await chooseWorkerModel({ preferred: "xai/grok-4", roleName: "research" }, e);
		expect(choice.spec).toBeUndefined();
		expect(choice.refusal).toContain("no worker was started");
		expect(choice.refusal).toContain('provider "xai"');
	});

	it("honours an explicit `model` that is configured, and refuses one that is not", async () => {
		const e = env(["openrouter/deepseek/deepseek-v4-flash"]);
		expect(
			await chooseWorkerModel(
				{ requested: "openrouter/deepseek/deepseek-v4-flash", preferred: "xai/grok-4", roleName: "r" },
				e,
			),
		).toEqual({ spec: "openrouter/deepseek/deepseek-v4-flash" });

		const refused = await chooseWorkerModel({ requested: "xai/grok-4", preferred: "zai/glm-5.3-flash", roleName: "r" }, e);
		expect(refused.spec).toBeUndefined();
		// An override is a decision: it is refused, never silently replaced.
		expect(refused.refusal).toContain("model xai/grok-4 is not configured");
		expect(refused.refusal).toContain("Drop `model`");
	});

	it("treats an unknown registry answer as configured, never as absent", async () => {
		// A headless caller has no registry to ask; `null` must not become a
		// refusal, or every delegation without a UI would die on this check.
		const e = env([], { isConfigured: () => null });
		expect(await chooseWorkerModel({ preferred: "xai/grok-4", roleName: "r" }, e)).toEqual({ spec: "xai/grok-4" });
		expect(await chooseWorkerModel({ preferred: "xai/grok-4", roleName: "r" }, undefined)).toEqual({ spec: "xai/grok-4" });
	});

	it("passes through a missing default — pi picks its own", async () => {
		expect(await chooseWorkerModel({ roleName: "r" }, env([]))).toEqual({ spec: undefined });
	});
});

describe("isAccountRefusal — what another account would clear", () => {
	const quota = (text: string) => isQuotaExhaustedText(text);
	it("is a throttle or an exhausted allowance, never a crash", () => {
		expect(isAccountRefusal('429 {"code":"1302","message":"Rate limit reached for requests"}', quota)).toBe(true);
		expect(isAccountRefusal('403 "You have run out of credits or need a Grok subscription"', quota)).toBe(true);
		expect(isAccountRefusal("Subagent became inactive for 600s and was stopped.", quota)).toBe(false);
		expect(isAccountRefusal("Could not start subagent: spawn ENOENT", quota)).toBe(false);
		expect(isAccountRefusal(undefined, quota)).toBe(false);
	});
});

describe("pickAlternateAccount — after a provider refusal", () => {
	it("picks the cheapest configured mode on a DIFFERENT provider", async () => {
		const e = env(["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-luna", "zai/glm-5.3-flash"]);
		// The refused key is zai's, so every zai model is out — a throttled
		// provider key is throttled for every model behind it.
		expect(await pickAlternateAccount("zai/glm-5.3-flash", e)).toBe("openai-codex/gpt-5.6-luna");
	});

	it("skips the same provider spelled through a router only when the id matches", async () => {
		const e = env(["openai-codex/gpt-5.6-luna", "openrouter/openai/gpt-5.6-luna"], {
			catalog: async () => [{ model: "openrouter/openai/gpt-5.6-luna" }, { model: "openai-codex/gpt-5.6-luna" }],
		});
		// Same model id on both — nothing left that is a different account AND a
		// different model, so the session model is the only candidate; it is the
		// refused model's id too, so: nothing.
		expect(await pickAlternateAccount("openai-codex/gpt-5.6-luna", e)).toBeUndefined();
	});

	it("falls back to the session model when the catalog offers nothing, and to nothing when that is the refused provider", async () => {
		const e = env(["openai-codex/gpt-5.6-terra"], { catalog: async () => [] });
		expect(await pickAlternateAccount("zai/glm-5.3-flash", e)).toBe("openai-codex/gpt-5.6-terra");
		expect(await pickAlternateAccount("openai-codex/gpt-5.6-luna", e)).toBeUndefined();
		expect(await pickAlternateAccount("zai/glm-5.3-flash", undefined)).toBeUndefined();
	});

	it("survives a catalog that throws", async () => {
		const e = env(["openai-codex/gpt-5.6-terra"], {
			catalog: async () => {
				throw new Error("HTTP 502");
			},
		});
		expect(await pickAlternateAccount("zai/glm-5.3-flash", e)).toBe("openai-codex/gpt-5.6-terra");
	});
});

describe("stoppedMidWork — an announcement is not a result", () => {
	it("recognises the measured shapes", () => {
		expect(stoppedMidWork("Now updating Agents.tsx to pass the renamed params:")).toBe(true);
		expect(stoppedMidWork("Now I'll write the failing reproduction tests...")).toBe(true);
		expect(stoppedMidWork("Let me look at the migration first")).toBe(true);
		// The third measured case ended as a sentence. It is given up ON PURPOSE:
		// the rule that keeps "Now the tests pass." from being flagged is the
		// same rule, and a spurious "ended WITHOUT delivering" over a correct
		// verdict costs more than one missed announcement.
		expect(
			stoppedMidWork("Checking the registry defaults for the two gates, and the association reconcile’s dry-run handling for contrast."),
		).toBe(false);
	});

	it("leaves real answers alone — including short verdicts that open like an announcement", () => {
		expect(stoppedMidWork("VERIFIED: the caption is inserted only on create; the backfill path is untouched (sales/models.py:412).")).toBe(false);
		expect(stoppedMidWork("No findings. The three files in the diff match the contract.")).toBe(false);
		expect(stoppedMidWork("Now the tests pass.")).toBe(false);
		expect(stoppedMidWork("Running the suite gives 3 failures.")).toBe(false);
		expect(stoppedMidWork("Checking complete: no issues found.")).toBe(false);
		expect(stoppedMidWork("Looking good!")).toBe(false);
		expect(stoppedMidWork("")).toBe(false);
		// Long text ending in a colon is an answer with a trailing list, not an announcement.
		expect(stoppedMidWork(`${"Findings: ".repeat(40)}the list follows:`)).toBe(false);
	});

	it("hands the announcement to the continuation so the second worker knows what done is not", () => {
		const task = continuationTask("review the diff", "Now updating Agents.tsx:");
		expect(task.startsWith("review the diff")).toBe(true);
		expect(task).toContain('"Now updating Agents.tsx:"');
		expect(task).toContain("end with the actual result");
	});
});

function result(overrides: Partial<SingleResult>): SingleResult {
	return {
		agent: "research",
		agentSource: "package",
		task: "t",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

describe("what the caller is shown", () => {
	it("renders the model note and the mid-work warning, and nothing when there is nothing to say", () => {
		expect(resultNotes(result({}))).toBe("");
		const notes = resultNotes(result({ modelNote: "ran on x after y refused", midWork: true }));
		expect(notes).toContain("[model note] ran on x after y refused");
		expect(notes).toContain("ended WITHOUT delivering");
	});

	it("reports a background delegation from the worker's verdict, not its exit code", () => {
		// A no-change writer and a provider error both exit 0 with
		// stopReason "error"; `done (exit 0)` next to a mid-sentence handoff was
		// the measured result.
		expect(delegationOutcome({ exitCode: 0, stderr: "", output: "", failed: true })).toEqual({ status: "failed", exitCode: 1 });
		expect(delegationOutcome({ exitCode: 0, stderr: "", output: "", failed: false })).toEqual({ status: "done", exitCode: 0 });
		expect(delegationOutcome({ exitCode: 2, stderr: "", output: "" })).toEqual({ status: "failed", exitCode: 2 });
	});
});
