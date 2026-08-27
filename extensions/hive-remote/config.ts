/**
 * hive-remote — configuration.
 *
 * OPT-IN, on the same terms as hive-telemetry: absent config means the
 * extension registers its commands and does nothing else — no handlers, no
 * timers, no filesystem, no network. Being steerable from a browser is a
 * bigger step than being measured, so it gets its own flag rather than riding
 * on telemetry's.
 */

import { atomicWrite, configPathFor, numberOr, readJSON } from "../hive-common/identity.ts";

export const CONFIG_NAME = "hive-remote";

export interface RemoteConfig {
	/** Master switch. Only /hive-remote-on sets it. */
	enabled: boolean;
	/** Endpoint fallback; the shared credential's URL wins. */
	url: string;
	/** How often the transcript queue is flushed, ms. */
	flushIntervalMs: number;
	/** Flush early once this many events are queued. */
	eventThreshold: number;
	/** Accept steer/follow-up from the browser. */
	allowSteer: boolean;
	/** Accept interrupt from the browser. */
	allowInterrupt: boolean;
	/**
	 * Accept a kill from the browser — end this pi session, not just the turn.
	 *
	 * Defaults TRUE, like its siblings, and for the same reason: this whole
	 * extension is opt-in and off by default, so a session that is visible and
	 * steerable from a browser has already made the larger decision. The case it
	 * exists for is a session wedged rather than busy, where an interrupt reaches
	 * nothing and the alternative is walking to that machine.
	 *
	 * Separable because the outcome is not: a steer is recoverable, a kill ends
	 * work in flight.
	 */
	allowKill: boolean;
	/**
	 * Accept a mode switch from the browser — change the model and thinking
	 * level of this running session.
	 *
	 * Separable from steering because the blast radius is different in kind: a
	 * steer adds a message the agent can weigh, whereas this changes what is
	 * doing the weighing, mid-task, and every subsequent turn inherits it. It is
	 * also the one control that can make a session cost more without anyone
	 * asking it to do more.
	 */
	allowSetMode: boolean;
	/**
	 * Accept an OPERATING-mode switch from the browser — change what the harness
	 * allows this running session to do.
	 *
	 * Separable from allowSetMode because it is a different axis and a different
	 * risk. That one changes what is doing the thinking; this one can take write
	 * access away mid-task (or hand it back). Someone who wants a remotely
	 * re-modellable session does not necessarily want its restrictions
	 * remotely adjustable.
	 */
	allowSetOpMode: boolean;
	/**
	 * Report live context usage, provider quota and current model.
	 *
	 * Separate from the capabilities above because it is the only one that is
	 * pure OUTPUT — it accepts no commands — and because the quota is an
	 * ACCOUNT-level fact rather than a session one. Someone may reasonably want a
	 * steerable session without publishing how much of their week is left.
	 */
	reportStatus: boolean;
	/**
	 * Stream partial assistant text for smooth rendering.
	 *
	 * Separable from allowSteer because it is a different privacy trade: deltas
	 * send MORE prose more often (every partial, not just finalized turns), and
	 * someone may reasonably want to be steerable without live-streaming every
	 * keystroke of the model's thinking.
	 */
	streamDeltas: boolean;
	/**
	 * Send the model's REASONING — live, and as durable transcript rows.
	 *
	 * Its own switch, separate from streamDeltas, because reasoning is a
	 * different kind of prose. It is where a model works through what it has read
	 * — file contents, error messages, half-formed guesses about a codebase — and
	 * where it is least careful about what it repeats. Someone may reasonably
	 * want a fully streamed, steerable session without publishing that.
	 *
	 * Defaults ON, like its siblings: a session that opted into being watched is
	 * far more useful when the watcher can see it working, and reasoning is most
	 * of the wall-clock of a turn on a thinking model.
	 */
	streamThinking: boolean;
	/**
	 * Report a heartbeat: what this session is doing, and that it is still here.
	 *
	 * Pure OUTPUT and carries no prose at all — a phase name and a tool name, the
	 * latter already visible in the transcript. Separable anyway, because it is
	 * the one thing here that keeps making requests while an agent sits in a long
	 * tool call rather than only when it produces output.
	 */
	reportActivity: boolean;
	/**
	 * Report the working tree: which files this session has changed, and whether
	 * each is committed, staged, unstaged or untracked.
	 *
	 * Separable from reportActivity, the other pure-output switch, because this
	 * one sends PATHS. A repository's layout is the most specific thing about a
	 * private codebase that a file list can carry, and someone may reasonably want
	 * a watchable session without publishing it. It is also the only reporter here
	 * that costs subprocesses rather than cached numbers.
	 */
	reportWorktree: boolean;
	/**
	 * Let the AGENT request a mid-session workspace grant — add another repo to
	 * this sandboxed session and clone it into scratch (`request_workspace`).
	 *
	 * Defaults FALSE, unlike its siblings, and that break is deliberate. Every
	 * other flag here governs what the OPERATOR can do to a session they are
	 * already watching; this one hands the running agent a new capability —
	 * pulling a second repo into its writable scratch and opening a channel to
	 * ask a human (or the handsfree judge) to widen its scope. That is a bigger
	 * step than being steerable, so it is off until the owner turns it on, and it
	 * gates BOTH the agent-facing tools and the `can_add_workspace` capability
	 * this client declares at attach.
	 */
	allowAddWorkspace: boolean;
}

const DEFAULTS: RemoteConfig = {
	enabled: false,
	url: "",
	flushIntervalMs: 2_000,
	eventThreshold: 8,
	allowSteer: true,
	allowInterrupt: true,
	allowKill: true,
	allowSetMode: true,
	allowSetOpMode: true,
	reportStatus: true,
	streamDeltas: true,
	streamThinking: true,
	reportActivity: true,
	reportWorktree: true,
	allowAddWorkspace: false,
};

export function configPath(): string {
	return configPathFor(CONFIG_NAME);
}

export function loadConfig(): RemoteConfig {
	const raw = readJSON<Partial<RemoteConfig>>(configPath()) ?? {};
	return {
		enabled: raw.enabled === true,
		url: typeof raw.url === "string" ? raw.url : "",
		// Floor of 500ms: this flush is what the browser sees as "live", but a
		// tighter loop would spend more time in HTTP than the transcript is worth.
		flushIntervalMs: numberOr(raw.flushIntervalMs, DEFAULTS.flushIntervalMs, 500, 60_000),
		eventThreshold: numberOr(raw.eventThreshold, DEFAULTS.eventThreshold, 1, 200),
		// Capabilities default to ON once enabled — a user who deliberately turned
		// this on wants it to work — but each can be withdrawn independently.
		allowSteer: raw.allowSteer !== false,
		allowInterrupt: raw.allowInterrupt !== false,
		allowKill: raw.allowKill !== false,
		allowSetMode: raw.allowSetMode !== false,
		allowSetOpMode: raw.allowSetOpMode !== false,
		reportStatus: raw.reportStatus !== false,
		streamDeltas: raw.streamDeltas !== false,
		streamThinking: raw.streamThinking !== false,
		reportActivity: raw.reportActivity !== false,
		reportWorktree: raw.reportWorktree !== false,
		// OPT-IN, not opt-out: this one grants the agent a new power rather than
		// withdrawing an operator control, so it must be turned on explicitly —
		// `=== true`, the same shape as `enabled`, never the `!== false` default.
		allowAddWorkspace: raw.allowAddWorkspace === true,
	};
}

export function writeConfig(patch: Partial<RemoteConfig>): void {
	const current = readJSON<Partial<RemoteConfig>>(configPath()) ?? {};
	atomicWrite(configPath(), JSON.stringify({ ...current, ...patch }, null, 2));
}
