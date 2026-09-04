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
	// Name `reproduction_key` HERE, in the message read immediately before the
	// retry. It is `Type.Optional` in the schema and mandatory for the first
	// phase, so a caller that answered this refusal perfectly — a listed id, a
	// failing one — was refused AGAIN on the next call, for a field this message
	// had never mentioned. Two refusals for one call is the dead end the
	// candidate list was supposed to end; listing ids only moved it one call
	// later. The example points at the newest FAILING result because `reproduce`
	// rejects a passing one, and handing over an id that the next line rejects
	// is the same failure wearing a different sentence.
	const example = recent.find(([, r]) => r.failed)?.[0] ?? recent[0]![0];
	return (
		`${head} Recent completed results, newest first — pass one of these ids as tool_call_id:\n${rows.join("\n")}\n` +
		`Phase "reproduce" also needs a reproduction_key — any stable name for this bug, repeated on the later "reverify" call: ` +
		`{"phase": "reproduce", "tool_call_id": "${example}", "reproduction_key": "targeted-test"}`
	);
}

/** The states the evidence protocol moves through; `phase` below holds one. */
type ProtocolState = "reproduce" | "hypothesize" | "instrument" | "confirm" | "fix" | "done" | "blocked";

/**
 * The `bugfix_evidence` phase argument each state is waiting for.
 *
 * Deliberately not the identity map, which is exactly why the caller could not
 * infer it: after `confirm` the machine sits at `fix` — the state where
 * `bugfix_root_cause` unlocks the editors — and the evidence call it wants next
 * is `reverify`. There is no `fix` phase argument to pass, and nothing the agent
 * could see said so.
 */
const EXPECTED_CALL: Record<ProtocolState, string | null> = {
	reproduce: "reproduce",
	hypothesize: "hypothesize",
	instrument: "instrument",
	confirm: "confirm",
	fix: "reverify",
	done: null,
	blocked: null,
};

/** The order, spelled the way the `phase` argument is spelled. */
const PHASE_ORDER = `reproduce → hypothesize → instrument → confirm → (bugfix_root_cause, then the edit) → reverify`;

/**
 * The refusal for a `reproduce` call that named a real result but cannot bind.
 *
 * The old wording — "needs an actual failing result and a stable reproduction
 * key" — fired for either half and named neither, so an agent that had just
 * been handed a failing id by refusalWithCandidates read it as a second verdict
 * on the id: the one thing that was right. It then went back to hunting ids.
 * Say which half is missing, and show the call that would have worked.
 */
function reproduceRefusal(id: string, observed: ObservedResult, key: string | undefined): string {
	const faults: string[] = [];
	if (observed.failed !== true) {
		faults.push(`${id} (${observed.name}) completed without failing, so it is not a reproduction — bind the run that shows the bug`);
	}
	if (!key) {
		faults.push(
			`reproduction_key is missing: any stable name for this bug will do. It is optional in the schema because the later ` +
				`phases do not all take it, but this phase requires it, and "reverify" must repeat the same value`,
		);
	}
	// The example may only echo the id back when the id was the good half. When
	// the run PASSED, printing it as the example would recommend the call that
	// just failed — the same self-contradiction, one refusal further on, that
	// this whole change exists to remove.
	const exampleID = observed.failed === true ? id : "<id of the failing run>";
	return (
		`Read as phase "reproduce", the failing baseline. ${faults.join(". ")}. ` +
		`Example: {"phase": "reproduce", "tool_call_id": "${exampleID}", "reproduction_key": "targeted-test"}`
	);
}

/**
 * The refusal for everything that is not a first-phase bind, split by WHICH
 * ordering went wrong.
 *
 * One sentence used to cover four distinct faults ("out of order, lacks a
 * hypothesis, or is not a distinct passing run of the same reproduction key and
 * tool"), leaving the caller to guess which had happened and to re-derive the
 * order by trial — on a protocol that is mandatory and documented nowhere it
 * can read. The machine holds both halves, the phase it read and the phase it
 * wants; only the message collapsed them.
 */
function orderingRefusal(requested: string, state: ProtocolState, detail: string | null): string {
	if (detail === null) {
		const expected = EXPECTED_CALL[state];
		const wants = expected
			? `it is waiting for phase "${expected}"`
			: state === "done"
				? "this reproduction is already re-verified — there is nothing further to record"
				: "the investigation is marked blocked";
		return `Read as phase "${requested}", but ${wants}. Order: ${PHASE_ORDER}.`;
	}
	return `Phase "${requested}" is the right next step, but ${detail}. Order: ${PHASE_ORDER}.`;
}

/** A reproduction: one model-supplied key bound to one observed failing run. */
type Reproduction = { key: string; failingCallID: string; toolName: string };

/**
 * Why a call whose phase WAS the expected one still could not be recorded.
 *
 * Each phase has exactly one further requirement, and `reverify` has four at
 * once — so that one is enumerated rather than summarised. An agent told "not a
 * distinct passing run of the same reproduction key and tool" has to test four
 * hypotheses against a gate that answers one bit per call; told which of the
 * four missed, it fixes the call.
 */
function payloadFault(
	p: { phase?: string; tool_call_id?: string; reproduction_key?: string; hypothesis?: string },
	observed: ObservedResult,
	reproduction: Reproduction | null,
): string {
	if (p.phase === "hypothesize" || p.phase === "confirm") {
		return "it carries no hypothesis — put the falsifiable mechanism in the `hypothesis` field";
	}
	if (p.phase === "instrument") {
		return (
			`tool_call_id is the failing baseline ${reproduction?.failingCallID} again — the instrument has to be a ` +
			`distinct run from the reproduction, or it measures nothing new`
		);
	}
	if (!reproduction) return `no reproduction is bound — start again at phase "reproduce"`;
	const faults: string[] = [];
	if (p.reproduction_key !== reproduction.key) {
		faults.push(
			`reproduction_key is ${p.reproduction_key ? `"${p.reproduction_key}"` : "missing"}, and the bound reproduction is "${reproduction.key}"`,
		);
	}
	if (p.tool_call_id === reproduction.failingCallID) {
		faults.push(`tool_call_id is the failing baseline ${reproduction.failingCallID} again — re-verification needs a distinct run`);
	}
	if (observed.name !== reproduction.toolName) {
		faults.push(`the result came from ${observed.name}, not ${reproduction.toolName} — rerun the tool that reproduced it`);
	}
	if (observed.failed) faults.push("that run still failed");
	// Unreachable while this list and the bind condition stay in step. Kept
	// because a drifting pair should degrade to the old vague sentence, not to
	// "…, but . Order: …" — a refusal with a hole in it reads as a harness bug
	// and sends the agent looking in the wrong place entirely.
	return faults.length > 0 ? faults.join("; ") : "it does not satisfy re-verification";
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
	let reproduction: Reproduction | null = null;
	let phase: ProtocolState = "reproduce";
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
				// This is the FIRST thing an agent in bugfix mode reads, and it used
				// to send them straight at `bugfix_root_cause` — which then refuses
				// until bugfix_evidence has walked every phase. The deny that opens
				// the investigation cannot prescribe the call that closes it, or the
				// agent's first two moves are both refusals.
				return {
					allowed: false,
					reason:
						`Bugfix mode: no fix before a root cause. Reproduce the bug and build something that measures it ` +
						`— the shell, tests and scripts are all open — recording each step with bugfix_evidence, in order: ` +
						`${PHASE_ORDER}. Once "confirm" is recorded, bugfix_root_cause accepts the mechanism and unlocks edits.`,
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
				if (observed.failed !== true || !key) return text(reproduceRefusal(p.tool_call_id!, observed, key));
				reproduction = { key, failingCallID: p.tool_call_id!, toolName: observed.name }; phase = "hypothesize";
				return protocolResult("hypothesize", `Reproduction failed via ${observed.name}; state a falsifiable mechanism.`);
			}
			if (p.phase === "hypothesize" && phase === "hypothesize" && p.hypothesis?.trim()) { phase = "instrument"; return protocolResult("instrument", "Hypothesis recorded; run an instrument that can distinguish it."); }
			if (p.phase === "instrument" && phase === "instrument" && p.tool_call_id !== reproduction?.failingCallID) { phase = "confirm"; return protocolResult("confirm", "Instrumentation recorded; confirm the mechanism it established."); }
			if (p.phase === "confirm" && phase === "confirm" && p.hypothesis?.trim()) { phase = "fix"; return protocolResult("fix", "Hypothesis confirmed; record the root cause, fix it, then rerun the same reproduction."); }
			if (p.phase === "reverify" && phase === "fix" && reproduction && p.reproduction_key === reproduction.key && p.tool_call_id !== reproduction.failingCallID && observed.name === reproduction.toolName && !observed.failed) { phase = "done"; return protocolResult("done", "The same reproduction now passes."); }
			// Two questions, answered separately: was this the wrong PHASE, or the
			// right phase with the wrong payload? The machine has always known
			// both — `phase` is the state and `p.phase` is what was asked for —
			// and answering only the union of them is what made every wrong
			// ordering look identical from the outside.
			// `?? "(none)"` rather than `!`: phase is required by the schema, but
			// this string is what a caller reads when something upstream did not
			// send it, and `Read as phase "undefined"` would send them hunting a
			// bug in their own arguments instead of an absent one.
			const requested = p.phase ?? "(none)";
			const expected = EXPECTED_CALL[phase];
			if (p.phase !== expected) return text(orderingRefusal(requested, phase, null));
			return text(orderingRefusal(requested, phase, payloadFault(p, observed, reproduction)));
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
