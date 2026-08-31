import { describe, expect, it } from "vitest";
import askExtension, { sanitizeQuestions, type AskDetails } from "../extensions/ask/index.ts";
import { createFakePi } from "./fake-pi.ts";
import {
	allAnswered,
	answers,
	initState,
	reduce,
	type AskAction,
	type AskQuestion,
	type AskState,
} from "../extensions/ask/state.ts";
import { PLAIN_ASK_STYLE, renderAskLines } from "../extensions/ask/view.ts";

const OPTIONS = [
	{ label: "Postgres (Recommended)", description: "the boring choice" },
	{ label: "SQLite" },
	{ label: "Sled" },
];

function q(id: string, multiSelect = false): AskQuestion {
	return { id, header: id.slice(0, 12), question: `Which ${id}?`, multiSelect, options: OPTIONS };
}

function run(state: AskState, ...actions: AskAction[]) {
	let effect: ReturnType<typeof reduce>["effect"] = null;
	for (const action of actions) {
		({ state, effect } = reduce(state, action));
	}
	return { state, effect };
}

describe("ask reducer", () => {
	it("digit press commits and advances a single-select; the last commit auto-submits", () => {
		const first = run(initState([q("db"), q("cache")]), { type: "digit", digit: 2 });
		expect(first.state.active).toBe(1);
		expect(first.effect).toBeNull();

		const second = run(first.state, { type: "digit", digit: 1 });
		expect(second.effect).toEqual({ kind: "submit" });
		expect(answers(second.state)).toEqual({ db: ["SQLite"], cache: ["Postgres (Recommended)"] });
	});

	it("Enter-Enter is the fast path: cursor starts on the recommended first option", () => {
		const { effect, state } = run(initState([q("db")]), { type: "enter" });
		expect(effect).toEqual({ kind: "submit" });
		expect(answers(state)).toEqual({ db: ["Postgres (Recommended)"] });
	});

	it("multi-select: space toggles in place, enter commits the question", () => {
		const toggled = run(initState([q("features", true)]), { type: "space" }, { type: "cursor", delta: 1 }, { type: "space" });
		expect(toggled.effect).toBeNull();
		expect(toggled.state.drafts[0].selected.sort()).toEqual([0, 1]);

		const committed = run(toggled.state, { type: "enter" });
		expect(committed.effect).toEqual({ kind: "submit" });
		expect(answers(committed.state).features).toEqual(["Postgres (Recommended)", "SQLite"]);
	});

	it("typing lands in the text field with no mode switch; text alone is the Other answer", () => {
		const typed = run(initState([q("db")]), { type: "typed", text: "du" }, { type: "typed", text: "ckdb" });
		expect(typed.state.focus).toBe("text");
		const submitted = run(typed.state, { type: "enter" });
		expect(submitted.effect).toEqual({ kind: "submit" });
		expect(answers(submitted.state)).toEqual({ db: ["duckdb"] });
	});

	it("text WITH a selection is a note appended after the labels", () => {
		const state0 = initState([q("db", true)]);
		const picked = run(state0, { type: "space" }, { type: "typed", text: "only for the API layer" });
		const submitted = run(picked.state, { type: "enter" });
		expect(answers(submitted.state).db).toEqual(["Postgres (Recommended)", "only for the API layer"]);
	});

	it("esc in text returns to options and keeps the text; esc-esc on options cancels; any action disarms", () => {
		const inText = run(initState([q("db")]), { type: "typed", text: "x" });
		const backOut = run(inText.state, { type: "escape" });
		expect(backOut.state.focus).toBe("options");
		expect(backOut.state.drafts[0].text).toBe("x");
		expect(backOut.effect).toBeNull();

		const armed = run(backOut.state, { type: "escape" });
		expect(armed.state.escArmed).toBe(true);
		const disarmed = run(armed.state, { type: "cursor", delta: 1 });
		expect(disarmed.state.escArmed).toBe(false);

		const cancelled = run(disarmed.state, { type: "escape" }, { type: "escape" });
		expect(cancelled.effect).toEqual({ kind: "cancel" });
	});

	it("never submits past an unanswered question — Enter on the last jumps back to the gap", () => {
		const state0 = initState([q("db"), q("cache")]);
		const onSecond = run(state0, { type: "nextQuestion" }, { type: "digit", digit: 1 });
		// cache answered, db is not; the commit landed on the LAST question.
		expect(onSecond.effect).toBeNull();
		expect(onSecond.state.active).toBe(0);
		expect(allAnswered(onSecond.state)).toBe(false);
	});

	it("backspace edits only the text field", () => {
		const typed = run(initState([q("db")]), { type: "typed", text: "ab" }, { type: "backspace" });
		expect(typed.state.drafts[0].text).toBe("a");
		const onOptions = run(initState([q("db")]), { type: "backspace" });
		expect(onOptions.state.drafts[0].text).toBe("");
	});
});

describe("ask view", () => {
	it("chips render only for multi-question sets, with answered marks and progress", () => {
		const single = renderAskLines(initState([q("db")]), PLAIN_ASK_STYLE);
		expect(single[0]).toContain("Which db?");

		const two = run(initState([q("db"), q("cache")]), { type: "digit", digit: 1 });
		const lines = renderAskLines(two.state, PLAIN_ASK_STYLE);
		expect(lines[0]).toContain("✓ db");
		expect(lines[0]).toContain("2/2");
	});

	it("the text row switches placeholder between Other and note", () => {
		const fresh = renderAskLines(initState([q("db")]), PLAIN_ASK_STYLE).join("\n");
		expect(fresh).toContain("Other — type your own answer");

		const picked = run(initState([q("db", true)]), { type: "space" });
		expect(renderAskLines(picked.state, PLAIN_ASK_STYLE).join("\n")).toContain("add a note");
	});

	it("escArmed swaps the hint to the dismissal warning", () => {
		const armed = run(initState([q("db")]), { type: "escape" });
		expect(renderAskLines(armed.state, PLAIN_ASK_STYLE).join("\n")).toContain("esc again to dismiss");
	});
});

describe("ask execute fallbacks", () => {
	const PARAMS = {
		questions: [
			{ id: "color", header: "Color", question: "Which color?", options: [{ label: "Red (Recommended)" }, { label: "Blue" }] },
		],
	};

	function tool() {
		const fake = createFakePi();
		askExtension(fake.api);
		const registered = fake.tools.find((entry) => entry.name === "ask_user_question");
		if (!registered) throw new Error("tool not registered");
		return {
			fake,
			execute: registered.definition.execute as (
				id: string,
				params: unknown,
				signal?: unknown,
				onUpdate?: unknown,
				ctx?: unknown,
			) => Promise<{ content: Array<{ text: string }>; details: AskDetails }>,
		};
	}

	function ctxOf(mode: string, overrides: Record<string, unknown> = {}, pendingMessages = false) {
		return {
			mode,
			hasPendingMessages: () => pendingMessages,
			ui: {
				select: async () => undefined,
				input: async () => undefined,
				notify: () => {},
				...overrides,
			},
		};
	}

	it("headless modes return the no_ui envelope instead of hanging on a modal", async () => {
		const { execute } = tool();
		const result = await execute("call-1", PARAMS, undefined, undefined, ctxOf("print"));
		expect(result.details.no_ui).toBe(true);
		expect(result.content[0].text).toContain("ask the user directly");
	});

	it("rpc mode walks select/input; a dismissed select reports dismissal", async () => {
		const { execute, fake } = tool();
		const result = await execute("call-1", PARAMS, undefined, undefined, ctxOf("rpc"));
		expect(result.details.dismissed).toBe(true);
		// The pending signal was raised and then cleared.
		const askEvents = fake.busEvents.filter((event) => event.name === "deck.section");
		expect(askEvents.length).toBe(2);
		expect((askEvents[1].payload as { state: unknown }).state).toBeNull();
	});

	it("cancels an RPC selection when the agent turn is interrupted", async () => {
		const { execute } = tool();
		const controller = new AbortController();
		const pending = execute(
			"call-1",
			PARAMS,
			controller.signal,
			undefined,
			ctxOf("rpc", { select: async () => new Promise<string>(() => {}) }),
		);
		await Promise.resolve();
		controller.abort();
		expect((await pending).details.interrupted).toBe(true);
	});

	it("rpc mode returns picked labels keyed by id", async () => {
		const { execute } = tool();
		const ctx = ctxOf("rpc", { select: async (_title: string, options: string[]) => options[1] });
		const result = await execute("call-1", PARAMS, undefined, undefined, ctx);
		expect(result.details.answers).toEqual({ color: ["Blue"] });
		expect(result.content[0].text).toContain("Color: Blue");
	});

	it("a message already queued supersedes the question — no overlay, no deck signal", async () => {
		const { execute, fake } = tool();
		const custom = async () => {
			throw new Error("overlay must not open when a message is queued");
		};
		const result = await execute("call-1", PARAMS, undefined, undefined, ctxOf("tui", { custom }, true));
		expect(result.details.superseded).toBe(true);
		expect(result.content[0].text).toContain("A user message is waiting");
		expect(fake.busEvents.filter((event) => event.name === "deck.section").length).toBe(0);
	});

	it("a message arriving while the overlay is open closes it as superseded", async () => {
		const { execute, fake } = tool();
		const custom = async (
			factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown,
		) => {
			return new Promise((resolve) => {
				factory({ requestRender: () => {} }, {}, undefined, resolve);
			});
		};
		const pending = execute("call-1", PARAMS, undefined, undefined, ctxOf("tui", { custom }));
		await fake.emit({ type: "input", text: "actually, do X instead", source: "interactive" });
		const result = await pending;
		expect(result.details.superseded).toBe(true);
		// The pending deck signal was raised and then cleared.
		const askEvents = fake.busEvents.filter((event) => event.name === "deck.section");
		expect(askEvents.length).toBe(2);
		expect((askEvents[1].payload as { state: unknown }).state).toBeNull();
	});

	it("cancels the TUI overlay when the agent turn is interrupted", async () => {
		const { execute } = tool();
		const controller = new AbortController();
		const custom = async (
			factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown,
		) =>
			new Promise((resolve) => {
				factory({ requestRender: () => {} }, {}, undefined, resolve);
			});
		const pending = execute("call-1", PARAMS, controller.signal, undefined, ctxOf("tui", { custom }));
		await Promise.resolve();
		controller.abort();
		expect((await pending).details.interrupted).toBe(true);
	});
});

describe("sanitizeQuestions", () => {
	it("normalizes ids, dedupes collisions, clamps headers, drops extra options", () => {
		const cleaned = sanitizeQuestions([
			{ id: "Auth Method!", header: "A very long header", question: "?", options: [{ label: "a" }, { label: "b" }] },
			{ id: "auth_method", header: "ok", question: "?", options: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" }] },
			{ id: "", header: "x", question: "?", options: [{ label: "a" }, { label: "b" }] },
		]);
		expect(cleaned[0].id).toBe("auth_method");
		expect(cleaned[1].id).toBe("q2_auth_method");
		expect(cleaned[2].id).toBe("q3");
		expect(cleaned[0].header.length).toBeLessThanOrEqual(12);
		expect(cleaned[1].options).toHaveLength(4);
	});
});
