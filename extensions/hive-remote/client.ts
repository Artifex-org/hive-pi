/**
 * hive-remote — the Hive API calls this extension makes.
 *
 * Thin wrappers over hive-common/http so the extension body stays about agent
 * lifecycle rather than HTTP. Nothing here throws; every function reports a
 * result the caller can branch on, because all of it runs on detached timers
 * where an unhandled rejection would be invisible.
 */

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import { request, withTimeout, type HiveAuth, type RequestResult } from "../hive-common/http.ts";
import type { ActivityPayload } from "./activity.ts";
import type { StatusPayload } from "./status.ts";
import type { WorktreePatch, WorktreePayload } from "./worktree.ts";
import type { WireEvent } from "./transcript.ts";

/** What this client can do, declared at attach so the UI never offers a control
 *  the client will silently ignore. */
export interface Capabilities {
	can_steer: boolean;
	can_interrupt: boolean;
	can_approve: boolean;
	/** Compact context without sending a message to the model. */
	can_compact?: boolean;
	/** End the SESSION, not the turn. Hive refuses to queue a kill without it. */
	can_kill: boolean;
	/** Switch the model and thinking level mid-session. Hive hides the mode
	 *  selector without it, rather than offering a control that does nothing. */
	can_set_mode: boolean;
	/**
	 * Switch the OPERATING mode — what the harness allows — mid-session.
	 *
	 * Declared only when something in this process actually enforces postures,
	 * never merely when the operator permits them: the server hides the selector
	 * without it, and a selector shown for a client that enforces nothing would
	 * tell an operator that writes are denied while every write tool stayed open.
	 */
	can_set_op_mode: boolean;
	/** Receive teammate messages. The server refuses to enqueue a team_message
	 *  to a client that did not declare it. */
	can_message: boolean;
	/**
	 * Request a mid-session workspace grant (add + clone another repo into
	 * scratch). OPTIONAL on the wire — and that is load-bearing, not tidiness.
	 *
	 * Attach is a full-record PUT the server decodes strictly, and the client
	 * running ahead of the server is the normal state of this pair. A server that
	 * predates this field would reject the WHOLE attach if it always arrived — the
	 * HIV-1163 failure class that costs a session its entire conversation. So the
	 * default-off case (everyone, until the owner opts in) sends a body
	 * byte-identical to today's: the field is spread in ONLY when true.
	 */
	can_add_workspace?: boolean;
	/**
	 * Consume a browser answer to a blocked interactive prompt (HIV-1765).
	 *
	 * OPTIONAL on the wire for the same HIV-1163 reason as `can_add_workspace`,
	 * and spread in only when true.
	 *
	 * Declared on what this PROCESS can honour, never on what the operator
	 * permits: the ask/plan extensions have to be loaded and listening, because
	 * the server draws an answer form from this flag and an unanswerable form is
	 * worse than none — the operator would answer, watch the card clear, and the
	 * agent would go on waiting at an overlay in a terminal nobody is sitting at.
	 */
	can_answer_questions?: boolean;
	/**
	 * Decline a pending plan approval and send the agent back to ask questions
	 * — the grill stage (HIV-2080).
	 *
	 * OPTIONAL on the wire and spread in only when true, same HIV-1163 reason as
	 * its neighbours.
	 *
	 * Gated on THREE things being true at once, because a grill that lands on any
	 * one of them missing is worse than no button: this build must have the
	 * switch case (it does, or this field would not exist), the ask/plan
	 * extensions must be loaded and answerable from a browser (otherwise the
	 * agent obediently asks questions into a terminal nobody is sitting at, and
	 * the plan never comes back), and steer consent must be given — a grill
	 * injects a turn into the agent's context exactly as a steer does.
	 */
	can_grill_plan?: boolean;
	/**
	 * Answer a request for ONE working-tree file's diff (HIV-1421).
	 *
	 * OPTIONAL on the wire like its two neighbours, same HIV-1163 reason. The
	 * server did not read this field at all until HIV-1769, which is why the
	 * feature was refused for every client however new — so a client declaring it
	 * against an older server is simply ignored, exactly as intended.
	 */
	can_diff?: boolean;
}

/** The deliberately small, path-free command record kept by Hive. */
export interface CapabilityCatalogEntry {
	name: string;
	description?: string;
	source: SlashCommandInfo["source"];
}

/** A bounded snapshot of the slash commands Pi exposed in this session. */
export interface CapabilityCatalog {
	commands: CapabilityCatalogEntry[];
	/**
	 * `provider/id` for every model this machine can actually run (HIV-1800).
	 *
	 * The workspace's model selector offers three server-configured modes and a
	 * "Custom…" row; this is what that row searches. It has to come from HERE
	 * because this is the only side that knows — Hive's mode config is fleet-wide
	 * and a given workstation need not have any of it configured, while the
	 * registry is exactly what `setModel` will accept.
	 *
	 * OMITTED, never `[]`, when there is nothing to report. Absent means "this
	 * client did not say" and leaves the browser's field open to free text; an
	 * empty array would be this machine claiming it can run no models at all.
	 */
	models?: string[];
}

/**
 * Hive's bounds on a catalog entry, mirrored here because THIS side owns the data.
 *
 * These are not defensive guesses — they are the server's documented limits
 * (`maxAgentCapability*` in internal/api/agent_conversations.go), and a body that
 * exceeds them is one the server cannot store.
 */
export const MAX_CATALOG_ENTRIES = 200;
export const MAX_CATALOG_NAME = 100;
export const MAX_CATALOG_DESCRIPTION = 500;
/** `maxAgentCatalogModels` / `maxAgentModelID`, same file, same reason. */
export const MAX_CATALOG_MODELS = 200;
export const MAX_CATALOG_MODEL_ID = 100;

/**
 * Converts Pi's registry into the privacy-safe catalog sent with an attach.
 * sourceInfo (and therefore local paths), argument schemas, and handlers never
 * cross this boundary.
 *
 * DESCRIPTIONS ARE TRUNCATED, and that is the whole reason this function has a
 * length constant (HIV-1163). A skill's description is its frontmatter prose —
 * written to tell a model when to dispatch the skill, not to label a button — so
 * running to thousands of characters is normal: 12 of the 22 skills on the
 * machine this was found on exceeded the cap, the longest at 2257 chars. Sending
 * them whole made the server reject the ENTIRE attach, which cost every session
 * on that workstation its conversation: no transcript, no steer, no interrupt,
 * retried every two seconds for the life of the process.
 *
 * A truncated tooltip is not a cost worth protecting against. Losing the
 * conversation is.
 */
export function buildCatalog(
	commands: readonly SlashCommandInfo[],
	/**
	 * `modelRegistry.getAvailable()` — the models with configured auth on this
	 * machine. Optional because the registry hangs off a session context this is
	 * sometimes called without, and a missing suggestion list must never cost an
	 * attach: the browser falls back to free text.
	 */
	models?: readonly { provider: string; id: string }[],
): CapabilityCatalog {
	const ids = buildModelList(models);
	return {
		commands: commands.slice(0, MAX_CATALOG_ENTRIES).map(({ name, description, source }) => ({
			name: clamp(name, MAX_CATALOG_NAME),
			description: description === undefined ? undefined : clamp(description, MAX_CATALOG_DESCRIPTION),
			source,
		})),
		// Spread-only-when-present, the same rule the capability flags follow: a
		// key that is always sent cannot later be told apart from one this client
		// deliberately left empty.
		...(ids.length > 0 ? { models: ids } : {}),
	};
}

/**
 * `provider/id`, deduped and bounded — the spelling Hive's mode config, the
 * status post and `setModel` all already use.
 *
 * Anything that would not round-trip is dropped rather than sent: a provider or
 * id containing a slash cannot be split back apart by the server (which splits on
 * the FIRST one), so it would appear in the picker and then be refused by the
 * route behind it. A registry entry missing either half is not a model anyone can
 * switch to.
 */
function buildModelList(models?: readonly { provider: string; id: string }[]): string[] {
	if (!models?.length) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const { provider, id } of models) {
		if (out.length === MAX_CATALOG_MODELS) break;
		if (!provider || !id || provider.includes("/")) continue;
		const spec = `${provider}/${id}`;
		if (Buffer.byteLength(spec, "utf8") > MAX_CATALOG_MODEL_ID || seen.has(spec)) continue;
		seen.add(spec);
		out.push(spec);
	}
	return out;
}

/**
 * Truncate to at most `max` BYTES without splitting a character.
 *
 * Bytes because the server's limit is bytes; whole characters because a lone
 * surrogate or half a multi-byte sequence is invalid UTF-8, and a jsonb column
 * refuses it — which would turn this truncation back into the failed attach it
 * exists to prevent. Sliced by code point rather than by `.slice()` so an emoji
 * or a CJK description cannot be cut mid-character.
 */
function clamp(value: string, max: number): string {
	if (Buffer.byteLength(value, "utf8") <= max) return value;
	let bytes = 0;
	let out = "";
	for (const ch of value) {
		const size = Buffer.byteLength(ch, "utf8");
		if (bytes + size > max) break;
		bytes += size;
		out += ch;
	}
	return out;
}

export interface AttachRequest extends Capabilities {
	title: string;
	branch: string;
	worktree: string;
	catalog: CapabilityCatalog;
	/** Multiplexer session, so the operator can join this agent at the machine. */
	terminal?: string;
	terminal_kind?: string;
}

export interface AttachResponse {
	session_id: string;
	last_seq: number;
}

/**
 * resolveSession maps hive-telemetry's client-minted run id to the server's
 * session id.
 *
 * The lookup is keyed server-side on (user_id, client_run_id) — the same unique
 * index the telemetry ingest writes through — so it resolves only the caller's
 * own sessions even if another developer's run id were known.
 */
export async function resolveSession(auth: HiveAuth, clientRunID: string): Promise<string | null> {
	const res = await request<{ id?: string }>(auth, "GET", `/agent-sessions/by-run/${encodeURIComponent(clientRunID)}`);
	return res.ok && res.body?.id ? res.body.id : null;
}

/** attach makes a telemetry session a conversation and returns the server's
 *  durable watermark, which is where this client resumes from. */
export function attach(auth: HiveAuth, sessionID: string, body: AttachRequest): Promise<RequestResult<AttachResponse>> {
	return request<AttachResponse>(auth, "PUT", `/agent-sessions/${sessionID}/conversation`, body);
}

export function postEvents(
	auth: HiveAuth,
	sessionID: string,
	events: WireEvent[],
): Promise<RequestResult<{ last_seq: number }>> {
	return request<{ last_seq: number }>(auth, "POST", `/agent-sessions/${sessionID}/events`, { events });
}

/**
 * postDelta streams partial assistant text. Fire-and-forget: it is never
 * persisted, so a lost delta costs nothing once the finalized event lands.
 *
 * `channel` is OMITTED for ordinary text, and that is deliberate compatibility
 * rather than tidiness. Hive decodes this body with DisallowUnknownFields, so a
 * server that predates the split would 400 every delta carrying the field — and
 * that would take the whole live stream down, not just reasoning. Sending it
 * only for reasoning means an older server loses exactly the thing it cannot
 * store.
 */
export function postDelta(
	auth: HiveAuth,
	sessionID: string,
	text: string,
	channel?: "thinking",
): Promise<RequestResult> {
	const body = channel ? { text, channel } : { text };
	return request(auth, "POST", `/agent-sessions/${sessionID}/deltas`, body, 2_000);
}

/**
 * postToolStart announces an in-flight tool call. Ephemeral like a delta —
 * never persisted; the durable event at tool end supersedes the pending card
 * the browser draws from this. Exists because a long call (a subagent
 * delegation above all) otherwise renders as NOTHING for its whole duration,
 * which is exactly when an operator is watching.
 */
export function postToolStart(
	auth: HiveAuth,
	sessionID: string,
	toolCallID: string,
	toolName: string,
	toolArgs?: string,
): Promise<RequestResult> {
	return request(auth, "POST", `/agent-sessions/${sessionID}/tool-starts`, {
		tool_call_id: toolCallID,
		tool_name: toolName,
		tool_args: toolArgs,
	}, 2_000);
}

/**
 * postToolUpdate ships a snapshot of what an in-flight call has produced.
 *
 * Fire-and-forget on the same terms as postToolStart, and for the sharper
 * version of the same reason: a progress reading is superseded roughly every
 * second, so retrying a failed one would deliver something already stale. A
 * dropped snapshot costs the viewer one second of freshness and nothing else,
 * because each snapshot is CUMULATIVE rather than a delta.
 */
export function postToolUpdate(
	auth: HiveAuth,
	sessionID: string,
	toolCallID: string,
	toolName: string,
	seq: number,
	text: string,
	details?: string,
): Promise<RequestResult> {
	return request(auth, "POST", `/agent-sessions/${sessionID}/tool-updates`, {
		tool_call_id: toolCallID,
		tool_name: toolName,
		update_seq: seq,
		text,
		tool_details: details,
	}, 2_000);
}

/**
 * postActivity reports the heartbeat: the phase, its tool, and when it began.
 *
 * Fire-and-forget with a short timeout like postDelta and postStatus. Retrying
 * would deliver a reading that is already wrong, and the next beat is along in
 * ten seconds — a dropped one costs the pane a few seconds of looking quieter
 * than it is.
 */
export function postActivity(
	auth: HiveAuth,
	sessionID: string,
	activity: ActivityPayload,
): Promise<RequestResult> {
	return request(auth, "POST", `/agent-sessions/${sessionID}/activity`, activity, 4_000);
}

/**
 * postPlan replaces the stored plan document.
 *
 * A whole-snapshot PUT rather than a patch stream, because the server is not a
 * second implementation of the client's fold: it stores what it is given and
 * refuses anything older. `revision` is sent alongside so a stale write from a
 * forked or resumed process is rejected (409) rather than silently overwriting
 * newer work — the client's own copy is not authoritative when two exist.
 */
export function postPlan(
	auth: HiveAuth,
	sessionID: string,
	document: unknown,
	revision: number,
): Promise<RequestResult<{ revision: number }>> {
	return request<{ revision: number }>(auth, "PUT", `/agent-sessions/${sessionID}/plan`, { document, revision });
}

/**
 * postWorkflow replaces the stored workflow document (stages and steps).
 *
 * The plan's twin in every respect, including the revision guard — and it
 * matters more here: a workflow is rewritten on every step tick, so two
 * processes reporting for one session produce far more chances for an older
 * snapshot to arrive last.
 */
export function postWorkflow(
	auth: HiveAuth,
	sessionID: string,
	document: unknown,
	revision: number,
): Promise<RequestResult<{ revision: number }>> {
	return request<{ revision: number }>(auth, "PUT", `/agent-sessions/${sessionID}/workflow`, {
		document,
		revision,
	});
}

export interface RemoteCommand {
	id: string;
	kind:
		| "steer"
		| "follow_up"
		| "interrupt"
		| "compact"
		| "kill"
		| "start_session"
		| "set_mode"
		| "team_message"
		| "set_op_mode"
		| "plan_approve"
		| "plan_grill"
		| "question_answer"
		| "worktree_diff";
	payload: string;
	/**
	 * Who enqueued it, stamped by the server (HIV-1215): "operator" (browser),
	 * "agent" (MCP steer_agent / message_teammate), "hive" (server-generated).
	 * Absent from servers that predate it; echoed back as the folded event's
	 * `origin` so the Hive transcript can say who an injected message came from.
	 */
	source?: string;
	/**
	 * The user id behind `source`, for the human origins (HIV-1420). Echoed onto
	 * the folded event so the Hive transcript can name WHO steered, not just
	 * which role — the case a read-write share creates, where the owner and a
	 * colleague both type into one session.
	 */
	issued_by?: string;
	attachment_ids?: string[];
}

/**
 * postStatus reports this session's live context usage, quota and model.
 *
 * Fire-and-forget with a short timeout, like postDelta: the reading is replaced
 * on the next tick, so a dropped one costs a few seconds of staleness and
 * retrying it would only ever deliver a number that is already wrong.
 */
export function postStatus(auth: HiveAuth, sessionID: string, status: StatusPayload): Promise<RequestResult> {
	return request(auth, "POST", `/agent-sessions/${sessionID}/status`, status, 4_000);
}

/**
 * postWorktree reports the working tree — what this agent has changed, and how
 * far along that change is.
 *
 * POST rather than PUT, unlike the plan: there is no revision for a newer report
 * to be stale against. The most recent look at the tree simply wins, which is
 * also why a dropped one costs nothing — the next tick re-measures.
 *
 * A longer timeout than the other fire-and-forget posts because the body is
 * larger: up to 200 paths with their line counts, where a status is a handful of
 * numbers.
 */
export function postWorktree(auth: HiveAuth, sessionID: string, worktree: WorktreePayload): Promise<RequestResult> {
	return request(auth, "POST", `/agent-sessions/${sessionID}/worktree`, worktree, 8_000);
}

/**
 * postWorktreePatch answers a `worktree_diff` request with ONE file's diff.
 *
 * The server asks because it cannot know: unpushed work exists only on this
 * machine, and the worktree report deliberately carries paths and counts rather
 * than content. The browser is waiting on a 30-second deadline, after which it
 * renders "unanswered" — so this is sent even when the answer is empty, with the
 * reason attached. A blank viewer that says nothing reads as "unchanged", which
 * is the one thing it must never mean.
 */
export function postWorktreePatch(auth: HiveAuth, sessionID: string, patch: WorktreePatch): Promise<RequestResult> {
	return request(auth, "POST", `/agent-sessions/${sessionID}/worktree/patch`, patch, 8_000);
}

export interface RemoteAttachment {
	data: string; // base64
	mediaType: string;
	// Sanitized bare filename from X-Hive-File-Name; "" for pasted screenshots.
	fileName: string;
}

// fetchCommandAttachment uses the normal owner-scoped bearer route. Attachment
// bytes never enter a command payload, transcript, or URL. Any content type is
// accepted — the STEER handler decides how each kind reaches the model (image
// block, text block, or a file in the worktree); refusing here is what used to
// drop a whole steer on the floor (HIV-1939).
export async function fetchCommandAttachment(auth: HiveAuth, sessionID: string, attachmentID: string): Promise<RemoteAttachment | null> {
	try {
		const res = await withTimeout(8_000, (signal) =>
			fetch(`${auth.url}/api/v1/agent-sessions/${encodeURIComponent(sessionID)}/attachments/${encodeURIComponent(attachmentID)}`, {
				headers: { Authorization: `Bearer ${auth.token}` }, signal,
			}),
		);
		if (!res.ok) return null;
		const mediaType = res.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
		const fileName = res.headers.get("x-hive-file-name") ?? "";
		return { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mediaType, fileName };
	} catch {
		return null;
	}
}

/**
 * claimCommands takes whatever the operator has queued, exactly once.
 *
 * Deliberately a POLL rather than a held-open stream. A long-lived connection
 * inside a desktop agent has to survive laptop sleep, VPN flaps and server
 * redeploys, and every one of those failure modes ends the same way: the steer
 * box silently stops working, with a reconnect state machine to get wrong. A
 * poll against an indexed partial index is cheap, carries no state, and is
 * self-healing by construction. A steer is human-typed, so the latency is
 * imperceptible. (The BROWSER side of this feature keeps SSE, where latency is
 * visible and a page can simply reconnect.)
 *
 * POST because claiming mutates: a claimed command is never handed out again.
 */
export async function claimCommands(auth: HiveAuth, sessionID: string): Promise<RemoteCommand[]> {
	const res = await request<{ items?: RemoteCommand[] }>(auth, "POST", `/agent-sessions/${sessionID}/commands/claim`);
	if (!res.ok || !res.body?.items) return [];
	return res.body.items;
}

// ---------------------------------------------------------------- grant requests
//
// The request→decide→one-shot-fetch spine that mirrors the server's credential
// grant, made GENERIC on purpose: `request_workspace` is the first caller, and
// `request_credential` (#18) is the second. The only thing that varies between
// them is the two URL path segments, so that is the only thing `kind` selects.

/**
 * The kinds of mid-session grant a session can ask for.
 *
 * Each maps to a pair of URL path segments under `/agent-sessions/{id}/…`. Add a
 * kind here and in REQUEST_PATHS to give it the whole request-and-wait machinery
 * for free — no other change to `requestAndWait`.
 */
export type RequestKind = "workspace" | "credential";

const REQUEST_PATHS: Record<RequestKind, { requests: string; grants: string }> = {
	workspace: { requests: "workspace-requests", grants: "workspace-grants" },
	credential: { requests: "credential-requests", grants: "credential-grants" },
};

/**
 * A server verdict on a grant request. `pending` is the only non-terminal one;
 * the poll stops on any of the other four. `approve` (a human decided) and
 * `auto` (every requested item was auto-approve, or handsfree decided) both
 * carry a grant; `deny` and `expired` carry nothing.
 */
export type RequestVerdict = "pending" | "approve" | "auto" | "deny" | "expired";

/** The request row Hive returns from the POST and each poll. */
export interface RequestRow {
	/** The grant id — the path segment the one-shot value fetch is keyed on. */
	id: string;
	client_call_id?: string;
	verdict: RequestVerdict;
}

/** One repo in a delivered workspace grant. */
export interface WorkspaceRepoGrant {
	/** Catalog name, and the checkout's directory basename under target_dir. */
	name: string;
	/** owner/repo, the GitHub clone source. */
	repo: string;
	/** Branch to check out; empty means the repo's default branch. */
	branch: string;
	/**
	 * The session's scratch root as a TILDE path (`~/.hive/scratch/<safe>`),
	 * computed server-side from the session branch. Expanded client-side; may be
	 * empty, in which case the client falls back to the sole dir under
	 * `~/.hive/scratch/`.
	 */
	target_dir: string;
}

/** The one-shot workspace grant value. */
export interface WorkspaceGrantValue {
	repos: WorkspaceRepoGrant[];
}

/** A grantable repo, from the readable workspace catalog. */
export interface WorkspaceCatalogEntry {
	name: string;
	repo: string;
	default_branch?: string;
	description?: string;
}

/**
 * The outcome of a request-and-wait, in a shape the caller can branch on without
 * a try/catch. Beyond the four server verdicts it adds two the client owns:
 * `timeout` (the wait window elapsed with the request still pending — not a
 * denial, the decision may yet land) and `error` (the request could not be
 * carried out at all). `grant` is present only on `approve`/`auto`; `error`/
 * `status`/`gone` describe a failed grant fetch on an otherwise-approved request.
 */
export interface Decision<G = unknown> {
	verdict: RequestVerdict | "timeout" | "error";
	grant?: G;
	/** Human-readable reason on `error`, or on an approved-but-unfetchable grant. */
	error?: string;
	/** HTTP status of a failed grant fetch, when there was one. */
	status?: number | null;
	/**
	 * The grant value was already delivered (HTTP 410). The value fetch is
	 * one-shot, so this is the expected outcome of asking for the SAME grant a
	 * second time — the checkout it produced almost certainly already exists.
	 */
	gone?: boolean;
}

function isTerminalVerdict(v: RequestVerdict): boolean {
	return v === "approve" || v === "auto" || v === "deny" || v === "expired";
}

// A request waiter owns its poll delay. Unlike background telemetry timers, it
// MUST stay referenced: an unref'ed timer can leave an in-flight tool parked
// forever without issuing its next verdict poll.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * requestAndWait POSTs a grant request, polls it to a terminal verdict, and on
 * approval fetches the one-shot grant value — the reusable core of the whole
 * request family.
 *
 * IDEMPOTENT by `clientCallID`: the server keys the row on
 * `(session_id, client_call_id)`, so re-running this with the same id returns
 * the existing row rather than opening a second request. A caller that retries
 * (a dropped connection, a re-invoked tool) therefore rejoins the decision it
 * already started rather than racing a duplicate. The POST alone can come back
 * already-terminal (`auto`, or an already-decided row), in which case the poll
 * loop is skipped entirely.
 *
 * Never throws: every failure is a `Decision`. The poll honours `signal`, so an
 * operator interrupt ends the wait instead of leaving the tool asleep to its
 * deadline.
 */
export async function requestAndWait<G = unknown>(
	auth: HiveAuth,
	kind: RequestKind,
	sessionID: string,
	clientCallID: string,
	body: Record<string, unknown>,
	opts: { pollMs: number; timeoutMs: number; signal?: AbortSignal },
): Promise<Decision<G>> {
	const paths = REQUEST_PATHS[kind];
	const base = `/agent-sessions/${encodeURIComponent(sessionID)}`;

	const created = await request<RequestRow>(auth, "POST", `${base}/${paths.requests}`, {
		...body,
		client_call_id: clientCallID,
	});
	if (!created.ok || !created.body) {
		return { verdict: "error", error: created.error ?? `request failed (HTTP ${created.status ?? "?"})`, status: created.status };
	}

	let row = created.body;
	const deadline = Date.now() + opts.timeoutMs;
	while (!isTerminalVerdict(row.verdict)) {
		if (opts.signal?.aborted) return { verdict: "error", error: "interrupted" };
		if (Date.now() >= deadline) return { verdict: "timeout" };
		await sleep(opts.pollMs);
		if (opts.signal?.aborted) return { verdict: "error", error: "interrupted" };
		const polled = await request<RequestRow>(auth, "GET", `${base}/${paths.requests}/${encodeURIComponent(clientCallID)}`);
		// A genuinely permanent failure will never become a verdict — a revoked
		// token (403) or a malformed request (400) would otherwise be re-hit every
		// pollMs for the whole timeout window, so stop. But a 404 here is NOT
		// permanent: this exact row was created (or rejoined) by the POST above, so
		// a not-found mid-poll is a server restart / rollout / read-replica lag, not
		// a vanished request — treat it as transient and keep polling. Giving up on
		// a 404 abandoned an approval that was already recorded (observed live when
		// a deploy cycled pods mid-request). A transient failure just waits for the
		// next poll; only a fresh row advances the loop, so a dropped poll is free.
		if (polled.authFailed || (polled.permanent && polled.status !== 404)) {
			return { verdict: "error", error: polled.error ?? `poll failed (HTTP ${polled.status ?? "?"})`, status: polled.status };
		}
		if (polled.ok && polled.body) row = polled.body;
	}

	if (row.verdict === "deny" || row.verdict === "expired") return { verdict: row.verdict };

	// approve | auto → fetch the one-shot value, keyed on the grant id.
	const value = await request<G>(auth, "GET", `${base}/${paths.grants}/${encodeURIComponent(row.id)}/value`);
	if (!value.ok || value.body === undefined) {
		return {
			verdict: row.verdict,
			error: value.error ?? `grant fetch failed (HTTP ${value.status ?? "?"})`,
			status: value.status,
			gone: value.status === 410,
		};
	}
	return { verdict: row.verdict, grant: value.body };
}

/** fetchWorkspaceCatalog reads the readable, non-secret list of grantable repos. */
export async function fetchWorkspaceCatalog(
	auth: HiveAuth,
	sessionID: string,
): Promise<{ ok: true; entries: WorkspaceCatalogEntry[] } | { ok: false; error: string }> {
	const res = await request<{ entries?: WorkspaceCatalogEntry[] }>(
		auth,
		"GET",
		`/agent-sessions/${encodeURIComponent(sessionID)}/workspace-catalog`,
	);
	if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status ?? "?"}` };
	return { ok: true, entries: res.body?.entries ?? [] };
}
