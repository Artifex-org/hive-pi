/**
 * brief — compile the opening prompt into a retrieval-backed brief (HIV-1798).
 *
 * On the first task-like prompt of a session, cheap models spend a bounded
 * retrieval pass — repo grep/read, the Hive knowledge brain, Linear when the
 * prompt names a ticket, one concurrent lane each (HIV-1804) — beside a local
 * `git log` of the files the task names (HIV-1806). The expensive model starts
 * its first turn already holding the facts it would otherwise spend two to five
 * turns discovering.
 *
 * Prior art, and where this deliberately differs:
 *
 *  - `dodo-reach/pi-clarify` is the UX reference (a `/`-command, an inline
 *    marker, `setEditorText` hand-back). It is text-to-text: it sharpens
 *    WORDING with no tools. This adds the retrieval half, which is the part
 *    that saves tokens.
 *  - Hive's `internal/factorycontext` is the rendering reference — see
 *    compile.ts.
 *  - `kb-nudge.ts` is the trigger reference: once per session, on a classified
 *    prompt, injected through `before_agent_start`.
 *
 * TWO EVENTS, AND NOT A THIRD. `input` and `before_agent_start` cover both
 * delivery modes. `context` would be the obvious way to rewrite a prompt and is
 * BANNED in this repo — it switches on a transform pi otherwise bypasses, on
 * every LLM call, for a prompt-cache cost nothing later points back to. There is
 * a build-level test enforcing it (test/no-forbidden-events.test.ts).
 *
 * THE AUTO PATH BLOCKS THE FIRST TURN, by design. A brief that arrives after the
 * model has started reading files has already lost. The timeout is what bounds
 * it, and every failure — timeout, crash, unparseable answer — falls through to
 * the original prompt untouched.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadBriefConfig, type BriefConfig } from "./config.ts";
import { compileBrief, type BriefReport } from "./compile.ts";
import { ALREADY_BRIEFED, isWorkerProcess, splitTeamProtocol, stripInlineMarker, suppressionReason, ticketKeys } from "./detect.ts";
import { planLanes } from "./lanes.ts";
import {
	HIVE_BRIEF_CHANNEL,
	HIVE_BRIEF_PROGRESS_CHANNEL,
	type HiveBriefEvent,
	type HiveBriefProgressEvent,
} from "../hive-common/channels.ts";
import { HIVE_METRIC_CHANNEL, type HiveMetricEvent } from "../hive-telemetry/types.ts";
import { runBriefer, type BriefLaneOutcome } from "./run.ts";

const STATUS_KEY = "brief";

/**
 * Metric names. `brief` is the automatic path — the one the token bet is about —
 * kept separate from `brief.manual` so an operator running `/brief` by hand
 * cannot move the number the A/B is reading.
 */
const METRIC_AUTO = "brief";
const METRIC_MANUAL = "brief.manual";

export default function (pi: ExtensionAPI) {
	const cfg = loadBriefConfig();
	// Returning BEFORE registration is the exception the README's "register
	// unconditionally, no-op on disabled state" idiom allows, and only because
	// neither of these can change while the process lives: an env kill switch is
	// read once, and a worker does not become interactive. The thing that DOES
	// change at runtime — `/brief off` — is the `auto` flag below, checked inside
	// the handler exactly as the idiom requires. (advisor/index.ts takes the same
	// shape for the same reason.)
	if (cfg.disabled) return;
	if (isWorkerProcess(process.env)) return;

	let auto = cfg.auto;
	let briefed = false;
	// One suppression is a decision worth recording; the same one on every
	// subsequent turn is noise that would bury it. See noteSuppression.
	let notedSuppression = false;

	pi.on("session_start", (event) => {
		const reason = (event as { reason?: string }).reason;
		if (reason === "startup" || reason === "new") {
			briefed = false;
			notedSuppression = false;
		}
	});

	/**
	 * The explicit path: `/brief <task>` and a trailing `-brief` marker.
	 *
	 * Both hand the result back through the editor rather than sending it. The
	 * whole point of asking for a brief by name is to read it before spending a
	 * frontier turn on it — and unlike the auto path, somebody is sitting there.
	 */
	pi.registerCommand("brief", {
		description: "Compile a prompt into a retrieval-backed brief — or `on` / `off` / `status`",
		handler: async (args: string, ctx: ExtensionContext) => {
			const arg = args.trim();
			if (arg === "off" || arg === "on") {
				auto = arg === "on";
				ctx.ui.notify(`brief: automatic compilation ${auto ? "on" : "off"}`, "info");
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(
					`brief: auto ${auto ? "on" : "off"}, ${briefed ? "already run" : "armed"} this session, ` +
						`budget ${cfg.budgetTokens} tokens, timeout ${cfg.timeoutMs}ms`,
					"info",
				);
				return;
			}
			if (!arg) {
				ctx.ui.notify("brief: pass the task — `/brief <what you want done>`", "warning");
				return;
			}
			await compileInto(pi, ctx, cfg, arg, "command");
		},
	});

	pi.on("input", async (event, ctx) => {
		const raw = (event as { text?: string }).text ?? "";
		const { text, marked } = stripInlineMarker(raw);
		if (!marked || !text.trim()) return { action: "continue" as const };
		await compileInto(pi, ctx, cfg, text, "marker");
		// `handled`, not `transform`: the brief lands in the editor and the human
		// sends it. Transforming here would start the turn on text nobody read.
		return { action: "handled" as const };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!auto) return;
		const prompt = (event as { prompt?: string }).prompt ?? "";
		const skip = suppressionReason({
			prompt,
			minPromptChars: cfg.minPromptChars,
			alreadyBriefed: briefed,
			env: process.env,
		});
		if (skip) {
			// `suppressionReason` returns a STRING rather than a boolean precisely so
			// this decision is loggable — "the brief did not fire" and "the brief
			// failed" want different fixes and are otherwise indistinguishable in the
			// data. HIV-1798 shipped with the reason computed and dropped on the
			// floor, which made a too-strict heuristic look exactly like a feature
			// nobody had switched on.
			if (!notedSuppression && skip !== ALREADY_BRIEFED) {
				notedSuppression = true;
				record(pi, { mode: "auto", ok: false, failure: "", suppressed: skip, model: "", modelSource: "", elapsedMs: 0 });
				metric(pi, METRIC_AUTO, "skip", 0);
			}
			return;
		}

		// Claimed BEFORE the first await. Two prompts submitted in quick
		// succession would otherwise each see `briefed === false` and each spawn
		// a worker — one of which is enriching a prompt the model is already past.
		briefed = true;

		// Read off ctx before awaiting: it goes stale the moment the session is
		// replaced (resume/fork/reload), and this handler is long-running by
		// nature. The same trap agenda/goal.ts documents.
		const cwd = ctx.cwd;
		const setStatus = (text: string | undefined) => {
			try {
				ctx.ui.setStatus(STATUS_KEY, text);
			} catch {
				/* ctx went stale mid-run; the status line is not worth failing over */
			}
		};

		const { task } = splitTeamProtocol(prompt);
		setStatus("compiling brief…");
		// The same news, for whoever is NOT at this terminal (HIV-2242).
		//
		// setStatus paints the local status line and reaches nothing else, so an
		// operator watching the Hive agents workspace saw a session register and
		// then sit at `idle` for as long as this handler holds the turn — up to
		// the 120s-per-lane wall. hive-remote only sets a phase at `turn_start`,
		// and the turn is exactly what is being held, so the beat that would have
		// said "working" is the one thing that cannot fire.
		progress(pi, "start", planLanes(ticketKeys(task)));
		try {
			const result = await runBriefer({
				task,
				cwd,
				timeoutMs: cfg.timeoutMs,
				model: cfg.model,
				// A beat per lane, so the workspace shows the pass advancing
				// instead of one static label for its whole duration.
				onLaneDone: (outcome, done, total) => laneProgress(pi, outcome.lane, outcome.ok, done, total),
			});
			recordLanes(pi, result.lanes);
			if (!result.draft) {
				record(pi, {
					mode: "auto",
					ok: false,
					failure: result.failure,
					model: result.model,
					modelSource: result.modelSource,
					elapsedMs: result.elapsedMs,
					lanes: result.lanes,
				});
				// A pass where every lane hit the wall is a latency problem; one that
				// returned nothing is a retrieval problem. Same absent brief, opposite
				// fixes — so they are not the same metric outcome.
				metric(pi, METRIC_AUTO, result.timedOut ? "timeout" : "fail", result.elapsedMs);
				return;
			}
			// includeOriginal:false — the prompt this brief accompanies is being
			// sent anyway, so repeating it here would be pure duplication.
			const { text, report } = compileBrief({
				original: task,
				draft: result.draft,
				budgetTokens: cfg.budgetTokens,
				includeOriginal: false,
				model: result.model,
				elapsedMs: result.elapsedMs,
			});
			record(pi, {
				mode: "auto",
				ok: true,
				failure: "",
				model: result.model,
				modelSource: result.modelSource,
				elapsedMs: result.elapsedMs,
				usage: result.usage,
				report,
				lanes: result.lanes,
				// The rendered brief rides on the ENTRY, not on the bus below.
				// hive-remote reads it from here to put it in the Hive agents
				// transcript (HIV-1801) — the plan-document pattern: a doorbell
				// carries a count, the prose is read from session state by a
				// subscriber that was already entitled to it.
				text,
			});
			// Rung AFTER the entry is persisted: the subscriber reads the newest
			// brief entry when it fires, so ringing first would race it to an
			// empty read.
			//
			// Only the automatic path rings. `/brief` writes to the editor and the
			// operator sends it as an ordinary prompt, which reaches Hive as a
			// normal user turn — announcing it here would double it.
			pi.events.emit(HIVE_BRIEF_CHANNEL, { sections: report.sections.length } satisfies HiveBriefEvent);
			metric(pi, METRIC_AUTO, "pass", result.elapsedMs);
			return {
				message: {
					customType: "brief",
					content: text,
					// Displayed: this is substantial content entering the model's
					// context on the operator's behalf, and an injection nobody can
					// see is an injection nobody can correct.
					display: true,
				},
			};
		} catch (err) {
			// The last hole in the fail-open contract (HIV-1805). Everything below
			// this handler resolves rather than throws, so reaching here means
			// something nobody modelled — and this is the handler that gates every
			// session's FIRST TURN. A brief that cannot be compiled costs a few
			// turns; an exception escaping here costs the prompt.
			record(pi, { mode: "auto", ok: false, failure: `brief crashed: ${String(err)}`, model: "", modelSource: "", elapsedMs: 0 });
			metric(pi, METRIC_AUTO, "fail", 0);
			return;
		} finally {
			setStatus(undefined);
			// From the `finally`, so it survives the paths that never reach a turn.
			// Reverting the remote phase on `turn_start` alone would be right on
			// every path this handler models and wrong on the one it does not — a
			// crash above, a session replaced mid-brief — and that is precisely the
			// case where a workspace stuck on "Briefing" would be the real news.
			progress(pi, "end");
		}
	});
}

/** Compile and hand the result back through the editor. */
async function compileInto(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cfg: BriefConfig,
	task: string,
	mode: "command" | "marker",
): Promise<void> {
	const cwd = ctx.cwd;
	const hasUI = ctx.hasUI;
	const notify = (message: string, type: "info" | "warning") => {
		try {
			ctx.ui.notify(message, type);
		} catch {
			/* stale ctx */
		}
	};

	try {
		ctx.ui.setStatus(STATUS_KEY, "compiling brief…");
	} catch {
		/* stale ctx */
	}
	let result;
	try {
		result = await runBriefer({ task, cwd, timeoutMs: cfg.timeoutMs, model: cfg.model });
	} catch (err) {
		// Same contract as the automatic path, and the same reason: an operator who
		// typed `/brief` gets a warning and keeps what they wrote.
		record(pi, { mode, ok: false, failure: `brief crashed: ${String(err)}`, model: "", modelSource: "", elapsedMs: 0 });
		metric(pi, METRIC_MANUAL, "fail", 0);
		notify("brief: the pass crashed — your prompt is unchanged", "warning");
		return;
	} finally {
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* stale ctx */
		}
	}

	recordLanes(pi, result.lanes);
	if (!result.draft) {
		record(pi, {
			mode,
			ok: false,
			failure: result.failure,
			model: result.model,
			modelSource: result.modelSource,
			elapsedMs: result.elapsedMs,
			lanes: result.lanes,
		});
		metric(pi, METRIC_MANUAL, result.timedOut ? "timeout" : "fail", result.elapsedMs);
		notify(`brief: ${result.failure} — your prompt is unchanged`, "warning");
		return;
	}

	// includeOriginal, unless replace is set: here the brief BECOMES the prompt,
	// so dropping the original would discard what the user actually typed.
	const { text, report } = compileBrief({
		original: task,
		draft: result.draft,
		budgetTokens: cfg.budgetTokens,
		includeOriginal: !cfg.replace,
		model: result.model,
		elapsedMs: result.elapsedMs,
	});
	record(pi, {
		mode,
		ok: true,
		failure: "",
		model: result.model,
		modelSource: result.modelSource,
		elapsedMs: result.elapsedMs,
		usage: result.usage,
		report,
		lanes: result.lanes,
	});
	metric(pi, METRIC_MANUAL, "pass", result.elapsedMs);

	if (!hasUI) {
		notify("brief: no editor to write to — run this in an interactive session", "warning");
		return;
	}
	try {
		ctx.ui.setEditorText(text);
	} catch {
		notify("brief: could not write to the editor", "warning");
		return;
	}
	notify(`brief: compiled in ${(result.elapsedMs / 1000).toFixed(1)}s — review it, then send`, "info");
}

interface BriefRecord {
	mode: "auto" | "command" | "marker";
	ok: boolean;
	failure: string;
	model: string;
	/** `override` | `mode:<key>` | `role` — which decided the model. */
	modelSource: string;
	elapsedMs: number;
	usage?: unknown;
	report?: BriefReport;
	/** Per-lane cost and outcome (HIV-1804) — a merged draft hides which lane paid for it. */
	lanes?: BriefLaneOutcome[];
	/** Set when the pass never ran, naming the suppression rule that stopped it. */
	suppressed?: string;
	/** The rendered brief, on the successful automatic path only. Read by
	 *  hive-remote to render it in the Hive agents transcript (HIV-1801). */
	text?: string;
}

/**
 * Persist what the pass cost and produced.
 *
 * `appendEntry`, so it never enters model context — this is the operator's
 * record, and the whole feature is a bet about token spend that nobody can
 * settle without it.
 *
 * It stays on the machine that wrote it: a session entry is transcript state,
 * and nothing forwards it. HIV-1798's header claimed hive-telemetry folded
 * these into the run; it does not, and never did — it reads `message_end`, not
 * entries. The fleet-visible half is `metric` below, which is why both exist.
 */
function record(pi: ExtensionAPI, entry: BriefRecord): void {
	pi.appendEntry("brief", entry);
}

/**
 * Say that the first turn is being HELD, and then that it is released (HIV-2242).
 *
 * Its own channel, not folded into `HIVE_BRIEF_CHANNEL`. That one is a document
 * doorbell: it rings once, on success, and means "a brief exists, go and read
 * it". This is a liveness signal — it fires on every automatic pass including
 * the ones that fail, and says nothing about whether there is anything to read.
 * Merging them would make the count-only payload conditional and put every
 * subscriber that wants the phase in the business of ignoring document events.
 *
 * Lane names only, and the same fail-open contract as `metric` below: a
 * subscriber that throws must never cost the prompt this handler is holding.
 *
 * The lanes are the ones this task PLANS to use — `planLanes` is pure, and the
 * runnable set is only resolved inside the briefer once the role is loaded. In
 * the one case they differ (a role that declares no tools for a lane) the brief
 * is about to fail anyway, and naming a lane that did not spawn is a smaller
 * lie than the alternative, which is announcing nothing while the turn is held.
 */
/**
 * One retrieval lane has settled.
 *
 * Same channel and the same never-throw contract as `progress`: a subscriber
 * that is absent or broken is not the brief's problem.
 */
function laneProgress(pi: ExtensionAPI, lane: string, ok: boolean, done: number, total: number): void {
	try {
		pi.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase: "lane", lane, ok, done, total } satisfies HiveBriefProgressEvent);
	} catch {
		/* no subscriber, or a subscriber that threw — never the brief's problem */
	}
}

function progress(pi: ExtensionAPI, phase: "start" | "end", lanes?: string[]): void {
	try {
		pi.events.emit(HIVE_BRIEF_PROGRESS_CHANNEL, { phase, ...(lanes ? { lanes } : {}) } satisfies HiveBriefProgressEvent);
	} catch {
		/* no subscriber, or a subscriber that threw — never the brief's problem */
	}
}

/**
 * Report the pass to hive-telemetry (HIV-1805).
 *
 * The metric channel is deliberately metric-only — a name, an enum outcome, a
 * duration, no free text — because any loaded extension can subscribe to pi's
 * bus, and a channel carrying prose would be an exfiltration path past
 * telemetry's own payload allowlist. A brief's outcome fits that shape exactly:
 * it IS a named pass/fail/timeout/skip with a duration, which is what the gate
 * bucket already models.
 *
 * Fire-and-forget by construction. Telemetry may be off, unauthenticated, or
 * not loaded at all; none of those is a reason for the brief to behave
 * differently, so the emit is wrapped and its outcome ignored.
 */
function metric(pi: ExtensionAPI, name: string, outcome: HiveMetricEvent["outcome"], valueMs: number): void {
	try {
		pi.events.emit(HIVE_METRIC_CHANNEL, { kind: "gate", name, outcome, value: Math.max(0, Math.round(valueMs)) } satisfies HiveMetricEvent);
	} catch {
		/* no subscriber, or a subscriber that threw — never the brief's problem */
	}
}

/**
 * One metric per lane, so a slow or broken lane is visible as itself.
 *
 * Without this the fan-out is opaque from outside: a pass whose ticket lane
 * times out on every prompt still reports `pass` overall, because the repo lane
 * carried it — and the fix for that is in the lane, not in the feature.
 */
function recordLanes(pi: ExtensionAPI, lanes: BriefLaneOutcome[]): void {
	for (const lane of lanes) {
		metric(pi, `${METRIC_AUTO}.${lane.lane}`, lane.ok ? "pass" : lane.timedOut ? "timeout" : "fail", lane.elapsedMs);
	}
}
