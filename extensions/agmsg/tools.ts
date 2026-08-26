/**
 * The sending half: agmsg as tools the model calls, not a skill it has to read.
 *
 * This is the difference between "agmsg is installed" and "this harness can talk
 * to other agents". A skill is progressive disclosure — a description in the
 * prompt, a file the model must decide to read, a bash invocation it must get
 * right. For a capability used once a week that is the correct trade. For the
 * channel a teammate is waiting on, it is one indirection too many: the model
 * that has just been handed a message has to be able to answer it as directly
 * as it writes a file.
 *
 * Every tool is a thin, typed wrapper over the agmsg script that already
 * implements it. No SQL, no schema knowledge, no second implementation of the
 * roster rules — a rejected send (unknown recipient, unjoined team) must fail
 * the way agmsg fails it, with agmsg's message.
 *
 * TEAM RESOLUTION. Most sessions belong to exactly one team, and requiring the
 * model to name it every time is a wrong-team send waiting to happen. `team` is
 * therefore optional and defaults to the session's single team; with more than
 * one joined, it becomes required and the error names the choices.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGuardedTool } from "../guards-common/capability.ts";
import type { AgmsgController, Role } from "./controller.ts";
import { agmsgHome, scriptPath, type AgmsgScript } from "./paths.ts";

const TOOL_TIMEOUT_MS = 30_000;

export interface ToolDeps {
	/**
	 * The controller as of NOW, or null before the first session.
	 *
	 * Resolved per call rather than captured: a `/agmsg join` or `/agmsg actas`
	 * mid-session must take effect on the very next tool call, and a session
	 * replacement swaps the controller out from under us.
	 */
	controller: () => AgmsgController | null;
	home?: string;
}

function text(body: string) {
	return { content: [{ type: "text" as const, text: body }], details: {} };
}

/**
 * The session's role, or an error the model can act on.
 *
 * Throwing (rather than returning an empty result) is deliberate: a send that
 * silently did nothing is the one failure mode that costs a teammate real time,
 * because both sides believe the message is in flight.
 */
function requireRole(deps: ToolDeps): Role {
	const controller = deps.controller();
	if (!controller) throw new Error("agmsg is not active in this session yet.");
	return controller.requireRole();
}

function resolveTeam(role: Role, requested?: string): string {
	if (requested?.trim()) return requested.trim();
	if (role.teams.length === 1) return role.teams[0];
	if (role.teams.length === 0) throw new Error("This agmsg identity is not in any team.");
	throw new Error(`This session is in several teams (${role.teams.join(", ")}). Pass team explicitly.`);
}

export function registerAgmsgTools(pi: ExtensionAPI, deps: ToolDeps): void {
	const home = deps.home ?? agmsgHome();

	async function run(script: AgmsgScript, args: string[], signal?: AbortSignal): Promise<string> {
		const res = await pi.exec(scriptPath(script, home), args, { signal, timeout: TOOL_TIMEOUT_MS });
		if (res.code !== 0) {
			throw new Error(`agmsg ${script} failed (exit ${res.code}): ${(res.stderr || res.stdout).trim()}`);
		}
		return res.stdout.trim();
	}

	registerGuardedTool(pi, {
		capability: { executes: true }, // runs the agmsg send.sh script via pi.exec
		name: "agmsg_send",
		label: "Message an agent",
		description:
			"Send a message to another AI agent on this machine over agmsg. The recipient is an agent name from " +
			"agmsg_team, not a person and not a file. Delivery is asynchronous: the message lands in the recipient's " +
			"session (immediately if it is running with monitor delivery, on its next inbox check otherwise). " +
			"There is no reply value — the answer arrives later as an incoming agmsg message.",
		promptSnippet:
			"Message another agent by name over agmsg (agmsg_team lists who is reachable; agmsg_send delivers asynchronously).",
		promptGuidelines: [
			"Use agmsg_send to answer an incoming [agmsg] message — replying in your own output only reaches the user, not the sender.",
			"Use agmsg_send when work depends on another agent's area, and say what you need and why; do not guess at their state.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Recipient agent name, as listed by agmsg_team" }),
			message: Type.String({ description: "Message body. Plain text; newlines are preserved." }),
			team: Type.Optional(Type.String({ description: "Team name. Defaults to this session's team." })),
		}),
		async execute(_id, params, signal) {
			const role = requireRole(deps);
			const team = resolveTeam(role, params.team);
			const out = await run("send.sh", [team, role.agent, params.to, params.message], signal);
			return text(out || `Sent to ${params.to} on team ${team}.`);
		},
	});

	registerGuardedTool(pi, {
		capability: { executes: true }, // runs the agmsg inbox.sh script via pi.exec
		name: "agmsg_inbox",
		label: "Check agmsg inbox",
		description:
			"Read unread agmsg messages addressed to this session and mark them read. With monitor delivery active, " +
			"messages arrive on their own and this is only needed to drain anything that landed while the session was down.",
		parameters: Type.Object({
			team: Type.Optional(Type.String({ description: "Team to check. Defaults to every team this session is in." })),
		}),
		async execute(_id, params, signal) {
			const role = requireRole(deps);
			const teams = params.team?.trim() ? [params.team.trim()] : role.teams;
			const parts: string[] = [];
			for (const team of teams) {
				const out = await run("inbox.sh", [team, role.agent], signal);
				if (out) parts.push(`# ${team}\n${out}`);
			}
			return text(parts.join("\n\n") || "No new messages.");
		},
	});

	registerGuardedTool(pi, {
		capability: { executes: true }, // runs the agmsg team.sh script via pi.exec
		name: "agmsg_team",
		label: "List agmsg team",
		description:
			"List the agents reachable over agmsg: their names, agent types (pi, claude-code, codex, …) and projects. " +
			"Call this before agmsg_send when unsure who to address.",
		parameters: Type.Object({
			team: Type.Optional(Type.String({ description: "Team to list. Defaults to this session's team." })),
		}),
		async execute(_id, params, signal) {
			const role = requireRole(deps);
			const teams = params.team?.trim() ? [params.team.trim()] : role.teams;
			const parts: string[] = [];
			for (const team of teams) parts.push(`# ${team}\n${await run("team.sh", [team], signal)}`);
			return text(parts.join("\n\n"));
		},
	});

	registerGuardedTool(pi, {
		capability: { executes: true }, // runs the agmsg history.sh script via pi.exec
		name: "agmsg_history",
		label: "agmsg history",
		description:
			"Show recent agmsg messages sent and received by this session's identity, including ones already read. " +
			"Use it to recover the thread of a conversation after a restart or a compaction.",
		parameters: Type.Object({
			team: Type.Optional(Type.String({ description: "Team. Defaults to this session's team." })),
		}),
		async execute(_id, params, signal) {
			const role = requireRole(deps);
			const team = resolveTeam(role, params.team);
			return text(await run("history.sh", [team, role.agent], signal));
		},
	});
}
