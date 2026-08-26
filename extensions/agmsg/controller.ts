/**
 * The session's agmsg state machine: role, delivery mode, watcher.
 *
 * Everything that knows HOW agmsg works lives here; index.ts only wires pi's
 * events to it and commands.ts only renders it. The split exists because this
 * is the part with real states — no role / one role / an ambiguous roster,
 * crossed with monitor/turn/off, plus a child process that can die — and it is
 * worth testing without a pi session around it.
 *
 * ROLE, NOT IDENTITY. `whoami.sh` answers "who is registered here", which can be
 * nobody, one name, or several. What the session actually sends and receives as
 * is a single ROLE, and there are two ways to get one: an unambiguous
 * registration, or an explicit `actas` claim (what a spawned agent runs as its
 * first input, and what a human uses to pick between several names). Ambiguity
 * never resolves itself — a session that guessed would answer under a name its
 * user never chose, and the recipient has no way to tell.
 *
 * NOTHING HERE MAY BE CALLED FROM AN EVENT HANDLER. `execFileSync` on a bash
 * script over SQLite is milliseconds, not microseconds, and pi awaits handlers
 * serially: a handler that resolved identity would be the agent loop for its
 * duration. Callers use a detached timer (index.ts) or run inside a command
 * handler, where the user is already waiting.
 */

import { execFileSync } from "node:child_process";

import { resolveIdentity, type Identity } from "./identity.ts";
import { isSilentNotice, type AgmsgMessage } from "./message.ts";
import { readDeliveryMode, type DeliveryMode } from "./mode.ts";
import { agmsgHome, scriptPath, type AgmsgScript } from "./paths.ts";
import { instanceId, startWatcher, type Watcher } from "./watcher.ts";

const SCRIPT_TIMEOUT_MS = 15_000;

/** What this session sends and receives as. */
export interface Role {
	agent: string;
	teams: string[];
	/** How the role was obtained — `/agmsg status` shows it, and a claim is worth seeing. */
	source: "registration" | "actas";
}

export interface ControllerHooks {
	/** Deliver a message into the conversation. Wakes an idle session. */
	inject: (message: AgmsgMessage) => void;
	/** Show the human something the model must not see. */
	notify: (text: string) => void;
	/** Repaint the footer. Called on every state change. */
	repaint: () => void;
}

export interface ControllerOptions extends ControllerHooks {
	/** pi's cwd — the starting point for agmsg's own project resolution. */
	cwd: string;
	sessionId: string | undefined;
	home?: string;
	pid?: number;
}

export interface ControllerState {
	identity: Identity;
	role: Role | null;
	mode: DeliveryMode;
	/** agmsg's resolved project root, or cwd until identity resolves. */
	project: string;
	watching: boolean;
	/** Messages injected this session — the footer's counter. */
	received: number;
}

/** Outcome of an `actas` claim, in the shape the caller reports to the human. */
export interface ActasResult {
	status: "ok" | "held" | "not_registered";
	teams: string[];
	owner?: string;
}

export class AgmsgController {
	private identityValue: Identity = { state: "not-joined", availableTeams: [] };
	private roleValue: Role | null = null;
	private modeValue: DeliveryMode = "off";
	private projectValue: string;
	private watcher: Watcher | null = null;
	private receivedCount = 0;
	private readonly home: string;
	private readonly pid: number;

	constructor(private readonly options: ControllerOptions) {
		this.projectValue = options.cwd;
		this.home = options.home ?? agmsgHome();
		this.pid = options.pid ?? process.pid;
	}

	state(): ControllerState {
		return {
			identity: this.identityValue,
			role: this.roleValue,
			mode: this.modeValue,
			project: this.projectValue,
			watching: this.watcher?.running() ?? false,
			received: this.receivedCount,
		};
	}

	role(): Role | null {
		return this.roleValue;
	}

	/** Why there is no role, phrased as the next step. Used verbatim in tool errors. */
	roleProblem(): string {
		if (this.identityValue.state === "multiple") {
			return `This session has several agmsg identities (${this.identityValue.agents.join(", ")}). Ask the user which one to use, then run /agmsg actas <name>.`;
		}
		return "This session has no agmsg identity. Ask the user whether to join a team, then run /agmsg join <team> <name>.";
	}

	/**
	 * Re-read identity and mode from agmsg, then make delivery match.
	 *
	 * Idempotent and safe to call repeatedly: it is the single path by which
	 * this session's delivery changes, whether the trigger was session start, a
	 * `/agmsg join`, or a mode switch made in another window.
	 *
	 * An `actas` claim SURVIVES a refresh. The claim is the more specific
	 * statement ("this session is bob"), and a later whoami that merely reports
	 * bob among several registrations must not undo it.
	 */
	refresh(): void {
		this.identityValue = resolveIdentity(this.projectValue, this.home);
		if (this.identityValue.state !== "not-joined" && this.identityValue.project) {
			this.projectValue = this.identityValue.project;
		}
		if (this.roleValue?.source !== "actas") {
			this.roleValue =
				this.identityValue.state === "joined"
					? { agent: this.identityValue.agent, teams: this.identityValue.teams, source: "registration" }
					: null;
		}
		this.modeValue = readDeliveryMode(this.projectValue);
		this.applyDelivery();
		this.options.repaint();
	}

	/**
	 * Claim a specific role for this session — the `actas` flow.
	 *
	 * This is what a spawned agent runs as its first input (`/agmsg actas <name>`,
	 * built by agmsg's spawn boot script), and what a human runs to pick one of
	 * several identities. The claim is EXCLUSIVE: agmsg refuses when another live
	 * session holds the name, which is what stops two agents from answering as
	 * the same teammate. A refusal is reported, never worked around.
	 */
	actas(name: string): ActasResult {
		const out = this.runAllowingFailure("actas-claim.sh", [
			this.projectValue,
			"pi",
			name,
			instanceId(this.options.sessionId, this.pid),
		]);
		const status = /status=(\w+)/.exec(out)?.[1];
		const teams = [...out.matchAll(/\bteam=(\S+)/g)].map((m) => m[1]);
		const owner = /owner=(\S+)/.exec(out)?.[1];

		if (status !== "ok") {
			return { status: status === "held" ? "held" : "not_registered", teams, owner };
		}

		this.roleValue = { agent: name, teams, source: "actas" };
		// Rebind the watcher: it must receive for THIS role, and agmsg's exclusive
		// watcher is also what signals readiness to a `spawn --wait-ready`.
		this.stopWatcher();
		this.modeValue = readDeliveryMode(this.projectValue);
		this.applyDelivery();
		this.options.repaint();
		return { status: "ok", teams };
	}

	/**
	 * Start or stop the watcher so it matches (role, mode).
	 *
	 * A claimed role is passed to the watcher as its active name, which makes it
	 * exclusive: it claims that one identity and signals readiness for it. A role
	 * that came from a plain registration leaves the name empty, and the watcher
	 * subscribes to every identity registered here — the leader case.
	 */
	private applyDelivery(): void {
		const wantWatcher = this.roleValue !== null && this.modeValue === "monitor";
		if (!wantWatcher) {
			this.stopWatcher();
			return;
		}
		if (this.watcher) return;
		this.watcher = startWatcher({
			project: this.projectValue,
			sessionId: this.options.sessionId,
			pid: this.pid,
			home: this.home,
			activeName: this.roleValue?.source === "actas" ? this.roleValue.agent : undefined,
			onMessage: (message) => {
				this.receivedCount += 1;
				this.options.inject(message);
				this.options.repaint();
			},
			onNotice: (text) => {
				if (!isSilentNotice(text)) this.options.notify(text);
			},
			onStopped: () => {
				this.watcher = null;
				this.options.repaint();
			},
		});
	}

	stopWatcher(): void {
		this.watcher?.stop();
		this.watcher = null;
	}

	restartWatcher(): void {
		this.stopWatcher();
		this.applyDelivery();
		this.options.repaint();
	}

	/**
	 * Turn-mode poll, run after the agent settles.
	 *
	 * `check-inbox.sh` owns the cooldown (60s by default, `delivery.turn.
	 * check_interval`) and the "a monitor watcher is alive, stand down" check —
	 * so this stays a plain call and cannot double-deliver against the watcher.
	 * Anything it prints is unread mail and goes straight into the conversation.
	 */
	pollInbox(): void {
		if (this.modeValue !== "turn" || !this.roleValue) return;
		const out = this.run("check-inbox.sh", ["pi", this.projectValue]).trim();
		if (!out) return;
		this.receivedCount += 1;
		this.options.inject({
			kind: "message",
			ts: new Date().toISOString(),
			team: this.roleValue.teams.join(", "),
			from: "inbox",
			to: this.roleValue.agent,
			body: out,
		});
		this.options.repaint();
	}

	/** `agmsg delivery set` for this project, then bring the session in line. */
	setMode(mode: DeliveryMode): string {
		const out = this.run("delivery.sh", ["set", mode, "pi", this.projectValue]);
		this.modeValue = readDeliveryMode(this.projectValue);
		this.stopWatcher();
		this.applyDelivery();
		this.options.repaint();
		return out.trim();
	}

	join(team: string, agent: string): string {
		const out = this.run("join.sh", [team, agent, "pi", this.projectValue]);
		this.refresh();
		return out.trim();
	}

	/** Drain unread mail on demand, regardless of delivery mode. */
	inbox(): string {
		const role = this.roleValue;
		if (!role) return this.roleProblem();
		const parts: string[] = [];
		for (const team of role.teams) {
			const out = this.run("inbox.sh", [team, role.agent]).trim();
			if (out) parts.push(`# ${team}\n${out}`);
		}
		return parts.join("\n\n") || "No new messages.";
	}

	send(to: string, message: string, team?: string): string {
		const role = this.requireRole();
		const target = team?.trim() || this.soleTeam(role);
		return this.run("send.sh", [target, role.agent, to, message]).trim() || `Sent to ${to} on team ${target}.`;
	}

	roster(team?: string): string {
		const role = this.requireRole();
		const teams = team?.trim() ? [team.trim()] : role.teams;
		return teams.map((t) => `# ${t}\n${this.run("team.sh", [t]).trim()}`).join("\n\n");
	}

	history(team?: string): string {
		const role = this.requireRole();
		return this.run("history.sh", [team?.trim() || this.soleTeam(role), role.agent]).trim();
	}

	requireRole(): Role {
		if (!this.roleValue) throw new Error(this.roleProblem());
		return this.roleValue;
	}

	/**
	 * The team to act in when the caller named none.
	 *
	 * Most sessions are in exactly one, and making the model name it every time
	 * is a wrong-team send waiting to happen. With several, guessing is the one
	 * thing that must not happen — the error names the choices instead.
	 */
	private soleTeam(role: Role): string {
		if (role.teams.length === 1) return role.teams[0];
		if (role.teams.length === 0) throw new Error("This agmsg identity is not in any team.");
		throw new Error(`This session is in several teams (${role.teams.join(", ")}). Pass team explicitly.`);
	}

	/**
	 * Blocking script call.
	 *
	 * A non-zero exit throws with agmsg's own stderr attached. There is no
	 * fallback value: "join failed but the session reports joined" is precisely
	 * the state that produces messages nobody receives.
	 */
	private run(script: AgmsgScript, args: string[]): string {
		try {
			return execFileSync(scriptPath(script, this.home), args, {
				timeout: SCRIPT_TIMEOUT_MS,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			const e = err as { stderr?: string; stdout?: string; message?: string };
			const detail = (e.stderr || e.stdout || e.message || "").toString().trim();
			throw new Error(`agmsg ${script} failed: ${detail}`);
		}
	}

	/**
	 * Like `run`, for the one script whose non-zero exits are ANSWERS.
	 *
	 * `actas-claim.sh` exits 1 for "another session holds this name" and 2 for
	 * "not registered here" — both are outcomes to report, and treating them as
	 * failures would turn the two states a user most needs to see into a generic
	 * error string.
	 */
	private runAllowingFailure(script: AgmsgScript, args: string[]): string {
		try {
			return execFileSync(scriptPath(script, this.home), args, {
				timeout: SCRIPT_TIMEOUT_MS,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			const e = err as { stdout?: string };
			return (e.stdout ?? "").toString();
		}
	}
}
