/**
 * opmode — the session's OPERATING mode: what the harness allows.
 *
 * The posture axis, orthogonal to the model axis hive-remote's `set_mode`
 * already drives. See modes.ts for the closed set and, more importantly, for
 * the rule that decides what may join it.
 *
 * WHY THIS IS NOT PART OF THE `plan` EXTENSION. Plan mode is one posture among
 * several, and it already exists here with a tested fail-closed classifier. So
 * this extension owns the AXIS and delegates the `plan` posture back to that
 * extension over PLAN_CONTROL_CHANNEL rather than running a second read-only
 * gate — two gates for one mode is two things to disagree. It listens on
 * PLAN_MODE_STATE_CHANNEL for the feedback half: a user typing `/plan exit`
 * drops the enforcement, and this must not go on claiming the session is
 * read-only afterwards.
 *
 * The same four mechanical constraints plan/index.ts documents apply verbatim:
 * no `context` handler (use `before_agent_start`), `setActiveTools` is advisory
 * and `tool_call` is the enforcement, nothing mutable at module scope, and
 * nothing here injects a turn.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	OP_MODE_CONTROL_CHANNEL,
	OP_MODE_STATE_CHANNEL,
	PLAN_CONTROL_CHANNEL,
	PLAN_MODE_STATE_CHANNEL,
	type OpModeControlEvent,
	type OpModeStateEvent,
	type PlanControlEvent,
	type PlanModeStateEvent,
} from "../hive-common/channels.ts";
import { parseResultHeader } from "../background/jobs.ts";
import { DECK_SECTION_CHANNEL, DECK_SYNC_CHANNEL, type DeckSectionEvent } from "../deck/protocol.ts";
import { classifyCommand, classifyDiscussionTool, classifyOrchestrateCommand, classifyOrchestrateTool } from "../plan/policy.ts";
import { BUGFIX_WITHHELD_TOOLS, DEFAULT_OP_MODE, isOpMode, OP_MODES, OP_MODE_ENFORCES, type OpMode } from "./modes.ts";
import { buildOpModePrompt } from "./prompt.ts";

/** Tools this extension owns; they stay callable in every mode it gates. */
const OP_MODE_TOOLS = ["bugfix_evidence", "bugfix_root_cause"];

/** A completed tool result the evidence protocol observed. */
export type ObservedResult = { name: string; failed: boolean; text: string };

/**
 * The refusal for a missing or unknown tool_call_id — WITH the ids it was
 * checked against.
 *
 * The id lives in the tool-event stream, which the model never sees: Pi's
 * rendered transcript carries no tool-call ids, so the bare "needs the id"
 * refusal demanded a value the caller had no way to produce. Agents holding a
 * live reproduction were refused on every attempt and the mandated protocol
 * could not be completed at all (HIV-3078 — 6+ blocking papercuts in the week
 * to 2026-08-30). Handing over the newest observed ids turns the dead end
 * into a one-call retry, without trusting anything model-authored: the ids
 * still come from the event stream, and the binding checks are unchanged.
 */
export function refusalWithCandidates(results: Map<string, ObservedResult>, requested: string | undefined): string {
	const head = requested
		? `Tool result ${requested} was not observed in this session.`
		: "Bugfix evidence needs the id of a completed tool result from this session.";
	const recent = [...results.entries()].slice(-8).reverse();
	if (recent.length === 0) {
		return `${head} No completed tool results have been observed yet — run the reproduction first, then record it.`;
	}
	const rows = recent.map(
		([id, r]) => `  ${id}  ${r.name}${r.failed ? "  (failed)" : ""}  ${r.text.replace(/\s+/g, " ").slice(0, 70)}`,
	);
	return `${head} Recent completed results, newest first — pass one of these ids as tool_call_id:\n${rows.join("\n")}`;
}

export default function (pi: ExtensionAPI) {
	let mode: OpMode = DEFAULT_OP_MODE;
	/**
	 * The recorded root cause, or null while none exists. This is the bugfix
	 * gate's key, and it is deliberately NOT persisted: see the session_start
	 * handler.
	 */
	let rootCause: { summary: string; evidence: string } | null = null;
	// Completed tool results, keyed by the id that identifies the run: the call
	// id for an ordinary tool, the job id for a pulled background job. The
	// evidence protocol consumes these instead of trusting a model-authored
	// command/outcome string.
	const results = new Map<string, ObservedResult>();
	// A reproduction is a stable, model-supplied descriptor bound to two distinct
	// observed runs: the failing baseline and its passing re-verification. Tool
	// call IDs identify one immutable invocation, so they cannot serve as both.
	let reproduction: { key: string; failingCallID: string; toolName: string } | null = null;
	let phase: "reproduce" | "hypothesize" | "instrument" | "confirm" | "fix" | "done" | "blocked" = "reproduce";
	/** Tool names captured before a mode narrowed them, so a switch back restores. */
	let toolsBeforeMode: string[] | null = null;
	let heldCtx: ExtensionContext | null = null;

	// `op-mode`, NOT `mode`: `--mode` is one of pi's OWN flags — every durable
	// worker is spawned as `pi --mode rpc` or `--mode json` (see agenda/spawn.ts)
	// — so registering that name would collide with it, and reading it back would
	// return "json" in every subagent rather than a posture.
	pi.registerFlag("op-mode", {
		description: `Start in an operating mode (${OP_MODES.join(" | ")})`,
		type: "string",
		default: "",
	});

	/** Announce the posture so hive-remote can REPORT it (never assume it). */
	const announce = () => {
		try {
			pi.events.emit(OP_MODE_STATE_CHANNEL, { mode } satisfies OpModeStateEvent);
		} catch {
			/* no bus, or nothing listening */
		}
	};

	/** Cosmetic by definition — never fail a tool call because a widget could not draw. */
	const paint = () => {
		try {
			const label = mode === DEFAULT_OP_MODE ? null : `${mode}${mode === "bugfix" && rootCause ? " · cause recorded" : ""}`;
			pi.events.emit(DECK_SECTION_CHANNEL, {
				section: "opmode",
				state: label ? { kind: "lines", summary: label, lines: [label] } : null,
			} satisfies DeckSectionEvent);
		} catch {
			/* no bus, or nothing listening */
		}
	};

	pi.events.on(DECK_SYNC_CHANNEL, () => paint());

	/**
	 * Narrow the active tool set to what this mode permits.
	 *
	 * Advisory only — pi force-activates every registered tool on session build
	 * and again on `/reload`, so this can never BE the enforcement. Its job is
	 * keeping withheld tools out of the system prompt so the model does not build
	 * an approach around calling them and then hit a wall of denials.
	 */
	const narrowTools = () => {
		try {
			const all = pi.getAllTools().map((tool) => tool.name);
			// Snapshot the ACTIVE set, not the registry: restoring from getAllTools()
			// resurrects tools other extensions keep deliberately inactive — the bug
			// plan/index.ts hit with agenda's consent-gated `orchestrate`.
			if (toolsBeforeMode === null) toolsBeforeMode = pi.getActiveTools();
			// Empty MCP parameters mean a read-only status query and let the gateway
			// remain visible; actual calls are classified again with their input.
			const permitted = all.filter((name) => toolVerdict(name, {}).allowed);
			pi.setActiveTools([...new Set([...permitted, ...OP_MODE_TOOLS])]);
		} catch {
			/* tool introspection unavailable; the deny hook still enforces */
		}
	};

	const restoreTools = () => {
		try {
			if (toolsBeforeMode) pi.setActiveTools(toolsBeforeMode);
		} catch {
			/* nothing to restore into */
		} finally {
			toolsBeforeMode = null;
		}
	};

	/* ---------------------------------------------------------------------- */
	/* Enforcement                                                             */
	/* ---------------------------------------------------------------------- */

	/**
	 * What this mode permits, by tool name.
	 *
	 * `plan` is absent on purpose: that posture's gate belongs to the plan
	 * extension, whose own `tool_call` hook is active whenever it is. Answering
	 * here as well would be a second opinion about one mode.
	 */
	function toolVerdict(name: string, input?: unknown): { allowed: true } | { allowed: false; reason: string } {
		switch (mode) {
			case "discuss":
				return classifyDiscussionTool(name, input);
			case "bugfix":
				if (rootCause || !BUGFIX_WITHHELD_TOOLS.has(name)) return { allowed: true };
				return {
					allowed: false,
					reason:
						`Bugfix mode: no fix before a root cause. Reproduce the bug and build something that measures it ` +
						`— the shell, tests and scripts are all open — then record what you found with bugfix_root_cause, ` +
						`which unlocks edits.`,
				};
			case "orchestrate":
				return classifyOrchestrateTool(name, input);
			case "build":
			case "plan":
				return { allowed: true };
		}
	}

	pi.on("tool_call", async (event) => {
		const verdict = toolVerdict(event.toolName, event.input);
		if (!verdict.allowed) return { block: true, reason: verdict.reason };

		// Shell gating for the two fail-closed read-only postures. Bugfix
		// deliberately leaves bash open — see BUGFIX_WITHHELD_TOOLS for why.
		if ((mode === "discuss" || mode === "orchestrate") && event.toolName === "bash") {
			const command = (event.input as { command?: unknown } | undefined)?.command;
			const raw = typeof command === "string" ? command : "";
			const shell = mode === "orchestrate"
				? classifyOrchestrateCommand(raw)
				: classifyCommand(raw, "Discussion");
			if (!shell.allowed) return { block: true, reason: shell.reason };
		}
	});

	pi.on("tool_result", (event) => {
		if (event.toolName === "bugfix_evidence" || event.toolName === "bugfix_root_cause") return;
		const text = (event.content ?? []).map((part) => "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
		const observed: ObservedResult = { name: event.toolName, failed: Boolean(event.isError), text: text.slice(0, 1200) };
		// A pulled background job is keyed by its JOB id, and carries the JOB's
		// verdict rather than the pull's. Both halves are load-bearing.
		//
		// The verdict, because `background_result` succeeds whatever the job did:
		// `isError` describes the pull, so every background run looked like a
		// passing one and `phase: "reproduce"` refused all of them. An agent whose
		// only way to run a multi-minute gate is a background job — the foreground
		// shell is capped well below one — therefore could not complete the
		// mandated protocol at all.
		//
		// The id, because `bg-42` is the identifier the session actually shows,
		// and because it is the one that makes the re-verification check mean
		// something. Keyed by call id, two pulls of the SAME failing job produce
		// two ids, and the second would satisfy "a distinct run"; keyed by job id
		// they collide, so a distinct id is a distinct run. The call id is not
		// also registered: it is invisible to the model by construction, so a
		// second row for it would only pad the candidate list.
		const job = event.toolName === "background_result" ? parseResultHeader(text) : null;
		if (job) {
			results.set(job.id, { ...observed, failed: job.status === "failed" });
			return;
		}
		results.set(event.toolCallId, observed);
	});

	pi.on("before_agent_start", (event) => {
		const prompt = buildOpModePrompt(mode);
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	/* ---------------------------------------------------------------------- */
	/* Tools                                                                   */
	/* ---------------------------------------------------------------------- */

	pi.registerTool({
		name: "bugfix_evidence",
		label: "Record bugfix evidence",
		description: "Bind a bugfix phase to a completed tool result. The tool-call id must name an actual result from this session; a stable reproduction key binds its failing baseline to a distinct passing re-verification. If you do not know the id, call with the phase alone — the refusal lists the recent result ids to pass.",
		parameters: Type.Object({
			phase: Type.Union([Type.Literal("reproduce"), Type.Literal("hypothesize"), Type.Literal("instrument"), Type.Literal("confirm"), Type.Literal("reverify"), Type.Literal("blocked")]),
			tool_call_id: Type.Optional(Type.String()),
			reproduction_key: Type.Optional(Type.String({ description: "Stable identifier for this reproduction; use the same value for the failing baseline and passing re-verification." })),
			hypothesis: Type.Optional(Type.String()),
		}),
		execute: async (_id, params) => {
			const p = params as { phase?: string; tool_call_id?: string; reproduction_key?: string; hypothesis?: string };
			if (p.phase === "blocked") { phase = "blocked"; return protocolResult("blocked", "Investigation stopped honestly; no edits were unlocked."); }
			const observed = p.tool_call_id ? results.get(p.tool_call_id) : undefined;
			// The id lives in the tool-event stream, which the MODEL never sees —
			// Pi's rendered transcript carries no tool-call ids, so "needs the id"
			// alone described a value the caller had no way to produce. Agents
			// with a live reproduction were refused every time (HIV-3078: 6+
			// blocking papercuts in one week). The refusal now hands over the ids
			// it is checking against, newest first, so the next call can succeed.
			if (!observed) return text(refusalWithCandidates(results, p.tool_call_id));
			if (p.phase === "reproduce") {
				const key = p.reproduction_key?.trim();
				if (observed.failed !== true || !key) return text("Reproduction evidence needs an actual failing result and a stable reproduction key.");
				reproduction = { key, failingCallID: p.tool_call_id!, toolName: observed.name }; phase = "hypothesize";
				return protocolResult("hypothesize", `Reproduction failed via ${observed.name}; state a falsifiable mechanism.`);
			}
			if (p.phase === "hypothesize" && phase === "hypothesize" && p.hypothesis?.trim()) { phase = "instrument"; return protocolResult("instrument", "Hypothesis recorded; run an instrument that can distinguish it."); }
			if (p.phase === "instrument" && phase === "instrument" && p.tool_call_id !== reproduction?.failingCallID) { phase = "confirm"; return protocolResult("confirm", "Instrumentation recorded; confirm the mechanism it established."); }
			if (p.phase === "confirm" && phase === "confirm" && p.hypothesis?.trim()) { phase = "fix"; return protocolResult("fix", "Hypothesis confirmed; record the root cause, fix it, then rerun the same reproduction."); }
			if (p.phase === "reverify" && phase === "fix" && reproduction && p.reproduction_key === reproduction.key && p.tool_call_id !== reproduction.failingCallID && observed.name === reproduction.toolName && !observed.failed) { phase = "done"; return protocolResult("done", "The same reproduction now passes."); }
			return text("That evidence is out of order, lacks a hypothesis, or is not a distinct passing run of the same reproduction key and tool.");
		},
	});

	pi.registerTool({
		name: "bugfix_root_cause",
		label: "Record root cause",
		description:
			"Record the root cause of the bug under investigation, with the evidence that establishes it. " +
			"In bugfix mode this unlocks file edits. Call it when you can explain the MECHANISM — which state, " +
			"at which point, produces the observed behaviour — not when you have found a line that changes the symptom.",
		promptSnippet:
			"Bugfix: record the mechanism with bugfix_root_cause (evidence, not inference) before editing any file.",
		parameters: Type.Object({
			summary: Type.String({
				description: "The mechanism, in one or two sentences: what state, at what point, produces the behaviour.",
			}),
			evidence: Type.String({
				description:
					"What established it — the failing repro, the measurement, the log line, the test that isolates it. " +
					"Name what you actually ran or observed, not what you reasoned.",
			}),
		}),
		execute: async (_id, params) => {
			const { summary, evidence } = params as { summary?: string; evidence?: string };
			const clean = (v: string | undefined) => (typeof v === "string" ? v.trim() : "");
			if (mode === "bugfix" && phase !== "fix") {
				return text("Record reproduce, instrumentation, and a confirmed hypothesis with bugfix_evidence before unlocking edits.");
			}
			if (!clean(summary) || !clean(evidence)) {
				// Refused rather than accepted-and-empty: an empty artifact would
				// unlock the edits while recording nothing, which is the gate
				// defeating itself.
				return text("A root cause needs both a mechanism and the evidence for it. Nothing was recorded.");
			}
			rootCause = { summary: clean(summary), evidence: clean(evidence) };
			// RESTORE the snapshot rather than re-narrowing. Once the gate is
			// unlocked every tool is permitted, so narrowTools() would compute its
			// set from the whole registry and activate tools that were deliberately
			// inactive before this mode — agenda's consent-gated `orchestrate` is
			// the one that has already been resurrected this way once. The snapshot
			// is exactly the set that was live before bugfix withheld the editors.
			restoreTools();
			paint();
			return text(
				`Root cause recorded — file edits are unlocked.\n\n` +
					`  ${rootCause.summary}\n  evidence: ${rootCause.evidence}\n\n` +
					`Fix it, then verify with the same instrument that established the cause.`,
			);
		},
	});

	function protocolResult(stage: string, body: string) {
		return { content: [{ type: "text" as const, text: body }], details: { hive_widget: { v: 1, type: "bugfix", spec: { stage, reproduction: reproduction?.key, blocked: stage === "blocked" } } } };
	}

	function text(body: string) {
		return { content: [{ type: "text" as const, text: body }], details: {} };
	}

	/* ---------------------------------------------------------------------- */
	/* Switching                                                               */
	/* ---------------------------------------------------------------------- */

	/**
	 * Move to `next`, telling the plan extension when the plan posture starts or
	 * stops. Returns what to say about it.
	 *
	 * `silent` suppresses the outbound plan request when this call is REACTING to
	 * the plan extension rather than driving it — otherwise a `/plan exit` would
	 * bounce back as an exit request and the two would talk in circles.
	 */
	function switchTo(next: OpMode, silent = false): string {
		if (next === mode) return `Already in ${next} mode.`;
		const previous = mode;
		mode = next;

		// Entering or leaving bugfix resets the gate. A root cause is about ONE
		// investigation, and carrying it into the next one would silently unlock
		// edits for a bug nobody has diagnosed.
		if (previous === "bugfix" || next === "bugfix") rootCause = null;

		if (!silent && (previous === "plan" || next === "plan")) {
			try {
				pi.events.emit(PLAN_CONTROL_CHANNEL, {
					action: next === "plan" ? "enter" : "exit",
				} satisfies PlanControlEvent);
			} catch {
				/* no bus, or the plan extension is not loaded */
			}
		}

		// Tool-set ownership, keyed on the mode being ENTERED and never on the one
		// being left. Three branches, and the third is the subtle one:
		//
		//   → discuss/bugfix : ours to narrow.
		//   → build          : ours to restore. No-op when we hold no snapshot,
		//                      which is why it is unconditional.
		//   → plan           : TOUCH NOTHING. The plan extension takes its own
		//                      snapshot and narrows, synchronously, inside the emit
		//                      above.
		//
		// Keying on the previous mode instead is what made the first version wrong.
		// Leaving bugfix FOR plan restored our snapshot after plan had already
		// snapshotted the bugfix-narrowed set — so plan's narrowing was undone
		// immediately, and `/plan exit` then restored that stale narrowed set,
		// stranding a build-mode session with no `edit` tool until a reload.
		// Holding our snapshot across the plan excursion instead means the eventual
		// return to build restores the right set.
		//
		// This ALSO fixes the mirror path (`/plan` typed while in bugfix, arriving
		// silently through PLAN_MODE_STATE_CHANNEL) without a special case, because
		// both paths enter `plan` and neither now touches the tool set.
		//
		// The order here — after the emit, not before — is load-bearing for the
		// opposite direction: plan → discuss needs plan to have restored its
		// snapshot BEFORE narrowTools() reads the active set, or we would snapshot
		// plan's narrowed set and plan would then restore over our narrowing.
		if (next === "discuss" || next === "bugfix" || next === "orchestrate") narrowTools();
		else if (next === DEFAULT_OP_MODE) restoreTools();
		announce();
		paint();
		return `Mode: ${next} — ${OP_MODE_ENFORCES[next]}`;
	}

	// The Hive workspace's doorbell. A key from the closed set, never free text.
	pi.events.on(OP_MODE_CONTROL_CHANNEL, (payload) => {
		const event = payload as OpModeControlEvent | undefined;
		if (!event || !isOpMode(event.mode)) return;
		const message = switchTo(event.mode);
		try {
			heldCtx?.ui.notify(message, "info");
		} catch {
			/* session replaced — the mode is still set; the banner is cosmetic */
		}
	});

	/**
	 * The plan extension's feedback. Without this, `/plan exit` would leave this
	 * extension reporting a read-only posture that nothing enforces — and the Hive
	 * workspace would show it.
	 */
	pi.events.on(PLAN_MODE_STATE_CHANNEL, (payload) => {
		const event = payload as PlanModeStateEvent | undefined;
		if (!event) return;
		if (!event.active && mode === "plan") switchTo(DEFAULT_OP_MODE, true);
		// The converse too: `/plan` typed directly moves this axis, so the two can
		// never disagree about whether the session is read-only.
		else if (event.active && mode !== "plan") switchTo("plan", true);
	});

	/* ---------------------------------------------------------------------- */
	/* Lifecycle                                                               */
	/* ---------------------------------------------------------------------- */

	pi.on("session_start", (_event, ctx) => {
		heldCtx = ctx;
		// A restored session does NOT restore its mode, matching the plan
		// extension's deliberate choice and for its reason: waking up restricted,
		// with no banner and no memory of asking for it, reads as a broken harness
		// rather than as a mode. The root cause goes with it — an unlocked gate
		// surviving a reload would be the worst half to keep.
		mode = DEFAULT_OP_MODE;
		rootCause = null;
		reproduction = null;
		phase = "reproduce";
		results.clear();
		toolsBeforeMode = null;
		announce();
		paint();
	});

	// `--mode` is honoured once, on the first session build — here rather than in
	// the factory so pi.getAllTools() sees the full registry, including tools
	// other extensions register after this one.
	pi.on("session_start", () => {
		const requested = pi.getFlag("op-mode");
		if (!isOpMode(requested) || requested === mode) return;
		switchTo(requested);
	});

	/* ---------------------------------------------------------------------- */
	/* Command                                                                 */
	/* ---------------------------------------------------------------------- */

	pi.registerCommand("mode", {
		description: `Operating mode — what the harness allows (${OP_MODES.join(" | ")})`,
		handler: async (args: string, ctx: ExtensionContext) => {
			const requested = args.trim().split(/\s+/).filter(Boolean)[0] ?? "";
			if (!requested) {
				const lines = OP_MODES.map((m) => `  ${m === mode ? "●" : "○"} ${m} — ${OP_MODE_ENFORCES[m]}`);
				ctx.ui.notify(`Mode: ${mode}\n${lines.join("\n")}\n\n/mode <name> to switch.`, "info");
				return;
			}
			if (!isOpMode(requested)) {
				// Name what IS available rather than only refusing: the closed set is
				// the point, so being told it is the fastest way to see the shape.
				ctx.ui.notify(`Unknown mode "${requested}". Available: ${OP_MODES.join(", ")}.`, "warning");
				return;
			}
			ctx.ui.notify(switchTo(requested), "info");
		},
	});
}
