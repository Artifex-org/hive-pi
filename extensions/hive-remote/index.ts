/**
 * hive-remote — makes this pi session visible in, and steerable from, the Hive
 * agents workspace.
 *
 * OPT-IN. With no config this extension registers three commands and does
 * nothing else: no event handlers, no timers, no files, no network. Being
 * steerable from a browser is a bigger step than being measured, so it has its
 * own flag rather than riding on hive-telemetry's.
 *
 * TWO MECHANICAL CONSTRAINTS, inherited from hive-telemetry and just as binding:
 *
 *  1. Every extension handler is `await`ed serially by pi's runner — a slow
 *     handler IS the agent loop. So no handler here awaits anything, spawns
 *     anything, or touches the filesystem. They fold synchronously into an
 *     in-memory queue; the network happens on a detached timer.
 *  2. pi SKIPS the `context` / `before_provider_request` transform paths
 *     entirely when no extension registers a handler. We register none, so the
 *     prompt cache is untouched by construction.
 *
 * ctx goes stale after session replacement, so every handler reads what it needs
 * SYNCHRONOUSLY at entry. The one exception is documented at `latestCtx`.
 */

import { rehydratePlan, toEntry } from "../plan/state.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AGENDA_INJECTION_CHANNEL,
	HIVE_BRIEF_CHANNEL,
	AGENT_STATUS_CHANNEL,
	CONDUCTOR_CHANNEL,
	HIVE_BRIEF_PROGRESS_CHANNEL,
	HIVE_STDIN_WAIT_CHANNEL,
	type HiveStdinWaitEvent,
	HIVE_PLAN_CHANNEL,
	HIVE_SESSION_CHANNEL,
	HIVE_SESSION_END_CHANNEL,
	OP_MODE_CONTROL_CHANNEL,
	OP_MODE_STATE_CHANNEL,
	PLAN_CONTROL_CHANNEL,
	PLAN_GRILL_CHANNEL,
	QUESTION_ANSWER_CHANNEL,
	QUESTION_LISTENER_CHANNEL,
	QUESTION_REMOTE_CHANNEL,
	type AgendaInjectionEvent,
	type HiveBriefEvent,
	type HiveBriefProgressEvent,
	type AgentStatusEvent,
	type ConductorStageEvent,
	type HivePlanEvent,
	type HiveSessionEndEvent,
	type HiveSessionEvent,
	type OpModeControlEvent,
	type OpModeStateEvent,
	type PlanGrillEvent,
	type PlanControlEvent,
	type QuestionAnswerEvent,
	type QuestionListenerEvent,
	type QuestionRemoteEvent,
} from "../hive-common/channels.ts";
import { latestAgentStatus } from "../agenda/recap.ts";
import {
	resolveAuth,
	resolveBranch,
	resolveProject,
	resolveTerminal,
	type ResolvedAuth,
} from "../hive-common/identity.ts";
import { isOverflowWedged } from "../hive-common/overflow.ts";
import type { HiveAuth } from "../hive-common/http.ts";
import { validateToken } from "../hive-common/http.ts";
import { fetchSessionRecap } from "../agenda/session-recap.ts";
import { attach, buildCatalog, claimCommands, fetchCommandAttachment, postActivity, postDelta, postPlan, postEvents, postStatus, postToolStart, postToolUpdate, postWorktree, postWorktreePatch, resolveSession, type RemoteCommand } from "./client.ts";
import { ARGS_BUDGET, budgeted } from "./budget.ts";
import {
	HEARTBEAT_MS,
	buildPayload,
	createActivity,
	enterPhase,
	shouldReport,
	toolEnded,
	toolDetail,
	toolStarted,
	turnEnded,
	updateDetail,
	type ActivityState,
} from "./activity.ts";
import { saveAttachment, textLikeAttachment } from "./attachments.ts";
import { loadConfig, writeConfig, type RemoteConfig } from "./config.ts";
import { registerWorkspaceTools } from "./workspace.ts";
import { collectPatch, collectWorktree, type WorktreePayload } from "./worktree.ts";
import { createDeltaQueue, type DeltaQueue } from "./deltaQueue.ts";
import { openJournal, type Journal } from "./journal.ts";
import { parseTeamMessage, renderTeamMessage, triggersTurn } from "./team.ts";
import { invalidateRemoteLifecycle, isCurrentRemoteLifecycle, type RemoteLifecycle } from "./lifecycle.ts";
import { BrowserSurfacePublisher, TerminalSurfacePublisher } from "./surfaces.ts";
import {
	buildStatus,
	changed,
	fetchCodexQuota,
	isThinkingLevel,
	splitModelSpec,
	type ModeSpec,
	type QuotaWindow,
	type StatusPayload,
} from "./status.ts";
import {
	createTranscript,
	drain,
	foldToolBatch,
	foldAssistantText,
	foldNotice,
	foldToolEnd,
	deltaOf,
	foldThinking,
	foldToolStart,
	foldUserText,
	grillNoticeText,
	rebase,
	requeue,
	thinkingOf,
	turnEndNotice,
	turnFailure,
	type Transcript,
} from "./transcript.ts";
import {
	readPathOf,
	resolveSkillCommand,
	skillActivationNotice,
	skillNameFromReadPath,
} from "./skill.ts";

const BATCH_MAX = 100;
const COMMAND_POLL_MS = 2_000;
/**
 * How long a killed session's aborted turn gets to unwind before shutdown().
 *
 * One tick would probably do — this is not a race being papered over, it is
 * giving the agent loop a chance to notice the abort and stop. Small enough to
 * stay inside the headless exit grace below, which must remain the LAST thing
 * that happens.
 */
const KILL_ABORT_GRACE_MS = 250;
/**
 * How long to wait after hive-telemetry announces a run id before trying to
 * attach to it.
 *
 * Not a retry interval — a single eager attempt that skips the wait for the
 * flush timer. Sized for one round-trip of telemetry's registration POST, which
 * is fired a macrotask after the announcement and is what makes the run id
 * resolvable server-side. Short, because Hive is a LAN/Tailscale hop away; and
 * safe if it is still too short, because the flush timer stays the backstop.
 */
const ATTACH_EAGER_DELAY_MS = 250;
/**
 * How often the status snapshot is considered for sending — not how often one
 * is sent. `changed()` gates the request, so an idle session at a prompt makes
 * no traffic at all, and a working one updates about as fast as the gauge can
 * visibly move.
 */
const STATUS_TICK_MS = 5_000;
/**
 * How often the working tree is re-measured on the fallback timer.
 *
 * Far slower than the status tick because this one costs three `git`
 * subprocesses rather than a cached number, and because a tree does not change
 * between turns — the turn_end flush below is the path that matters, and this is
 * the backstop for a turn that runs for twenty minutes.
 */
const WORKTREE_TICK_MS = 60_000;
const SURFACE_TICK_MS = 2_000;
/**
 * How often the provider quota is re-read.
 *
 * Slow on purpose. It is a separate HTTP call to someone else's backend, and a
 * weekly window does not move on a five-second scale — the number an operator
 * glances at is meaningful to the minute at best. Refreshed once at attach so
 * the segment is populated before the first turn rather than after it.
 */
const QUOTA_REFRESH_MS = 5 * 60_000;

/**
 * The two ambient reads this extension makes, injectable for tests.
 *
 * Both resolve through `homedir()` — `~/.pi/agent/hive-telemetry/` — with no
 * environment seam, so a test that did not override them would read the
 * DEVELOPER'S real config and credential: green or red depending on whose
 * machine it ran on, and reaching for a live token on a machine that has one.
 * That is the reason this entry point had no wiring test at all (HIV-1627),
 * which is a poor reason to leave the attach sequence, the command dispatch and
 * the kill path unexercised.
 *
 * Same shape as `usage`'s `UsageDeps`: real implementations by default, so
 * production wiring is unchanged and only a caller that passes something gets
 * something else.
 */
export interface RemoteDeps {
	loadConfig?: () => RemoteConfig;
	resolveAuth?: (fallbackUrl?: string) => ResolvedAuth | null;
	/** Override the post-compact recap fetch (tests). Production uses fetchSessionRecap. */
	fetchSessionRecap?: (sessionID?: string | null) => Promise<string | null>;
}

export default function (pi: ExtensionAPI, deps: RemoteDeps = {}) {
	const readConfig = deps.loadConfig ?? loadConfig;
	const readAuth = deps.resolveAuth ?? resolveAuth;
	const readRecap = deps.fetchSessionRecap ?? fetchSessionRecap;
	// Read once in the factory: a plain file read, not a long-lived resource, and
	// it is what keeps the disabled path free of any handler at all.
	let cfg: RemoteConfig = readConfig();

	/**
	 * Whether the mid-session workspace grant is on, CAPTURED AT INIT.
	 *
	 * Read once here rather than off `cfg` at use, so the agent-facing tools and
	 * the `can_add_workspace` capability can never disagree: `/hive-remote-on`
	 * reassigns `cfg`, and if the attach read the live flag while the tools had
	 * already registered against the init value, a session could declare the
	 * capability with no tool behind it (or vice versa). One frozen value keeps
	 * them atomic. Flipping this flag is a config edit + restart, by design — it
	 * hands the agent a new power, not an operator a new control.
	 */
	const workspaceEnabled = cfg.allowAddWorkspace;

	const transcript: Transcript = createTranscript();
	const activity: ActivityState = createActivity(Date.now());
	let auth: HiveAuth | null = null;
	let sessionID: string | null = null;
	/** The watermark this client resumed from, for /hive-remote-status. Null when
	 *  this session started the conversation rather than rejoining one. */
	let resumedFrom: number | null = null;
	/**
	 * Events the server acknowledged but did not store, counted from the watermark
	 * it returns on every post.
	 *
	 * `rebase` makes this impossible at attach, so a non-zero count here means a
	 * DIFFERENT numbering fault — two clients minting seqs for one session, or a
	 * watermark that moved under us. It is the detector for the failure class this
	 * whole path exists to remove, and it must never be silent again.
	 */
	let silentlyDropped = 0;
	let attaching = false;
	const lifecycle: RemoteLifecycle = { generation: 0 };
	let surfacePublisher: BrowserSurfacePublisher | null = null;
	let terminalPublisher: TerminalSurfacePublisher | null = null;
	let sending = false;

	/**
	 * Whether this server understands reasoning, learned from its answers.
	 *
	 * Assumed true and withdrawn on the first refusal, rather than probed. The
	 * client running AHEAD of the server is the normal state of this pair — pi
	 * updates by `pi update`, Hive by merge and rollout — and a capability probe
	 * would be one more request per session to learn something the first real
	 * request tells us for free.
	 *
	 * `thinkingEvents` is the one that matters: a permanently-rejected batch is
	 * DROPPED, not requeued (see flush), so a batch containing a reasoning row
	 * would take the assistant text and tool calls beside it down too. The flush
	 * catches that case and re-queues the batch without its reasoning.
	 */
	let thinkingEvents = true;
	let thinkingDeltas = true;
	/**
	 * One send queue per channel, created on first use because both need `auth`
	 * and `sessionID`, which arrive at attach.
	 */
	let answerQueue: DeltaQueue | null = null;
	let thinkingQueue: DeltaQueue | null = null;
	function deltaQueue(channel?: "thinking"): DeltaQueue {
		const make = () =>
			createDeltaQueue(async (text) => {
				if (!auth || !sessionID) return;
				const res = await postDelta(auth, sessionID, text, channel);
				// A server that predates the channel 400s this and only this. Stop
				// sending rather than posting into a refusal for the life of the
				// session; ordinary text deltas are unaffected because they carry no
				// channel at all.
				if (channel && !res.ok && res.permanent) thinkingDeltas = false;
			});
		if (channel === "thinking") return (thinkingQueue ??= make());
		return (answerQueue ??= make());
	}

	/**
	 * The local journal, when one is configured. Opened at attach because it is
	 * named after the session id, and closed with everything else.
	 */
	let journal: Journal | null = null;

	/**
	 * pushDelta sends one delta both ways.
	 *
	 * LOCAL FIRST, and uncoalesced. The queue exists to keep HTTP in order and
	 * pays for it by accumulating text behind an in-flight request; a reader on
	 * this machine needs neither the ordering trick nor the wait, so it gets the
	 * text at the moment it was produced. Ordering holds there for a simpler
	 * reason: one appender, one file, append order.
	 */
	function pushDelta(text: string, channel?: "thinking"): void {
		journal?.delta(text, channel);
		deltaQueue(channel).push(text);
	}

	/**
	 * latestCtx is the ONLY retained ctx, refreshed on every handler entry.
	 *
	 * The downlink runs on a detached timer and cannot capture a ctx at
	 * registration time — that one goes stale the moment the session is replaced
	 * (a resume, a fork, a /reload), and calling abort() on a stale ctx aborts
	 * nothing. Refreshing the reference on every event means an interrupt always
	 * reaches whichever session is actually running. A stale ctx is still
	 * possible in the window between a replacement and the next event, so the
	 * call is guarded: aborting nothing is an acceptable miss, throwing into the
	 * agent loop is not.
	 */
	let latestCtx: ExtensionContext | null = null;
	const remember = (ctx: ExtensionContext) => {
		latestCtx = ctx;
	};
	/** Read the live session directory synchronously. A retained context can go
	 * stale during resume/fork/reload; absence is not permission to fall back to
	 * the process launch root, which may be a different checkout entirely. */
	const liveCwd = (): string | null => {
		try {
			return latestCtx?.cwd ?? null;
		} catch {
			return null;
		}
	};

	/**
	 * What this machine can actually run, for the workspace's "Custom…" model row
	 * (HIV-1800).
	 *
	 * `getAvailable()` rather than `getAll()`: the browser posts one of these back
	 * as a model switch, and a model with no configured auth here would be
	 * accepted by the server, queued, and then refused by `applyMode` with "no
	 * credential for … on this machine". A picker whose entries fail is worse than
	 * a shorter picker.
	 *
	 * Read at attach time rather than cached, because it is not constant: an
	 * operator adding a provider key mid-day is exactly the case where they then
	 * go looking for the new model in this list. Empty (and therefore omitted) via
	 * the guard below whenever no ctx has been seen yet — an attach must never
	 * wait on, or fail for, a suggestion list.
	 */
	const availableModels = () => {
		try {
			return latestCtx?.modelRegistry.getAvailable() ?? [];
		} catch {
			return [];
		}
	};

	/**
	 * clientRunID is announced by hive-telemetry on every agent run.
	 *
	 * Subscribed on pi.events rather than pi.on because that bus outlives the
	 * session runtime — a resumed or forked session re-announces a FRESH id, and
	 * the conversation must follow it rather than stay bound to a dead row.
	 */
	/**
	 * Why the last attach did not land, verbatim from the server where there is
	 * one. Reported by /hive-remote-status; cleared on success.
	 */
	let lastAttachError = "";

	let clientRunID = "";
	let unsubscribeSession: (() => void) | undefined;
	unsubscribeSession = pi.events.on(HIVE_SESSION_CHANNEL, (data: unknown) => {
		const id = (data as HiveSessionEvent | undefined)?.clientRunID;
		if (typeof id !== "string" || !id || id === clientRunID) return;
		clientRunID = id;
		// A new run means a new session row: drop the old binding so the next
		// attach targets the row telemetry is actually writing to.
		sessionID = null;
		// And nothing can be answered remotely until the next attach lands. Said
		// out loud rather than left to go stale: a tool that blocks on a stale
		// "yes" is the wedged-session failure this whole signal exists to avoid.
		announceRemoteAnswers(false);

		// Ring the doorbell instead of only recording it.
		//
		// `clientRunID` is the ONE precondition ensureAttached() waits on, and
		// this is the moment it arrives — but attach only ran from the flush
		// timer, so every launch sat out most of a flushIntervalMs before anyone
		// tried. Measured 2026-08-06 across real launches: 2.1–3.5s from session
		// start to the conversation row, on launches whose fast path is ~13s
		// total. That was a timer, not work.
		//
		// Deferred rather than called here, for the reason ensureAttached()
		// documents at its resolveTerminal() call: it does blocking subprocess
		// work, which has no business on an event-bus handler's stack.
		//
		// The delay is for telemetry's registration POST, which it fires one
		// macrotask after this announcement — attaching before the server has
		// heard of the run id just burns the attempt on "does not know this run
		// id yet". If it is still in flight we lose nothing: the flush timer
		// remains the backstop and behaves exactly as it does today.
		setTimeout(() => void ensureAttached(), ATTACH_EAGER_DELAY_MS).unref?.();
	});

	/**
	 * The plan doorbell (HIV-1158).
	 *
	 * The `plan` extension announces a revision and nothing else; the document
	 * itself is READ HERE, out of the session entries, under the consent this
	 * extension's own config represents. That split is what keeps prose off the
	 * process-local bus, where any loaded extension could subscribe to it — see
	 * hive-common/channels.ts.
	 *
	 * Coalesced to the newest pending revision rather than queued: the plan is a
	 * snapshot, so posting three intermediate revisions to arrive at the same
	 * document is pure waste, and the server would reject the stale ones anyway.
	 */
	let pendingPlanRevision: number | null = null;
	let sendingPlan = false;
	let unsubscribePlan: (() => void) | undefined;
	unsubscribePlan = pi.events.on(HIVE_PLAN_CHANNEL, (data: unknown) => {
		const revision = (data as HivePlanEvent | undefined)?.revision;
		if (typeof revision !== "number") return;
		pendingPlanRevision = revision;
		// Detached, like every other network call here: an extension handler is
		// awaited serially by pi's runner, so a slow handler IS the agent loop.
		setTimeout(() => void flushPlan(), 0);
	});

	/**
	 * The workflow doorbell — the plan's, applied to the stages-and-steps
	 * document.
	 *
	 * Coalescing matters more here than it does for the plan: a workflow is
	 * revised on every step tick, so a burst of five ticks in one turn would
	 * otherwise be five PUTs of a snapshot that is identical by the time the
	 * first lands. The newest pending revision wins and the rest are dropped.
	 */
	// The workflow doorbell is gone with the workflow document (HIV-2904): lanes
	// live in the plan, so `hive:plan` is the only doorbell, and it carries the
	// tick counter as well as the revision.
	/**
	 * The operating mode actually in force, as the `opmode` extension reports it.
	 *
	 * REPORTED, never inferred from the last command we forwarded: a switch can
	 * be refused locally, opmode may not be loaded at all, and a user can change
	 * the posture at the terminal with `/mode`. Undefined until something says
	 * otherwise, and undefined is sent as ABSENT — the workspace renders that as
	 * unknown, which is the only honest answer a client that does not enforce
	 * postures can give.
	 */
	let opMode: string | undefined;

	/**
	 * Whether anything in this process actually enforces postures.
	 *
	 * Having HEARD from `opmode` is the only signal worth trusting — it announces
	 * on session_start — and it is deliberately not "is the config flag on" or "is
	 * a command named /mode registered". The capability we are about to declare
	 * means "a switch sent here will be applied", and only the enforcer's own
	 * voice establishes that.
	 *
	 * Under-claiming at first attach is the safe direction, and it self-corrects:
	 * the first report re-attaches with the capability on.
	 */
	const opModeLoaded = (): boolean => opMode !== undefined;

	/**
	 * Which interactive prompts something in this process is prepared to have
	 * answered from a browser (HIV-1765).
	 *
	 * Exactly the opModeLoaded argument, applied to a different failure. The
	 * capability draws an answer FORM in the workspace; declaring it because a
	 * config flag is on, rather than because `ask`/`plan` announced themselves,
	 * would give the operator a Send button that clears the card and releases
	 * nothing — leaving an agent blocked at an overlay in a pane nobody is
	 * sitting at, which is the exact stall this feature exists to end.
	 */
	const questionListeners = new Set<string>();

	pi.events.on(QUESTION_LISTENER_CHANNEL, (data: unknown) => {
		const tool = (data as QuestionListenerEvent | undefined)?.tool;
		if (tool !== "ask_user_question" && tool !== "plan_ask") return;
		if (questionListeners.has(tool)) return;
		const first = questionListeners.size === 0;
		questionListeners.add(tool);
		// The first listener proves the capability; re-attach so the conversation
		// record stops saying this client cannot be answered.
		//
		// The SECOND one is re-attached for too: `can_grill_plan` needs both tools
		// (HIV-2080), and the extensions announce in load order. Refreshing only on
		// the first would leave the grill capability decided by whichever of `ask`
		// and `plan` happened to register earlier — a button that appears or does
		// not depending on file order is indistinguishable from a broken feature.
		if (first || questionListeners.size === 2) queueConversationRefresh();
	});

	/**
	 * Whether this client can be asked to GRILL — decline a pending plan approval
	 * and send the agent back to interrogate the operator (HIV-2080).
	 *
	 * Three conditions, and each one is a distinct way for the button to lie:
	 * without `plan_ask` the plan extension is not loaded and the decline lands
	 * nowhere; without `ask_user_question` the agent has no way to ask what it is
	 * being told to ask; without steer consent (and the delta stream that carries
	 * a question to the browser) the questions go to a terminal nobody is sitting
	 * at, and the plan never comes back.
	 */
	const canGrillPlan = () =>
		cfg.allowSteer &&
		cfg.streamDeltas &&
		questionListeners.has("ask_user_question") &&
		questionListeners.has("plan_ask");

	/**
	 * Tell the waiting tools whether a browser can actually reach them.
	 *
	 * `plan_ask` uses this to decide whether to BLOCK, so a false positive here
	 * costs a wedged session (HIV-1449: 68 minutes at a prompt nobody could see).
	 * It is therefore driven by the attach lifecycle — a live session id — and not
	 * by the config, which only says the operator would permit it.
	 */
	const announceRemoteAnswers = (available: boolean) => {
		try {
			pi.events.emit(QUESTION_REMOTE_CHANNEL, { available } satisfies QuestionRemoteEvent);
		} catch {
			/* no bus, or nothing waiting */
		}
	};

	pi.events.on(OP_MODE_STATE_CHANNEL, (data: unknown) => {
		const next = (data as OpModeStateEvent | undefined)?.mode;
		if (typeof next !== "string" || next === opMode) return;
		const first = opMode === undefined;
		opMode = next;
		// Report immediately rather than waiting for the status timer: this is the
		// one reading that changes what an operator believes the session may DO,
		// and a stale one there is worse than a stale token count.
		setTimeout(() => void flushStatus(), 0);
		// The first report is also what proves the capability. Re-attach so the
		// conversation record stops saying this client cannot switch postures.
		if (first) queueConversationRefresh();
	});

	/**
	 * Conductor stage transitions, folded as transcript notices.
	 *
	 * The event carries a stage name and nothing else (see
	 * hive-common/channels.ts); a notice is the honest rendering — the workspace
	 * transcript shows "conductor: entering plan stage" exactly where it
	 * happened, with no new wire protocol and no server change. Guarded on the
	 * config because a fold into the queue of a disabled extension would
	 * accumulate forever with nothing draining it.
	 */
	const CONDUCTOR_STAGES = new Set(["idle", "frame", "plan", "execute", "verify", "consolidate", "done"]);
	let unsubscribeConductor: (() => void) | undefined;
	unsubscribeConductor = pi.events.on(CONDUCTOR_CHANNEL, (data: unknown) => {
		if (!cfg.enabled) return;
		const stage = (data as ConductorStageEvent | undefined)?.stage;
		if (typeof stage !== "string" || !CONDUCTOR_STAGES.has(stage)) return;
		foldNotice(transcript, `conductor: entering ${stage} stage`, Date.now(), "conductor");
		kick();
	});

	/**
	 * Harness injections, folded as transcript notices (HIV-1242).
	 *
	 * The bus carries the POLICY NAME and nothing else; the notice says which
	 * mechanism steered ("gate re-run guidance", "goal continuation") without
	 * carrying the injected prose — an operator who wants the words sees them
	 * in the turn the injection triggers.
	 */
	const INJECTION_POLICIES = new Set(["verification-loop", "goal", "drift", "conductor", "loop"]);
	let unsubscribeInjection: (() => void) | undefined;
	unsubscribeInjection = pi.events.on(AGENDA_INJECTION_CHANNEL, (data: unknown) => {
		if (!cfg.enabled) return;
		const policy = (data as AgendaInjectionEvent | undefined)?.policy;
		if (typeof policy !== "string" || !INJECTION_POLICIES.has(policy)) return;
		foldNotice(transcript, `harness: ${policy} injected a follow-up turn`, Date.now(), "agenda");
		kick();
	});

	/**
	 * The plan was DECLINED and sent back for questions (HIV-2080).
	 *
	 * Folded from the outcome channel rather than from the command, because the
	 * command is a request the `plan` extension may refuse: every card in a Hive
	 * transcript stays clickable forever — they are historical rows, not a live
	 * queue — so a click on last week's card must produce no row at all rather
	 * than a notice claiming a plan was sent back.
	 *
	 * The text is MACHINE-COMPOSED in a fixed order and its prefix is a contract
	 * with the browser's card (web/src/lib/planGrill.ts), the same arrangement
	 * "Turn finished" and "Turn failed" already use. Counters only — the round
	 * and the step tally — because that is all the doorbell carries and all a
	 * reader needs to see that the loop is progressing rather than repeating.
	 */
	let unsubscribeGrill: (() => void) | undefined;
	unsubscribeGrill = pi.events.on(PLAN_GRILL_CHANNEL, (data: unknown) => {
		if (!cfg.enabled) return;
		const event = data as PlanGrillEvent | undefined;
		if (typeof event?.round !== "number" || event.round < 1) return;
		foldNotice(transcript, grillNoticeText(event.round, event.stepCount), Date.now(), "hive");
		kick();
	});

	/**
	 * The opening brief, folded into the transcript (HIV-1801).
	 *
	 * Without this the brief reaches Hive not at all: `message_end` returns early
	 * on anything whose role is not `assistant`, so the `customType` message the
	 * brief extension injects is dropped on the floor — and an operator watching
	 * the workspace saw the agent begin work on context that was invisible to
	 * them. That is the wrong way round for the one thing in a session written by
	 * neither the agent nor the operator.
	 *
	 * `kind: "notice"` with `origin: "brief"`, NOT a new kind. Kinds are
	 * allowlisted server-side and mirrored by a CHECK constraint, so a new one
	 * costs a migration; `origin` is sanitized rather than allowlisted precisely
	 * so "a new client origin must not need a server deploy first". The web
	 * renders this origin as its own row.
	 *
	 * The doorbell carries a count; the prose is read HERE, out of the session
	 * entries, under this extension's own consent — the plan-document pattern.
	 */
	let unsubscribeBrief: (() => void) | undefined;
	unsubscribeBrief = pi.events.on(HIVE_BRIEF_CHANNEL, (data: unknown) => {
		if (!cfg.enabled) return;
		const sections = (data as HiveBriefEvent | undefined)?.sections;
		// A brief that kept no sections is a brief with nothing in it; the entry
		// still exists for the spend record, but there is nothing to show.
		if (typeof sections !== "number" || sections <= 0) return;
		const text = latestBriefText(latestCtx);
		if (!text) return;
		foldNotice(transcript, text, Date.now(), "brief");
		kick();
	});

	/**
	 * The brief HOLDING the first turn, as an activity phase (HIV-2242).
	 *
	 * Every other phase this client reports belongs to a turn. This one is the
	 * window before the first turn exists: `brief` blocks `before_agent_start`
	 * by design, for up to 120s per retrieval lane, and `turn_start` — where the
	 * phase would otherwise become `working` — is precisely what it is holding.
	 * So the pane's one honest signal of life was suppressed exactly when the
	 * operator most wanted it: a launched session registered, drew no activity
	 * row, and looked identical to an agent that had hung.
	 *
	 * The lanes ride as the DETAIL, which is the field built for this — the pane
	 * already prefers a detail over a phase name for `tool`, for the same reason:
	 * "Briefing" and "Briefing · repo, knowledge, ticket" answer different
	 * questions, and the second one is the one being asked.
	 *
	 * `end` reverts to `working` rather than `idle`. The turn is about to start
	 * and the agent is not at rest — and `idle` is a phase `shouldReport`
	 * suppresses, so claiming it here would replace a wrong row with no row.
	 * `turn_start` re-enters `working` a moment later, which `enterPhase`
	 * correctly treats as a no-op rather than restarting the elapsed timer.
	 */
	// Which lanes this pass spawned, and which have landed. Reset on every
	// `start` so a second brief in the same session does not inherit the first
	// one's ticks.
	let briefLanes: string[] = [];
	let briefSettled = new Map<string, boolean>();
	/**
	 * A shell command blocked waiting for input.
	 *
	 * Reported as a DETAIL on the running tool phase, deliberately NOT as
	 * `enterPhase(…, "needs_input")`. `shouldReport` treats needs_input as
	 * idle-shaped and stops the heartbeat — so a false positive there would
	 * silence the very liveness signal the workspace uses to tell a working agent
	 * from a dead one. needs_input stays reserved for a real ask_user_question.
	 *
	 * The two confidence tiers are worded differently on purpose: `proven` means
	 * the process was observed blocked in a read on its stdin, `quiet` only means
	 * nothing has printed for a long time, and a stalled network call reaches the
	 * second but never the first.
	 */
	let unsubscribeStdinWait: (() => void) | undefined;
	unsubscribeStdinWait = pi.events.on(HIVE_STDIN_WAIT_CHANNEL, (data: unknown) => {
		if (!cfg.enabled || !cfg.reportActivity) return;
		const event = data as HiveStdinWaitEvent | undefined;
		if (event?.phase !== "waiting" && event?.phase !== "resolved") return;
		if (activity.phase !== "tool") return;
		if (event.phase === "resolved") {
			// Drop the annotation but keep the phase: the command is still running.
			updateDetail(activity, "tool", activity.tool);
			beat();
			return;
		}
		const secs = Number.isFinite(event.quietSeconds) ? Math.max(0, Math.round(event.quietSeconds)) : 0;
		const suffix = event.confidence === "proven"
			? `waiting for input (${secs}s)`
			: `no output for ${secs}s`;
		updateDetail(activity, "tool", `${activity.tool ?? "bash"} · ${suffix}`);
		beat();
	});
	let unsubscribeBriefProgress: (() => void) | undefined;
	unsubscribeBriefProgress = pi.events.on(HIVE_BRIEF_PROGRESS_CHANNEL, (data: unknown) => {
		if (!cfg.enabled || !cfg.reportActivity) return;
		const event = data as HiveBriefProgressEvent | undefined;
		const at = Date.now();
		if (event?.phase === "start") {
			briefLanes = (event.lanes ?? []).filter((l) => typeof l === "string" && l.trim());
			briefSettled = new Map();
			enterPhase(activity, "briefing", at, undefined, briefingDetail(briefLanes, briefSettled));
			beat();
			return;
		}
		// One lane settled. Re-enter the SAME phase with a new detail: enterPhase
		// treats a repeat of the current phase as a detail update and leaves the
		// elapsed timer running, which is what makes this read as progress rather
		// than as the pass restarting.
		//
		// Without these beats the row showed one unchanging line for the whole
		// pass, and a spawning session was indistinguishable from a hung one —
		// the complaint HIV-2242 half-fixed by getting a row on screen at all.
		if (event?.phase === "lane" && activity.phase === "briefing") {
			if (typeof event.lane === "string" && event.lane.trim()) {
				briefSettled.set(event.lane, event.ok !== false);
			}
			updateDetail(activity, "briefing", briefingDetail(briefLanes, briefSettled));
			beat();
			return;
		}
		// An `end` we never saw the `start` for — a brief that began before this
		// extension was switched on, a replayed event — must not drag an
		// unrelated phase into `working`. Only the phase this handler set is ours
		// to clear.
		if (event?.phase === "end" && activity.phase === "briefing") {
			enterPhase(activity, "working", at);
			beat();
		}
	});

	/**
	 * What the brief is retrieving, as one line for the activity row.
	 *
	 * Lane names are the only thing the channel carries and the only thing worth
	 * showing: they are what distinguishes "the knowledge brain is slow again"
	 * from "this is a big repo" while the operator watches the timer climb. No
	 * lanes — an older `brief` that announces only the phase — degrades to the
	 * bare word, which the pane already renders with its own elapsed counter.
	 */
	function briefingDetail(lanes: string[] | undefined, settled: Map<string, boolean>): string | undefined {
		const named = (lanes ?? []).filter((l) => typeof l === "string" && l.trim());
		if (named.length === 0) return undefined;
		// A lane that has landed is marked; one still out is left plain. A failed
		// or timed-out lane is marked DIFFERENTLY rather than dropped — "the
		// knowledge lane gave up" is the single most useful thing this row can
		// say, and hiding it would make a degraded pass look like a slow one.
		const parts = named.map((lane) => {
			if (!settled.has(lane)) return lane;
			return settled.get(lane) ? `${lane} ✓` : `${lane} ✕`;
		});
		const suffix = settled.size > 0 ? ` (${settled.size}/${named.length})` : "";
		return `Briefing · ${parts.join(", ")}${suffix}`;
	}

	/** The newest `brief` entry's rendered text, or null. */
	function latestBriefText(ctx: ExtensionContext | null): string | null {
		if (!ctx) return null;
		try {
			const entries = ctx.sessionManager.getEntries() as readonly { customType?: string; data?: unknown }[];
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i]?.customType !== "brief") continue;
				const text = (entries[i]?.data as { text?: unknown } | undefined)?.text;
				return typeof text === "string" && text.trim() ? text : null;
			}
		} catch {
			/* session replaced mid-read */
		}
		return null;
	}

	/**
	 * The recap doorbell (HIV-1240). Agenda persisted a status entry and rang;
	 * the prose is read HERE, out of the session entries, under this
	 * extension's own consent — the plan-document pattern. `needs_input`
	 * becomes the activity phase (so the workspace's triage sees it) and the
	 * recap rides one immediate beat; the server preserves it across the
	 * recap-less beats that follow.
	 */
	let unsubscribeStatus: (() => void) | undefined;
	unsubscribeStatus = pi.events.on(AGENT_STATUS_CHANNEL, (data: unknown) => {
		const revision = (data as AgentStatusEvent | undefined)?.revision;
		if (typeof revision !== "number") return;
		const status = latestStatusEntry(latestCtx);
		if (!status) return;
		const at = Date.now();
		if (status.taskState === "needs_input") {
			enterPhase(activity, "needs_input", at);
		} else if (status.taskState === "completed") {
			// The agent reached its goal (or the conductor closed the lifecycle):
			// finished work awaiting review, distinct from blocked-on-a-question
			// (HIV-1265). Idle-shaped for beating; the workspace shows it as a
			// calm "ready for review", not the amber "needs you".
			enterPhase(activity, "completed", at);
		}
		const completionSummarySeq = status.taskState === "completed" && transcript.lastAssistantSeq > 0
			? transcript.lastAssistantSeq
			: undefined;
		if (!auth || !sessionID || (!cfg.reportActivity && completionSummarySeq === undefined)) return;
		const a = auth;
		const s = sessionID;
		const payload = {
			...buildPayload(activity, at),
			...(status.recap ? { recap: status.recap } : {}),
			...(completionSummarySeq === undefined ? {} : { completion_summary_seq: completionSummarySeq }),
		};
		setTimeout(() => void postActivity(a, s, payload), 0);
	});

	/** The newest agent-status entry, or null. */
	function latestStatusEntry(ctx: ExtensionContext | null): ReturnType<typeof latestAgentStatus> {
		if (!ctx) return null;
		try {
			return latestAgentStatus(ctx.sessionManager.getEntries() as readonly unknown[]);
		} catch {
			return null;
		}
	}

	/**
	 * Read the newest plan snapshot out of the session and PUT it.
	 *
	 * Reads the entries at send time rather than caching a copy: `appendEntry`
	 * has already run by the time the doorbell rings, so the newest entry is the
	 * document the extension just persisted, and re-deriving it means there is
	 * no second copy to fall out of step.
	 */
	async function flushPlan(): Promise<void> {
		if (sendingPlan || !auth || !sessionID || pendingPlanRevision === null) return;
		const revision = pendingPlanRevision;
		pendingPlanRevision = null;

		const document = latestPlanEntry(latestCtx);
		if (!document) return;

		sendingPlan = true;
		try {
			await postPlan(auth, sessionID, document, revision);
			// Deliberately no retry and no error surfacing. A dropped plan costs a
			// stale panel until the next patch, which is seconds away in an active
			// session — and failing loudly here would put a network error in front
			// of a developer whose only crime was writing a plan.
		} catch {
			/* the next revision re-sends the whole snapshot */
		} finally {
			sendingPlan = false;
			if (pendingPlanRevision !== null) setTimeout(() => void flushPlan(), 0);
		}
	}

	/** The newest `plan` custom entry's payload, or null when there is none. */
	function latestPlanEntry(ctx: ExtensionContext | null): unknown {
		// FOLDED, not merely latest. Since HIV-2904 a status tick writes a small
		// `plan.tick` entry instead of re-emitting the whole document, so the
		// newest SNAPSHOT is the plan as of the last re-plan and knows nothing
		// about the checkboxes ticked since. Taking it would send Hive a
		// document whose progress never moves — the exact live view the merge
		// exists to make possible.
		//
		// `rehydratePlan` is a pure function over entries; importing it here is
		// the same cross-extension read `tasks` already does of `status-footer`.
		try {
			const entries = ctx?.sessionManager.getEntries() as readonly unknown[] | undefined;
			if (entries) {
				const folded = rehydratePlan(entries);
				if (folded) return toEntry(folded);
			}
		} catch {
			/* session replaced mid-read — fall through to the raw snapshot */
		}
		return latestEntryOfType(ctx, "plan");
	}

	/** The newest custom entry of a type, or null when there is none. */
	function latestEntryOfType(ctx: ExtensionContext | null, customType: string): unknown {
		if (!ctx) return null;
		try {
			const entries = ctx.sessionManager.getEntries() as readonly { customType?: string; data?: unknown }[];
			for (let i = entries.length - 1; i >= 0; i--) {
				if (entries[i]?.customType === customType) return entries[i].data ?? null;
			}
		} catch {
			/* session replaced mid-read */
		}
		return null;
	}

	// ------------------------------------------------------------------- status

	/**
	 * The last quota reading, and the last status actually sent.
	 *
	 * The quota persists between turns on purpose: it arrives only on a provider
	 * response, and the reading from the previous call is still the truth until
	 * the next one replaces it. Zeroing it between turns would make the segment
	 * blink out every time the agent went idle — which is most of the time an
	 * operator is looking at it.
	 */
	let quota: { quota?: QuotaWindow; plan_type?: string } = {};
	let lastStatus: StatusPayload | null = null;
	let sendingStatus = false;
	/**
	 * The last report the server ACCEPTED, as JSON.
	 *
	 * Compared as a string rather than field-wise: the payload is a list, and the
	 * point is only "has anything at all moved". Recording an optimistic copy
	 * would suppress every later send until the tree happened to change again, so
	 * one rejected request would freeze the panel — the same trap lastStatus
	 * documents.
	 */
	let lastWorktree: string | null = null;
	// Tool-state maps are created when a reporting session starts. Cleanup can
	// also run before that setup (for example, an immediate shutdown), so it
	// reaches them through this optional teardown instead of a temporal dead zone.
	let clearInteractiveToolState: (() => void) | undefined;
	/**
	 * The paths of the most recent worktree REPORT — the set a diff request is
	 * allowed to name (HIV-1421).
	 *
	 * `lastWorktree` next to it is the encoded payload, kept only to skip an
	 * unchanged re-send; it cannot answer "is this a file we reported", which is
	 * the question that keeps a browser-supplied string from becoming an
	 * arbitrary read on the developer's machine.
	 */
	let reportedPaths = new Set<string>();
	/** Directory paired with reportedPaths. A diff request must read from the
	 * same tree whose file list authorized it, even if the session moved since. */
	let reportedWorktreePath = "";
	let sendingWorktree = false;

	/**
	 * Re-read the provider quota.
	 *
	 * Keeps the previous reading when the fetch cannot answer: an unreachable
	 * endpoint, a non-codex model, a proxy credential. An absent answer is not a
	 * reset quota, and blanking the segment every time the network hiccuped
	 * would make it useless exactly when it matters.
	 */
	async function refreshQuota(): Promise<void> {
		if (!cfg.reportStatus || !latestCtx) return;
		try {
			const reading = await fetchCodexQuota(latestCtx, Date.now());
			if (reading) {
				quota = reading;
				setTimeout(() => void flushStatus(), 0);
			}
		} catch {
			/* the next refresh tries again */
		}
	}

	/**
	 * Measure the working tree and report it if it moved.
	 *
	 * BLOCKING for the duration of three `git` calls, which is why every caller is
	 * a detached timer or a setTimeout(…, 0) — never a handler. pi awaits handlers
	 * serially, so a 40ms subprocess inside one is 40ms of stalled agent loop.
	 */
	async function flushWorktree(): Promise<void> {
		if (sendingWorktree || !cfg.reportWorktree || !auth || !sessionID) return;
		const cwd = liveCwd();
		if (!cwd) return;

		let next: WorktreePayload | null;
		try {
			next = collectWorktree(cwd);
		} catch {
			// collectWorktree already swallows git's own failures; this covers the
			// cwd having been removed underneath us (a torn-down worktree).
			return;
		}
		// Not a repository. Sending an empty tree would render as CLEAN, which is a
		// different and much more misleading claim than "no report".
		if (!next) return;

		const encoded = JSON.stringify(next);
		if (encoded === lastWorktree) return;

		sendingWorktree = true;
		try {
			const res = await postWorktree(auth, sessionID, next);
			if (res.ok) {
				lastWorktree = encoded;
				reportedPaths = new Set(next.files.map((f) => f.path));
				reportedWorktreePath = next.path;
			}
		} catch {
			/* the next tick re-measures and re-sends */
		} finally {
			sendingWorktree = false;
		}
	}

	async function flushStatus(): Promise<void> {
		if (sendingStatus || !cfg.reportStatus || !auth || !sessionID || !latestCtx) return;

		let next: StatusPayload;
		try {
			next = buildStatus(latestCtx, pi, quota, opMode);
		} catch {
			// A ctx replaced mid-read. The next tick has a live one.
			return;
		}
		if (!changed(lastStatus, next)) return;

		sendingStatus = true;
		try {
			const res = await postStatus(auth, sessionID, next);
			// Only remember what the server accepted. Recording an optimistic copy
			// would suppress every subsequent send until the reading moved again,
			// so one rejected request would silently freeze the bar.
			if (res.ok) lastStatus = next;
		} catch {
			/* the next tick re-derives and re-sends */
		} finally {
			sendingStatus = false;
		}
	}

	// ------------------------------------------------------------------ sending

	/** flush sends one batch. Never awaited by anything pi controls. */
	async function flush(): Promise<void> {
		if (sending || !auth || !sessionID) return;
		const batch = drain(transcript, BATCH_MAX);
		if (batch.length === 0) return;
		sending = true;
		try {
			const res = await postEvents(auth, sessionID, batch);
			if (res.ok) {
				// The server answers every post with its watermark. A 2xx therefore
				// does NOT mean "stored" — events at or below the watermark are
				// dropped by the idempotent insert, and until now that answer was
				// parsed by nothing, which is why the reload bug could run for
				// months looking like a quiet session rather than a failing one.
				const highest = batch[batch.length - 1]?.seq ?? 0;
				const watermark = res.body?.last_seq;
				// After storing a batch the watermark is GREATEST(previous, highest),
				// so a clean post answers with exactly `highest`. Anything ABOVE it
				// means the server was already past this whole batch and discarded
				// every event in it — the reload failure, in the one place it is
				// visible from a 2xx. (A partial overlap answers with `highest` too
				// and is not detectable from the response alone; say what is known
				// rather than imply a count that was never measured.)
				if (Number.isInteger(watermark) && (watermark as number) > highest) {
					silentlyDropped += batch.length;
					foldNotice(
						transcript,
						`Hive discarded ${batch.length} event${batch.length === 1 ? "" : "s"} numbered up to ${highest}: its watermark is already ${watermark}`,
						Date.now(),
						"hive",
					);
					// Catch up so the NEXT batch lands above it rather than repeating
					// this for the rest of the session.
					rebase(transcript, watermark as number);
				}
			}
			if (!res.ok) {
				// Permanent means this server will never accept the batch, so
				// re-queuing it would retry forever and block everything behind it.
				// Auth failure stops the whole extension rather than hammering.
				if (res.authFailed) {
					// /hive-login, registered by hive-telemetry — this used to name
				// /hive-remote-login, which nothing registers, so the one message an
				// operator sees when the credential expires sent them to a command
				// that does not exist.
				stop("authentication failed — run /hive-login");
					return;
				}
				// A server that predates reasoning rejects the WHOLE batch with
				// "unknown event kind", and a permanent rejection is dropped — so
				// the assistant text and tool calls travelling with it would be lost
				// to a feature they have nothing to do with. Withdraw the capability
				// and re-queue what this server can actually store.
				if (res.permanent && thinkingEvents && batch.some((e) => e.kind === "thinking")) {
					thinkingEvents = false;
					requeue(transcript, batch.filter((e) => e.kind !== "thinking"));
					return;
				}
				if (!res.permanent) requeue(transcript, batch);
			}
		} finally {
			sending = false;
		}
	}

	function kick(): void {
		// setTimeout(0) rather than an await: the caller is an event handler, and
		// the agent loop must not wait on the network.
		setTimeout(() => void flush(), 0);
	}

	/**
	 * Send the heartbeat, if it is worth sending.
	 *
	 * Called from event handlers (a transition is news the moment it happens) AND
	 * from a timer (nothing changing for four minutes is exactly when the pane
	 * needs proof). `shouldReport` gates both, so the two callers cannot produce
	 * a duplicate between them.
	 *
	 * setTimeout(0) for the same reason everything else here uses it: pi awaits
	 * handlers serially, so a beat that waited on the network would BE the agent
	 * loop — a liveness feature that made the agent slower.
	 */
	function beat(): void {
		if (!cfg.reportActivity || !auth || !sessionID) return;
		const at = Date.now();
		if (!shouldReport(activity, at)) return;
		const a = auth;
		const s = sessionID;
		const payload = buildPayload(activity, at);
		setTimeout(() => void postActivity(a, s, payload), 0);
	}

	// ----------------------------------------------------------------- downlink

	/**
	 * Is the session unable to send another request at all?
	 *
	 * Reads through `latestCtx` because that is the only ctx this extension
	 * retains, and returns FALSE on anything it cannot read: a downlink that
	 * suppressed deliveries because it could not see the session would be a
	 * worse failure than the one it is preventing.
	 */
	function overflowWedged(ctx: ExtensionContext | null): boolean {
		if (!ctx) return false;
		try {
			return isOverflowWedged(ctx.sessionManager.getBranch() as readonly unknown[]);
		} catch {
			return false;
		}
	}

	async function applyCommand(cmd: RemoteCommand): Promise<void> {
		switch (cmd.kind) {
			case "steer":
			case "follow_up": {
				if (!cfg.allowSteer || !auth || !sessionID) return;
				const attachments = await Promise.all(
					(cmd.attachment_ids ?? []).map((id) => fetchCommandAttachment(auth as HiveAuth, sessionID as string, id)),
				);
				if (attachments.some((a) => a === null)) {
					foldNotice(transcript, "could not retrieve attachment from Hive", Date.now(), "hive");
					kick();
					return;
				}
				// Three deliveries by kind (HIV-1939): images stay image blocks;
				// text-like files inline as fenced text (the model can read them
				// directly); everything else lands in the worktree, where the
				// agent's own tools can open it — a base64 blob in context helps
				// nothing and costs everything.
				let text = cmd.payload;
				const imageBlocks: { type: "image"; mimeType: string; data: string }[] = [];
				for (const a of attachments) {
					const att = a!;
					if (att.mediaType === "image/png" || att.mediaType === "image/jpeg" || att.mediaType === "image/webp") {
						imageBlocks.push({ type: "image", mimeType: att.mediaType, data: att.data });
						continue;
					}
					const bytes = Buffer.from(att.data, "base64");
					const name = att.fileName || "attachment";
					if (textLikeAttachment(att.mediaType) && bytes.length <= 256 * 1024) {
						text += `\n\n[attached file: ${name} (${att.mediaType})]\n\`\`\`\n${bytes.toString("utf8")}\n\`\`\``;
						continue;
					}
					const saved = saveAttachment(name, bytes);
					text += saved
						? `\n\n[attached file saved to ${saved} (${att.mediaType}, ${bytes.length} bytes)]`
						: `\n\n[attachment ${name} could not be saved]`;
				}
				// expandPromptTemplates is required for a browser `/skill:name` to
				// actually expand — without it the slash stays literal user text
				// and the Access rail never sees an applied skill. Only a
				// catalogued skill opts in: factory launches `--no-skills`, and
				// expanding an unknown slash would dispatch a command that is not
				// there. A text-only steer is sent as a STRING because that is the
				// documented expansion path; an image-bearing one stays an array.
				const expand = resolveSkillCommand(cmd.payload, pi.getCommands()) !== null;
				const deliverAs = cmd.kind === "steer" ? "steer" as const : "followUp" as const;
				if (imageBlocks.length === 0) {
					pi.sendUserMessage(text, { deliverAs, expandPromptTemplates: expand });
				} else {
					pi.sendUserMessage([{ type: "text" as const, text }, ...imageBlocks], {
						deliverAs,
						expandPromptTemplates: expand,
					});
				}
				// Echo the server-stamped source as the event's origin: this is the
				// only place the transcript can learn whether the steer came from
				// the operator or from another agent's MCP call (HIV-1215) — and,
				// with the issuer, WHICH PERSON, once a read-write share means the
				// owner is not the only human who can steer (HIV-1420).
				foldUserText(transcript, cmd.payload, Date.now(), cmd.source, cmd.issued_by);
				kick();
				return;
			}
			case "compact": {
				// A built-in Pi command, not a steer: `sendUserMessage("/compact")`
				// would send the literal text to the model because the remote path
				// bypasses the interactive command parser.
				if (!cfg.allowSteer) return;
				try {
					latestCtx?.compact();
				} catch {
					// A replaced context cannot compact; the next command remains explicit.
				}
				kick();
				return;
			}
			case "complete": {
				if (!cfg.allowKill) return;
				// The reviewed final assistant message and acknowledgement are already
				// durable before this command is claimed. Do not add a best-effort
				// terminal notice that could race graceful shutdown and imply delivery.
				setTimeout(() => {
					try {
						latestCtx?.shutdown();
					} catch {
						// A failed graceful shutdown leaves the session available for the
						// operator to inspect or end explicitly; never crash the downlink.
					}
				}, 0);
				if (!process.stdout.isTTY) setTimeout(() => process.exit(0), 2_000);
				return;
			}
			case "kill": {
				if (!cfg.allowKill) return;
				// Fold the notice BEFORE shutting down: this is the last thing this
				// session will ever say, and it is the only record of WHY it ended.
				// A session that simply vanishes is indistinguishable from a crash.
				foldNotice(transcript, "killed from the Hive agents workspace", Date.now(), "hive");
				// Tell hive-telemetry why, for the same reason and in the same
				// breath. The notice above lands in the TRANSCRIPT, which a human
				// has to open; the session row's `outcome` is what every fleet
				// aggregate reads, and without this it would say `completed` —
				// shutdown() is graceful, so pi reports reason "quit". Emitted
				// before shutdown() because that call does not return here.
				pi.events.emit(HIVE_SESSION_END_CHANNEL, { reason: "killed" } satisfies HiveSessionEndEvent);
				kick();

				// STOP THE TURN FIRST. shutdown() ends a session that is WAITING; it
				// does not end one inside a turn.
				//
				// Measured 2026-08-06 on three real kills: two sessions claimed the
				// command mid-tool-call and carried on working — one issued its next
				// tool call twelve seconds later and was still alive four minutes
				// on — while a third, idle at its prompt, died on the same command.
				// The command was delivered, acknowledged, and silently ignored,
				// which is the worst of the three outcomes: the operator watches a
				// session they believe they ended.
				//
				// So abort the in-flight turn, exactly as `interrupt` does, and only
				// then shut down. The kill was designed for a session wedged rather
				// than busy; busy is the common case.
				try {
					latestCtx?.abort();
				} catch {
					// A stale ctx aborts nothing. That is a miss, not a failure —
					// and it must never propagate into the agent loop.
				}

				// Deferred so the aborted turn can unwind before shutdown runs.
				// Calling both in the same tick is indistinguishable from never
				// having aborted, which is the bug this is fixing.
				//
				// Graceful, not process.exit(): pi persists the session and fires
				// session_shutdown, which is what stops agenda's durable workers.
				// Killing the process instead would orphan them holding their
				// worktree locks — invisibly, since the parent is gone.
				//
				// Via latestCtx, the same route `interrupt` uses for abort():
				// shutdown() is on ExtensionContext, not ExtensionAPI.
				setTimeout(() => {
					try {
						latestCtx?.shutdown();
					} catch {
						// A shutdown that throws leaves the session alive; the operator
						// sees no state change and can escalate. Never let it propagate
						// into the poll loop and kill the downlink for other commands.
					}
				}, KILL_ABORT_GRACE_MS).unref?.();
				// HEADLESS ONLY: under `--mode rpc` shutdown() ends the SESSION but
				// the process stays alive on stdin, answering get_state forever —
				// measured, not assumed. In a TUI the human sees the app close; in a
				// pod (or any pipe-driven pi) nothing supervises the survivor, the
				// task never finishes, and "Kill" in the workspace becomes a lie.
				// So a kill of a headless session also ends the process, after a
				// grace period long enough for the telemetry flush and this
				// extension's own final folds to leave the machine.
				//
				// exit(0), not a signal: the wrapper treats a clean exit after a
				// kill command as the operator's success path, not a failure.
				if (!process.stdout.isTTY) {
					setTimeout(() => process.exit(0), 2000);
				}
				return;
			}
			case "interrupt": {
				if (!cfg.allowInterrupt) return;
				try {
					latestCtx?.abort();
				} catch {
					// A stale ctx aborts nothing. That is a miss, not a failure —
					// and it must never propagate into the agent loop.
				}
				foldNotice(transcript, "interrupted from the Hive agents workspace", Date.now(), "hive");
				kick();
				return;
			}
			case "set_mode": {
				if (!cfg.allowSetMode) return;
				await applyMode(cmd.payload);
				return;
			}
			case "set_op_mode": {
				if (!cfg.allowSetOpMode) return;
				applyOpMode(cmd.payload);
				return;
			}
			case "plan_approve": {
				// A request only: plan owns the ready-state check and may refuse it.
				pi.events.emit(PLAN_CONTROL_CHANNEL, { action: "approve" } satisfies PlanControlEvent);
				return;
			}
			case "plan_grill": {
				// The decline half (HIV-2080). A request only, same as approve: plan
				// validates that there is a pending gate and ignores a stale click.
				//
				// Gated on steer consent, which approve is not, and the asymmetry is
				// the point. Approving RELEASES a session the operator already
				// started; grilling puts a new instruction into its context and burns
				// a turn on it, which is what `allowSteer` is the consent for.
				if (!cfg.allowSteer) return;
				// The notice is folded from the OUTCOME channel below, not here.
				// `plan` may refuse this — a stale click on an old card in the
				// transcript is the ordinary case, since every card stays clickable
				// forever — and a notice folded on receipt would tell the operator
				// their plan had been sent back when nothing had happened.
				pi.events.emit(PLAN_CONTROL_CHANNEL, { action: "grill" } satisfies PlanControlEvent);
				return;
			}
			case "worktree_diff": {
				// The operator opened a changed file in the workspace (HIV-1421).
				// Answered here and nowhere else: the server has no copy of unpushed
				// work, so this machine is the only thing that can say what changed.
				//
				// Detached, because reading a diff is three subprocesses and an
				// event handler must never block the agent loop. Always answered —
				// even when the answer is empty, with its reason — because the
				// browser is on a 30-second deadline and an unanswered request
				// renders as a shrug rather than as the honest "no changes".
				const path = cmd.payload;
				if (!path || !auth || !sessionID) return;
				const a2 = auth;
				const s2 = sessionID;
				const known = reportedPaths;
				const worktreePath = reportedWorktreePath;
				if (!worktreePath) {
					void postWorktreePatch(a2, s2, { path, patch: "", reason: "no worktree reported yet" });
					return;
				}
				setTimeout(() => {
					// The known-path check is the boundary: only a file this session
					// has already REPORTED as changed can be read back. Without it the
					// request is an arbitrary-file read on the developer's machine,
					// addressed by a string from a browser.
					const patch = collectPatch(worktreePath, path, (p) => known.has(p));
					void postWorktreePatch(a2, s2, patch);
				}, 0);
				return;
			}
			case "question_answer": {
				// An operator answered a blocked prompt in the browser (HIV-1765).
				// Routed by tool call id and nothing else: whichever extension is
				// waiting on that call takes it, and everyone else — including a tool
				// that already settled locally — ignores it. A late answer is the
				// normal race, not an error, so there is nothing to report here.
				let event: QuestionAnswerEvent | null = null;
				try {
					const parsed = JSON.parse(cmd.payload) as { call_id?: unknown; answers?: unknown };
					if (typeof parsed.call_id === "string" && parsed.call_id !== "") {
						event = {
							callID: parsed.call_id,
							answers: (parsed.answers ?? {}) as Record<string, string[]>,
						};
					}
				} catch {
					/* fall through to the notice */
				}
				if (!event) {
					// The one case worth saying out loud: the operator believes they
					// answered, and nothing will act on it.
					foldNotice(transcript, "Hive sent an answer this client could not read", Date.now(), "hive");
					kick();
					return;
				}
				pi.events.emit(QUESTION_ANSWER_CHANNEL, event satisfies QuestionAnswerEvent);
				return;
			}
			case "team_message": {
				// Gated on the same consent as steer: a teammate's message enters the
				// agent's context exactly like an operator's would, so the server only
				// enqueues it to clients that declared can_message (= allowSteer here).
				if (!cfg.allowSteer) return;
				const msg = parseTeamMessage(cmd.payload ?? "");
				if (!msg) {
					foldNotice(transcript, "Hive sent a team message this client could not read", Date.now(), "team");
					kick();
					return;
				}
				const rendered = renderTeamMessage(msg);
				// A custom message rather than a user message (the agenda precedent):
				// the transcript should show a teammate speaking, not the operator.
				// Only a direct "message" wakes an idle agent; every other category
				// — relationship, lifecycle, and the HIV-1488 digest/note pushes —
				// waits for the next turn. The digest in particular goes to every
				// member on a timer, so waking on it would bill a turn per member
				// per sweep for a team with nothing to report.
				// Never WAKE a session that is wedged against its own context
				// window. The wake does not land as a message the model reads; it
				// lands as one more refused request, and each refusal leaves the
				// context larger than the last. Measured, this path plus
				// `background`'s notify kept a grok session issuing identical 400s
				// for 12h27m (HIV-3060) — see `hive-common/overflow.ts`.
				//
				// The message is still DELIVERED and still folded, so nothing is
				// lost: it sits in the queue for whenever the session can run
				// again, exactly as a non-waking team category already does.
				const wedged = overflowWedged(latestCtx);
				pi.sendMessage(
					{ customType: "team-message", content: rendered, display: true },
					{ deliverAs: "followUp", triggerTurn: !wedged && triggersTurn(msg.category) },
				);
				foldNotice(transcript, rendered, Date.now(), "team");
				if (wedged) {
					// The only place a human learns why their teammate's message
					// produced nothing. A wedged session looks identical to a busy
					// one from the workspace.
					foldNotice(
						transcript,
						"queued without waking the agent: this session is wedged on a context overflow",
						Date.now(),
						"hive",
					);
				}
				kick();
				return;
			}
			default:
				// start_session is for hive-agent, not for a session that already
				// exists. Unknown kinds are ignored so an older client stays
				// forward-compatible with a newer server.
				return;
		}
	}

	/**
	 * Switch this session's model and thinking level.
	 *
	 * The payload carries the RESOLVED model, not a difficulty name: Hive owns
	 * the mode→model mapping and applies it when the operator clicks, so the two
	 * sides can never come to disagree about what "high" means, and the record of
	 * what was actually asked for is exact.
	 *
	 * Every outcome folds a notice, including the failures. This changes what is
	 * doing the thinking for every subsequent turn, and a switch that silently
	 * did not happen is the worst version of that: the operator believes the
	 * session is on a stronger model and reads its output accordingly.
	 */
	async function applyMode(payload: string): Promise<void> {
		let spec: ModeSpec;
		try {
			spec = JSON.parse(payload) as ModeSpec;
		} catch {
			foldNotice(transcript, "Hive sent a mode switch this client could not read", Date.now(), "hive");
			kick();
			return;
		}

		const parts = spec?.model ? splitModelSpec(spec.model) : null;
		if (!parts) {
			foldNotice(transcript, `Hive asked for an unusable model id ${JSON.stringify(spec?.model ?? "")}`, Date.now(), "hive");
			kick();
			return;
		}

		const model = latestCtx?.modelRegistry.find(parts.provider, parts.id);
		if (!model) {
			// The mode config is fleet-wide; a workstation need not have every model
			// in it configured. Say which one is missing — the operator can add it.
			foldNotice(transcript, `mode "${spec.mode}" needs ${spec.model}, which is not configured on this machine`, Date.now(), "hive");
			kick();
			return;
		}

		let switched = false;
		try {
			switched = await pi.setModel(model);
		} catch {
			switched = false;
		}
		if (!switched) {
			foldNotice(transcript, `could not switch to ${spec.model} — no credential for ${parts.provider} on this machine`, Date.now(), "hive");
			kick();
			return;
		}

		// After the model, never before: pi clamps the level to the model's
		// capabilities, so setting it against the outgoing model would clamp
		// against the wrong ceiling.
		if (isThinkingLevel(spec.thinking)) {
			try {
				pi.setThinkingLevel(spec.thinking);
			} catch {
				// A model that refuses the level still ran the switch. Reporting the
				// model change honestly matters more than the level.
			}
		}

		foldNotice(transcript, `mode set to ${spec.mode} (${spec.model}) from the Hive agents workspace`, Date.now(), "hive");
		kick();
		// Report the new model immediately rather than waiting for the next tick:
		// the browser's selector should settle on what HAPPENED, not on what was
		// requested, and the round trip is the only thing that can tell it apart.
		setTimeout(() => void flushStatus(), 0);
		queueConversationRefresh();
	}

	/**
	 * Switch this session's OPERATING mode — what the harness allows.
	 *
	 * A DOORBELL, not an application: this extension does not enforce postures
	 * and must not pretend to. It hands the requested key to the `opmode`
	 * extension, which owns the closed set and the enforcement, and learns the
	 * outcome the same way the browser does — by being told what mode is actually
	 * in force on OP_MODE_STATE_CHANNEL.
	 *
	 * That indirection is why there is no success notice here. Announcing "mode
	 * set to plan" at the moment of forwarding would be this extension asserting
	 * a restriction it neither applied nor verified — and if `opmode` is not
	 * loaded, nothing would have happened at all.
	 */
	function applyOpMode(payload: string): void {
		let mode = "";
		try {
			mode = (JSON.parse(payload) as { mode?: string })?.mode ?? "";
		} catch {
			mode = "";
		}
		if (!mode) {
			foldNotice(transcript, "Hive sent an operating-mode switch this client could not read", Date.now(), "hive");
			kick();
			return;
		}
		try {
			pi.events.emit(OP_MODE_CONTROL_CHANNEL, { mode, source: "hive" } satisfies OpModeControlEvent);
		} catch {
			/* no bus, or the opmode extension is not loaded */
		}
	}

	async function pollOnce(): Promise<void> {
		if (!auth || !sessionID) return;
		const cmds = await claimCommands(auth, sessionID);
		for (const cmd of cmds) await applyCommand(cmd);
	}

	// ------------------------------------------------------------------ attach

	/**
	 * ensureAttached resolves identity and registers the conversation.
	 *
	 * Blocking I/O (git, file reads) lives here rather than in a handler, and it
	 * runs on the timer. `attaching` guards against a second attempt overlapping
	 * a slow first one.
	 */
	async function ensureAttached(): Promise<void> {
		if (sessionID || attaching || !cfg.enabled) return;
		const cwd = liveCwd();
		if (!cwd) return;
		attaching = true;
		const generation = lifecycle.generation;
		try {
			const resolved = readAuth(cfg.url);
			if (!resolved) {
				lastAttachError = "no Hive credential — run /hive-login";
				return;
			}
			auth = { token: resolved.token, url: resolved.url };

			// hive-telemetry owns the session row and announces its client-minted
			// run id on the in-process bus; we resolve that to the server's session
			// id. Without it there is nothing to attach a conversation TO, which is
			// the case /hive-remote-status reports explicitly rather than silently
			// looking enabled while doing nothing.
			if (!clientRunID) return;
			const resolvedSession = await resolveSession(auth, clientRunID);
			if (!isCurrentRemoteLifecycle(lifecycle, generation)) return;
			if (!resolvedSession) {
				lastAttachError = "Hive does not know this run id yet — waiting for hive-telemetry's first flush";
				return;
			}

			const project = resolveProject(cwd);
			// Blocking (a subprocess, for a session nobody launched) — which is
			// why it is HERE, on the attach timer, and not in a handler.
			const terminal = resolveTerminal();
			const res = await attach(auth, resolvedSession, {
				title: pi.getSessionName() ?? project.projectHint,
				branch: resolveBranch(cwd),
				worktree: cwd,
				terminal: terminal?.name,
				terminal_kind: terminal?.kind,
				can_steer: cfg.allowSteer,
				can_interrupt: cfg.allowInterrupt,
				can_kill: cfg.allowKill,
				// Completion uses the same local shutdown primitive as kill, but has
				// distinct server semantics: it records the completed outcome instead
				// of an operator termination.
				...(cfg.allowKill ? { can_complete: true } : {}),
				can_set_mode: cfg.allowSetMode,
				// Declared only when the `opmode` extension is actually loaded. The
				// config flag alone is not enough: it says the OPERATOR permits remote
				// posture switches, not that anything in this process can enforce one.
				// Claiming it without opmode would let the workspace show a session as
				// read-only while every write tool stayed open — the worst failure this
				// feature can produce, and the reason the capability is gated on the
				// enforcer rather than on the permission.
				can_set_op_mode: cfg.allowSetOpMode && opModeLoaded(),
				// Team messages enter the context like a steer does, so they ride the
				// same consent rather than growing a separate flag.
				can_message: cfg.allowSteer,
				// Browser approvals are a separate, later opt-in (HIV-1088). Never
				// declare a capability this build cannot honour: the UI renders
				// controls from these, so a false claim is a button that hangs.
				can_approve: false,
				// Compaction aborts a turn, so it is gated on the same explicit remote
				// control consent as a steer. Spread-only for older Hive servers.
				...(cfg.allowSteer ? { can_compact: true } : {}),
				// SPREAD IN ONLY WHEN ON, never `can_add_workspace: false`. Attach is
				// a strict full-record PUT, and a server that predates this field
				// would reject the WHOLE body if it always arrived — the HIV-1163
				// class that costs a session its conversation. Off (the default) must
				// send a body byte-identical to today's.
				...(workspaceEnabled ? { can_add_workspace: true } : {}),
				// Same spread-only-when-true rule, same HIV-1163 reason. Gated on a
				// LISTENER having announced itself — never on config alone: this flag
				// draws an answer form, and a form nothing is waiting behind is worse
				// than no form at all. streamDeltas joins it because that is what
				// carries the question to the browser in the first place.
				...(questionListeners.size > 0 && cfg.streamDeltas ? { can_answer_questions: true } : {}),
				// The grill verb (HIV-2080). Same spread-only-when-true rule, same
				// HIV-1163 reason; the three conditions live in canGrillPlan().
				...(canGrillPlan() ? { can_grill_plan: true } : {}),
				// The working-tree diff (HIV-1421, declarable since HIV-1769 — the
				// server never read this field, so the feature was refused for every
				// client for its whole life). Spread-only-when-true like its
				// neighbours, and gated on `reportWorktree`: the diff can only name a
				// file the worktree REPORT listed, so without the report there is
				// nothing a request could legitimately ask for.
				...(cfg.reportWorktree ? { can_diff: true } : {}),
				// File attachments (HIV-1939): this build's steer path fetches any
				// content type and never drops a steer on a non-image. Spread only
				// when steer is on — an attachment is a steer argument.
				...(cfg.allowSteer ? { can_attach_files: true } : {}),
				catalog: buildCatalog(pi.getCommands(), availableModels()),
			});
			if (!isCurrentRemoteLifecycle(lifecycle, generation)) return;
			if (res.ok) {
				sessionID = resolvedSession;
				lastAttachError = "";
				// The journal is named after the session, so this is the first
				// moment it can exist. A re-attach replaces it rather than
				// leaking the old handle.
				journal?.close();
				journal = openJournal(resolvedSession);
				// A browser can reach this session now, which is what lets `plan_ask`
				// block instead of returning its question as text.
				//
				// Gated on streamDeltas because that is what carries the question TO
				// the browser: `postToolStart` rides the same consent, and it is what
				// creates the durable row the answer form is drawn from. Without it
				// the operator is never shown the question, so a blocking `plan_ask`
				// would wait out its full window for an answer nobody could give —
				// re-creating, precisely, the stuck chat this feature exists to end.
				announceRemoteAnswers(cfg.streamDeltas);
				// RESUME FROM THE SERVER'S WATERMARK, before anything can be sent.
				//
				// This is the whole point of `last_seq` coming back from attach, and
				// for a long time it was read by nothing: a `/reload` builds a fresh
				// Transcript numbering from 1, the server's insert ignores anything at
				// or below its watermark, and so every turn after a reload vanished
				// with no error anywhere — the session simply looked idle. See
				// `rebase` for why the queue moves with the counter.
				const shift = rebase(transcript, res.body?.last_seq);
				if (shift > 0) {
					resumedFrom = res.body?.last_seq ?? null;
					foldNotice(transcript, `resumed the Hive transcript from event ${resumedFrom}`, Date.now(), "hive");
				}
				// Read the quota once now rather than waiting out the refresh
				// interval: an operator opening the workspace on a session that has
				// been idle for an hour should see a number, not an empty segment
				// that fills in five minutes.
				setTimeout(() => void refreshQuota(), 0);
				// And the tree, for the same reason: an operator opening the workspace
				// on a session that has been mid-task for an hour should see what it
				// has changed, not an empty panel that fills in a minute.
				if (cfg.reportWorktree) setTimeout(() => void flushWorktree(), 0);
			} else if (res.authFailed) {
				// /hive-login, registered by hive-telemetry — this used to name
				// /hive-remote-login, which nothing registers, so the one message an
				// operator sees when the credential expires sent them to a command
				// that does not exist.
				stop("authentication failed — run /hive-login");
			} else {
				// Say WHY, every time. A rejected attach used to be indistinguishable
				// from one that had simply not happened yet: /hive-remote-status said
				// `attached: no` and stopped there, so the only way to learn that the
				// server had rejected the body — and which field it objected to — was
				// to reconstruct the request by hand with curl. Hours went into that
				// once (HIV-1163, an over-long skill description); the reason was in
				// the response the whole time, and this simply keeps it.
				lastAttachError = res.error ?? `Hive rejected the attach (HTTP ${res.status ?? "?"})`;
				// `permanent` means this body will never be accepted by this server.
				// The timer still retries — a redeploy can make it valid, and this
				// extension must self-heal without a restart — but the operator is no
				// longer the last to know.
				if (res.permanent) lastAttachError += " — this will not succeed until the client or server changes";
			}
		} finally {
			if (isCurrentRemoteLifecycle(lifecycle, generation)) attaching = false;
		}
	}

	/** Re-attach with the latest title after Pi session metadata changes. */
	function queueConversationRefresh(): void {
		if (!auth || !sessionID || lifecycle.titleTimer) return;
		const generation = lifecycle.generation;
		lifecycle.titleTimer = setTimeout(() => {
			lifecycle.titleTimer = undefined;
			const currentAuth = auth;
			const currentSessionID = sessionID;
			if (!currentAuth || !currentSessionID || !isCurrentRemoteLifecycle(lifecycle, generation)) return;

			const cwd = liveCwd();
			if (!cwd) return;
			void (async () => {
				try {
					const project = resolveProject(cwd);
					// Re-resolved rather than captured: a resumed session can be in a
					// different tmux session than the one it first attached from. Cheap
					// in the case that matters — a launched agent is TOLD its session
					// name through the environment, so this reads a variable rather than
					// spawning anything. This runs on a detached timer, never inside a
					// handler, so the fallback's subprocess cannot stall the agent loop.
					const terminal = resolveTerminal();
					await attach(currentAuth, currentSessionID, {
						title: pi.getSessionName() ?? project.projectHint,
						branch: resolveBranch(cwd),
						worktree: cwd,
						// SEND THE TERMINAL HERE TOO, or the refresh erases it.
						//
						// An attach is a whole-record PUT, so a field this call omits is
						// a field the server overwrites with nothing. Leaving the
						// terminal out meant the join hint appeared at attach and was
						// wiped by the first auto-title — seconds later, silently, and
						// indistinguishable from never having reported one.
						//
						// The server now preserves on empty (HIV-1166), so this is the
						// belt to that braces: the value is CORRECT here rather than
						// merely not-destroyed, which also means a session that moved to
						// a different tmux session reports the move on its next refresh.
						terminal: terminal?.name,
						terminal_kind: terminal?.kind,
						can_steer: cfg.allowSteer,
						can_interrupt: cfg.allowInterrupt,
						can_kill: cfg.allowKill,
						can_set_mode: cfg.allowSetMode,
						// Same whole-record-PUT rule as the terminal above: omitting this
						// would withdraw the capability on the first title refresh, and
						// the selector would vanish from the workspace seconds after the
						// session appeared.
						can_set_op_mode: cfg.allowSetOpMode && opModeLoaded(),
						// Same whole-record-PUT rule as the terminal above: omitting
						// can_message here would erase it on the first title refresh.
						can_message: cfg.allowSteer,
						can_approve: false,
						// Kept in lockstep with the attach above — a whole-record PUT,
						// so a title refresh must not withdraw compaction support.
						...(cfg.allowSteer ? { can_compact: true } : {}),
						// Kept in lockstep with the attach above — a whole-record PUT, so
						// omitting this when it is on would erase the capability on the
						// first title refresh, exactly as the terminal comment warns.
						// Still spread conditionally: an old server must see today's body.
						...(workspaceEnabled ? { can_add_workspace: true } : {}),
						// Same spread-only-when-true rule, same HIV-1163 reason. Gated on a
						// LISTENER having announced itself — never on config alone: this
						// flag draws an answer form, and a form nothing is waiting behind is
						// worse than no form at all. streamDeltas joins it because that is
						// what carries the question to the browser in the first place.
						...(questionListeners.size > 0 && cfg.streamDeltas ? { can_answer_questions: true } : {}),
						...(canGrillPlan() ? { can_grill_plan: true } : {}),
						// Kept in lockstep with the attach above, per the whole-record
						// PUT rule stated a few lines up.
						...(cfg.reportWorktree ? { can_diff: true } : {}),
						// Lockstep with the attach above (whole-record PUT rule).
						...(cfg.allowSteer ? { can_attach_files: true } : {}),
						catalog: buildCatalog(pi.getCommands(), availableModels()),
					});
				} catch {
					// A title refresh is cosmetic. It must never affect the agent loop
					// or stop the regular attach/streaming retry path.
				}
			})();
		}, 0);
		lifecycle.titleTimer.unref?.();
	}

	function cleanup(): void {
		invalidateRemoteLifecycle(lifecycle);
		attaching = false;
		sessionID = null;
		journal?.close();
		journal = null;
		announceRemoteAnswers(false);
		lastAttachError = "";
		auth = null;
		latestCtx = null;
		unsubscribeSession?.();
		unsubscribeSession = undefined;
		// The plan doorbell outlives the session runtime exactly as the session
		// channel does, so it has to be released here too — a live subscription
		// after cleanup would keep posting through a null auth on every patch.
		unsubscribePlan?.();
		unsubscribePlan = undefined;
		pendingPlanRevision = null;
		// Same for the workflow doorbell, and for the same reason.
		unsubscribeConductor?.();
		unsubscribeConductor = undefined;
		unsubscribeInjection?.();
		unsubscribeInjection = undefined;
		unsubscribeStatus?.();
		unsubscribeStatus = undefined;
		unsubscribeBrief?.();
		unsubscribeBrief = undefined;
		unsubscribeBriefProgress?.();
		unsubscribeStdinWait?.();
		unsubscribeBriefProgress = undefined;
		unsubscribeGrill?.();
		unsubscribeGrill = undefined;
		// The status cache is per-session: a resumed session attaches to a new row
		// whose stored reading is empty, so keeping `lastStatus` would suppress the
		// first send and leave the new conversation's bar blank until the numbers
		// happened to move.
		lastStatus = null;
		quota = {};
		// Per-session for the same reason as lastStatus: a resumed session attaches
		// to a new row whose stored tree is empty, and keeping the cache here would
		// suppress the first send and leave the new conversation's panel blank.
		lastWorktree = null;
		clearInteractiveToolState?.();
		clearInteractiveToolState = undefined;
		reportedPaths = new Set();
		reportedWorktreePath = "";
	}

	function start(): void {
		if (lifecycle.flushTimer) return;
		lifecycle.flushTimer = setInterval(() => {
			void ensureAttached().then(() => flush());
		}, cfg.flushIntervalMs);
		lifecycle.flushTimer.unref?.();
		lifecycle.pollTimer = setInterval(() => void pollOnce(), COMMAND_POLL_MS);
		lifecycle.pollTimer.unref?.();
		surfacePublisher ??= new BrowserSurfacePublisher();
		// The agent's terminal rides the same tick. Both publishers no-op when
		// their launch published no surface, so this costs nothing off a launch.
		terminalPublisher ??= new TerminalSurfacePublisher();
		lifecycle.surfaceTimer = setInterval(
			() => {
				void surfacePublisher?.tick(auth, sessionID);
				void terminalPublisher?.tick(auth, sessionID);
			},
			SURFACE_TICK_MS,
		);
		lifecycle.surfaceTimer.unref?.();
		if (cfg.reportStatus) {
			lifecycle.statusTimer = setInterval(() => void flushStatus(), STATUS_TICK_MS);
			lifecycle.statusTimer.unref?.();
			lifecycle.quotaTimer = setInterval(() => void refreshQuota(), QUOTA_REFRESH_MS);
			lifecycle.quotaTimer.unref?.();
		}
		if (cfg.reportWorktree) {
			// The BACKSTOP. turn_end is where a tree actually changes, and that is
			// where the real flush lives; this covers the turn that runs for twenty
			// minutes and edits forty files before it ends.
			lifecycle.worktreeTimer = setInterval(() => void flushWorktree(), WORKTREE_TICK_MS);
			lifecycle.worktreeTimer.unref?.();
		}
		if (cfg.reportActivity) {
			// The proof-of-life half. The handlers already report every transition;
			// this exists for the case they cannot cover — a phase that does not
			// change for minutes, which is precisely when silence and work look the
			// same from the browser.
			lifecycle.activityTimer = setInterval(() => beat(), HEARTBEAT_MS);
			lifecycle.activityTimer.unref?.();
		}
		registerHandlers();
	}

	function stop(reason: string): void {
		cleanup();
		cfg = { ...cfg, enabled: false };
		void reason;
	}

	// ----------------------------------------------------------------- handlers

	let handlersRegistered = false;
	/**
	 * The current turn, for the end-of-turn notice: when it began and how many
	 * tool calls it ran. `turnStartedAtMs` undefined means the start was never
	 * seen — hive-remote attached mid-turn — and the notice then omits the
	 * duration rather than inventing one.
	 */
	let turnStartedAtMs: number | undefined;
	let turnToolCalls = 0;
	function registerHandlers(): void {
		if (handlersRegistered) return;
		handlersRegistered = true;

		// A compact command may arrive before the first turn. Retain the session
		// context so the capability declared at attach is immediately actionable.
		pi.on("session_start", (_event, ctx) => {
			remember(ctx);
		});

		// Detail-rail recap after compaction. Gated on THIS extension being on
		// (consent) and on an attached session id (identity). Scheduled off the
		// handler: resolveAuth / fetch are blocking I/O and must not run inside
		// pi's serial await. The generation stamp drops a late reply after a
		// session replacement.
		pi.on("session_compact", () => {
			if (!cfg.enabled) return;
			const generation = lifecycle.generation;
			const recapSession = sessionID;
			setTimeout(() => {
				void (async () => {
					if (!cfg.enabled || lifecycle.generation !== generation) return;
					const recap = await readRecap(recapSession);
					if (!recap || !cfg.enabled || lifecycle.generation !== generation) return;
					try {
						pi.sendMessage(
							{ customType: "agenda", content: recap, display: false },
							{ deliverAs: "nextTurn" },
						);
					} catch {
						/* session replaced while the fetch was in flight */
					}
				})();
			}, 0);
		});

		// BEFORE skill expansion, so `/skill:foo` is still visible. A handled
		// extension command never reaches this event; an unknown `/skill:`
		// that is not in the catalog is not folded as an activation.
		pi.on("input", (event, ctx) => {
			remember(ctx);
			const name = resolveSkillCommand(String(event.text ?? ""), pi.getCommands());
			if (!name) return;
			foldNotice(transcript, skillActivationNotice(name), Date.now(), "skill");
			kick();
		});

		pi.on("message_end", (event, ctx) => {
			remember(ctx);
			const msg = event.message as AssistantMessage | undefined;
			if (!msg || msg.role !== "assistant") return;
			// Reasoning FIRST: it is what the model was doing before it answered,
			// and the transcript is ordered by when things happened.
			if (cfg.streamThinking && thinkingEvents) {
				const thinking = thinkingOf(msg);
				if (thinking) foldThinking(transcript, thinking, Date.now());
			}
			const text = textOf(msg);
			if (text) foldAssistantText(transcript, text, Date.now());
			foldToolBatch(transcript, toolCallIDsOf(msg));
			if (transcript.queue.length >= cfg.eventThreshold) kick();
		});

		/**
		 * Per-call progress state for `tool_execution_update`.
		 *
		 * `seq` orders snapshots at the receiver (the transport does not, and a
		 * snapshot is cumulative — applying an older one would rewind the
		 * reader's view). `lastText` skips a resend when nothing changed;
		 * `lastAtMs` enforces the throttle.
		 */
		const toolProgress = new Map<string, { seq: number; lastText: string; lastAtMs: number }>();
		// An ordinary tool-start is a best-effort progress hint. An interactive
		// question is different: its start is the only durable copy of the call id
		// and question arguments, so retry transient transport failures until the
		// active call ends. The server keys it by call id, making every retry safe.
		const interactiveToolStarts = new Map<string, string>();
		// Delivery and liveness are separate: an acknowledged start still needs
		// tracking until its tool ends, so an interrupt can retire its card.
		const acknowledgedInteractiveToolStarts = new Set<string>();
		// A canceled turn can still surface a late tool_execution_end. Keep a
		// bounded tombstone so that delayed event cannot duplicate the synthetic
		// terminal result we already folded for the same call.
		const cancelledToolEnds = new Set<string>();
		clearInteractiveToolState = () => {
			interactiveToolStarts.clear();
			acknowledgedInteractiveToolStarts.clear();
			cancelledToolEnds.clear();
		};
		const MAX_CANCELLED_TOOL_ENDS = 64;
		const rememberCancelledToolEnd = (callID: string) => {
			if (cancelledToolEnds.size >= MAX_CANCELLED_TOOL_ENDS) {
				const oldest = cancelledToolEnds.keys().next();
				if (!oldest.done) cancelledToolEnds.delete(oldest.value);
			}
			cancelledToolEnds.add(callID);
		};
		const INTERACTIVE_TOOL_START_RETRY_MS = 500;
		const isInteractiveQuestionTool = (toolName: string) =>
			toolName === "ask_user_question" || toolName === "plan_ask";
		const postInteractiveToolStart = (
			auth: Parameters<typeof postToolStart>[0],
			sess: Parameters<typeof postToolStart>[1],
			callID: string,
			toolName: string,
			args: Parameters<typeof postToolStart>[4],
		) => {
			const attempt = async () => {
				if (!interactiveToolStarts.has(callID)) return;
				const result = await postToolStart(auth, sess, callID, toolName, args);
				if (!interactiveToolStarts.has(callID)) return;
				if (result.ok || result.permanent || result.authFailed) {
					acknowledgedInteractiveToolStarts.add(callID);
					return;
				}
				setTimeout(() => void attempt(), INTERACTIVE_TOOL_START_RETRY_MS);
			};
			void attempt();
		};
		/**
		 * 1 Hz. bash's own onUpdate fires at 100ms, which is ten network round
		 * trips a second for a readout nobody can read that fast.
		 */
		const TOOL_UPDATE_THROTTLE_MS = 1000;
		/**
		 * The TAIL, not the head: a running command's interesting output is at
		 * the end. Comfortably under the server's 16 KiB post-redaction clamp.
		 */
		const TOOL_UPDATE_BUDGET = 8192;

		pi.on("tool_execution_update", (event, ctx) => {
			remember(ctx);
			const callID = String(event.toolCallId ?? "");
			const toolName = String(event.toolName ?? "");
			// Same consent as tool-starts — live-stream content on the same terms
			// as partial text. No new config knob.
			if (!cfg.streamDeltas || !auth || !sessionID || !callID || !toolName) return;

			const partial = event.partialResult as
				| { content?: { type?: string; text?: string }[]; details?: unknown }
				| undefined;
			const text = (partial?.content ?? [])
				.map((b) => (typeof b?.text === "string" ? b.text : ""))
				.join("");
			// bash's FIRST update is `{content: [], details: undefined}` — the
			// tool_start frame already covered that moment, so it is not news.
			if (!text && partial?.details === undefined) return;

			const st = toolProgress.get(callID) ?? { seq: 0, lastText: "", lastAtMs: 0 };
			const now = Date.now();
			if (now - st.lastAtMs < TOOL_UPDATE_THROTTLE_MS) return;
			// Unchanged text and no typed payload is nothing to report. Details are
			// NOT compared: a gate advancing through its checks ships an identical
			// tail with a changed spec, and skipping those would freeze the meter.
			if (text === st.lastText && partial?.details === undefined) return;

			st.seq += 1;
			st.lastText = text;
			st.lastAtMs = now;
			toolProgress.set(callID, st);

			const tail = text.length > TOOL_UPDATE_BUDGET ? text.slice(-TOOL_UPDATE_BUDGET) : text;
			// An envelope goes through budgeted(), which prunes the TREE and
			// re-stringifies. Slicing an envelope's JSON as a string would leave
			// it unparseable, and the widget then silently never renders (HIV-1145).
			const details = partial?.details !== undefined ? budgeted(partial.details, ARGS_BUDGET) : undefined;
			const a = auth;
			const sess = sessionID;
			const seq = st.seq;
			// Detached, and no awaits in the handler: pi awaits every extension
			// handler serially, so a slow handler IS the agent loop it reports on.
			setTimeout(() => {
				void postToolUpdate(a, sess, callID, toolName, seq, tail, details);
			}, 0);
		});

		pi.on("tool_execution_start", (event, ctx) => {
			remember(ctx);
			const callID = String(event.toolCallId ?? "");
			const toolName = String(event.toolName ?? "");
			const readPath = readPathOf(toolName, event.args);
			if (readPath) {
				const loaded = skillNameFromReadPath(readPath, pi.getCommands());
				if (loaded) foldNotice(transcript, skillActivationNotice(loaded), Date.now(), "skill");
			}
			foldToolStart(transcript, callID, toolName, event.args);
			// The command, not just the tool name: `bash` is the same word for a
			// two-second `ls` and a twenty-minute `hive check`, and the transcript's
			// own tool event does not reach Hive until the call ENDS.
			toolStarted(activity, callID, toolName, Date.now(), toolDetail(toolName, event.args));
			beat();
			// Ephemeral in-flight announcement, so the workspace can show a
			// pending card during a long call instead of nothing until its end.
			// Rides the streamDeltas consent — it is live-stream content on the
			// same terms as partial text. Detached: no awaits in handlers.
			if (cfg.streamDeltas && auth && sessionID && toolName) {
				const a = auth;
				const s = sessionID;
				const args = budgeted(event.args, ARGS_BUDGET);
				if (callID && isInteractiveQuestionTool(toolName)) {
					interactiveToolStarts.set(callID, toolName);
					postInteractiveToolStart(a, s, callID, toolName, args);
				} else {
					setTimeout(() => {
						void postToolStart(a, s, callID, toolName, args);
					}, 0);
				}
			}
		});

		pi.on("tool_execution_end", (event, ctx) => {
			remember(ctx);
			const callID = String(event.toolCallId ?? "");
			if (cancelledToolEnds.delete(callID)) return;
			turnToolCalls += 1;
			foldToolEnd(
				transcript,
				callID,
				String(event.toolName ?? ""),
				event.result,
				Boolean(event.isError),
				Date.now(),
			);
			toolEnded(activity, callID, Date.now());
			toolProgress.delete(callID);
			interactiveToolStarts.delete(callID);
			acknowledgedInteractiveToolStarts.delete(callID);
			beat();
			if (transcript.queue.length >= cfg.eventThreshold) kick();
		});

		pi.on("turn_start", (_event, ctx) => {
			remember(ctx);
			turnStartedAtMs = Date.now();
			turnToolCalls = 0;
			// `working`, not `thinking`: the model is at the provider and has not
			// told us what it is doing yet. The first delta refines this within a
			// second or two, and guessing in the meantime would put a label on the
			// pane that the next frame contradicts.
			enterPhase(activity, "working", turnStartedAtMs);
			beat();
		});

		pi.on("turn_end", (event, ctx) => {
			remember(ctx);
			// The durable "this turn is over" marker, folded BEFORE the flush so
			// it rides the same batch as the turn's final message. The Hive
			// workspace renders it as a turn divider under the result; an
			// operator glancing at the transcript sees the agent finished
			// without having to infer it from silence.
			//
			// And when the turn FAILED, it says so and says why (HIV-1914).
			// Previously this reported a clean end regardless, so a turn that
			// never reached the model was indistinguishable from one that
			// worked — the state eight agents were in for two hours while every
			// Hive view called them healthy.
			foldNotice(
				transcript,
				turnEndNotice(turnStartedAtMs, turnToolCalls, Date.now(), turnFailure(event?.message)),
				Date.now(),
			);
			turnStartedAtMs = undefined;
			turnToolCalls = 0;
			// The one event that means idle. Sent immediately so the pane's
			// activity line disappears with the turn rather than lingering for up
			// to a beat interval, still claiming work that has finished.
			turnEnded(activity, Date.now());
			// A turn is when files change. setTimeout(…, 0) rather than inline:
			// this handler is awaited by pi's runner, and collectWorktree spawns
			// three subprocesses — running it here would put them on the agent loop.
			if (cfg.reportWorktree) setTimeout(() => void flushWorktree(), 0);
			// An aborted tool may never emit tool_execution_end. Progress is purely
			// local, but a pending interactive question is persisted in Hive and
			// must receive a normal terminal event so its durable browser card retires.
			for (const [callID, toolName] of interactiveToolStarts) {
				rememberCancelledToolEnd(callID);
				foldToolEnd(
					transcript,
					callID,
					toolName,
					{ content: [{ type: "text", text: "The tool was cancelled because the agent turn ended before it returned." }] },
					false,
					Date.now(),
				);
			}
			toolProgress.clear();
			interactiveToolStarts.clear();
			acknowledgedInteractiveToolStarts.clear();
			beat();
			kick();
			// A turn is when context usage actually jumps; the timer would show it
			// within five seconds, but this is the moment the operator is watching.
			if (cfg.reportStatus) setTimeout(() => void flushStatus(), 0);
		});

		pi.on("session_info_changed", (_event, ctx) => {
			remember(ctx);
			queueConversationRefresh();
		});

		// Live partial text and reasoning. NOT persisted — they exist so the
		// browser reads like a terminal instead of repainting once per turn.
		// Fire-and-forget, and only when the operator opted in separately from
		// steering.
		//
		// Registered whenever EITHER stream is wanted, because this handler is
		// also where the phase becomes `thinking` or `responding` — the only
		// place pi says which of the two is happening.
		if (cfg.streamDeltas || cfg.streamThinking) {
			pi.on("message_update", (event, ctx) => {
				remember(ctx);
				const delta = deltaOf(event);
				if (!delta.text) return;
				// The phase moves whether or not the text is sent: knowing the agent
				// is reasoning is useful even to a session that has chosen not to
				// publish what it is reasoning about.
				enterPhase(activity, delta.thinking ? "thinking" : "responding", Date.now());
				beat();
				if (!auth || !sessionID) return;
				if (delta.thinking && (!cfg.streamThinking || !thinkingDeltas)) return;
				if (!delta.thinking && !cfg.streamDeltas) return;
				const a = auth;
				const s = sessionID;
				const channel = delta.thinking ? ("thinking" as const) : undefined;
				// THROUGH THE QUEUE, never straight to postDelta. One request in
				// flight per channel is what keeps the text in order: these used to
				// go out as independent concurrent POSTs, and HTTP does not order
				// across requests, so a reply mid-stream arrived shuffled.
				pushDelta(delta.text, channel);
			});
		}

		pi.on("session_shutdown", () => {
			cleanup();
		});
	}

	// ------------------------------------------------------------------- tools

	// Register the workspace grant tools once, at init, gated on the frozen flag.
	// Their existence IS the consent — when the flag is off there is no tool and
	// no capability. They read `auth`/`sessionID` live (a session attaches after
	// this runs), and are inert until it does, reporting "not attached" rather
	// than failing. Registered outside start() because a tool is a session-wide
	// capability, not part of the attach/stream lifecycle start()/stop() manage.
	if (workspaceEnabled) {
		registerWorkspaceTools(pi, {
			getAuth: () => auth,
			getSessionID: () => sessionID,
		});
	}

	// ----------------------------------------------------------------- commands

	pi.registerCommand("hive-remote-status", {
		description: "Show whether this session is attached to the Hive agents workspace",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const lines = [
				`enabled:  ${cfg.enabled}`,
				`attached: ${sessionID ? `yes (${sessionID})` : "no"}${resumedFrom !== null ? ` — resumed from event ${resumedFrom}` : ""}`,
				`queued:   ${transcript.queue.length} event(s)${transcript.dropped ? `, ${transcript.dropped} dropped` : ""}, next seq ${transcript.seq + 1}`,
				`steer:    ${cfg.allowSteer}   interrupt: ${cfg.allowInterrupt}   kill: ${cfg.allowKill}   deltas: ${cfg.streamDeltas}`,
				`workspace: ${workspaceEnabled} (request_workspace ${workspaceEnabled ? "registered" : "off"})`,
			];
			// Only when non-zero, and never silently: an acknowledged-but-unstored
			// event is the one failure here that leaves no trace in the transcript
			// the operator is reading.
			if (silentlyDropped > 0) {
				lines.push(
					`WARNING: Hive discarded ${silentlyDropped} acknowledged event(s) as already-seen numbers.`,
					"That means something else is minting sequence numbers for this session.",
				);
			}
			// Report the ACTUAL precondition. This used to name
			// HIVE_AGENT_SESSION_ID, which nothing sets and nothing reads — so an
			// operator debugging a session that would not attach was sent looking
			// for an environment variable that never existed, while the real cause
			// (no run id on the in-process bus) went unmentioned.
			if (cfg.enabled && !sessionID && !clientRunID) {
				lines.push(
					"",
					"No run id from hive-telemetry yet — nothing to attach a conversation to.",
					"hive-telemetry announces it on the in-process bus; check it is enabled and has a credential.",
				);
			} else if (cfg.enabled && !sessionID && lastAttachError) {
				lines.push("", `Last attach failed: ${lastAttachError}`);
			}
			ctx.ui.notify(lines.join("\n"));
		},
	});

	pi.registerCommand("hive-remote-on", {
		description: "Make this workstation's pi sessions visible and steerable in Hive",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const resolved = readAuth(cfg.url);
			if (!resolved) {
				ctx.ui.notify("No Hive credential found — run /hive-login first.", "error");
				return;
			}
			const check = await validateToken(resolved.url, resolved.token);
			if (!check.ok) {
				ctx.ui.notify(`Hive rejected the credential: ${check.message}`, "error");
				return;
			}
			if (!check.who.hasUser) {
				// A machine token has no owning user and the agent-session routes
				// refuse it outright, so say so now rather than at the first silent
				// 403 an hour from now.
				ctx.ui.notify("That is a machine token; agent sessions are per-developer.", "error");
				return;
			}
			writeConfig({ enabled: true, url: resolved.url });
			cfg = readConfig();
			start();
			ctx.ui.notify(`Hive agents workspace enabled for ${check.who.name ?? "this user"}.`);
		},
	});

	pi.registerCommand("hive-remote-off", {
		description: "Stop reporting this session to the Hive agents workspace",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			writeConfig({ enabled: false });
			stop("disabled by /hive-remote-off");
			ctx.ui.notify("Hive agents workspace disabled for this machine.");
		},
	});

	// The single act that switches anything on. Absent config = a no-op extension.
	if (cfg.enabled) start();
}

/** textOf concatenates an assistant message's text blocks. */
function textOf(msg: AssistantMessage): string {
	const content = (msg as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text ?? "") : ""))
		.join("");
}

/** deltaOf pulls the incremental text out of a message_update event. */
function toolCallIDsOf(msg: AssistantMessage): string[] {
	const content = (msg as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall" || !("id" in block)) return [];
		return typeof block.id === "string" && block.id ? [block.id] : [];
	});
}

