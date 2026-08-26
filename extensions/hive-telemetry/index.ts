/**
 * hive-telemetry — report this session's metrics to hive under the developer's
 * own API key, so local agent spend can be analysed alongside factory spend.
 *
 * OPT-IN. With no config this extension registers two commands and does nothing
 * else: no event handlers, no timers, no files, no network. A successful
 * `/hive-login` is the single act of consent. Finding $HIVE_TOKEN in the
 * environment is a credential source, never a consent signal — that token
 * exists for the `hive` CLI.
 *
 * METRICS ONLY. See payload.ts, which is the entire privacy boundary.
 *
 * TWO MECHANICAL CONSTRAINTS, both verified in pi 0.83.0's source, and both
 * stronger than style rules:
 *
 *  1. Every extension handler is `await`ed serially by the runner
 *     (dist/core/extensions/runner.js) — a slow handler IS the agent loop. So no
 *     handler here awaits anything, spawns anything, or touches the filesystem.
 *     Flushes are dispatched via setTimeout(0) onto the next macrotask and never
 *     awaited by anything pi controls.
 *  2. pi SKIPS the `context` / `before_provider_request` / `before_provider_headers`
 *     transform paths entirely when no extension registers a handler
 *     (dist/core/sdk.js). Registering one does not merely risk a prompt-cache
 *     bug — it switches on a path pi otherwise bypasses. We register none, so
 *     the ~96% cache hit rate is untouched by construction.
 *
 * ctx goes stale after session replacement, so every handler reads what it needs
 * from ctx SYNCHRONOUSLY at entry and never touches it afterwards.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
	BACKOFF_MAX_MS,
	backoffMs,
	clearAuthFailure,
	createRun,
	foldGate,
	foldMessageEnd,
	foldToolEnd,
	classifyToolError,
	toolErrorText,
	foldToolStart,
	foldToolUsage,
	foldTurnEnd,
	latchAuthFailure,
	markEnded,
	recordCompaction,
	resolveEndOutcome,
	shouldHeartbeat,
	takeHeartbeatSlot,
	type RunAccumulator,
} from "./accumulator.ts";
import {
	clearCredentials,
	loadConfig,
	readStoredCredential,
	resolveAuth,
	resolveProject,
	saveCredentials,
	writeConfig,
} from "./identity.ts";
import {
	HIVE_SESSION_CHANNEL,
	HIVE_SESSION_END_CHANNEL,
	type HiveSessionEndEvent,
	type HiveSessionEvent,
} from "../hive-common/channels.ts";
import { piVersion } from "../hive-common/piVersion.ts";
import { buildPayload } from "./payload.ts";
import { clearSpool, drainSpool, spoolStats, writeSpool } from "./spool.ts";
import { postUsage, validateToken, postHeartbeat } from "./transport.ts";
import { HIVE_METRIC_CHANNEL, type HiveMetricEvent, type ResolvedConfig } from "./types.ts";

/** Long enough for the deferred `git remote` probe to land in the first flush. */
const PROJECT_RESOLVE_GRACE_MS = 1_500;

const SETTLE_MIN_INTERVAL_MS = 15_000;
const SHUTDOWN_BUDGET_MS = 1_500;
const DRAIN_DELAY_MIN_MS = 3_000;
const DRAIN_DELAY_JITTER_MS = 7_000;
/** Resolved from the installed package, never restated — see ../hive-common/piVersion. */
const PI_VERSION = piVersion();

type FlushReason = "session_start" | "interval" | "threshold" | "settle" | "shutdown" | "manual";

export default function (pi: ExtensionAPI) {
	// Read once in the factory. This is a plain file read, not a long-lived
	// resource, so it is safe here — and it is what keeps the disabled path free
	// of any handler at all.
	let cfg: ResolvedConfig = loadConfig();

	let run: RunAccumulator | null = null;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let intervalTimer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeMetrics: (() => void) | undefined;
	/**
	 * Why the session is ending, when something knew better than pi's shutdown
	 * reason — see HIVE_SESSION_END_CHANNEL.
	 *
	 * Module-scoped rather than read at shutdown because the announcement and the
	 * shutdown are two separate events: hive-remote emits this and THEN calls
	 * shutdown(), so the value has to survive the gap. Never cleared — a session
	 * ends once, and a stale value cannot outlive the process that holds it.
	 */
	let endReason: HiveSessionEndEvent["reason"] | undefined;

	// Subscribed once at load, NOT per session_start like the metric channel:
	// this fires at most once per process and holds no session state, so there is
	// no reload leak to unsubscribe and no window where a kill could arrive
	// unheard. Synchronous, so the reason is recorded before hive-remote's
	// shutdown() on the next line of ITS handler.
	pi.events.on(HIVE_SESSION_END_CHANNEL, (data: unknown) => {
		try {
			const event = data as HiveSessionEndEvent;
			if (event?.reason) endReason = event.reason;
		} catch {
			/* fail open */
		}
	});

	// ---------------------------------------------------------------- flushing

	/**
	 * Tell the human, ONCE, that hive refused the credential — and which refusal
	 * it was.
	 *
	 * A silent latch is indistinguishable from "still starting" from the outside:
	 * the workspace shows "session attaching…" indefinitely and the only evidence
	 * is a 401 buried in the launch log. Custom entries are visible to the human
	 * and never enter LLM context, so this cannot cost a prompt-cache hit or leak
	 * into a turn.
	 *
	 * 401 and 403 arrive as ONE `authFailed` flag, because hive-common's
	 * classify() is shared with hive-remote and both must stop retrying. They need
	 * opposite actions from the human, though, so the distinction is made here
	 * from the status rather than by forking that classification: a 401 is a token
	 * hive does not recognise (rotated, expired, revoked) and /hive-login replaces
	 * it; a 403 is a token hive DOES recognise and refuses, so pasting the same
	 * one back changes nothing.
	 */
	function announceAuthRejection(status: number | null, source: string, from: "flush" | "heartbeat"): void {
		const advice =
			status === 403
				? "The token is recognised but not permitted — /hive-login with the same token will not help. Mint a per-user token (a machine token has no owning user, and agent sessions are attributed to a person)."
				: "Run /hive-login to paste a fresh token, then /hive-telemetry flush to send what spooled.";
		try {
			pi.appendEntry("hive-telemetry-auth-rejected", {
				message:
					`hive rejected the telemetry credential (${status ?? "auth error"} on the ${from}, token from ${source}). ` +
					"Usage reporting is halted for this session and snapshots spool locally. " +
					`Liveness heartbeats continue, backing off to at most one every ${Math.round(BACKOFF_MAX_MS / 60_000)} minutes — ` +
					"a session that goes silent is one the server reaps, and this one should show up as unauthenticated, not as dead. " +
					advice,
			});
		} catch {
			/* nothing to append into */
		}
	}

	/**
	 * snapshotAndPost sends one cumulative snapshot and resolves to whether the
	 * server accepted it.
	 *
	 * It returns a boolean rather than resolving void because the caller decides
	 * whether to drop the spooled copy, and "the promise settled" is NOT "the
	 * server took it" — a `.then(() => clearSpool())` on a void promise deletes
	 * the offline backup precisely when the POST failed and the backup is the
	 * only remaining copy.
	 */
	function snapshotAndPost(reason: FlushReason): Promise<boolean> {
		const current = run;
		if (!current) return Promise.resolve(false);

		const auth = resolveAuth(cfg);
		if (!auth) return Promise.resolve(false);

		current.seq += 1;
		current.dirty = 0;
		current.inFlight = true;
		current.lastFlushMs = Date.now();
		const payload = buildPayload(current, cfg, PI_VERSION, Date.now());

		if (cfg.spoolEveryFlush) writeSpool(payload);

		return postUsage(payload, auth)
			.then((res) => {
				current.inFlight = false;
				if (res.ok) {
					// The ONLY place contact is proven. `lastFlushMs` above is set
					// before the POST and so records an attempt; this records an
					// arrival, and the interval tick suppresses the heartbeat on
					// this one alone.
					current.lastFlushOkMs = Date.now();
					current.consecutiveFailures = 0;
					current.backoffUntilMs = 0;
					// A manual flush that succeeds clears the auth latch: the
					// credential was evidently repaired (new /hive-login, restored
					// grant), and staying latched would ignore that forever. The
					// heartbeat's backoff clears with it, so cadence returns to
					// normal on the same act rather than staying decayed for however
					// long the last step had left to run.
					clearAuthFailure(current);
					if (cfg.spoolEveryFlush) clearSpool(current.runId);
					return true;
				}
				if (res.authFailed) {
					// Do NOT retry a 401 on a timer: hive's authMiddleware writes
					// api_tokens.last_used_at on every call, so a two-minute retry
					// loop against a revoked token looks like credential stuffing.
					// Keep the spooled copy: the token may yet be repaired.
					//
					// This latch stops the USAGE flush only. The heartbeat is not
					// stopped, it is backed off onto the same curve — see
					// takeHeartbeatSlot for why silence is the worse of the two.
					if (latchAuthFailure(current, Date.now())) {
						announceAuthRejection(res.status, auth.source, "flush");
					}
					writeSpool(payload);
					return false;
				}
				if (res.permanent) {
					// This server will never accept this payload, so retrying it
					// forever would be the one way to make the spool unbounded.
					clearSpool(current.runId);
					return false;
				}
				// Transient (5xx, 429, network). The FLUSH backs off; the heartbeat
				// deliberately does not follow it. A server having a bad minute is
				// not a reason for its own fleet view to conclude this session died.
				current.consecutiveFailures += 1;
				current.backoffUntilMs = Date.now() + backoffMs(current.consecutiveFailures);
				writeSpool(payload);
				return false;
			})
			.catch(() => {
				current.inFlight = false;
				writeSpool(payload);
				return false;
			});
	}

	/**
	 * queueFlush defers to the next macrotask, so the POST starts only after the
	 * awaited handler chain has already returned control to the agent loop.
	 * Nothing pi controls ever awaits the result.
	 *
	 * Returns whether a POST is on its way — already in flight, already queued, or
	 * queued right here. The interval needs that answer to decide whether the
	 * session has spoken this tick: a flush that was refused by the auth latch or
	 * a backoff is NOT contact, and treating it as contact is how a busy session
	 * with a rejected token went completely silent (the return sat below the
	 * heartbeat branch, so a no-op flush consumed the tick).
	 */
	function queueFlush(reason: FlushReason): boolean {
		const current = run;
		if (!current || current.authFailed) return false;
		if (current.inFlight) return true;
		if (Date.now() < current.backoffUntilMs) return false;
		if (flushTimer) return true;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			void snapshotAndPost(reason);
		}, 0);
		flushTimer.unref?.();
		return true;
	}

	function stopTimers(): void {
		if (intervalTimer) clearInterval(intervalTimer);
		if (flushTimer) clearTimeout(flushTimer);
		intervalTimer = undefined;
		flushTimer = undefined;
	}

	// ---------------------------------------------------------------- commands
	// Command handlers are user-initiated and off the agent loop, so awaiting
	// here is fine — unlike in any event handler below.

	pi.registerCommand("hive-login", {
		description: "Authenticate pi telemetry against hive and enable reporting",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const notify = (msg: string, type: "info" | "warning" | "error" = "info") => {
				try {
					ctx.ui.notify(msg, type);
				} catch {
					/* no UI in this mode */
				}
			};

			// An inline token would be written into the session transcript AND
			// shipped to the model on the next turn. Refuse rather than sanitize.
			if (args.trim() && args.trim() !== "--from-env") {
				notify(
					"Do not pass a token as an argument — it lands in the session transcript and is sent to the model. Run /hive-login with no arguments.",
					"warning",
				);
				return;
			}

			cfg = loadConfig();
			let token: string | undefined;
			if (args.trim() !== "--from-env") {
				try {
					token = await ctx.ui.input("Hive API token", "hive_… (leave empty to use $HIVE_TOKEN)");
				} catch {
					/* no interactive UI — fall through to the environment */
				}
			}

			const existing = resolveAuth(cfg);
			const url = existing?.url ?? "";
			const useToken = token?.trim() || existing?.token;
			if (!useToken || !url) {
				notify(
					"No token or no endpoint. Set HIVE_URL (and HIVE_TOKEN), or run /hive-login and paste a token.",
					"error",
				);
				return;
			}

			const result = await validateToken(url, useToken);
			if (!result.ok) {
				notify(`hive login failed: ${result.message}`, "error");
				return;
			}
			if (!result.who.hasUser) {
				notify(
					"That token has no owning user (a machine token). Agent sessions are attributed to a person, so ingest will reject it — mint a per-user token instead.",
					"warning",
				);
				return;
			}

			saveCredentials({
				token: useToken,
				url,
				user: result.who.name,
				tokenName: result.who.tokenName,
				scope: result.who.scope,
				validatedAt: new Date().toISOString(),
			});
			writeConfig({ enabled: true, url });
			cfg = loadConfig();

			// A live run that latched authFailed resumes NOW: the latch exists to
			// stop hammering a dead token, and this command just validated a fresh
			// one. Without this, a session survived /hive-login silently muted for
			// the rest of its life — startRun below returns early on `run`.
			if (run?.authFailed) {
				clearAuthFailure(run);
				run.backoffUntilMs = 0;
				queueFlush("manual");
			}

			// Begin collecting NOW rather than at the next restart. session_start
			// has already fired for this session, so without this the session the
			// user just logged in from would record nothing at all — which is
			// exactly what happened before the handlers were made unconditional.
			try {
				startRun(ctx.sessionManager.getSessionId() ?? "", ctx.cwd, "");
			} catch {
				/* no live session to attach to — the next one picks it up */
			}
			notify(
				`hive telemetry on — ${result.who.name ?? result.who.tokenName ?? "authenticated"} (scope ${result.who.scope}, key …${useToken.slice(-4)})`,
			);
		},
	});

	pi.registerCommand("hive-telemetry", {
		description: "Show exactly what this session would report to hive, and manage reporting",
		getArgumentCompletions: (prefix: string) =>
			["", "on", "off", "flush", "logout"]
				.filter((s) => s.startsWith(prefix))
				.map((value) => ({ value, label: value || "status" })),
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const notify = (msg: string, type: "info" | "warning" | "error" = "info") => {
				try {
					ctx.ui.notify(msg, type);
				} catch {
					/* no UI in this mode */
				}
			};
			const verb = args.trim();

			if (verb === "on" || verb === "off") {
				writeConfig({ enabled: verb === "on" });
				cfg = loadConfig();
				if (verb === "off") {
					stopTimers();
					run = null; // stop collecting immediately, not at the next restart
				} else {
					try {
						startRun(ctx.sessionManager.getSessionId() ?? "", ctx.cwd, "");
					} catch {
						/* no live session — the next one picks it up */
					}
				}
				notify(`hive telemetry ${verb}`);
				return;
			}
			if (verb === "logout") {
				clearCredentials();
				writeConfig({ enabled: false });
				cfg = loadConfig();
				stopTimers();
				notify("hive telemetry credentials cleared and reporting disabled");
				return;
			}
			if (verb === "flush") {
				if (!run) {
					notify("no active run to flush", "warning");
					return;
				}
				await snapshotAndPost("manual");
				notify(run.authFailed ? "flush failed: auth rejected" : "flushed");
				return;
			}

			// Status. The preview is produced by the SAME buildPayload the
			// transport uses, so what a human inspects cannot drift from what is
			// actually sent.
			const auth = resolveAuth(cfg);
			const stored = readStoredCredential();
			const spool = spoolStats();
			const status = {
				enabled: cfg.enabled,
				endpoint: auth?.url ?? "(unresolved)",
				token: auth ? `…${auth.token.slice(-4)} (from ${auth.source})` : "(none)",
				identity: stored?.user ?? stored?.tokenName ?? "(not validated)",
				auth_rejected: run?.authFailed === true,
				// The observable consequence of a rejection, spelled out: without it
				// `auth_rejected: true` leaves an operator unable to tell a backed-off
				// heartbeat from a stopped one, which is the whole question they have.
				heartbeat: run?.authFailed
					? `backed off, next in ~${Math.max(0, Math.round((run.heartbeatBackoffUntilMs - Date.now()) / 1000))}s`
					: "normal cadence",
				spool: `${spool.files} file(s), ${Math.round(spool.bytes / 1024)} KiB`,
				would_send: run ? buildPayload(run, cfg, PI_VERSION, Date.now()) : "(no active run)",
			};
			// appendEntry writes a custom ENTRY, which explicitly does not
			// participate in LLM context — so this dump is visible to the human
			// and invisible to the model, and the prompt prefix is untouched.
			try {
				pi.appendEntry("hive-telemetry-status", status);
			} catch {
				/* nothing to append into */
			}
			notify(
				cfg.enabled
					? run?.authFailed
						? "hive telemetry: enabled but the credential was REJECTED — run /hive-login, then /hive-telemetry flush"
						: "hive telemetry: enabled (payload written to the transcript)"
					: "hive telemetry: disabled — run /hive-login",
			);
		},
	});

	// ------------------------------------------------------------ event wiring
	//
	// Handlers are registered UNCONDITIONALLY, and every one of them no-ops
	// while `run` is null. An earlier version returned here when disabled, so
	// that no handler existed at all — which was cheaper and WRONG: the factory
	// runs once at startup, so a session that was live when /hive-login enabled
	// reporting had no handlers to add and silently recorded nothing for the
	// rest of its life. Measured: a session at 7 turns / 18k tokens reported
	// zero. A null check per event is a fine price for that not happening.

	/**
	 * startRun begins collecting for the current session. Called from
	 * session_start and from /hive-login, so enabling takes effect immediately
	 * rather than at the next restart.
	 */
	function startRun(sessionId: string, cwd: string, forkedFrom: string): void {
		if (!cfg.enabled || run) return;
		if (!resolveAuth(cfg)) return; // enabled but no credential: stay inert

		// A closed map, not a passthrough: the server allowlists sources, and an
		// unmapped value would 400 every flush for the life of the session.
		// "cloud" is a Hive factory pod (HIVE_TELEMETRY_SOURCE set by the
		// factory-exec interactive wrapper); "eval" predates it.
		const envSource = process.env.HIVE_TELEMETRY_SOURCE;
		const source = envSource === "eval" || envSource === "cloud" ? envSource : "workstation";
		run = createRun(randomUUID(), sessionId, forkedFrom, source, Date.now());
		const current = run;

		// Announce the run id to any sibling Hive extension in this process
		// (hive-remote resolves it to a server session id via /by-run). Emitted
		// on every run because the id is fresh each time — a resumed or forked
		// session restarts the accumulator at zero, so reusing an id would make
		// cumulative totals go backwards and the server would reject the flush.
		// Identifier only; this bus never carries prose.
		pi.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: current.runId } satisfies HiveSessionEvent);

		// Export the run id for pi-mcp-adapter's ${PI_HIVE_RUN_ID} header
		// interpolation (mcp.json sends it as X-Hive-Session, HIV-1277): the
		// hive server then attributes knowledge_* provenance to this session
		// without the model having to pass a `session` argument. Headers are
		// resolved per connection attempt, so a run started before the first
		// hive MCP connect — the normal order — is picked up automatically.
		process.env.PI_HIVE_RUN_ID = current.runId;

		// REGISTER IMMEDIATELY, with nothing to report yet.
		//
		// Every other flush is gated on `dirty > 0` — there is no point posting
		// counters that have not moved. This one is not about counters. Until the
		// server has a row, `/agent-sessions/by-run` 404s, so hive-remote cannot
		// resolve a session id and cannot attach a conversation; the session is
		// invisible in the agents workspace and cannot be steered from it.
		//
		// That bit hardest exactly where it was least acceptable: an agent LAUNCHED
		// from the browser with no opening prompt does nothing, so it never went
		// dirty, so it never registered — and the operator could not send it its
		// first instruction, which was the entire point of launching it. The same
		// delay is why a hand-started session seemed to "take a long time to show
		// up": it appeared on its first turn, not when it opened.
		//
		// A session that exists is a fact worth reporting on its own. The row is
		// small, `live_state` already describes an idle one honestly, and the
		// workspace already hides ended sessions by default.
		// Deferred, so the registration flush carries the project.
		//
		// resolveProject shells out to git and therefore runs off the loop; the
		// registration flush was queued immediately and won the race, so a session
		// registered with an EMPTY repo — and with no turns there is no second
		// flush to correct it. The agents workspace grouped every idle session
		// under "(NO REPO)", which is exactly the sessions a launch produces.
		//
		// One tick later than the announcement, so the id still reaches siblings
		// as early as possible; only the network call waits.
		setTimeout(() => {
			if (run === current) queueFlush("session_start");
		}, PROJECT_RESOLVE_GRACE_MS);

		// Project resolution shells out to git, so it happens off the loop.
		const resolveTimer = setTimeout(() => {
			try {
				current.project = resolveProject(cwd);
			} catch {
				/* not a repo, or git missing — the payload just has no repo */
			}
		}, 0);
		resolveTimer.unref?.();

		// Jittered so a six-pane workmux layout does not POST all at once.
		const drainTimer = setTimeout(
			() => {
				const auth = resolveAuth(cfg);
				if (auth) void drainSpool(auth, current.runId).catch(() => undefined);
			},
			DRAIN_DELAY_MIN_MS + Math.random() * DRAIN_DELAY_JITTER_MS,
		);
		drainTimer.unref?.();

		if (intervalTimer) clearInterval(intervalTimer);
		intervalTimer = setInterval(() => {
			if (!run) return;
			// RE-ANNOUNCE the run id, every tick.
			//
			// The id is broadcast once, from startRun. A single broadcast is a race:
			// any sibling extension that had not yet subscribed when it fired never
			// learns the id and can never ask for it, because the bus carries no way
			// to request one. hive-remote lost that race and sat "enabled: true,
			// attached: no" forever — steerable in principle, unreachable in fact,
			// while its own status command blamed an environment variable nothing
			// sets.
			//
			// Re-announcing turns a broadcast anyone can miss into a state anyone can
			// observe. It is idempotent by construction: a listener that already has
			// this id ignores it, so the only cost is a repeated string on an
			// in-process bus.
			pi.events.emit(HIVE_SESSION_CHANNEL, { clientRunID: run.runId } satisfies HiveSessionEvent);

			// Reporting usage IS contact — but only a flush that ARRIVED is, and
			// this used to skip the heartbeat on one that had merely been queued.
			//
			// THE BUG THAT COST A LIVE AGENT. `dirty > 0` is true on every tick of
			// a working session, so a busy run took this branch from its first
			// tick and never once reached the heartbeat below: `last_seen_at` was
			// NULL for the whole of a 22-turn session (a78c92ef, 2026-08-17). That
			// left liveness resting entirely on the flush — and when the flush
			// loop stopped at 18:11:28, the server's 5-minute sweep ended the
			// session `heartbeat_timeout` while the agent kept working. Hive
			// recorded 22 turns and $1.57 against the pane's 59 and $6.11, and
			// every `only_live` view hid it (HIV-1996).
			//
			// So the flush is still queued exactly as before — that part was never
			// wrong — and only the DECISION TO STAY SILENT now requires proof of
			// arrival. `lastFlushOkMs` is 0 until the first acknowledged flush, so
			// a session heartbeats from tick one and can never start life invisible.
			const flushing = run.dirty > 0 && queueFlush("interval");
			if (!shouldHeartbeat(run, flushing, Date.now(), cfg.flushIntervalMs)) return;

			// Silence is how the server concludes a session is dead, so an idle
			// session still has to speak — and so does one whose credential was
			// rejected. takeHeartbeatSlot decays that second case onto the flush's
			// own backoff curve instead of stopping it: a session that vanishes is
			// worse than one showing up unauthenticated, and a token repaired
			// mid-flight must not find its session already reaped.
			const auth = resolveAuth(cfg);
			if (!auth) return;
			if (!takeHeartbeatSlot(run, Date.now())) return;

			const current = run;
			void postHeartbeat(current.runId, auth).then((res) => {
				// The one path that learns a credential died WITHOUT a flush. An
				// idle session never flushes, so before this a token revoked
				// mid-session was re-presented every interval with nothing in a
				// position to notice — the same defect, entered from the other side.
				if (res.authFailed && run === current && latchAuthFailure(current, Date.now())) {
					announceAuthRejection(res.status, auth.source, "heartbeat");
				}
			}).catch(() => undefined); // the keepalive still may not break the loop it runs on
		}, cfg.flushIntervalMs);
		intervalTimer.unref?.();
	}

	pi.on("session_start", (event, ctx) => {
		// Read ctx synchronously; it is stale after any await.
		const cwd = ctx.cwd;
		let sessionId = "";
		try {
			sessionId = ctx.sessionManager.getSessionId() ?? "";
		} catch {
			/* no session yet */
		}
		startRun(sessionId, cwd, event.reason === "fork" ? sessionId : "");

		// pi.events outlives the session runtime, unlike pi.on handlers — so the
		// unsubscribe must be held and called on shutdown or every /reload leaks
		// another subscriber writing into a dead accumulator. Drop any previous
		// one first: session_start can fire again (reload) without a shutdown.
		unsubscribeMetrics?.();
		unsubscribeMetrics = pi.events.on(HIVE_METRIC_CHANNEL, (data: unknown) => {
			try {
				const event = data as HiveMetricEvent;
				if (run && event && event.kind === "gate") foldGate(run, event);
			} catch {
				/* fail open */
			}
		});
	});

	pi.on("message_end", (event, ctx) => {
		try {
			if (!run) return;
			const msg = event.message;
			if (msg.role !== "assistant") return;
			const assistant = msg as AssistantMessage;
			// Captured synchronously: whether this provider bills per token or
			// against a flat-rate subscription. The server decides what that
			// means for money; this is only the claim.
			let notional = false;
			try {
				// isUsingOAuth needs the Model object, not the provider id, so
				// the registry resolves it from the message's own provider+model.
				const resolved = ctx.modelRegistry.find(assistant.provider, assistant.model);
				if (resolved) notional = ctx.modelRegistry.isUsingOAuth(resolved) === true;
			} catch {
				/* unknown — the server's own policy still classifies it */
			}
			foldMessageEnd(run, assistant, notional);
			if (run.dirty >= cfg.eventThreshold) queueFlush("threshold");
		} catch {
			/* fail open: telemetry must never break the agent loop */
		}
	});

	// Context compaction. `session_compact` is the EXTENSION-layer event (the
	// lower-level compaction_start/compaction_end pair is not exposed to
	// extensions), and it fires only after a compaction completes. reason
	// "overflow" is tracked separately because it means the session ran OUT of
	// context rather than tidying up at a threshold.
	pi.on("session_compact", (event) => {
		try {
			if (!run) return;
			recordCompaction(run, event.reason, event.compactionEntry?.tokensBefore);
		} catch {
			/* fail open */
		}
	});

	pi.on("turn_end", () => {
		try {
			if (run) foldTurnEnd(run);
		} catch {
			/* fail open */
		}
	});

	pi.on("tool_execution_start", (event) => {
		try {
			// event.args is deliberately NOT read here or anywhere else.
			if (run) foldToolStart(run, event.toolCallId, event.toolName);
		} catch {
			/* fail open */
		}
	});

	pi.on("tool_execution_end", (event) => {
		try {
			if (!run) return;
			const isError = event.isError === true;
			// The ONLY read of event.result in this extension, and it is
			// consumed on this line: toolErrorText normalises the shape,
			// classifyToolError reduces it to one of eight enum values, and
			// nothing keeps a reference to either. What reaches the accumulator
			// is a ToolErrorKind — the type makes storing text here impossible
			// rather than merely discouraged.
			//
			// Read only when the call actually failed: a successful result is
			// never inspected at all, which keeps the exception as narrow as it
			// can be while still answering "why do tools fail here".
			//
			// event.args remains unread, everywhere, without exception.
			const kind = isError ? classifyToolError(toolErrorText(event.result)) : undefined;
			foldToolEnd(run, event.toolCallId, event.toolName, isError, kind);
			if (run.dirty >= cfg.eventThreshold) queueFlush("threshold");
		} catch {
			/* fail open */
		}
	});

	pi.on("tool_result", (event) => {
		try {
			// The only place a nested subagent's spend is visible.
			if (run && event.usage) foldToolUsage(run, event.usage);
		} catch {
			/* fail open */
		}
	});

	pi.on("agent_settled", () => {
		try {
			if (!run || run.dirty === 0) return;
			if (Date.now() - run.lastFlushMs < SETTLE_MIN_INTERVAL_MS) return;
			queueFlush("settle");
		} catch {
			/* fail open */
		}
	});

	pi.on("session_shutdown", async (event) => {
		try {
			if (!run) return;
			const current = run;
			markEnded(current, resolveEndOutcome(endReason, String(event.reason)), Date.now());
			stopTimers();
			unsubscribeMetrics?.();
			unsubscribeMetrics = undefined;

			// Synchronous, ~1ms: durability is guaranteed before anything else,
			// whatever happens to the process next.
			current.seq += 1;
			writeSpool(buildPayload(current, cfg, PI_VERSION, Date.now()));
			current.seq -= 1; // snapshotAndPost re-increments for the live send

			// The spooled copy is dropped ONLY on a confirmed 2xx. Clearing it
			// whenever the promise settles would delete the offline backup
			// exactly when the POST failed and the backup is the only copy left.
			if (event.reason !== "quit") {
				// The process survives a reload/new/resume/fork, so a detached
				// POST completes normally.
				void snapshotAndPost("shutdown").then((ok) => {
					if (ok) clearSpool(current.runId);
				});
				run = null;
				return;
			}

			// On quit the process is about to exit and a detached fetch would die
			// with it, so a bounded wait is the price of not losing the tail.
			await Promise.race([
				snapshotAndPost("shutdown").then((ok) => {
					if (ok) clearSpool(current.runId);
				}),
				new Promise((resolve) => {
					const t = setTimeout(resolve, SHUTDOWN_BUDGET_MS);
					t.unref?.();
				}),
			]);
			run = null;
		} catch {
			/* fail open */
		}
	});
}
