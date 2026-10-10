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

import type { ExtensionAPI, ExtensionContext, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
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
import { DECK_SECTION_CHANNEL, DECK_SYNC_CHANNEL, type DeckSectionEvent } from "../deck/protocol.ts";
import { opModeShellVerdict, opModeToolVerdict, PHASE_ORDER } from "./verdict.ts";
import {
	applyEvidence,
	applyRootCause,
	INITIAL_EVIDENCE,
	isJobStatus,
	jobVerdict,
	observeToolResult,
	SHELL_FAMILY,
	type EvidenceMachine,
	type EvidenceParams,
	type ObservedResult,
} from "./bugfix.ts";

// The evidence protocol lives in bugfix.ts; re-exported for existing importers.
export { leadingJSON, observe, refusalWithCandidates, sameHiveWorkRerun, type ObservedResult, type Verdict } from "./bugfix.ts";
import { DEFAULT_OP_MODE, isOpMode, OP_MODES, OP_MODE_ENFORCES, type OpMode } from "./modes.ts";
import { buildOpModePrompt } from "./prompt.ts";
import { exposureFor, restoredLoadout } from "../loadout/policy.ts";

/** Tools this extension owns; they stay callable in every mode it gates. */
const OP_MODE_TOOLS = ["bugfix_evidence", "bugfix_root_cause"];

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
	let evidence: EvidenceMachine = INITIAL_EVIDENCE;
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
			pi.events.emit(OP_MODE_STATE_CHANNEL, { mode, modes: OP_MODES } satisfies OpModeStateEvent);
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
			// Snapshot the ACTIVE set, not the registry: restoring from getAllTools()
			// resurrects tools other extensions keep deliberately inactive — the bug
			// plan/index.ts hit with agenda's consent-gated `orchestrate`.
			if (toolsBeforeMode === null) toolsBeforeMode = pi.getActiveTools();
			// Empty MCP parameters mean a read-only status query and let the gateway
			// remain visible; actual calls are classified again with their input.
			const permitted = pi.getActiveTools().filter((name) => toolVerdict(name, {}).allowed);
			pi.setActiveTools([...new Set([...permitted, ...OP_MODE_TOOLS])]);
		} catch {
			/* tool introspection unavailable; the deny hook still enforces */
		}
	};

	/**
	 * `keepModeTools`: the root-cause unlock restores the editors while the mode
	 * is still bugfix, and the protocol's last phase (`bugfix_evidence
	 * {phase:"reverify"}`) still needs the evidence tool. They are deferred, so
	 * a restore that dropped them would leave that phase uncallable.
	 */
	const restoreTools = (keepModeTools = false) => {
		try {
			if (toolsBeforeMode) {
				const restored = restoredLoadout(toolsBeforeMode, pi.getActiveTools(), OP_MODE_TOOLS);
				pi.setActiveTools(keepModeTools ? [...new Set([...restored, ...OP_MODE_TOOLS])] : restored);
			} else if (!keepModeTools) {
				// Leaving bugfix after the unlock: the snapshot is already spent,
				// and only the mode tools the unlock kept are left to withdraw.
				const current = pi.getActiveTools();
				if (current.some((name) => OP_MODE_TOOLS.includes(name))) {
					pi.setActiveTools(current.filter((name) => !OP_MODE_TOOLS.includes(name)));
				}
			}
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
	function toolVerdict(name: string, input?: unknown) {
		return opModeToolVerdict(mode, name, input, rootCause !== null);
	}

	pi.on("tool_call", async (event) => {
		const verdict = toolVerdict(event.toolName, event.input);
		if (!verdict.allowed) return { block: true, reason: verdict.reason };
		if (verdict.updatedInput) Object.assign(event.input, verdict.updatedInput);

		// Shell gating for the two fail-closed read-only postures. Bugfix
		// deliberately leaves bash open — see BUGFIX_WITHHELD_TOOLS for why.
		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown } | undefined)?.command;
			const shell = opModeShellVerdict(mode, typeof command === "string" ? command : "");
			if (!shell.allowed) return { block: true, reason: shell.reason };
		}
	});

	pi.on("tool_result", (event) => {
		if (event.toolName === "bugfix_evidence" || event.toolName === "bugfix_root_cause") return;
		const texts = (event.content ?? []).map((part) => "text" in part && typeof part.text === "string" ? part.text : "");
		// A pulled background job is keyed by its JOB id and carries the JOB's
		// verdict (bugfix.ts observeToolResult) — `background_result` succeeds
		// whatever the job did, and an agent whose only way to run a long gate is
		// a background job could otherwise never bind a reproduction.
		const { key, observed } = observeToolResult(event.toolName, event.toolCallId, Boolean(event.isError), texts, event.structuredContent);
		results.set(key, observed);
		return evidenceTag(event, key);
	});

	/**
	 * The id to bind, written INTO the result while the protocol is live.
	 *
	 * Pi's rendered transcript carries no tool-call ids, so the model was asked
	 * for a value it could not see, and every phase began with a deliberately
	 * refused call just to list them (papercuts 2026-10-04T13:12, 2047). Only in
	 * bugfix mode and only until the reproduction is re-verified, so no other
	 * session pays a token for it. Appended after the tool's own output and
	 * tagged, like toolhints, so it is never mistaken for the tool's words; and
	 * `structuredContent` is passed back unchanged, because pi drops it when a
	 * handler replaces `content` alone.
	 */
	function evidenceTag(event: ToolResultEvent, key: string): ToolResultEventResult | undefined {
		if (mode !== "bugfix" || evidence.phase === "done" || evidence.phase === "blocked") return undefined;
		// Not inside a codemode script: its value is the tool's text, and a tag
		// there breaks `JSON.parse(await bash(...))` or lands in a file a
		// read-modify-write round trip writes back (review of #104).
		if (event.parentToolCallId) return undefined;
		const tag = { type: "text" as const, text: `[bugfix evidence id: ${key}]` };
		return {
			content: [...(event.content ?? []), tag],
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	}

	/**
	 * A background job that finished is announced by a follow-up message, not a
	 * tool result, and the model often never pulls it: the notification already
	 * carried the output. Such a job was invisible here — "lists recent result
	 * IDs but omits the completed bg-30 failing Playwright run". The message is
	 * the background extension's own (`customType: "background"`, details.id and
	 * details.status), which only an extension can emit, so it is as trustworthy
	 * as the pulled header and keyed the same way.
	 */
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; customType?: string; content?: unknown; details?: unknown } | undefined;
		if (message?.role !== "custom" || message.customType !== "background") return;
		const details = message.details as { id?: unknown; status?: unknown } | undefined;
		if (typeof details?.id !== "string" || !isJobStatus(details.status)) return;
		const text = typeof message.content === "string" ? message.content.slice(0, 1200) : "";
		results.set(details.id, { name: "background_bash", family: SHELL_FAMILY, verdict: jobVerdict(details.status), text });
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
		name: "bugfix_evidence", exposure: exposureFor("bugfix_evidence"),
		label: "Record bugfix evidence",
		description: `Bind a bugfix phase to a completed tool result. The phases run in one order: ${PHASE_ORDER}. The tool-call id must name an actual result from this session; reproduction_key is required by the reproduce and reverify phases, the same value on both, which is what binds one failing baseline to a distinct passing re-verification. If you do not know the id, call with the phase alone — the refusal lists the recent result ids to pass.`,
		parameters: Type.Object({
			phase: Type.Union([Type.Literal("reproduce"), Type.Literal("hypothesize"), Type.Literal("instrument"), Type.Literal("confirm"), Type.Literal("reverify"), Type.Literal("blocked")]),
			tool_call_id: Type.Optional(Type.String()),
			// Optional in the SCHEMA and mandatory in the reproduce and reverify
			// phases, because the phases between them do not take it. That gap is
			// only survivable if the description says so: a caller who reads
			// `Type.Optional` and omits it hits a refusal it could not predict.
			reproduction_key: Type.Optional(Type.String({ description: "Stable identifier for this reproduction. REQUIRED by the reproduce and reverify phases — optional only because the phases between them do not take it — and the same value must be used for both." })),
			hypothesis: Type.Optional(Type.String()),
		}),
		execute: async (_id, params) => {
			// The machine is bugfix.ts's, shared with the Claude adapter.
			const step = applyEvidence(evidence, results, params as EvidenceParams);
			evidence = step.machine;
			return step.stage ? protocolResult(step.stage, step.text) : text(step.text);
		},
	});

	pi.registerTool({
		name: "bugfix_root_cause", exposure: exposureFor("bugfix_root_cause"),
		label: "Record root cause",
		description:
			"Record the root cause of the bug under investigation, with the evidence that establishes it. " +
			"In bugfix mode this unlocks file edits. Call it when you can explain the MECHANISM — which state, " +
			"at which point, produces the observed behaviour — not when you have found a line that changes the symptom.",
		promptSnippet:
			"Bugfix: walk the phases with bugfix_evidence (reproduce → hypothesize → instrument → confirm), then record " +
			"the mechanism with bugfix_root_cause (evidence, not inference) — that is what unlocks editing a file.",
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
			const recorded = applyRootCause(mode, evidence.phase, params as { summary?: unknown; evidence?: unknown });
			if (!recorded.rootCause) return text(recorded.text);
			rootCause = recorded.rootCause;
			// RESTORE the snapshot rather than re-narrowing. Once the gate is
			// unlocked every tool is permitted, so narrowTools() would compute its
			// set from the whole registry and activate tools that were deliberately
			// inactive before this mode — agenda's consent-gated `orchestrate` is
			// the one that has already been resurrected this way once. The snapshot
			// is exactly the set that was live before bugfix withheld the editors,
			// plus this mode's own tools: the reverify phase is still ahead.
			restoreTools(true);
			paint();
			return text(recorded.text);
		},
	});

	function protocolResult(stage: string, body: string) {
		return { content: [{ type: "text" as const, text: body }], details: { hive_widget: { v: 1, type: "bugfix", spec: { stage, reproduction: evidence.reproduction?.key, blocked: stage === "blocked" } } } };
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
		// The evidence machine goes with it: a reproduction bound in one
		// investigation must not be re-verified, or confirmed, in the next.
		if (previous === "bugfix" || next === "bugfix") {
			rootCause = null;
			evidence = INITIAL_EVIDENCE;
		}

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
		evidence = INITIAL_EVIDENCE;
		results.clear();
		toolsBeforeMode = null;
		// Flags are extension-scoped: only plan can read --plan. Send the launch
		// request with its session identity so plan applies it AFTER its reset,
		// even when opmode runs first. With no explicit mode, sync its own flag.
		const requested = pi.getFlag("op-mode");
		pi.events.emit(PLAN_CONTROL_CHANNEL, {
			action: isOpMode(requested) ? requested === "plan" ? "enter" : "exit" : "sync",
			startupSessionId: ctx.sessionManager.getSessionId(),
		} satisfies PlanControlEvent);
		// Never announce transient build before applying an explicit launch mode.
		// The startup request above owns plan entry/exit, not switchTo's doorbell.
		if (isOpMode(requested) && requested !== mode) switchTo(requested, true);
		else {
			announce();
			paint();
		}
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
