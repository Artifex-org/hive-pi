import { describe, expect, it } from "vitest";
import { loadAdvisorConfig } from "../extensions/advisor/config.ts";
import { pickAdvisorModel, pickConfiguredAdvisor, type AgentMode } from "../extensions/advisor/modes.ts";
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

// The catalog is the SERVER's ladder; whether a rung runs on THIS machine is a
// separate fact, and the measured failure was the two disagreeing: the top
// rung in the catalog, absent from one workstation's registry, and every
// advisor call there dying on "not configured on this machine" — 100 in seven
// days — while a configured model one rung down sat unused.
describe("pickConfiguredAdvisor", () => {
	const only = (...specs: string[]) => (spec: string) => specs.includes(spec);

	it("is pickAdvisorModel when everything is configured", () => {
		const pick = pickConfiguredAdvisor(LADDER, "openai-codex/gpt-5.6-terra", () => true);
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-sol");
		expect(pick?.note).toBeUndefined();
	});

	it("skips an unconfigured higher rung for the next configured one above the caller", () => {
		const ladder: AgentMode[] = [
			{ key: "top", model: "openai-codex/gpt-6-astra" },
			{ key: "high", model: "openai-codex/gpt-5.6-sol" },
			{ key: "low", model: "openai-codex/gpt-5.6-luna" },
		];
		const pick = pickConfiguredAdvisor(ladder, "openai-codex/gpt-5.6-luna", only("openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"));
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-sol");
		expect(pick?.note).toBeUndefined();
	});

	it("falls to the caller's own class WITH a note when nothing above is configured", () => {
		const pick = pickConfiguredAdvisor(LADDER, "openai-codex/gpt-5.6-terra", only("openai-codex/gpt-5.6-terra"));
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-terra");
		expect(pick?.note).toContain("the same class as this session");
		expect(pick?.note).toContain("openai-codex/gpt-5.6-sol");
		expect(pick?.note).toContain("PI_ADVISOR_MODEL");
	});

	it("falls below the caller, still with a note, rather than failing", () => {
		const pick = pickConfiguredAdvisor(LADDER, "openai-codex/gpt-5.6-sol", only("openai-codex/gpt-5.6-luna"));
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-luna");
		expect(pick?.note).toContain("LOWER class");
	});

	it("gives an unrankable caller the strongest CONFIGURED rung", () => {
		const pick = pickConfiguredAdvisor(LADDER, "openrouter/anthropic/claude-opus-4.8", only("openai-codex/gpt-5.6-terra"));
		expect(pick?.spec).toBe("openai-codex/gpt-5.6-terra");
		expect(pick?.note).toBeUndefined();
	});

	it("returns null only when no catalog model is configured at all", () => {
		expect(pickConfiguredAdvisor(LADDER, "openai-codex/gpt-5.6-terra", () => false)).toBeNull();
		expect(pickConfiguredAdvisor([], "x/y", () => true)).toBeNull();
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
