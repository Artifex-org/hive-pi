/**
 * A provider-terminated turn is not retried unchanged (cutoff.ts).
 *
 * The pure half pins the decision; the native half runs a real AgentSession
 * with pi's own retry enabled, because the property that matters — what the
 * RETRIED request contains, and whether a queued operator message reaches the
 * model before the interrupted work does — is pi's behaviour as much as ours.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { decideCutOff, installCutOffGuard, isCutOff, MAX_CUT_OFFS, rehydrateCap, stoppedRecap, THINKING_CAP_ENTRY } from "../extensions/agenda/cutoff.ts";
import { createFakePi } from "./fake-pi.ts";

const terminated = (): AssistantMessage => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });

describe("isCutOff", () => {
	it("is a long turn whose provider error says terminated", () => {
		expect(isCutOff(terminated(), 15 * 60_000)).toBe(true);
	});

	it("is not a short termination — a transport blip pi's identical retry is right for", () => {
		expect(isCutOff(terminated(), 3_000)).toBe(false);
	});

	it("is not any other error, nor a completed turn", () => {
		expect(isCutOff(fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }), 15 * 60_000)).toBe(false);
		expect(isCutOff(fauxAssistantMessage("done"), 15 * 60_000)).toBe(false);
	});
});

describe("decideCutOff", () => {
	it("first cut-off: a retry notice naming the length and asking for an early tool call", () => {
		const d = decideCutOff({ streak: 1, durationsMs: [15 * 60_000], pending: false });
		expect(d.stop).toBe(false);
		expect(d.notice).toContain("after 15 min");
		expect(d.notice).toContain("emit a tool call early");
	});

	it(`stops at the ${MAX_CUT_OFFS}nd consecutive cut-off`, () => {
		const d = decideCutOff({ streak: 2, durationsMs: [15 * 60_000, 11 * 60_000], pending: false });
		expect(d.stop).toBe(true);
		expect(d.notice).toContain("15 min, 11 min");
		expect(d.notice).toContain("waiting for an operator");
	});

	it("a queued operator message wins over stopping — answering a person is not an automatic retry", () => {
		const d = decideCutOff({ streak: 3, durationsMs: [1, 2, 3], pending: true });
		expect(d.stop).toBe(false);
		expect(d.notice).toContain("operator message is queued");
	});

	it("the stopped recap leads with what is needed", () => {
		expect(stoppedRecap([15 * 60_000, 15 * 60_000])).toMatch(/^Needs operator: provider cut off 2 turns in a row \(15m, 15m\)/);
	});
});

interface Harness {
	faux: ReturnType<typeof fauxProvider>;
	prompt(text: string): Promise<void>;
	pi(): ExtensionAPI;
	guard(): ReturnType<typeof installCutOffGuard>;
	agendaNotices(): string[];
	thinking(): string;
	dispose(): Promise<void>;
}

async function harness(): Promise<Harness> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-agenda-cutoff-"));
	const faux = fauxProvider({
		provider: "agenda-cutoff-test",
		models: [{ id: "test", name: "test", reasoning: true, input: ["text"], contextWindow: 16_000, maxTokens: 1_000 }],
	});
	const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	// pi's real retry, fast: the property under test is what the retry SENDS.
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 }, compaction: { enabled: false } });
	let api: ExtensionAPI | undefined;
	let guard: ReturnType<typeof installCutOffGuard> | undefined;
	const extension: ExtensionFactory = (pi) => {
		api = pi;
		guard = installCutOffGuard(pi, { minMs: 0 });
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [extension],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "high",
		settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(), noTools: "all",
	});
	await session.bindExtensions({ mode: "rpc" });
	return {
		faux,
		prompt: (text) => session.prompt(text),
		pi: () => api as ExtensionAPI,
		guard: () => guard as ReturnType<typeof installCutOffGuard>,
		agendaNotices: () => session.messages
			.filter((m) => m.role === "custom" && m.customType === "agenda")
			.map((m) => (m as { content: unknown }).content as string),
		thinking: () => session.thinkingLevel,
		dispose: async () => {
			session.dispose();
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

/** The text of every message the provider saw, in order, by role. */
function seen(context: { messages: readonly unknown[] }): string[] {
	return context.messages.map((raw) => {
		const m = raw as { role: string; content: unknown };
		const text = typeof m.content === "string"
			? m.content
			: (m.content as { type: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text).join("");
		return `${m.role}: ${text}`;
	});
}

describe("a cut-off turn against pi's real retry", () => {
	it("the retry carries the notice and a capped thinking level, and the cap lifts after a completed turn", async () => {
		const h = await harness();
		try {
			const retried: { messages: string[]; reasoning: unknown }[] = [];
			h.faux.setResponses([
				terminated(),
				(context, options) => {
					retried.push({ messages: seen(context), reasoning: options?.reasoning });
					return fauxAssistantMessage("Resumed in a small step.");
				},
			]);
			await h.prompt("Do the long task.");

			expect(h.faux.state.callCount).toBe(2);
			expect(retried[0].messages.at(-1)).toMatch(/^user: Your last turn was cut off by the model provider/);
			expect(retried[0].reasoning).toBe("low");
			expect(h.thinking()).toBe("high");
			expect(h.guard().stopped()).toBeNull();
		} finally {
			await h.dispose();
		}
	}, 15_000);

	it("a steer queued during the cut-off turn reaches the retried request, after the notice", async () => {
		const h = await harness();
		try {
			let retry: string[] = [];
			h.faux.setResponses([
				() => {
					// hive-remote delivers an operator steer exactly this way.
					h.pi().sendUserMessage("Operator: switch to the smaller fix.", { deliverAs: "steer" });
					return terminated();
				},
				(context) => {
					retry = seen(context);
					return fauxAssistantMessage("Switching to the smaller fix.");
				},
			]);
			await h.prompt("Do the long task.");

			expect(retry.at(-2)).toMatch(/^user: .*operator message is queued/);
			expect(retry.at(-1)).toBe("user: Operator: switch to the smaller fix.");
		} finally {
			await h.dispose();
		}
	}, 15_000);

	it("a queued follow-up is delivered as soon as the told-to-stop retry ends — not after more cut-offs", async () => {
		const h = await harness();
		try {
			const contexts: string[][] = [];
			h.faux.setResponses([
				() => {
					h.pi().sendUserMessage("Operator: status please.", { deliverAs: "followUp" });
					return terminated();
				},
				(context) => {
					contexts.push(seen(context));
					return fauxAssistantMessage("Stopping for the queued message.");
				},
				(context) => {
					contexts.push(seen(context));
					return fauxAssistantMessage("Status: half done.");
				},
			]);
			await h.prompt("Do the long task.");

			expect(h.faux.state.callCount).toBe(3);
			expect(contexts[0].at(-1)).toMatch(/operator message is queued.*end your turn now/);
			expect(contexts[1].at(-1)).toBe("user: Operator: status please.");
		} finally {
			await h.dispose();
		}
	}, 15_000);

	it("a second consecutive cut-off stops the automatic retries and marks the session as needing a person", async () => {
		const h = await harness();
		try {
			h.faux.setResponses([terminated(), terminated(), fauxAssistantMessage("never sent")]);
			await h.prompt("Do the long task.");

			// pi would retry up to 3 times; the guard stopped it after the second.
			expect(h.faux.state.callCount).toBe(2);
			expect(h.faux.getPendingResponseCount()).toBe(1);
			expect(h.agendaNotices()).toHaveLength(2);
			expect(h.agendaNotices()[1]).toContain("Automatic retries are stopped");
			expect(h.guard().stopped()).toMatch(/^Needs operator/);
		} finally {
			await h.dispose();
		}
	}, 15_000);

	it("a person's next prompt clears the stop, and a completed turn restores the thinking level", async () => {
		const h = await harness();
		try {
			h.faux.setResponses([terminated(), terminated(), fauxAssistantMessage("Back, in small steps.")]);
			await h.prompt("Do the long task.");
			expect(h.thinking()).toBe("low");

			await h.prompt("Continue.");
			expect(h.guard().stopped()).toBeNull();
			expect(h.thinking()).toBe("high");
		} finally {
			await h.dispose();
		}
	}, 15_000);
});

describe("the thinking cap survives a reload", () => {
	it("rehydrates the newest cap entry on the branch; a release clears it", () => {
		const capped = { customType: THINKING_CAP_ENTRY, data: { from: "xhigh", to: "low" } };
		expect(rehydrateCap([capped])).toEqual({ from: "xhigh", to: "low" });
		expect(rehydrateCap([capped, { customType: THINKING_CAP_ENTRY, data: { released: true } }])).toBeNull();
		expect(rehydrateCap([{ customType: THINKING_CAP_ENTRY, data: { from: "bogus", to: "low" } }])).toBeNull();
		expect(rehydrateCap([])).toBeNull();
	});

	it("a resumed session restores the operator's level at its first completed turn", async () => {
		const fake = createFakePi();
		let level = "low";
		const set = vi.fn((next: string) => { level = next; });
		fake.api.getThinkingLevel = () => level as ReturnType<ExtensionAPI["getThinkingLevel"]>;
		fake.api.setThinkingLevel = set;
		installCutOffGuard(fake.api);
		await fake.emit({ type: "session_start" }, { branch: [{ customType: THINKING_CAP_ENTRY, data: { from: "xhigh", to: "low" } }] });
		await fake.emit({ type: "turn_start" });
		await fake.emit({ type: "turn_end", outcome: "completed", message: fauxAssistantMessage("ok"), toolResults: [], entries: [] });
		expect(set).toHaveBeenCalledWith("xhigh");
		expect(fake.entries.at(-1)).toMatchObject({ customType: THINKING_CAP_ENTRY, data: { released: true } });
	});

	it("a model that offers nothing below the current level is left alone", async () => {
		const fake = createFakePi();
		let level = "high";
		// pi clamps an unavailable level to the nearest the model offers.
		fake.api.getThinkingLevel = () => level as ReturnType<ExtensionAPI["getThinkingLevel"]>;
		fake.api.setThinkingLevel = (next) => { level = next === "low" ? "high" : next; };
		installCutOffGuard(fake.api, { minMs: 0 });
		await fake.emit({ type: "session_start" });
		await fake.emit({ type: "turn_start" });
		await fake.emit({ type: "turn_end", outcome: "error", message: terminated(), toolResults: [], entries: [] }, { pendingMessages: false });
		expect(level).toBe("high");
		expect(fake.entries.some((e) => e.customType === THINKING_CAP_ENTRY)).toBe(false);
	});
});
