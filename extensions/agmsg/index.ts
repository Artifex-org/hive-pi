/**
 * agmsg — agent-to-agent messaging as a native capability of this harness.
 *
 * Other agent runtimes integrate agmsg by writing a rule file that asks the
 * model to poll an inbox after each tool call. pi does not have to: an
 * extension can push a message into a session that is sitting idle
 * (`sendMessage(..., { triggerTurn: true })`), which turns "check whether
 * anyone wrote" into "someone wrote". That is the whole reason this is an
 * extension and not a skill — and the reason a message reaches a pi agent
 * while it is waiting rather than at the end of its next turn.
 *
 * FOUR PARTS, each in its own file:
 *   message.ts     the watcher's line format, parsed  (pure)
 *   identity.ts    who this session is on the bus     (pure parse + one exec)
 *   watcher.ts     watch.sh as a supervised child     (process)
 *   controller.ts  identity × mode × watcher          (the state machine)
 * plus tools.ts (what the model calls) and commands.ts (what the human calls).
 *
 * THE MECHANICAL CONSTRAINT, inherited from every extension here: pi awaits
 * handlers serially, so a slow handler IS the agent loop. Every handler below
 * is synchronous and allocation-light; identity resolution, script calls and
 * process spawning happen on a detached timer.
 *
 * INERT WITHOUT AN INSTALL. No agmsg on the machine means no handlers, no
 * tools, no command — the factory returns before registering anything.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerAgmsgCommands } from "./commands.ts";
import { AgmsgController } from "./controller.ts";
import { formatInjection } from "./message.ts";
import { agmsgInstalled } from "./paths.ts";
import { registerAgmsgTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	if (!agmsgInstalled()) return;

	let controller: AgmsgController | null = null;
	/**
	 * The most recent ctx pi handed us. Held deliberately, and every use is
	 * guarded: after a session replacement the old ctx throws on ANY property
	 * access, and the watcher paints through this one from a child-process
	 * callback long after the emit that minted it returned.
	 */
	let latestCtx: ExtensionContext | null = null;

	const withCtx = (fn: (ctx: ExtensionContext) => void): void => {
		const ctx = latestCtx;
		if (!ctx) return;
		try {
			fn(ctx);
		} catch {
			// Stale ctx (session replaced mid-flight). The next session_start
			// installs a fresh one; dropping this paint is the correct outcome.
		}
	};

	/**
	 * Run blocking agmsg work off the handler path.
	 *
	 * `unref` so a pending timer never holds the process open at exit, and a
	 * try/catch because an exception thrown from a timer callback has no handler
	 * above it — it would take down pi, over a message that did not arrive.
	 */
	const detach = (fn: () => void): void => {
		const timer = setTimeout(() => {
			try {
				fn();
			} catch (err) {
				withCtx((ctx) => ctx.ui.notify(`agmsg: ${(err as Error).message}`, "error"));
			}
		}, 0);
		timer.unref?.();
	};

	const repaint = (): void => {
		const state = controller?.state();
		withCtx((ctx) => {
			if (!state?.role) {
				ctx.ui.setStatus("agmsg", undefined);
				return;
			}
			// ◉ receiving, ◌ monitor configured but the watcher is down (a claim
			// refused, a crashed watcher) — the distinction a user needs at a
			// glance, because both look identical from inside the conversation.
			const marker = state.mode === "monitor" ? (state.watching ? "◉" : "◌") : state.mode;
			const count = state.received > 0 ? ` ${state.received}✉` : "";
			ctx.ui.setStatus("agmsg", `${marker} ${state.role.agent}@${state.role.teams.join(",")}${count}`);
		});
	};

	// Tools and the command are registered unconditionally (given an install):
	// sending is useful in a project this session never joined — the role check
	// happens per call, with an error that says how to fix it.
	registerAgmsgTools(pi, { controller: () => controller });

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		controller?.stopWatcher();
		controller = new AgmsgController({
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId?.(),
			inject: (message) => {
				pi.sendMessage(
					{
						customType: "agmsg",
						content: formatInjection(message),
						display: true,
						details: { team: message.team, from: message.from, to: message.to, ts: message.ts },
					},
					// followUp, not steer: a message that arrives mid-tool-call waits
					// for the agent to finish what it was doing rather than cutting in
					// between a tool call and its result. triggerTurn is what makes an
					// IDLE session answer at all — without it the message sits unread
					// until the human types something.
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
			notify: (text) => withCtx((c) => c.ui.notify(text, "warning")),
			repaint,
		});
		const started = controller;
		detach(() => started.refresh());
	});

	// The identity line rides in the system prompt rather than in a message: it
	// is true for the whole session, and a per-turn injection would be both
	// repetitive and a cache miss on every turn.
	pi.on("before_agent_start", (event) => {
		const role = controller?.role();
		if (!role) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${identityPrompt(role.agent, role.teams)}` };
	});

	// Turn delivery: after the agent settles, ask agmsg whether anything is
	// waiting. check-inbox.sh owns the cooldown and stands down when a monitor
	// watcher is alive, so this cannot double-deliver.
	pi.on("agent_settled", () => {
		const active = controller;
		if (!active) return;
		detach(() => active.pollInbox());
	});

	pi.on("session_shutdown", () => {
		controller?.stopWatcher();
		withCtx((ctx) => ctx.ui.setStatus("agmsg", undefined));
	});

	registerAgmsgCommands(pi, () => controller);
}

/** The system-prompt paragraph. Exported so a test can assert what the model is told. */
export function identityPrompt(agent: string, teams: string[]): string {
	return [
		"<agmsg>",
		`You are reachable by other AI agents as "${agent}" on team ${teams.join(", ")}.`,
		"Incoming messages arrive as [agmsg] blocks. Answer them with agmsg_send — text you write",
		"outside a tool call reaches the user, not the sender. agmsg_team lists who is reachable.",
		"</agmsg>",
	].join("\n");
}
