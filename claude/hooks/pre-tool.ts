/**
 * PreToolUse — op-mode enforcement and the worktree guard. Synchronous, no
 * model calls, no network: it sits in front of every tool call.
 *
 * Both answers come from hive-pi's own policy, applied to Claude's tool names
 * mapped onto pi's:
 *   - discuss / plan / orchestrate: `opmode/verdict.ts` and the plan
 *     extension's `planToolVerdict` — the same refusal text a pi session reads;
 *   - the worktree guard: `guards-common/worktree-guard.ts`'s `decide`, exactly
 *     as `guards-bridge.ts` calls it for pi's edit/write.
 *
 * In the read-only postures every tool is classified (see readOnlyDecision):
 * MCP tools by pi's MCP classifiers, Claude's read-only built-ins by name, and
 * anything unknown is denied, as pi denies it. Which tools reach this hook is
 * the plugin's PreToolUse matcher (README.md).
 *
 * Bugfix mode withholds the editors until the episode records a root cause
 * through the MCP tools `bugfix_evidence` → `bugfix_root_cause` (claude/bugfix.ts),
 * with opmode's refusal; Bash stays open, as in pi.
 *
 * The permission decision is only ever DENY or nothing: printing "allow"
 * would skip Claude's own permission prompt, which is not this hook's call.
 * Reviewed gateway calls may emit updatedInput to bind their dispatch identity
 * without granting permission or bypassing Claude's own checks.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { decide, realProbe } from "../../extensions/guards-common/worktree-guard.ts";
import { opModeShellVerdict, opModeToolVerdict } from "../../extensions/opmode/verdict.ts";
import { planToolVerdict } from "../../extensions/plan/policy.ts";
import { CLAUDE_BUGFIX_TOOLS } from "../bugfix.ts";
import type { Control } from "../state.ts";
import { denyToolUse, type HookInput, type HookOutput } from "./io.ts";

/** Claude's mutating tools and Bash, by pi's name for the same operation. */
export const CLAUDE_TO_PI_TOOL: Readonly<Record<string, string>> = {
	Edit: "edit",
	MultiEdit: "multiedit",
	Write: "write",
	NotebookEdit: "notebook_edit",
	Bash: "bash",
};

/** The file a Claude edit tool writes, as given. */
function editTarget(toolName: string, input: Record<string, unknown>): string | undefined {
	const raw = toolName === "NotebookEdit" ? input.notebook_path : input.file_path;
	return typeof raw === "string" && raw ? raw : undefined;
}

/** Claude's own file tools that may write its plan document. */
const PLAN_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** `realpath` of what exists, the lexical path of what does not yet. */
function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Is this Claude Code writing its OWN plan document — `<config dir>/plans/<name>.md`?
 *
 * Claude's native plan mode saves the plan there before ExitPlanMode presents
 * it; refusing that write leaves the approval UI with no plan and costs the
 * agent a turn. The exemption is that one directory of THIS session's config
 * dir (the launch's `HIVE_CLAUDE_CONFIG_DIR`, never the tool input), one level
 * deep, `.md` only — and judged where the bytes land: an existing symlinked
 * target, or a plans dir that resolves outside the config dir, is refused.
 */
export function isOwnPlanFile(claudeName: string, input: Record<string, unknown>, cwd: string | undefined, configDir: string | undefined): boolean {
	if (!configDir || !PLAN_FILE_TOOLS.has(claudeName)) return false;
	const target = editTarget(claudeName, input);
	if (!target) return false;
	const path = isAbsolute(target) ? resolve(target) : cwd ? resolve(cwd, target) : undefined;
	const plans = join(resolve(configDir), "plans");
	if (!path || dirname(path) !== plans || !path.endsWith(".md")) return false;
	if (existsSync(plans) && realpathSync(plans) !== join(realOrSelf(resolve(configDir)), "plans")) return false;
	try {
		if (!lstatSync(path).isFile()) return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
	}
	return true;
}

/** The adapter's own MCP server: its tools are pi's tools under Claude's MCP names. */
const OWN_MCP_PREFIX = "mcp__hive-pi__";

/**
 * Claude built-ins that read, plan or ask, and change nothing — allowed in the
 * read-only postures by name. `Task*` (Claude's own subagents and task list)
 * passes because every tool call those subagents make comes back through this
 * same hook.
 */
const CLAUDE_READ_ONLY = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "TodoWrite", "TodoRead", "ExitPlanMode", "AskUserQuestion"]);

function claudeReadOnly(name: string): boolean {
	return CLAUDE_READ_ONLY.has(name) || name.startsWith("Task");
}

type ReadOnlyMode = "plan" | "discuss" | "orchestrate";

/** pi's verdict for one tool, by pi's name, in a read-only posture. */
function readOnlyVerdict(mode: ReadOnlyMode, piName: string, input: Record<string, unknown>) {
	if (mode === "plan") return planToolVerdict(piName, input);
	const tool = opModeToolVerdict(mode, piName, input, false);
	if (!tool.allowed || piName !== "bash") return tool;
	const command = typeof input.command === "string" ? input.command : "";
	return opModeShellVerdict(mode, command);
}

/**
 * The read-only postures over Claude's WHOLE tool vocabulary, not only the
 * mutating five: pi's posture denies what it does not know to be read-only,
 * and an MCP tool can write as surely as Edit can.
 *   - Edit/MultiEdit/Write/NotebookEdit/Bash: pi's own names, pi's verdict.
 *   - this server's tools (`mcp__hive-pi__subagent`, …): pi's names for them.
 *   - any other `mcp__<server>__<tool>`: pi's MCP classifiers (they
 *     canonicalise the name), so a reviewed read-only card passes and an
 *     unreviewed or mutating tool is denied.
 *   - Claude's read-only built-ins: allowed by name.
 *   - anything else: denied, as pi denies an unknown tool.
 */
function readOnlyDecision(mode: ReadOnlyMode, claudeName: string, input: Record<string, unknown>): HookOutput {
	const mapped = CLAUDE_TO_PI_TOOL[claudeName];
	if (mapped) {
		const verdict = readOnlyVerdict(mode, mapped, input);
		return verdict.allowed ? null : denyToolUse(verdict.reason);
	}
	if (claudeName.startsWith(OWN_MCP_PREFIX) || claudeName.startsWith("mcp__")) {
		const piName = claudeName.startsWith(OWN_MCP_PREFIX) ? claudeName.slice(OWN_MCP_PREFIX.length) : claudeName;
		const verdict = readOnlyVerdict(mode, piName, input);
		if (!verdict.allowed) return denyToolUse(verdict.reason);
		return verdict.updatedInput
			? { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: verdict.updatedInput } }
			: null;
	}
	if (claudeReadOnly(claudeName)) return null;
	return denyToolUse(
		`\`${claudeName}\` is not a tool ${mode} mode knows to be read-only, so it is denied rather than assumed safe. ` +
			"Ask the user to switch the session to build mode if it is needed.",
	);
}

/**
 * `configDir` is the launch's Claude config dir, which holds this session's
 * plan documents (isOwnPlanFile).
 *
 * `rootCauseRecorded` is the bugfix gate's key (claude/bugfix.ts): until the
 * episode records a root cause, bugfix mode denies the file-mutating tools
 * with opmode's own refusal, naming the tools by their Claude names.
 */
export function preToolDecision(input: HookInput, control: Control, rootCauseRecorded = false, configDir?: string): HookOutput {
	const claudeName = input.tool_name ?? "";
	const toolInput = input.tool_input ?? {};
	const mode = control.opMode;
	// Claude's plan document is the plan mode's own output, not a change to the
	// work: no decision, so Claude's own permission check still applies.
	if (mode === "plan" && isOwnPlanFile(claudeName, toolInput, input.cwd, configDir)) return null;
	if (mode === "plan" || mode === "discuss" || mode === "orchestrate") {
		const decision = readOnlyDecision(mode, claudeName, toolInput);
		if (decision) return decision;
	}

	const piName = CLAUDE_TO_PI_TOOL[claudeName];
	if (!piName) return null;
	if (mode === "bugfix") {
		// Bash stays open, exactly as pi leaves it: the investigation IS the
		// work — repros, instruments, the failing test (opmode/modes.ts,
		// BUGFIX_WITHHELD_TOOLS). Only the file editors wait for a root cause.
		const verdict = opModeToolVerdict(mode, piName, toolInput, rootCauseRecorded, CLAUDE_BUGFIX_TOOLS);
		if (!verdict.allowed) return denyToolUse(verdict.reason);
	}

	if (piName !== "bash") {
		const target = editTarget(claudeName, toolInput);
		const path = target && !isAbsolute(target) && input.cwd ? resolve(input.cwd, target) : target;
		const verdict = decide(path, claudeName === "Write" ? "Write" : "Edit", realProbe);
		if (verdict.kind === "block") return denyToolUse(verdict.reason);
	}
	return null;
}
