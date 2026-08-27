/**
 * hive-remote — the heartbeat: what this session is doing, and that it is still
 * here to say so (HIV-1212).
 *
 * The Hive pane could only ever show an agent working while it happened to be
 * emitting assistant text. A killed pi, a wedged provider call and a four-minute
 * `bash` all rendered identically — a static transcript — and the operator's only
 * recourse was to walk to the terminal, which is the thing the workspace exists
 * to replace.
 *
 * WHY A BEAT PROVES ANYTHING. This runs on the extension's own timer inside pi's
 * process. If the agent is waiting on a slow provider call the event loop is free
 * and the beat lands, correctly reporting work. If the process is gone, or an
 * event handler is blocking the loop synchronously, the beat stops — also
 * correctly, because that IS frozen. It is the one signal whose absence means
 * what we want it to mean.
 *
 * Everything in this file is PURE and synchronous. It is called from pi event
 * handlers, and pi awaits every handler serially: a slow handler IS the agent
 * loop. The HTTP lives in index.ts, on a detached timer, exactly as the status
 * snapshot does.
 */

/**
 * The phases this client reports.
 *
 * `working` is the honest name for "a turn is in flight and the model is at the
 * provider" — the gap between sending a tool result and the first token coming
 * back, which on a reasoning model is most of a turn. Calling that `thinking`
 * would be a guess about what the model is doing; calling it `idle` would be
 * wrong.
 *
 * `briefing` is the one phase that is NOT part of a turn: the brief extension
 * holds `before_agent_start` for up to 120s per retrieval lane, and every other
 * phase here is entered at `turn_start` or later. Before it existed that whole
 * window reported `idle` — which `shouldSend` suppresses — so the workspace
 * showed a registered session doing nothing, and a launch that was working
 * normally was indistinguishable from one that had hung (HIV-2242).
 *
 * The wire does NOT constrain this set. Hive stores what it is sent, so a phase
 * added here needs no server deploy first, and a browser that predates one
 * renders it as generic work rather than dropping it.
 */
export type Phase =
	| "idle"
	| "briefing"
	| "working"
	| "thinking"
	| "responding"
	| "tool"
	| "needs_input"
	| "completed";

export interface ActivityState {
	phase: Phase;
	/** The tool being run, when the phase is `tool`. */
	tool?: string;
	/** What that tool is doing — the command, the path. Cleared with the phase. */
	detail?: string;
	/** Whether the current detail has already ridden a beat, so the ten-second
	 *  heartbeats that follow do not re-send it. */
	detailSent: boolean;
	/** When the CURRENT phase began. Never moved by a heartbeat. */
	sinceMs: number;
	/**
	 * Tool calls started but not finished, by call id.
	 *
	 * A map rather than a counter because the NAME is what the operator reads —
	 * "running bash" and "running rg" are different situations when a session has
	 * gone quiet. Concurrent calls are normal (pi runs a batch), so an ending call
	 * must not drop the phase while its siblings are still going.
	 */
	running: Map<string, string>;
	/** The last (phase, tool) actually sent, and when. The send gate. */
	sent?: { phase: Phase; tool?: string; atMs: number };
}

/**
 * How often a beat is sent while work is in flight.
 *
 * Ten seconds, against a browser that warns at ~35 s. That gap is deliberate:
 * two beats can be lost or late — a timer firing behind a busy event loop, a
 * request that took a moment — without the pane accusing a perfectly healthy
 * session of being stuck.
 */
export const HEARTBEAT_MS = 10_000;

export function createActivity(nowMs: number): ActivityState {
	return { phase: "idle", sinceMs: nowMs, running: new Map(), detailSent: false };
}

/**
 * Move to a phase.
 *
 * A no-op when nothing changed, and that is load-bearing rather than an
 * optimisation: `sinceMs` is what the pane's elapsed timer counts from, so
 * re-entering the phase you are already in on every streamed token would reset
 * it sixty times a second and a long turn would permanently read as "0s".
 */
export function enterPhase(
	state: ActivityState,
	phase: Phase,
	nowMs: number,
	tool?: string,
	detail?: string,
): void {
	if (state.phase === phase && state.tool === tool) return;
	state.phase = phase;
	state.tool = tool;
	// The detail belongs to the phase, so it dies with it. Carrying it across
	// would label the next tool call with the previous one's command.
	state.detail = detail;
	state.detailSent = false;
	state.sinceMs = nowMs;
}

/**
 * Change the CURRENT phase's detail without restarting the phase.
 *
 * `enterPhase` no-ops on a repeat of the same phase, deliberately: re-entering
 * `working` at every `turn_start` must not reset the elapsed timer. That is
 * right for a phase with nothing to say while it runs, and wrong for one that
 * does. The brief's retrieval lanes settle at different times, and the row
 * should show them landing — with the timer still climbing, because the pass
 * has not restarted.
 *
 * Guarded on the phase the caller believes it is in, so a late or replayed beat
 * from a finished pass cannot relabel whatever came next. Unchanged text is a
 * no-op rather than a redundant send.
 */
export function updateDetail(state: ActivityState, phase: Phase, detail: string | undefined): void {
	if (state.phase !== phase) return;
	if (state.detail === detail) return;
	state.detail = detail;
	state.detailSent = false;
}

/** A tool call began. The newest one names the phase — it is the one whose
 *  output the operator is waiting for. */
export function toolStarted(
	state: ActivityState,
	callID: string,
	name: string,
	nowMs: number,
	detail?: string,
): void {
	if (!callID || !name) return;
	state.running.set(callID, name);
	enterPhase(state, "tool", nowMs, name, detail);
}

/**
 * A tool call ended.
 *
 * While siblings are still running the phase stays `tool` and adopts one of
 * them; the operator wants to know something is still executing, not that the
 * one call they happened to be watching finished.
 *
 * With none left the phase becomes `working`, not `idle`: the turn has not
 * ended, the model is back at the provider deciding what to do with the result.
 * `turn_end` is the only thing that says idle.
 */
export function toolEnded(state: ActivityState, callID: string, nowMs: number): void {
	state.running.delete(callID);
	const next = lastValue(state.running);
	if (next !== undefined) {
		enterPhase(state, "tool", nowMs, next);
		return;
	}
	enterPhase(state, "working", nowMs);
}

function lastValue(map: Map<string, string>): string | undefined {
	let last: string | undefined;
	for (const value of map.values()) last = value;
	return last;
}

/** A turn ended: nothing is in flight, and any tool we never saw finish is gone
 *  with it. Clearing the map matters — an aborted tool never emits its end
 *  event, and a stale entry would make the next turn report the wrong tool. */
export function turnEnded(state: ActivityState, nowMs: number): void {
	state.running.clear();
	enterPhase(state, "idle", nowMs);
}

/** What goes on the wire. */
export interface ActivityPayload {
	phase: Phase;
	tool?: string;
	/** ISO 8601. The server keeps it as the phase's start and does NOT move it on
	 *  a heartbeat, so one long tool call reads as one long tool call. */
	since?: string;
	/** The turn-end recap line (HIV-1240). Sent when agenda refreshed it; the
	 *  server preserves the stored value on the beats that omit it. */
	recap?: string;
	/**
	 * What the in-flight tool is DOING — the command, for a bash (HIV-1279).
	 *
	 * `tool` is the same word ("bash") for a two-second `ls` and a twenty-minute
	 * `hive check`, and tool events only reach Hive when the tool ENDS — so
	 * while a long call is blocking, this is the only thing that can say what is
	 * being waited on. Sent on the beat that enters the phase; omitted on the
	 * heartbeats that follow, where the server preserves the stored value.
	 */
	detail?: string;
	/** Final assistant transcript sequence when the agenda declares completion. */
	completion_summary_seq?: number;
}

/**
 * Whether this state is worth a request.
 *
 * TWO reasons to send, and the second is the whole feature: the phase changed
 * (news), or work is in flight and the last beat has aged out (proof of life).
 *
 * AN IDLE SESSION NEVER BEATS. A workstation sitting at a prompt overnight would
 * otherwise POST every ten seconds, forever, to say nothing — the kind of cost
 * that only shows up on someone else's graph. It costs nothing in the pane
 * either: an idle agent draws no activity row, so there is no liveness claim
 * standing that could go stale. The transition INTO idle is still news and is
 * still sent.
 */
export function shouldReport(state: ActivityState, nowMs: number): boolean {
	const sent = state.sent;
	if (!sent) return true;
	if (sent.phase !== state.phase || sent.tool !== state.tool) return true;
	// `needs_input` and `completed` are idle-shaped for beating (HIV-1240/1265):
	// the agent is waiting on a human — for an answer, or for its finished work
	// to be reviewed — and a session waiting overnight must not POST every ten
	// seconds to say so. The transition was the news; the workspace judges
	// staleness by the server's own liveness, not by re-beats.
	if (state.phase === "idle" || state.phase === "needs_input" || state.phase === "completed") return false;
	// A detail the wire has not seen yet is news in its own right, even though
	// the phase has not moved. Some phases have progress to report WHILE they
	// run — the brief's retrieval lanes settle one at a time — and without this
	// every such update waited for the next heartbeat, which is most of a
	// minute. The row then sat unchanged for the length of the pass, which is
	// exactly what "the session looks dead" describes.
	//
	// Deliberately BELOW the idle-shaped check, so a session parked overnight on
	// `needs_input` still says nothing: this lets progress through, not chatter.
	// `detailSent` is set when the payload is built, so this fires once per
	// change rather than on every subsequent beat.
	if (state.detail && !state.detailSent) return true;
	return nowMs - sent.atMs >= HEARTBEAT_MS;
}

/**
 * Take the payload and record that it was sent.
 *
 * Recording at BUILD time rather than on a successful response, deliberately: a
 * beat is fire-and-forget with a short timeout, and re-reporting because a
 * response was slow would queue a burst of identical posts behind one stalled
 * request. A dropped beat costs a few seconds of the pane looking quieter than
 * it is, and the next beat corrects it.
 */
export function buildPayload(state: ActivityState, nowMs: number): ActivityPayload {
	state.sent = { phase: state.phase, tool: state.tool, atMs: nowMs };
	const payload: ActivityPayload = { phase: state.phase };
	if (state.tool) payload.tool = state.tool;
	// ONCE per phase. The server preserves it across the detail-less beats that
	// follow, so re-sending the same command every ten seconds would be pure
	// wire noise.
	if (state.detail && !state.detailSent) {
		payload.detail = state.detail;
		state.detailSent = true;
	}
	try {
		payload.since = new Date(state.sinceMs).toISOString();
	} catch {
		// An unrepresentable date is not worth failing a heartbeat over; the
		// server falls back to now() and the pane loses only the elapsed time.
	}
	return payload;
}

/** How much of a command is worth putting on a one-line status. Matches the
 *  server's own cap on the column. */
export const MAX_DETAIL = 240;

/**
 * A one-line description of what a tool call is about to do.
 *
 * Reads the ONE argument that answers "what is this waiting on" per tool, rather
 * than dumping the arguments: a status line is glanced at, and a JSON blob is
 * not glanced at. Anything unrecognised returns "" and the pane falls back to
 * the tool name, which is what it showed before this existed.
 *
 * Only the FIRST line of a command. A heredoc or a multi-line script would
 * otherwise put its whole body on a status line — and its first line is the part
 * that says what it is.
 */
export function toolDetail(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const pick = (key: string): string => (typeof a[key] === "string" ? (a[key] as string) : "");
	let raw = "";
	switch (toolName) {
		case "bash":
			raw = pick("command") || pick("cmd");
			break;
		case "read":
		case "write":
		case "edit":
			raw = pick("path") || pick("file_path") || pick("filePath");
			break;
		case "grep":
		case "find":
			raw = pick("pattern") || pick("query");
			break;
		default:
			return "";
	}
	const line = raw.split("\n", 1)[0].trim();
	return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}
