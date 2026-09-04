/**
 * hive-common — the in-process event-bus channels Hive extensions use to talk to
 * each other.
 *
 * These are PROCESS-LOCAL. Anything on pi's event bus can be emitted by any
 * loaded extension, so a channel that carried prose would be an exfiltration
 * path straight past each extension's own payload boundary. Every channel here
 * therefore carries identifiers and enums only — the same rule
 * hive-telemetry's HIVE_METRIC_CHANNEL already states for gates.
 */

/**
 * Announces the client-minted run id of the session row hive-telemetry is
 * currently reporting under.
 *
 * hive-remote needs it because the two halves of the client live in one process
 * but not in one extension: telemetry creates the session row, hive-remote
 * attaches a conversation to it. Telemetry mints a FRESH run id on every agent
 * run — a resumed or forked session restarts its accumulator at zero, and
 * reusing the id would make cumulative totals go backwards, which the server
 * rejects — so this cannot be a constant and has to be announced each time.
 */
export const HIVE_SESSION_CHANNEL = "hive.session";

export interface HiveSessionEvent {
	/** Opaque client-minted id; the server maps it to a session via /by-run. */
	clientRunID: string;
}

/**
 * Announces that the `plan` extension changed the plan document.
 *
 * Carries a REVISION AND NOTHING ELSE, and that is the whole design. A plan is
 * prose — file paths, rationale, the shape of unreleased work — and the rule at
 * the top of this file is that a channel carrying prose would be an exfiltration
 * path past each extension's own payload boundary: any loaded extension can
 * subscribe to anything on pi's bus.
 *
 * So this is a doorbell, not a delivery. hive-remote reads the document from the
 * session entries it already has access to, under the consent its own config
 * represents. The plan extension never learns whether Hive is configured, and
 * hive-remote never receives prose it was not already entitled to read.
 */
export const HIVE_PLAN_CHANNEL = "hive.plan";

export interface HivePlanEvent {
	revision: number;
	/**
	 * The tick counter (HIV-2904). Optional on the wire so a client that
	 * predates the merge still type-checks against this channel; a listener
	 * that only knows `revision` keeps working and simply refetches less often.
	 */
	progress?: number;
}



/**
 * Asks the `plan` extension to enter read-only plan mode — the conductor's
 * doorbell. An enum action and nothing else; the plan extension decides
 * whether the request is honoured (it is a no-op when the mode is already
 * active), so the sender never learns or controls plan state directly.
 */
export const PLAN_CONTROL_CHANNEL = "hive.plan.control";

export interface PlanControlEvent {
	/**
	 * `exit` exists because plan mode is now also reachable as an OPERATING mode
	 * (`opmode`), and a posture you can enter but not leave is not a posture. The
	 * plan extension still decides whether to honour either action — a request is
	 * a doorbell, never a write into another extension's state.
	 */
	/** `approve` is a request only; the plan extension still validates its state. */
	/**
	 * `grill` is the third answer to a plan gate: not yet, ask me things first.
	 * It DECLINES the approval without ending the plan — the mode stays
	 * read-only, the phase falls back to `drafting`, and the agent has to
	 * interrogate the operator before it may present again. Same request-only
	 * rule as `approve`: the plan extension validates that there is a pending
	 * gate to decline, and ignores the doorbell when there is not.
	 */
	action: "enter" | "exit" | "approve" | "grill";
}

/**
 * Announces that the user DECLINED the plan and asked to be grilled instead.
 *
 * The doorbell half of the grill verb, and it exists for the reason
 * PLAN_APPROVED_CHANNEL does: the plan extension must not inject a turn
 * (constraint #4 in plan/index.ts — the one-injector invariant agenda's driver
 * owns), but something has to tell the agent it is now expected to ask
 * questions. agenda subscribes and injects, exactly as it does for an approval.
 *
 * Counters only, per the rule at the top of this file. A subscriber that wants
 * the plan's prose reads the document from the session entries it already has
 * access to.
 */
export const PLAN_GRILL_CHANNEL = "hive.plan.grill";

export interface PlanGrillEvent {
	/** The plan's revision at the moment it was declined. */
	revision: number;
	stepCount: number;
	/** How many times this session has been grilled, including this one. */
	round: number;
}

/**
 * Announces whether the `plan` extension's read-only mode is ACTUALLY on.
 *
 * The feedback half of PLAN_CONTROL_CHANNEL, and it exists to close a real
 * hole rather than for symmetry. `opmode` delegates its `plan` posture to this
 * extension instead of running a second read-only gate, so without a report
 * back, a user typing `/plan exit` would drop the enforcement while `opmode`
 * still believed — and told the Hive workspace — that the session was
 * read-only. That is precisely the "configured, green, enforcing nothing"
 * failure plan/policy.ts's own header documents, arrived at from the other
 * direction.
 *
 * A boolean and nothing else, per the rule at the top of this file.
 */
export const PLAN_MODE_STATE_CHANNEL = "hive.plan.mode-state";

export interface PlanModeStateEvent {
	active: boolean;
}

/**
 * Asks the `opmode` extension to switch the session's OPERATING mode — what the
 * harness allows — as opposed to which model does the thinking.
 *
 * A key from a CLOSED set (`OP_MODES` in opmode/modes.ts), never free text: the
 * set is the containment mechanism, and a channel that accepted arbitrary
 * strings would let any loaded extension invent a posture nothing enforces.
 */
export const OP_MODE_CONTROL_CHANNEL = "hive.opmode.control";

export interface OpModeControlEvent {
	mode: string;
	/** Where the request came from, for the transcript notice. */
	source: "hive" | "user";
}

/**
 * Announces the operating mode now in force, so hive-remote can REPORT it.
 *
 * Reported rather than assumed for the reason the whole feature turns on: a
 * switch can be refused locally, and an operator told a session is read-only
 * when nothing denies its writes has been actively misinformed.
 */
export const OP_MODE_STATE_CHANNEL = "hive.opmode.state";

export interface OpModeStateEvent {
	mode: string;
	/**
	 * Every posture this build knows, so the server can offer only what this
	 * client can actually enforce.
	 *
	 * Without it the server has one bit — `can_set_op_mode` — which says some
	 * enforcer is present, not WHICH postures it understands. An older pi handed
	 * a mode it does not know drops it in silence (`isOpMode` returns false) and
	 * runs unrestricted in `build`, so a server guessing wrong shows a lead as
	 * coordination-only while every write tool stays open.
	 *
	 * Optional because the enforcer may predate this field; a subscriber that
	 * receives none must not assume the empty set.
	 */
	modes?: readonly string[];
}

/**
 * Announces that the user APPROVED the plan (via the `plan_ready` confirm or
 * `/plan approve`). Counters and booleans only — the plan's prose (its goal
 * sentence, step titles) is deliberately NOT carried, per the rule at the top
 * of this file. A subscriber that needs the document reads it from the session
 * entries it already has access to, exactly as hive-remote does for
 * HIVE_PLAN_CHANNEL.
 */
/**
 * Announces a conductor stage transition. An enum stage name and nothing else
 * — hive-remote folds it into the transcript as a notice so the agents
 * workspace shows the lifecycle moving, and the browser needs no new protocol.
 */
export const CONDUCTOR_CHANNEL = "hive.conductor";

export interface ConductorStageEvent {
	stage: "idle" | "frame" | "plan" | "execute" | "verify" | "consolidate" | "done";
}

/**
 * Announces WHY this session is ending, when pi's own shutdown event cannot say.
 *
 * `SessionShutdownEvent.reason` is a closed set — "quit" | "reload" | "new" |
 * "resume" | "fork" — describing HOW the session stopped, with no room for why.
 * A kill from the Hive agents workspace shuts down GRACEFULLY (that is the whole
 * point: the transcript is persisted and durable workers are stopped), so it
 * arrives as "quit", which hive-telemetry maps to `completed`. A session an
 * operator deliberately stopped was therefore recorded as one that finished its
 * work — the strongest possible misreport, since `completed` is the outcome the
 * fleet aggregates read as success.
 *
 * An enum and nothing else, per the rule at the top of this file. hive-remote
 * knows the kill arrived; hive-telemetry owns the outcome. This carries the one
 * fact between them and no prose.
 */
export const HIVE_SESSION_END_CHANNEL = "hive.session.end";

export interface HiveSessionEndEvent {
	/**
	 * Only `killed` today. An enum rather than a boolean so the next
	 * server-driven end (an eviction, a budget stop) extends it without
	 * changing the channel's shape.
	 */
	reason: "killed";
}

/**
 * Delivers an answer an operator gave in the BROWSER to whichever extension is
 * blocked on that question — `ask` or `plan` (HIV-1765).
 *
 * This is the one channel that carries free text, and the exception is
 * deliberate rather than an erosion. The rule at the top of this file exists to
 * stop SESSION data — the agent's prose, its file paths, its plan — leaking to
 * any loaded extension through a shared bus. This travels the other way: it is
 * operator INPUT arriving from outside, addressed to a tool that is already
 * waiting for exactly it, and its values are the option labels the model itself
 * asked about plus whatever the human chose to type into an answer box. Nothing
 * here is knowledge the session held and the operator did not.
 *
 * Routing is by `callID` and nothing else. An extension that is not blocked on
 * that exact call ignores the event — which is also what makes a late answer
 * (the local terminal answered first) harmless rather than a second decision.
 */
export const QUESTION_ANSWER_CHANNEL = "hive.question.answer";

/**
 * Announces that an extension in this process can BE answered remotely — the
 * capability half, and the reason `can_answer_questions` is gated on the
 * enforcer rather than on a config flag (the `opmode` argument, applied to a
 * different failure).
 *
 * Hive draws an answer form from the declared capability. Declaring it because
 * an operator permitted it, rather than because something here is listening,
 * would produce a form whose Send button clears the card and releases nothing.
 * A tool name and nothing else.
 */
export const QUESTION_LISTENER_CHANNEL = "hive.question.listener";

export interface QuestionListenerEvent {
	tool: "ask_user_question" | "plan_ask";
}

/**
 * Announces whether a browser can actually answer right now — the feedback half.
 *
 * `plan_ask` returns IMMEDIATELY by design: an unattended worker has no one to
 * answer, and a modal that blocks forever is worse than a question the user
 * reads in the transcript. That reasoning is unchanged and this does not
 * overturn it; it supplies the missing premise. When a Hive session is attached
 * there IS someone who can answer, through the browser, so blocking becomes the
 * better behaviour — and only then.
 *
 * (The cost of getting this wrong is on record: HIV-1449, 68 minutes and 40
 * turns burned at a confirm nobody could see.)
 */
export const QUESTION_REMOTE_CHANNEL = "hive.question.remote";

export interface QuestionRemoteEvent {
	/** True while a Hive session is attached and accepting answers. */
	available: boolean;
}

export interface QuestionAnswerEvent {
	/** The tool call id this answers. Never a question id — those live inside. */
	callID: string;
	/**
	 * Values per question id. `ask_user_question` keys these on the ids the model
	 * minted; `plan_ask` mints none and uses the single key "answer", a constant
	 * the server's browser form asserts too.
	 */
	answers: Record<string, string[]>;
}

export const PLAN_APPROVED_CHANNEL = "hive.plan.approved";

export interface PlanApprovedEvent {
	revision: number;
	stepCount: number;
	/**
	 * True when the approval dialog named multi-agent orchestration and the
	 * user still approved — the consent that lets agenda enable `orchestrate`
	 * without a separate `/ultracode on`.
	 */
	orchestrationConsented: boolean;
}

/**
 * Announces that agenda refreshed the session's status entry — the recap +
 * task-state classifier (HIV-1240). A revision and nothing else, per the rule
 * at the top of this file: the recap is PROSE, so hive-remote reads it from
 * the session entries it already has access to (the plan-document pattern).
 */
export const AGENT_STATUS_CHANNEL = "hive.agent-status";

export interface AgentStatusEvent {
	revision: number;
}

/**
 * Announces that the agenda driver injected a follow-up turn. The POLICY NAME
 * enum and nothing else — hive-remote folds it as a transcript notice so the
 * workspace shows the harness steering (a gate re-run, a goal continuation, a
 * drift realignment) as a distinct system row rather than nothing at all.
 */
export const AGENDA_INJECTION_CHANNEL = "hive.agenda.injection";

export interface AgendaInjectionEvent {
	policy: string;
}

/**
 * Announces that the `brief` extension compiled an opening brief (HIV-1801).
 *
 * A SECTION COUNT and nothing else, per the rule at the top of this file. The
 * brief is the most prose-shaped payload in this harness — file paths, ticket
 * contents, whatever the knowledge brain returned — so putting it on a bus any
 * loaded extension can subscribe to would be exactly the exfiltration path that
 * rule exists to prevent. This is a doorbell; hive-remote reads the document
 * from the session entries it already has access to, under the consent its own
 * config represents. Same shape as the plan and recap doorbells.
 *
 * The count is here because it is the one thing a subscriber might reasonably
 * act on without reading the document: zero sections means the compiler dropped
 * everything to the budget, and there is nothing worth fetching.
 */
export const HIVE_BRIEF_CHANNEL = "hive.brief";

export interface HiveBriefEvent {
	/** How many sections survived the token budget. Never the prose. */
	sections: number;
}

/**
 * Announces that the `brief` extension is HOLDING the first turn (HIV-2242).
 *
 * The brief blocks `before_agent_start` by design — a brief that arrives after
 * the model has started reading files has already lost — and its retrieval wall
 * is 120s PER LANE. Until this channel existed the only signal that anything was
 * happening was `ctx.ui.setStatus`, which paints the local status line and
 * reaches nothing else. An operator watching the Hive agents workspace saw a
 * session register and then sit at `idle` for up to two minutes: the phase is
 * only set at `turn_start`, and the turn is precisely what the brief is holding.
 * Indistinguishable, from the browser, from an agent that launched and hung.
 *
 * DISTINCT FROM `HIVE_BRIEF_CHANNEL`, and deliberately not folded into it. That
 * one is a document doorbell: it fires once, on success, and means "a brief was
 * compiled, go and read it". This one is a liveness signal: it fires on every
 * automatic pass including the ones that fail, and means nothing more than "the
 * first turn is being held, and here is why". Merging them would make the
 * count-only payload conditional and put a subscriber that wants the phase in
 * the business of ignoring document events.
 *
 * LANE NAMES ONLY. They are a closed enum from `brief/lanes.ts` (`repo`,
 * `knowledge`, `ticket`), not prose — which is what keeps this inside the rule
 * at the top of this file. The task, the goal and anything retrieved stay off
 * the bus, exactly as they do for the plan and recap doorbells.
 */
export const HIVE_BRIEF_PROGRESS_CHANNEL = "hive.brief-progress";

export interface HiveBriefProgressEvent {
	/**
	 * `start` when the retrieval pass is spawned, `end` when the handler
	 * releases the turn.
	 *
	 * `end` fires from a `finally`, so it survives the paths that never reach a
	 * turn at all — a crash inside the handler, a session replaced mid-brief. A
	 * subscriber that reverted the phase on `turn_start` alone would be correct
	 * on every path the brief models and wrong on the one it does not, which is
	 * the path where a stuck "Briefing" would be the actual news.
	 */
	phase: "start" | "end" | "lane";
	/** Which retrieval lanes were spawned. Present on `start` only. */
	lanes?: string[];
	/**
	 * A `lane` beat: one retrieval lane has SETTLED. Present on `phase: "lane"`.
	 *
	 * `start` and `end` alone leave the operator staring at a single unchanging
	 * "Briefing · repo, knowledge" for the length of the pass — which is the
	 * complaint that a spawning session "looks dead". The pass is a fan-out of
	 * independent lanes that finish at different times, so it has real progress
	 * to report; it just was not reporting any.
	 *
	 * Sent as each lane settles rather than batched at the end, since a beat
	 * that arrives with the result is not a progress indicator.
	 */
	lane?: string;
	/** Whether that lane returned anything. False for a timeout or a failure. */
	ok?: boolean;
	/** Lanes settled so far, and how many were spawned — enough to render "2/3". */
	done?: number;
	total?: number;
}

/**
 * Announces that this session's shell command is (or is no longer) blocked
 * waiting for input.
 *
 * WHY IT IS A CHANNEL rather than a direct call: the detector runs inside
 * pretty-tools' bash override, and the thing that must report it lives in
 * hive-remote. Neither may import the other — they are separate extensions with
 * separate jiti instances — so the bus is the only seam.
 *
 * IDENTIFIERS AND ENUMS ONLY, per this file's rule. `confidence` is the
 * detector's own two-tier verdict and NOT a sentence: `proven` means the process
 * was observed blocked in a read on its stdin, `quiet` only means nothing has
 * run or printed for a long time. A consumer that renders these differently is
 * doing the right thing; one that renders them identically is overclaiming.
 *
 * Deliberately no command text: the command a user is being asked about may
 * itself contain a secret, and this bus is readable by every loaded extension.
 */
export const HIVE_STDIN_WAIT_CHANNEL = "hive.stdin-wait";

export interface HiveStdinWaitEvent {
	/** The tool call id, so a consumer can tell one command's block from another's. */
	callID: string;
	phase: "waiting" | "resolved";
	confidence: "proven" | "quiet";
	quietSeconds: number;
}
