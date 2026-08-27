/**
 * guards-bridge — bridges pi BASH calls to the Claude Code guard hook.
 *
 *   pre-bash-dispatch.sh  — kubectl --context, workmux add -C, raw
 *                           `git worktree add`, guarded-checkout file
 *                           mutations, --no-verify (ask)
 *
 * The edit guard is NO LONGER bridged: it lives in `guards-common/worktree-guard.ts`, native.
 * The old rule here said the bash scripts were the single source of truth and
 * must not be ported — but opencode had already carried its own TypeScript port
 * for as long as it has had plugins, and the bridge failed OPEN wherever
 * `~/.claude/hooks` does not exist. hive-pi is a package: the Hive Code Factory
 * and the Aurora in-app agent install it into containers with no `~/.claude` at
 * all, where a bridged guard reported healthy and enforced nothing.
 *
 * `pre-bash-dispatch.sh` stays bridged deliberately. It encodes machine-specific
 * policy (which kubectl contexts exist, which checkouts are guarded, workmux
 * invocation shapes) that has no meaning inside a factory container, so failing
 * open there is the CORRECT behaviour rather than a gap. Porting it would drag
 * workstation facts into a shared package.
 *
 * Contract: hook gets Claude-hook JSON on stdin, answers on stdout with
 *   {decision:"block", reason} | {decision:"ask", message}
 *   | {hookSpecificOutput:{permissionDecision:"deny", permissionDecisionReason}}
 * or nothing (allow). Non-zero exit / bad JSON → fail-open (Claude parity).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decide, realProbe } from "./guards-common/worktree-guard.ts";
import { ghBodyVerdict } from "./guards-common/gh-body-guard.ts";
import { appendHint } from "./toolhints/index.ts";

/** Matches toolhints' and toolcwd's tag: one way of speaking as the harness. */
const GUARD_NOTE_TAG = "harness";

/**
 * A guard note waiting to be attached to the next tool result, and the set of
 * notes already delivered this session.
 *
 * Module state rather than a parameter because the decision happens in
 * `tool_call` and the only place to say it is `tool_result`. The queue holds at
 * most one: a second edit before the first result would drop an older note, and
 * dropping a duplicate of a once-per-session message costs nothing.
 */
let pendingGuardNote: string | null = null;
const deliveredGuardNotes = new Set<string>();

function queueGuardNote(note: string): void {
	if (deliveredGuardNotes.has(note)) return;
	deliveredGuardNotes.add(note);
	pendingGuardNote = note;
}

function takeGuardNote(): string | null {
	const note = pendingGuardNote;
	pendingGuardNote = null;
	return note;
}

const HOOKS_DIR = join(process.env.HOME ?? "", ".claude/hooks");
const BASH_HOOK = join(HOOKS_DIR, "pre-bash-dispatch.sh");
const HOOK_TIMEOUT_MS = 10_000;

/**
 * Every tool that runs a shell command, by name.
 *
 * This is a SET rather than a string comparison because the single comparison
 * it replaced was a live bypass. The guard matched `toolName === "bash"`
 * exactly, so `background/`'s `background_bash` — same shell, same `command`
 * parameter, same power — would have executed with no guard at all. A new tool
 * escaping an existing guard by being new is precisely the failure class wave 5
 * exists to remove, and the fix belongs here rather than in a second copy of
 * the hook call inside the new extension.
 *
 * A tool added to this set must take its command in a `command` parameter.
 * `test/guard-bypass-audit.test.ts` fails when a registered tool spawns a shell
 * and is not listed.
 */
export const SHELL_TOOLS = new Set(["bash", "background_bash"]);

interface HookVerdict {
	decision?: "block" | "ask" | string;
	reason?: string;
	message?: string;
	hookSpecificOutput?: {
		permissionDecision?: string;
		permissionDecisionReason?: string;
	};
}

/**
 * Fail-open is deliberate (Claude parity), but the five ways it happens are not
 * equally expected, and until now they were indistinguishable.
 *
 * ABSENT is normal: `~/.claude/hooks/` does not exist in a container, which is
 * every factory job. Silence there is correct — logging it would be noise on
 * every tool call.
 *
 * ERRORED, TIMED OUT and UNPARSEABLE are not normal. Each means the guard was
 * meant to run and did not, and each currently looks exactly like "allowed".
 * That is the quiet-failure shape this wave exists to remove, so they say so
 * once per session — once, because a broken hook would otherwise print on every
 * bash call and train the reader to ignore it.
 */
const warnedHookFailures = new Set<string>();

function warnOnce(kind: string, detail: string): void {
	if (warnedHookFailures.has(kind)) return;
	warnedHookFailures.add(kind);
	console.warn(
		`guards-bridge: the guard hook ${detail}. Commands are being ALLOWED without it. ` +
			`This is different from the hook simply not being installed (containers), which is silent by design.`,
	);
}

function runHook(script: string, payload: Record<string, unknown>): HookVerdict | null {
	// Not installed — the expected case off a workstation. Silent.
	if (!existsSync(script)) return null;
	const res = spawnSync("bash", [script], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		cwd: process.cwd(),
		timeout: HOOK_TIMEOUT_MS,
	});
	if (res.error) {
		warnOnce("spawn", `could not be run (${res.error.name})`);
		return null;
	}
	if (res.status !== 0) {
		// spawnSync reports a timeout kill as a signal, not an error.
		warnOnce("exit", res.signal ? `was killed (${res.signal}) — likely the ${HOOK_TIMEOUT_MS}ms timeout` : `exited ${res.status}`);
		return null;
	}
	const out = (res.stdout ?? "").trim();
	if (!out) {
		warnOnce("empty", "returned no output");
		return null;
	}
	try {
		return JSON.parse(out) as HookVerdict;
	} catch {
		warnOnce("json", "returned output that is not JSON");
		return null;
	}
}

/** Normalize both hook output shapes to a single verdict. */
function interpret(v: HookVerdict | null): { kind: "allow" } | { kind: "block"; reason: string } | { kind: "ask"; message: string } {
	if (!v) return { kind: "allow" };
	if (v.decision === "block") return { kind: "block", reason: v.reason ?? "Blocked by guard hook" };
	if (v.decision === "ask") return { kind: "ask", message: v.message ?? v.reason ?? "Guard hook requests confirmation" };
	if (v.hookSpecificOutput?.permissionDecision === "deny") {
		return { kind: "block", reason: v.hookSpecificOutput.permissionDecisionReason ?? "Blocked by worktree guard" };
	}
	return { kind: "allow" };
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (SHELL_TOOLS.has(event.toolName)) {
			const input = event.input as { command?: string };
			if (!input.command) return;
			// Native, and BEFORE the bridge: this one is about the command text
			// alone, so it holds in a factory container where `~/.claude` — and
			// therefore the bridged hook — does not exist.
			const ghBody = ghBodyVerdict(input.command);
			if (ghBody.kind === "block") return { block: true, reason: ghBody.reason };
			const verdict = interpret(
				runHook(BASH_HOOK, { tool_name: "Bash", tool_input: { command: input.command } }),
			);
			if (verdict.kind === "block") return { block: true, reason: verdict.reason };
			if (verdict.kind === "ask") {
				let ok = false;
				try {
					ok = await ctx.ui.confirm("Guard hook", verdict.message);
				} catch {
					ok = false; // headless / no UI → conservative
				}
				// TERMINATE (pi 0.84.1): a human said no, so there is nothing for the
				// model to work out. Without this the block costs a follow-up model
				// call whose only possible useful output is "understood" — and whose
				// likelier output is a workaround for the thing that was just
				// refused, which is the worst response available to a denial.
				//
				// Deliberately NOT applied to the guard-hook blocks below. Those
				// carry actionable remediation ("use `git -C /abs/worktree`", "use a
				// Monitor until-loop"), and the follow-up turn is where the agent
				// retries correctly and finishes the task. Terminating there would
				// convert a recoverable misstep into an abandoned task — spending the
				// saved call many times over. `terminate` is for "stop", not for
				// "that was wrong"; upstream only honours it when EVERY finalized
				// result in the batch sets it, so this stays conservative by
				// construction.
				if (!ok) return { block: true, terminate: true, reason: `User declined: ${verdict.message}` };
			}
			return;
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const input = event.input as { path?: string; file_path?: string };
			const verdict = decide(input.path ?? input.file_path, event.toolName === "edit" ? "Edit" : "Write", realProbe);
			if (verdict.kind === "block") return { block: true, reason: verdict.reason };
			// An allow that has something to say. A `note` nobody reads is a field
			// that documents itself and informs no one, so it is queued here and
			// appended to this edit's own result below.
			if (verdict.kind === "allow" && verdict.note) queueGuardNote(verdict.note);
		}
	});

	// Deliver a queued guard note on the next tool result.
	//
	// ONCE PER SESSION PER TEXT: the condition is a property of the checkout, not
	// of the edit, so repeating it on every write in that directory would be pure
	// noise — and noise is how a real warning stops being read.
	pi.on("tool_result", (event) => {
		const note = takeGuardNote();
		if (!note) return;
		return { content: appendHint(event.content, `\n\n[${GUARD_NOTE_TAG}] ${note}`) };
	});

	// `!` / `!!` user commands get the same bash checks (kubectl context etc.).
	pi.on("user_bash", (event) => {
		const verdict = interpret(
			runHook(BASH_HOOK, { tool_name: "Bash", tool_input: { command: event.command } }),
		);
		if (verdict.kind === "block") {
			return {
				result: {
					output: `guard hook blocked this command:\n${verdict.reason}`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}
		// "ask" is not blocking for user-typed commands — the human typed it.
		return;
	});
}
