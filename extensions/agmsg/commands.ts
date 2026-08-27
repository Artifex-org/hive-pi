/**
 * `/agmsg` — the human's half of the channel, and the spawn boot command.
 *
 * The model has tools; the person driving the session needs the things a tool
 * must never do on its own: pick an identity, change how messages are
 * delivered, and see whether the receiver is actually alive. Joining a team
 * under a chosen name is an identity decision, and delivery mode rewrites a
 * file in the project — neither belongs to the model.
 *
 * `/agmsg actas <name>` has a second caller that is not a human at all. When
 * agmsg spawns a pi agent it launches `pi -n <team>-<agent> "/agmsg actas
 * <agent>"`, optionally with a task appended on the following lines. That is
 * the whole boot protocol: claim the role, then do the work. It matches
 * `cmd_prefix=/` in the driver manifest, and it is why the verb takes free text
 * after the name rather than splitting on whitespace like the others.
 *
 * Command handlers may block: the user (or the spawn) is waiting on this one
 * call. This is the one place in the extension where a synchronous agmsg call
 * is correct.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { AgmsgController } from "./controller.ts";
import { describeIdentity } from "./identity.ts";
import type { DeliveryMode } from "./mode.ts";

const USAGE = [
	"/agmsg                           status: role, delivery mode, watcher",
	"/agmsg inbox                     read unread messages now",
	"/agmsg team                      who is reachable",
	"/agmsg history                   recent messages for this role",
	"/agmsg send <to> <message>       send as this session's role",
	"/agmsg join <team> <name>        join a team under a name",
	"/agmsg actas <name> [task]       claim a registered identity for this session",
	"/agmsg mode <monitor|turn|off>   set delivery for this project",
	"/agmsg restart                   restart the inbox watcher",
].join("\n");

function isMode(value: string): value is DeliveryMode {
	return value === "monitor" || value === "turn" || value === "off";
}

export function statusReport(controller: AgmsgController): string {
	const state = controller.state();
	const delivery =
		state.mode === "monitor" ? `monitor (watcher ${state.watching ? "running" : "not running"})` : state.mode;
	const role = state.role
		? `${state.role.agent} @ ${state.role.teams.join(", ") || "no team"} (${state.role.source})`
		: describeIdentity(state.identity);
	return [
		`role:      ${role}`,
		`project:   ${state.project}`,
		`delivery:  ${delivery}`,
		`received:  ${state.received} message(s) this session`,
	].join("\n");
}

/**
 * The controller is created at `session_start`, not at extension load, so the
 * command takes a getter rather than an instance — a `/agmsg` typed before the
 * first session exists must say so instead of throwing.
 */
export type ControllerRef = () => AgmsgController | null;

export function registerAgmsgCommands(pi: ExtensionAPI, ref: ControllerRef): void {
	pi.registerCommand("agmsg", {
		description: "agmsg: status, inbox, team, send, join, actas, delivery mode",
		getArgumentCompletions: (prefix: string) => {
			const verbs = ["inbox", "team", "history", "send", "join", "actas", "mode", "restart"];
			const items = verbs.filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const controller = ref();
			if (!controller) {
				ctx.ui.notify("agmsg is not active in this session yet.", "warning");
				return;
			}

			const raw = args.trim();
			try {
				// actas and send take free text after their first argument — a spawn
				// task and a message body respectively — so they are matched before
				// the whitespace split the other verbs use. Splitting and re-joining
				// a message would silently collapse its newlines and indentation,
				// which is exactly what a pasted diff or stack trace consists of.
				const actas = /^actas(?:\s+(\S+)([\s\S]*))?$/.exec(raw);
				if (actas) {
					await runActas(pi, controller, ctx, actas[1], (actas[2] ?? "").trim());
					return;
				}

				const send = /^send(?:\s+(\S+)([\s\S]*))?$/.exec(raw);
				if (send) {
					const [, to, body = ""] = send;
					if (!to || !body.trim()) {
						ctx.ui.notify("usage: /agmsg send <to> <message>", "warning");
						return;
					}
					ctx.ui.notify(controller.send(to, body.trim()));
					return;
				}

				const [verb = "", ...rest] = raw.split(/\s+/).filter(Boolean);
				switch (verb) {
					case "":
					case "status":
						ctx.ui.notify(statusReport(controller));
						return;
					case "inbox":
						ctx.ui.notify(controller.inbox());
						return;
					case "team":
						ctx.ui.notify(controller.roster(rest[0]));
						return;
					case "history":
						ctx.ui.notify(controller.history(rest[0]));
						return;
					case "restart":
						controller.restartWatcher();
						ctx.ui.notify(statusReport(controller));
						return;
					case "join": {
						const [team, name] = rest;
						if (!team || !name) {
							ctx.ui.notify("usage: /agmsg join <team> <name>", "warning");
							return;
						}
						ctx.ui.notify(`${controller.join(team, name)}\n\n${statusReport(controller)}`);
						return;
					}
					case "mode": {
						const [mode] = rest;
						if (!mode || !isMode(mode)) {
							ctx.ui.notify("usage: /agmsg mode <monitor|turn|off>", "warning");
							return;
						}
						controller.setMode(mode);
						ctx.ui.notify(statusReport(controller));
						return;
					}
					default:
						ctx.ui.notify(`unknown: /agmsg ${verb}\n\n${USAGE}`, "warning");
				}
			} catch (err) {
				// agmsg's own message, verbatim. Rewriting it here would hide the
				// roster/lock detail that says what to do next.
				ctx.ui.notify((err as Error).message, "error");
			}
		},
	});
}

/**
 * Claim a role, then hand any spawn task to the model.
 *
 * A REFUSED CLAIM STOPS EVERYTHING. `held` means another live session is
 * already answering as this name; running the task anyway would produce a
 * second agent doing the same work under an identity it does not own. The task
 * is dropped and the reason is shown — a spawn that fails loudly costs one
 * restart, a spawn that proceeds costs a duplicated change.
 */
async function runActas(
	pi: ExtensionAPI,
	controller: AgmsgController,
	ctx: ExtensionCommandContext,
	name: string | undefined,
	task: string,
): Promise<void> {
	if (!name) {
		ctx.ui.notify("usage: /agmsg actas <name> [task]", "warning");
		return;
	}

	const result = controller.actas(name);
	if (result.status === "held") {
		ctx.ui.notify(
			`agmsg: "${name}" is already held by another live session${result.owner ? ` (${result.owner})` : ""}. ` +
				"Close that session or pick another name; nothing was claimed here.",
			"error",
		);
		return;
	}
	if (result.status === "not_registered") {
		ctx.ui.notify(`agmsg: "${name}" is not registered in this project. Run /agmsg join <team> ${name} first.`, "error");
		return;
	}

	ctx.ui.notify(statusReport(controller));
	// The task rides in as a user message so it starts a normal turn — the agent
	// then works with its role already claimed and its watcher already running.
	if (task) pi.sendUserMessage(task);
}
