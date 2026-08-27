/**
 * A fake `ExtensionAPI` for unit-testing extension *behaviour*.
 *
 * Every existing suite in this repo tests a pure fold. Nothing tested what an
 * extension actually DOES when pi emits an event — which is where this harness's
 * three shipped bugs lived (2026-08-05: handlers registered behind an `if
 * (!enabled) return`, a spool deleted on failure, an unpriced model reported as
 * $0). All three needed the thing running.
 *
 * Faithfulness rules, each one load-bearing:
 *
 *  - `emit()` awaits handlers **serially in registration order**, because pi
 *    does (`core/extensions/runner.js`: `for (const ext …) for (const handler …)
 *    { await handler(event, ctx) }`). A fake that ran them concurrently would
 *    hide the "a slow handler IS the agent loop" class of bug entirely.
 *  - `ctx` is minted per emit and can be **staled** (`stale()`), after which
 *    every property access throws — that is the failure mode extensions must
 *    survive across an `await`, and the reason `verification-loop.ts` reads
 *    `mode`/`cwd` before its first one.
 *  - Everything the API records is a plain array, so a test asserts on
 *    call *counts* as well as contents. "Exactly one injection per settle" is
 *    only checkable that way.
 *
 * Not faithful, deliberately: no real session tree, no tool execution, no TUI.
 * `as unknown as ExtensionAPI` is the honest cast — this implements the surface
 * extensions in this repo actually touch, not all ~40 methods.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * pi exports `ExtensionAPI` and `ExtensionContext` but not `ExtensionMode`, so
 * derive it rather than restating the union — a mode added upstream then shows
 * up here as a type error instead of silently going untested.
 */
export type ExtensionMode = ExtensionContext["mode"];

export interface RecordedMessage {
	customType: string;
	content: string;
	display?: boolean;
	details?: unknown;
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
}

export interface RecordedUserMessage {
	content: unknown;
	options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean };
}

export interface RecordedEntry {
	customType: string;
	data: unknown;
}

export interface RecordedBusEvent {
	name: string;
	payload: unknown;
}

export interface RecordedStatus {
	key: string;
	text: string | undefined;
}

/**
 * A `ctx.ui.setWidget` call. `factory` widgets can be rendered in tests by
 * invoking the factory with a stub theme and calling `.render(width)` on the
 * returned component — that exercises the REAL pi-tui render path.
 */
export interface RecordedWidget {
	key: string;
	cleared: boolean;
	lines?: string[];
	factory?: (tui: unknown, theme: unknown) => { render(width: number): string[] };
}

export interface RecordedNotification {
	message: string;
	type?: string;
}

export interface RecordedTool {
	name: string;
	definition: Record<string, unknown>;
}

export interface RecordedCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

/**
 * The part of a pi session entry that consumers here actually read. A full
 * `SessionEntry` would couple every test to pi's internal tree types.
 */
export interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
		errorMessage?: string;
	};
}

export interface FakeCtxOptions {
	mode?: ExtensionMode;
	cwd?: string;
	/** What `ctx.ui.confirm` resolves to. Defaults to true (accept). */
	confirm?: boolean;
	idle?: boolean;
	pendingMessages?: boolean;
	/**
	 * Entries returned by `sessionManager.getBranch()` — the ACTIVE root→leaf
	 * path. Only the shape consumers actually read is modelled —
	 * `{ message: { role, content } }` — because a full SessionEntry would couple
	 * every test to pi's internal tree types.
	 */
	branch?: SessionEntryLike[];
	/**
	 * Entries returned by `sessionManager.getEntries()` — EVERY entry in the
	 * session file, abandoned branches included. Defaults to `branch`, so a test
	 * that does not care sees the old behaviour; set it to model a tree, and put
	 * the abandoned branch's snapshots LAST if the point is that a newest-wins
	 * all-entries read returns the wrong one.
	 */
	entries?: SessionEntryLike[];
	/**
	 * Hand the handler a ctx that is ALREADY stale, as happens when a session is
	 * replaced between pi emitting the event and the handler running. Every
	 * property access throws immediately.
	 */
	staleCtx?: boolean;
}

/** Convenience: a branch whose most recent assistant turn is `text`. */
export function assistantSaid(text: string): FakeCtxOptions["branch"] {
	return [
		{ message: { role: "user", content: "go" } },
		{ message: { role: "assistant", content: text } },
	];
}

/**
 * A branch whose most recent turn did not RUN — the provider refused it, or the
 * human aborted it. `stopReason` is what pi persists; see turn-outcome.ts.
 */
export function assistantFailed(stopReason: "error" | "aborted", errorMessage = "boom"): FakeCtxOptions["branch"] {
	return [
		{ message: { role: "user", content: "continue" } },
		{ message: { role: "assistant", content: "", stopReason, errorMessage } },
	];
}

export interface FakePi {
	/** Pass this to the extension factory. */
	api: ExtensionAPI;

	/** Drive a lifecycle event through every registered handler, serially. */
	/** Emits, and returns each handler's return value in registration order —
	 *  a `tool_call` verdict is a return value, not a side effect. */
	emit(event: { type: string } & Record<string, unknown>, ctxOptions?: FakeCtxOptions): Promise<unknown[]>;

	/**
	 * Invalidate the ctx handed to the CURRENT/most recent emit, simulating
	 * session replacement. Subsequent property access on it throws pi's literal
	 * message. Call this from inside a handler's awaited work to test the
	 * stale-ctx path.
	 */
	staleCurrentCtx(): void;

	/** Run a registered command's handler. Throws if the command is not registered. */
	runCommand(name: string, args?: string, ctxOptions?: FakeCtxOptions): Promise<void>;

	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	messages: RecordedMessage[];
	userMessages: RecordedUserMessage[];
	/** Number of direct ExtensionAPI.compact() calls. */
	compactions: number;
	entries: RecordedEntry[];
	busEvents: RecordedBusEvent[];
	statuses: RecordedStatus[];
	notifications: RecordedNotification[];
	/**
	 * Every `ctx.ui.setWidget` call, in order — SHARED across emits rather
	 * than merged per-emit, because widget owners paint through a held ctx
	 * long after the emit that minted it (deck, agenda), and a per-emit array
	 * would silently drop those later paints.
	 */
	widgets: RecordedWidget[];
	/** Every `ctx.ui.setEditorText` call, in order. */
	editorTexts: string[];
	tools: RecordedTool[];
	commands: Map<string, RecordedCommand>;
	shortcuts: Map<string, { description?: string }>;
	flags: Map<string, unknown>;
	activeTools: string[];
	/** Every value passed to `setSessionName`, in order. */
	sessionNames: string[];
	/** Number of graceful `ctx.shutdown()` calls. */
	shutdowns: number;
	/** pi shutdown reasons produced by graceful `ctx.shutdown()` calls. */
	shutdownReasons: string[];
	/** The current session name tracked by the fake. */
	sessionName: string | undefined;
	/** Every value `setActiveTools` was called with, in order. */
	activeToolsHistory: string[][];
}

/** pi's literal stale-context message — matched by extensions that guard on it. */
export const STALE_CTX_MESSAGE = "extension ctx is stale";

interface CtxSinks {
	statuses: RecordedStatus[];
	notifications: RecordedNotification[];
	widgets: RecordedWidget[];
	editorTexts: string[];
	shutdowns: { value: number };
	shutdownReasons: string[];
	onCompact: () => void;
}

/**
 * Sinks are SHARED with the FakePi rather than merged per emit: extensions
 * hold a ctx and write through it from detached promises and timers long
 * after the emit that minted it returned (usage's detached fetch, deck's
 * held-ctx paints). A merge-after-emit model silently drops exactly those
 * writes — which is the class of bug these tests exist to catch.
 */
function makeCtx(
	options: FakeCtxOptions,
	sinks: CtxSinks,
): {
	ctx: ExtensionContext;
	stale: () => void;
} {
	const { statuses, notifications, widgets, shutdowns } = sinks;
	let isStale = options.staleCtx === true;

	const target = {
		mode: options.mode ?? "tui",
		cwd: options.cwd ?? "/tmp/fake-repo",
		hasUI: true,
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => options.pendingMessages ?? false,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		getContextUsage: () => undefined,
		compact: () => sinks.onCompact(),
		shutdown: () => {
			sinks.shutdowns.value++;
			sinks.shutdownReasons.push("quit");
		},
		getSystemPrompt: () => "",
		model: undefined,
		scopedModels: [],
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			// Overridable: a guard's DENIED branch only exists when the human says
			// no, and hardcoding `true` made that branch untestable.
			confirm: async () => options.confirm ?? true,
			select: async () => undefined,
			input: async () => undefined,
			setWidget: (key: string, content: unknown) => {
				if (content === undefined) widgets.push({ key, cleared: true });
				else if (Array.isArray(content)) widgets.push({ key, cleared: false, lines: content as string[] });
				else widgets.push({ key, cleared: false, factory: content as RecordedWidget["factory"] });
			},
			setWorkingMessage: () => {},
			// Recorded, because "hand the result back for review instead of
			// sending it" is a behavioural claim (brief, HIV-1798) and the only
			// way to check it is to see what was written to the editor.
			setEditorText: (text: string) => {
				sinks.editorTexts.push(text);
			},
		},
		sessionManager: {
			// `entries` defaults to `branch`, so every existing test keeps its old
			// behaviour — but the two can now DIFFER, which is the whole point.
			//
			// They used to be the same array unconditionally, and that made the
			// distinction this harness exists to model invisible: a session is a
			// tree, `getBranch()` is the root→leaf path and `getEntries()` is every
			// entry the file holds, including abandoned branches. A test could not
			// tell a branch-scoped read from an all-entries read, so the whole
			// class of bug HIV-1972 fixes was untestable here (and an extension
			// reading the wrong one passed review twice).
			getEntries: () => options.entries ?? options.branch ?? [],
			getBranch: () => options.branch ?? [],
			getEntry: () => undefined,
			getLeafEntry: () => undefined,
		},
		modelRegistry: {},
	};

	// A Proxy is the only way to make EVERY access throw once stale, including
	// the ones a handler captured a reference to but calls later.
	const ctx = new Proxy(target, {
		get(t, prop, receiver) {
			if (isStale) throw new Error(STALE_CTX_MESSAGE);
			return Reflect.get(t, prop, receiver);
		},
	}) as unknown as ExtensionContext;

	return { ctx, stale: () => { isStale = true; } };
}

export function createFakePi(): FakePi {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const messages: RecordedMessage[] = [];
	const userMessages: RecordedUserMessage[] = [];
	let compactions = 0;
	const entries: RecordedEntry[] = [];
	const busEvents: RecordedBusEvent[] = [];
	const statuses: RecordedStatus[] = [];
	const notifications: RecordedNotification[] = [];
	const tools: RecordedTool[] = [];
	const commands = new Map<string, RecordedCommand>();
	const shortcuts = new Map<string, { description?: string }>();
	const flags = new Map<string, unknown>();
	const activeToolsHistory: string[][] = [];
	const sessionNames: string[] = [];
	const shutdowns = { value: 0 };
	const shutdownReasons: string[] = [];
	let sessionName: string | undefined;
	let activeTools: string[] = [];

	let staleCurrent: (() => void) | null = null;

	const busHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const widgets: RecordedWidget[] = [];
	const editorTexts: string[] = [];

	const api = {
		on(event: string, handler: (e: unknown, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: { name: string } & Record<string, unknown>) {
			tools.push({ name: tool.name, definition: tool });
			// pi force-activates every registered extension tool at session build
			// (agent-session.js:157/:2003) — the fake must do the same or an
			// opt-in gate looks like it works when it does not.
			activeTools.push(tool.name);
		},
		registerCommand(name: string, options: { description?: string; handler: RecordedCommand["handler"] }) {
			commands.set(name, { name, description: options.description, handler: options.handler });
		},
		registerShortcut(shortcut: string, options: { description?: string }) {
			shortcuts.set(shortcut, { description: options.description });
		},
		registerFlag(name: string, options: { default?: unknown }) {
			flags.set(name, options.default);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		sendMessage(
			message: { customType: string; content: string; display?: boolean; details?: unknown },
			options?: RecordedMessage["options"],
		) {
			messages.push({ ...message, options });
		},
		sendUserMessage(content: unknown, options?: RecordedUserMessage["options"]) {
			userMessages.push({ content, options });
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ customType, data });
		},
		setSessionName(name: string) {
			sessionName = name;
			sessionNames.push(name);
		},
		getSessionName: () => sessionName,
		setLabel() {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		getActiveTools: () => [...activeTools],
		getAllTools: () => tools.map((t) => ({ name: t.name })),
		setActiveTools(names: string[]) {
			activeTools = [...names];
			activeToolsHistory.push([...names]);
		},
		getCommands: () =>
			Array.from(commands.values()).map((c) => ({
				name: c.name,
				source: c.name.startsWith("skill:") ? ("skill" as const) : ("extension" as const),
			})),
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		compact: () => { compactions++; },
		setThinkingLevel() {},
		registerProvider() {},
		unregisterProvider() {},
		events: {
			emit(name: string, payload: unknown) {
				busEvents.push({ name, payload });
				for (const h of busHandlers.get(name) ?? []) h(payload);
			},
			on(name: string, handler: (payload: unknown) => void) {
				const list = busHandlers.get(name) ?? [];
				list.push(handler);
				busHandlers.set(name, list);
				return () => {
					const current = busHandlers.get(name) ?? [];
					busHandlers.set(
						name,
						current.filter((h) => h !== handler),
					);
				};
			},
		},
	};

	const fake: FakePi = {
		api: api as unknown as ExtensionAPI,

		async emit(event, ctxOptions = {}) {
			const { ctx, stale } = makeCtx(ctxOptions, {
				statuses, notifications, widgets, editorTexts, shutdowns, shutdownReasons,
				onCompact: () => { compactions++; },
			});
			staleCurrent = stale;
			// RETURN the handler results. Some events are not notifications — a
			// `tool_call` handler's return value is the verdict pi acts on
			// (`{block, reason, terminate}`), so a fake that swallowed it could
			// only ever test that a guard ran, never WHAT it decided.
			const results: unknown[] = [];
			for (const handler of handlers.get(event.type) ?? []) {
				results.push(await handler(event, ctx));
			}
			return results;
		},

		staleCurrentCtx() {
			staleCurrent?.();
		},

		async runCommand(name, args = "", ctxOptions = {}) {
			const command = commands.get(name);
			if (!command) throw new Error(`no command registered named "${name}"`);
			const { ctx } = makeCtx(ctxOptions, {
				statuses, notifications, widgets, editorTexts, shutdowns, shutdownReasons,
				onCompact: () => { compactions++; },
			});
			await command.handler(args, ctx);
		},

		handlers,
		messages,
		userMessages,
		get compactions() { return compactions; },
		entries,
		busEvents,
		statuses,
		notifications,
		widgets,
		editorTexts,
		tools,
		commands,
		shortcuts,
		flags,
		get activeTools() {
			return [...activeTools];
		},
		sessionNames,
		get shutdowns() {
			return shutdowns.value;
		},
		shutdownReasons,
		get sessionName() {
			return sessionName;
		},
		activeToolsHistory,
	};

	return fake;
}
