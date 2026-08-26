/**
 * session-context — one-shot project context injection, bridged to the
 * Claude Code SessionStart hook (~/.claude/hooks/session-context.sh, the
 * single source of truth shared with Claude Code).
 *
 * The script detects the project from cwd and assembles: context packs,
 * the workspace-evaluation block (worktrees/PRs/agents),
 * knowledge prefetch, and KB pointers. It prints {continue, additionalContext}.
 *
 * Cache-stability contract (see KB infrastructure/harness/harness-engineering.md):
 *   - inject exactly ONCE, as a persistent message on the FIRST agent start
 *     of a fresh session ("startup" | "new") — never on resume/reload/fork,
 *     where the injection already lives in the session JSONL;
 *   - re-arm only after compaction (the summary may have squeezed it out);
 *   - never mutate the system prompt or inject per-turn.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { consumeHandoff } from "./agenda/handoff.ts";

const HOOK = join(process.env.HOME ?? "", ".claude/hooks/session-context.sh");
const HOOK_TIMEOUT_MS = 20_000;

function runSessionContext(cwd: string): Promise<string | null> {
	if (!existsSync(HOOK)) return Promise.resolve(null);
	return new Promise((resolve) => {
		const child = spawn("bash", [HOOK], { cwd, stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(null);
		}, HOOK_TIMEOUT_MS);
		child.stdout.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.on("close", () => {
			clearTimeout(timer);
			try {
				const parsed = JSON.parse(out) as { additionalContext?: string };
				resolve(parsed.additionalContext?.trim() ? parsed.additionalContext : null);
			} catch {
				resolve(null);
			}
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
	});
}

/**
 * Spawned workers set this. A worker runs one task in an isolated context and
 * then dies, so the interactive session's context pack — project facts,
 * worktree and PR state, KB pointers, all written for a session that will use
 * them across many turns — cannot pay for itself there.
 *
 * This is not a token nit. Every `pi -p --no-session` child reports
 * `reason:"startup"`, which is exactly what arms this extension, so EVERY
 * subagent and every `/goal` evaluator was paying it. Measured on this
 * workstation: 2,472 bytes (~620 tokens) injected per worker, plus ~510-645 ms
 * of hook wall-clock. The orchestrator multiplies that by the fan-out width —
 * a 12-way fan-out threw away ~7,400 tokens before any worker read its task.
 *
 * A worker that genuinely needs project context should be handed it in its task
 * prompt, chosen by the parent, rather than inheriting the whole pack.
 */
const IS_WORKER = process.env.PI_AGENDA_WORKER === "1";

export default function (pi: ExtensionAPI) {
	let armed = false;
	/**
	 * Separate from `armed`, deliberately: a handoff seed (`.pi/handoff.md`,
	 * written by `/handoff` — see agenda/handoff.ts) is consumed ONLY at a
	 * fresh session's first start. The compaction re-arm below must not eat a
	 * seed written mid-session for the NEXT one.
	 */
	let handoffArmed = false;
	let pending: Promise<string | null> | null = null;

	pi.on("session_start", (event, ctx) => {
		// Registered unconditionally and disabled INSIDE the handler: the factory
		// runs once at startup, so a registration gated on state could never be
		// un-gated later.
		if (IS_WORKER) return;
		// A new process opened with --session reports "startup", not "resume".
		// Inspect persisted entries as the source of truth so an existing session
		// never receives a duplicate injection.
		const alreadyInjected = ctx.sessionManager
			.getEntries()
			.some((entry) => entry.type === "custom_message" && entry.customType === "session-context");
		if ((event.reason === "startup" || event.reason === "new") && !alreadyInjected) {
			armed = true;
			handoffArmed = true;
			pending = runSessionContext(ctx.cwd); // start early, await at first prompt
		}
	});

	pi.on("session_compact", () => {
		if (IS_WORKER) return;
		// Compaction may have summarized the context away — re-inject fresh once.
		armed = true;
		pending = null;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (IS_WORKER || !armed) return;
		armed = false;
		const consumeSeed = handoffArmed;
		handoffArmed = false;
		let cwd: string;
		let mode: string;
		try {
			cwd = ctx.cwd;
			mode = ctx.mode;
		} catch {
			return;
		}
		const context = await (pending ?? runSessionContext(cwd));
		pending = null;
		// Interactive modes only: a stray scripted `pi -p` in this cwd must not
		// silently eat a handoff seed meant for the next real session.
		const handoff = consumeSeed && (mode === "tui" || mode === "rpc") ? consumeHandoff(cwd) : null;
		const parts = [context, handoff].filter((part): part is string => Boolean(part));
		if (parts.length === 0) return;
		return {
			message: {
				customType: "session-context",
				content: parts.join("\n\n"),
				display: false,
			},
		};
	});
}
