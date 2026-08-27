import { describe, expect, it } from "vitest";
import { loadAdvisorConfig } from "../extensions/advisor/config.ts";
import { pickAdvisorModel, type AgentMode } from "../extensions/advisor/modes.ts";
import { buildAdvisorPrompt, capTranscript } from "../extensions/advisor/prompt.ts";

// The advisor's pure core: which model is "one class above", how a transcript
// is fitted to the advisor's context, and that the conversation is always
// framed as data. The completion itself is a plain pi-ai call and is not
// re-tested here.

const LADDER: AgentMode[] = [
	{ key: "high", model: "openai-codex/gpt-5.6-sol", thinking: "high" },
	{ key: "medium", model: "openai-codex/gpt-5.6-terra", thinking: "high" },
	{ key: "low", model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" },
];

describe("pickAdvisorModel", () => {
	it("picks one class above the current model", () => {
		const pick = pickAdvisorModel(LADDER, "openai-codex/gpt-5.6-terra");
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-sol");
		expect(pick?.modeKey).toBe("high");
	});

	it("keeps the top class at the top — a fresh context is the value", () => {
		const pick = pickAdvisorModel(LADDER, "openai-codex/gpt-5.6-sol");
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-sol");
	});

	it("routes an unknown current model to the top", () => {
		const pick = pickAdvisorModel(LADDER, "openrouter/some/custom-model");
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-sol");
	});

	it("steps low up to medium, not straight to the top", () => {
		const pick = pickAdvisorModel(LADDER, "openai-codex/gpt-5.6-luna");
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-terra");
	});

	it("ranks the same model reached through a different provider", () => {
		// One model, two spellings: the catalog carries the openai-codex spec,
		// the session may be running openrouter's copy. Before this it read as
		// "not in the catalog" and silently got the top instead of its class.
		const pick = pickAdvisorModel(LADDER, "openrouter/openai/gpt-5.6-luna");
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-terra");
		expect(pick?.modeKey).toBe("medium");
	});

	it("still routes a genuinely unknown model to the top", () => {
		// The id fallback must not turn every unmatched spec into a match — a
		// model that is not on the ladder at all is still unrankable.
		const pick = pickAdvisorModel(LADDER, "openrouter/anthropic/claude-opus-4.8");
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-sol");
	});

	it("prefers an EXACT spec match over a bare-id one", () => {
		// If both spellings are on the ladder, the exact spec wins so the
		// fallback never reorders a catalog that was already unambiguous.
		const ladder: AgentMode[] = [
			{ key: "high", model: "openai-codex/gpt-5.6-sol" },
			{ key: "alt", model: "openrouter/openai/gpt-5.6-terra" },
			{ key: "medium", model: "openai-codex/gpt-5.6-terra" },
		];
		expect(pickAdvisorModel(ladder, "openai-codex/gpt-5.6-terra")?.modeKey).toBe("alt");
	});

	it("returns null for an empty or unusable catalog", () => {
		expect(pickAdvisorModel([], "x/y")).toBeNull();
		expect(pickAdvisorModel([{ key: "bad", model: "notaspec" }], "x/y")).toBeNull();
	});
});

describe("capTranscript", () => {
	it("leaves an under-budget transcript untouched", () => {
		const { text, capped } = capTranscript("short conversation", 1000);
		expect(text).toBe("short conversation");
		expect(capped).toBe(false);
	});

	it("keeps the head (the task statement) and the tail when over budget", () => {
		const head = "TASK: build the widget. ";
		const body = "x".repeat(5000);
		const tail = " FINAL: tests are red.";
		const { text, capped } = capTranscript(head + body + tail, 1000);
		expect(capped).toBe(true);
		expect(text.length).toBeLessThanOrEqual(1000);
		expect(text.startsWith("TASK: build the widget.")).toBe(true);
		expect(text.endsWith("FINAL: tests are red.")).toBe(true);
		expect(text).toContain("elided");
	});
});

describe("buildAdvisorPrompt", () => {
	it("fences the transcript as data and names both models", () => {
		const prompt = buildAdvisorPrompt("[user] do the thing", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-sol");
		expect(prompt).toContain("BEGIN AGENT CONVERSATION (DATA)");
		expect(prompt).toContain("END AGENT CONVERSATION (DATA)");
		expect(prompt).toContain("gpt-5.6-terra");
		expect(prompt).toContain("gpt-5.6-sol");
		// The transcript sits between the markers, never before the instructions.
		expect(prompt.indexOf("do the thing")).toBeGreaterThan(prompt.indexOf("BEGIN AGENT CONVERSATION"));
	});
});

describe("loadAdvisorConfig", () => {
	it("applies defaults on an empty environment", () => {
		const cfg = loadAdvisorConfig({});
		expect(cfg.modelOverride).toBeUndefined();
		expect(cfg.timeoutMs).toBe(240_000);
		expect(cfg.maxChars).toBe(400_000);
		expect(cfg.disabled).toBe(false);
	});

	it("honors overrides and rejects nonsense numbers", () => {
		const cfg = loadAdvisorConfig({
			PI_ADVISOR_MODEL: " openrouter/anthropic/claude-opus-4.8 ",
			PI_ADVISOR_TIMEOUT_MS: "-5",
			PI_ADVISOR_MAX_CHARS: "1000",
			PI_ADVISOR_DISABLED: "1",
		});
		expect(cfg.modelOverride).toBe("openrouter/anthropic/claude-opus-4.8");
		expect(cfg.timeoutMs).toBe(240_000);
		expect(cfg.maxChars).toBe(1000);
		expect(cfg.disabled).toBe(true);
	});
});
