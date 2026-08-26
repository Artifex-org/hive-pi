/**
 * brief — what to enrich, and what to leave alone.
 *
 * Every function here is pure and every rule is a real failure mode rather than
 * defensive padding. The expensive mistakes this module exists to prevent:
 *
 *  - Enriching an already-compiled brief. A launched teammate's prompt is
 *    written by an orchestrator following "the prompt must stand alone", and
 *    re-compiling one produces a brief of a brief.
 *  - Rewriting the TEAM PROTOCOL block Hive appends server-side
 *    (`internal/mcp/agentops_launch_protocol.go`). That block is a contract with
 *    the controlling session — four moments a teammate must report — not prose
 *    to be tightened. It is split off before the worker sees the task and put
 *    back verbatim afterwards.
 *  - Firing inside a worker. Subagent workers spawn with `--no-extensions`, but
 *    `runRoleAgent` does not, and an extension that enriches its own worker's
 *    task recurses until something runs out.
 */

/** Stamped into every compiled brief; seeing it again means "already done". */
export const BRIEF_MARKER = "<!-- brief:v1";

/**
 * The headings Hive prepends to the block it appends to a launched agent's
 * prompt. Matched on the stable prefix rather than the whole sentence so a
 * wording change on the server does not silently turn the protocol into
 * enrichable prose.
 *
 * THERE ARE TWO, and knowing only one is worse than knowing neither, because
 * the failure is silent in exactly the case that matters most. `internal/mcp/
 * agentops_launch_protocol.go` emits the TEAM variant for a launch that joins a
 * team and the BIGGER-THAN-ONE-AGENT variant for a solo launch — and solo is
 * the common case. With only the team heading listed, `splitTeamProtocol`
 * returned a solo launch's ENTIRE prompt as `task`, `protocol` came back empty,
 * and every rule below that keys on "was this prompt machine-appended to"
 * quietly did not apply to most launches (HIV-2530).
 *
 * Measured 2026-08-22 on Aurora launch 8ae46e84: the prompt carried
 * "IF THIS TURNS OUT TO BE BIGGER THAN ONE AGENT (added by Hive)" and was
 * treated as hand-typed prose throughout.
 */
const HIVE_PROTOCOL_HEADINGS = [
	"TEAM PROTOCOL (added by Hive",
	"IF THIS TURNS OUT TO BE BIGGER THAN ONE AGENT (added by Hive",
] as const;

/** Ticket keys worth a Linear lookup. Deliberately our three teams only. */
const TICKET_KEY = /\b(?:TES|ASF|HIV)-\d+\b/g;

/** The end-of-prompt opt-in marker, pi-clarify's `-clarify` shape. */
const INLINE_MARKER = /\s*-brief\s*$/;

export interface SplitPrompt {
	/** The part a briefer may read and restate. */
	task: string;
	/** The appended contract, verbatim, or "" when there was none. */
	protocol: string;
}

/**
 * Separate the caller's task from any machine-appended protocol block.
 *
 * The split is on the heading, not on the `---` rule, because a task may
 * legitimately contain horizontal rules and losing half a task to one would be
 * silent.
 */
export function splitTeamProtocol(prompt: string): SplitPrompt {
	// The EARLIEST heading present wins. A prompt carrying more than one block
	// must not be split at the second, which would leave the first appended to
	// the task and hand it to a briefer as prose.
	let at = -1;
	for (const heading of HIVE_PROTOCOL_HEADINGS) {
		const i = prompt.indexOf(heading);
		if (i >= 0 && (at < 0 || i < at)) at = i;
	}
	if (at < 0) return { task: prompt, protocol: "" };

	// Reattach the `---` rule and blank lines that introduce the block, so the
	// protocol goes back exactly as it arrived.
	let start = at;
	const preamble = prompt.slice(0, at);
	const rule = preamble.lastIndexOf("---");
	if (rule >= 0 && preamble.slice(rule + 3).trim() === "") start = rule;

	// Neither side is trimmed: the split must be LOSSLESS, so `task + protocol`
	// reconstructs the prompt byte for byte and the protocol goes back exactly as
	// the server wrote it. Consumers trim their own copy.
	return { task: prompt.slice(0, start), protocol: prompt.slice(start) };
}

/** Ticket keys named in the prompt, deduped, in first-seen order. */
export function ticketKeys(prompt: string): string[] {
	return Array.from(new Set(prompt.match(TICKET_KEY) ?? []));
}

/** Strip a trailing `-brief`, reporting whether it was there. */
export function stripInlineMarker(text: string): { text: string; marked: boolean } {
	const stripped = text.replace(INLINE_MARKER, "");
	return { text: stripped, marked: stripped !== text };
}

/**
 * Is this prompt worth a retrieval pass?
 *
 * Deliberately a local heuristic rather than a call out to
 * `~/.claude/hooks/kb-task-nudge.sh` (which `kb-nudge.ts` shares with Claude
 * Code). Two reasons: that hook answers a different question — "would a KB
 * library hint help here" — and it is a subprocess on a path that already
 * blocks the agent's first turn. Keeping it local also makes it testable, which
 * matters more than a shared definition for a gate this cheap.
 *
 * The bar is low on purpose. A false positive costs one cheap worker; a false
 * negative costs the whole feature on the prompt that needed it most.
 */
export function looksTaskLike(prompt: string, minChars: number): boolean {
	const text = prompt.trim();
	if (text.length < minChars) return false;
	// A slash command or a `!` shell escape is already a specific instruction.
	if (text.startsWith("/") || text.startsWith("!")) return false;
	if (ticketKeys(text).length > 0) return true;
	// A path or a filename anywhere is a strong signal of repo work.
	if (/[\w/-]+\.(ts|tsx|js|go|py|star|md|json|ya?ml|sql|sh)\b/.test(text)) return true;
	return TASK_VERB.test(text);
}

/**
 * Verbs that mean "do something to this codebase". Word-anchored so `fixture`
 * does not read as `fix`, and case-insensitive because a prompt is typed, not
 * composed.
 */
const TASK_VERB =
	/\b(add|build|change|check|convert|debug|delete|deploy|diagnose|document|extend|find|fix|implement|improve|investigate|migrate|move|port|refactor|remove|rename|replace|review|rewrite|ship|test|trace|triage|update|upgrade|why|wire)\b/i;

/**
 * The steady-state suppression: every turn after the first reports it.
 *
 * A named constant because the caller MATCHES on it — it is the one reason not
 * worth recording, since logging it once per turn would bury the reasons that
 * mean something. A drifting string literal would silently restore the spam.
 */
export const ALREADY_BRIEFED = "already briefed this session";

export interface SuppressionInput {
	prompt: string;
	minPromptChars: number;
	alreadyBriefed: boolean;
	env: NodeJS.ProcessEnv;
}

/**
 * Why this prompt should NOT be auto-enriched, or null to proceed.
 *
 * Returns a reason string rather than a boolean so the decision is loggable —
 * "the brief did not fire" is otherwise indistinguishable from "the brief
 * failed", and those want different fixes.
 */
export function suppressionReason(input: SuppressionInput): string | null {
	if (isWorkerProcess(input.env)) return "running inside a worker";
	if (input.alreadyBriefed) return ALREADY_BRIEFED;
	if (input.prompt.includes(BRIEF_MARKER)) return "prompt is already a compiled brief";

	const { task } = splitTeamProtocol(input.prompt);
	if (!task.trim()) return "prompt is protocol only";
	if (!looksTaskLike(task, input.minPromptChars)) return "prompt is not task-like";
	return null;
}

/**
 * Are we the child of a delegation rather than an interactive session?
 *
 * `PI_AGENDA_WORKER` is set by `subagent/index.ts` and the agenda executor;
 * `PI_BRIEF_WORKER` is this extension's own, set on the briefer it spawns, so
 * the recursion is cut even if the worker somehow loads extensions.
 */
export function isWorkerProcess(env: NodeJS.ProcessEnv): boolean {
	return env.PI_AGENDA_WORKER === "1" || env.PI_BRIEF_WORKER === "1";
}
