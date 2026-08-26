/**
 * readiness — what this environment can already do, established before the
 * agent asks (HIV-1969).
 *
 * THE PROBLEM, MEASURED. Capabilities in this harness announce themselves by
 * failing. `dev_db_start` reports missing Postgres binaries on first call;
 * `pi-mcp-adapter` defaults every server to `lifecycle: "lazy"` so the first
 * `mcp__*` call pays connect + handshake mid-task; a delegation dies on an
 * OpenRouter 402 that was true before the session began. Three of those cost a
 * turn each on 2026-08-16 alone (`~/.pi/agent/papercuts.md`).
 *
 * FOUR MECHANICAL CONSTRAINTS, the same ones `workflow/index.ts` documents:
 *
 *  1. **Nothing slow in a handler.** pi awaits event handlers serially, so a
 *     handler that awaited seven probes WOULD BE the agent loop's first turn.
 *     `session_start` therefore does nothing but capture ctx, rehydrate, and
 *     arm an unref'd timer; every probe runs after the handler has returned.
 *  2. No `context` / `before_provider_request` / `before_provider_headers`
 *     handler — registering one switches on transform work pi otherwise skips,
 *     on every LLM call. `test/no-forbidden-events.test.ts` fails the build on it.
 *  3. Nothing mutable at module scope: pi builds a fresh jiti per extension with
 *     `moduleCache: false`, so state lives in the factory closure.
 *  4. Nothing here injects a turn or re-enters the agent loop, so the
 *     one-injector invariant in `agenda/driver.ts` is untouched.
 *
 * WHAT IT DOES NOT DO, deliberately: there is **no push**. `background`'s
 * asymmetry says an injection lands unconditionally and is therefore the most
 * expensive text per byte, so it must be reserved for a completion the agent is
 * waiting on. "Postgres finished warming" is only worth a turn if the agent
 * asked for Postgres and was refused — and this extension has no such signal
 * yet. Until it does, readiness is a snapshot (once, at first agent start) plus
 * a tool the model calls when it cares. A timer that injected would bill a turn
 * per firing whether or not anything changed; `agenda/loop.ts` states the
 * doctrine and the economics agree.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { registerGuardedTool } from "../guards-common/capability.ts";
import { DECK_SECTION_CHANNEL, DECK_SYNC_CHANNEL, type DeckSectionEvent } from "../deck/protocol.ts";
import { realDeps, runAll } from "./probes.ts";
import {
	applyResults,
	emptyReadiness,
	isEmpty,
	orderedResults,
	READINESS_ENTRY_TYPE,
	rehydrateReadiness,
	renderLines,
	snapshotBlock,
	summaryLine,
	toEntry,
	type ReadinessState,
} from "./state.ts";

/**
 * The probes spawn `gh` and `git` and reach two HTTP endpoints; they write
 * nothing anywhere.
 */
const PROBE_CAPABILITY = {
	executes: true,
	writesExemptBecause: "probes read only — no path is written by any of them",
};

/** Off switch for a machine where probing is unwanted (a factory container). */
function disabled(env: Record<string, string | undefined>): boolean {
	return env.PI_READINESS === "0";
}

/**
 * The snapshot injection is separately gated, and **opt-in** (`=1`).
 *
 * Default-on would ship the one arm this work is supposed to MEASURE on
 * plausibility — HIV-1633's own text says not to, and HIV-1969's verification
 * section commits to keeping it off until HIV-1629's eval corpus can tell
 * whether it moves mean turns and tool calls. The probes, the tool, the deck
 * and `/readiness` all work regardless; this flag governs only the tokens that
 * enter the model's context unasked.
 */
function snapshotEnabled(env: Record<string, string | undefined>): boolean {
	return env.PI_READINESS_SNAPSHOT === "1";
}

export default function (pi: ExtensionAPI) {
	if (disabled(process.env)) return;

	let state: ReadinessState = emptyReadiness(Date.now());
	let latestCtx: ExtensionContext | null = null;
	let probing = false;
	/** Armed by session_start, consumed by the first before_agent_start. */
	let snapshotPending = false;

	const publish = () => {
		try {
			pi.appendEntry(READINESS_ENTRY_TYPE, toEntry(state));
		} catch {
			/* session went away; the in-memory copy still drives this process */
		}
		paintDeck();
	};

	/**
	 * Only rows that are NOT ready reach the deck. A section listing six green
	 * rows would take the band from publishers describing something happening,
	 * to say that nothing is wrong — which is what the collapsed summary is for.
	 */
	const paintDeck = () => {
		const lines = renderLines(state);
		const event: DeckSectionEvent = {
			section: "env",
			state: lines.length === 0 ? null : { kind: "lines", summary: summaryLine(state), lines },
		};
		try {
			pi.events.emit(DECK_SECTION_CHANNEL, event);
		} catch {
			/* no bus, or no deck loaded */
		}
	};

	const probe = async (): Promise<ReadinessState> => {
		if (probing) return state;
		probing = true;
		try {
			const deps = realDeps(() => toolNames(pi), process.cwd());
			const results = await runAll(deps);
			const applied = applyResults(state, results);
			state = applied.state;
			if (applied.changed) publish();
			return state;
		} finally {
			probing = false;
		}
	};

	/**
	 * ONE delayed re-probe, and it exists for a measured reason.
	 *
	 * `pi-mcp-adapter` starts its initialization from `session_start` without
	 * awaiting it, so at the moment the first probe runs there is usually not a
	 * single `mcp__*` tool registered yet. The first pass therefore reports every
	 * server as `unknown`; this second pass, after the adapter has had time to
	 * register, is what turns that into the real answer.
	 *
	 * It is a settle, not a poll: exactly one follow-up, unref'd so it can never
	 * hold the process open, and it publishes only if something actually moved
	 * (`applyResults` reports that). A recurring timer here would be the periodic
	 * status injection `background/README.md` argues against — one that costs
	 * nothing in context still costs an `appendEntry` per firing.
	 */
	const MCP_SETTLE_MS = 6_000;
	const scheduleSettle = () => {
		const timer = setTimeout(() => {
			void probe();
		}, MCP_SETTLE_MS);
		timer.unref?.();
	};

	pi.on("session_start", (event, ctx) => {
		latestCtx = ctx;
		const reason = (event as { reason?: string }).reason;
		// Restore first: a `/reload` or a fork inherits a perfectly good readout,
		// and re-probing from zero would blank the deck for a few seconds for
		// nothing. A fresh session has nothing to restore.
		if (reason !== "new") {
			try {
				state = rehydrateReadiness(ctx.sessionManager.getEntries() as readonly unknown[]) ?? state;
			} catch {
				/* session replaced mid-read */
			}
		}
		snapshotPending = reason === "startup" || reason === "new";
		paintDeck();
		// Detached: the handler returns now, the probes run after it. This is the
		// whole reason the extension does not cost startup latency.
		const timer = setTimeout(() => {
			void probe().then(scheduleSettle);
		}, 0);
		timer.unref?.();
	});

	pi.events.on(DECK_SYNC_CHANNEL, () => paintDeck());

	/**
	 * The snapshot (HIV-1633), injected ONCE.
	 *
	 * Placed on the same seam and with the same discipline as
	 * `session-context.ts`: first agent start of a fresh session only, never on
	 * resume/fork (where it is already in the transcript) and never per turn —
	 * a per-turn injection is the classic prompt-cache bug (technique #1).
	 *
	 * It ships whatever the probes have established BY THEN and does not wait
	 * for them. Waiting would trade the cost this extension exists to remove for
	 * the same cost in a different place.
	 */
	pi.on("before_agent_start", () => {
		if (!snapshotPending) return;
		snapshotPending = false;
		if (!snapshotEnabled(process.env) || isEmpty(state)) return;
		const text = snapshotBlock(state, Date.now());
		if (!text) return;
		// The injection shape `session-context.ts` uses: a custom-typed message
		// returned from the handler, `display: false` so it is context and not
		// something the operator has to scroll past.
		return { message: { customType: "readiness-snapshot", content: text, display: false } };
	});

	registerGuardedTool(pi, {
		name: "readiness",
		label: "Readiness",
		capability: PROBE_CAPABILITY,
		description: [
			"What this environment can already do: MCP servers, credentials, the disposable Postgres,",
			"the headless browser, and the checkout. Each row names the tool that uses the capability and,",
			"when it is not ready, what to do about it. Call it instead of discovering a missing capability",
			"by failing — and again after fixing one, to confirm.",
		].join(" "),
		promptSnippet: "Check which environment capabilities are ready before relying on one",
		promptGuidelines: [
			"Call readiness before a task that depends on a database, a browser, an MCP server or a delegation — it is one call against several failed ones.",
			"A `warming` MCP row means the tools are cached but nothing has connected: the first call works, it just pays the connect.",
			"A product MCP (`borealis` / `aurorasvc`) only appears in that project's checkout. A cached tool count from the other product is not this session being ready.",
			"`unknown` means the probe could not tell, NOT that the capability is missing.",
		],
		parameters: Type.Object({
			refresh: Type.Optional(
				Type.Boolean({ description: "Re-run the probes instead of returning the last result. Default true." }),
			),
		}),
		renderCall: (_args, theme) => new Text(theme.fg("dim", "⛭ readiness"), 0, 0),
		renderResult: (_result, _options, theme) => new Text(theme.fg("dim", summaryLine(state)), 0, 0),
		async execute(_id, params) {
			if (params.refresh !== false) await probe();
			const rows = orderedResults(state);
			return {
				content: [
					{
						type: "text" as const,
						text: rows.length === 0 ? "No probes have reported yet." : [summaryLine(state), ...renderLines(state, { all: true })].join("\n"),
					},
				],
				details: { revision: state.revision, results: rows },
			};
		},
	});

	pi.registerCommand("readiness", {
		description: "What the environment can do — re-probes, then prints every row",
		handler: async (_args: string, ctx: ExtensionContext): Promise<void> => {
			// Read the ctx property before the await: a ctx can go stale across one.
			const ui = ctx?.ui ?? latestCtx?.ui;
			await probe();
			const body = isEmpty(state)
				? "No probes have reported yet."
				: [summaryLine(state), ...renderLines(state, { all: true })].join("\n");
			ui?.notify?.(body, "info");
		},
	});
}

/** Every registered tool name, for the per-server MCP probe. */
function toolNames(pi: ExtensionAPI): string[] {
	try {
		return (pi.getAllTools?.() ?? []).map((tool: { name?: unknown }) => (typeof tool.name === "string" ? tool.name : ""));
	} catch {
		return [];
	}
}
