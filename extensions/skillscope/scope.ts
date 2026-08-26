/**
 * skillscope — resolving "may the model reach for this skill, here?"
 *
 * THE PROBLEM THIS EXISTS FOR. Our settings point pi at the entire Claude Code
 * skill library (`~/.claude/skills`) plus the hive-pi skills, in every project.
 * Every skill's `<description>` is in the system prompt of every session, so a
 * Aurora session pays attention-tax for `borealis-hedge-review`, and an Borealis
 * session for `sales-flow-walkthrough`. The skill list is global; the relevance
 * is per-project. This module is the per-project half.
 *
 * THREE SCOPES, chosen to match what pi can actually distinguish:
 *
 *   auto    the skill is advertised in the system prompt and the model may load
 *           it on its own. Today's behaviour, and the default.
 *   manual  not advertised; the model may not load it; `/skill:<name>` still
 *           works. This is pi's own `disable-model-invocation` frontmatter flag
 *           (see its `formatSkillsForPrompt`), lifted from per-file-forever to
 *           per-project.
 *   off     not advertised, and nothing under the skill directory may be read.
 *
 * Everything here is pure — no fs, no path existence checks, no clock. The pi
 * wiring lives in ./index.ts, which is what makes this file the one the tests
 * import.
 */

import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SkillScope = "auto" | "manual" | "off";

/**
 * The reserved key that sets the fallback for skills with no entry of their own.
 *
 * Config is a flat `{ "<skill-name>": "<scope>" }` map, so `default` costs us
 * the ability to scope a skill literally named "default". That is the trade the
 * flat shape buys: a config file you can read at a glance, with no nesting and
 * no schema version. A skill named `default` is hypothetical; a config nobody
 * can read is not.
 */
export const DEFAULT_KEY = "default";

/**
 * A parsed config. `bySkill` includes the reserved DEFAULT_KEY entry when the
 * file set one, which is what makes merging two files a plain per-key merge:
 * a project that overrides only the fallback overrides only the fallback.
 */
export interface ScopeConfig {
	readonly bySkill: ReadonlyMap<string, SkillScope>;
}

export const EMPTY_CONFIG: ScopeConfig = { bySkill: new Map() };

/** A skill, reduced to the fields this module needs. Mirrors pi's `Skill`. */
export interface SkillLike {
	readonly name: string;
}

/** A skill with the paths enforcement needs. Mirrors pi's `Skill`. */
export interface SkillPaths extends SkillLike {
	/** Absolute path of SKILL.md. */
	readonly filePath: string;
	/** Absolute path of the skill's directory. */
	readonly baseDir: string;
}

export function isScope(value: unknown): value is SkillScope {
	return value === "auto" || value === "manual" || value === "off";
}

/**
 * Parse a config file's contents, tolerantly.
 *
 * A malformed or absent config must mean "everything auto" — i.e. exactly
 * today's behaviour — because this extension is loaded in every session and a
 * config typo must not be able to hide a skill the user is relying on. So an
 * unrecognised value drops that ENTRY, never the whole file, and a non-object
 * yields the empty config rather than throwing.
 */
export function parseScopeConfig(raw: unknown): ScopeConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_CONFIG;
	const bySkill = new Map<string, SkillScope>();
	// Object.entries rather than `in`, so an inherited or `__proto__` key from a
	// hand-edited JSON file cannot become a scope.
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (key && isScope(value)) bySkill.set(key, value);
	}
	return { bySkill };
}

/** Whether anything is configured at all — the "changes nothing" fast path. */
export function isConfigured(config: ScopeConfig): boolean {
	return config.bySkill.size > 0;
}

/**
 * Merge configs, later wins per key.
 *
 * PROJECT OVERRIDES USER, per key rather than wholesale: a project that names
 * three skills does not discard the user's opinion about the other ninety.
 * Whether the project file is consulted at all is a TRUST decision, and it is
 * made in index.ts — this function has no way to know and no business deciding.
 */
export function mergeScopeConfigs(...configs: readonly ScopeConfig[]): ScopeConfig {
	const bySkill = new Map<string, SkillScope>();
	for (const config of configs) {
		for (const [name, scope] of config.bySkill) bySkill.set(name, scope);
	}
	return { bySkill };
}

/** The scope in force for `name`: explicit entry, then the file's `default`, then `auto`. */
export function resolveScope(name: string, config: ScopeConfig): SkillScope {
	return config.bySkill.get(name) ?? config.bySkill.get(DEFAULT_KEY) ?? "auto";
}

export interface SkillPartition<T extends SkillLike> {
	/** Advertised in the system prompt; the model may load them. */
	readonly auto: T[];
	/** Hidden from the prompt; reachable only through `/skill:<name>`. */
	readonly manual: T[];
	/** Hidden, and unreadable. */
	readonly off: T[];
}

/**
 * Split a skill list by resolved scope, preserving pi's load order within each
 * bucket so the prompt block we rebuild differs from pi's only by subtraction.
 */
export function partitionSkills<T extends SkillLike>(skills: readonly T[], config: ScopeConfig): SkillPartition<T> {
	const partition: SkillPartition<T> = { auto: [], manual: [], off: [] };
	for (const skill of skills) partition[resolveScope(skill.name, config)].push(skill);
	return partition;
}

/**
 * Replace pi's skills block inside an assembled system prompt.
 *
 * pi builds the prompt as `prompt += formatSkillsForPrompt(skills)` (verbatim,
 * see its `buildSystemPrompt`), so re-formatting the same list reproduces the
 * block exactly and an indexOf/splice is precise. Rebuilding the whole prompt
 * from `systemPromptOptions` was the alternative and is worse: `buildSystemPrompt`
 * is not root-exported, and rebuilding would discard whatever an earlier
 * `before_agent_start` handler had already spliced in.
 *
 * TWO DEGENERATE CASES, both of which must be no-ops rather than edits:
 *
 * - `oldBlock === ""` — `String.replace("")` INSERTS at index 0, so the naive
 *   version corrupts the prompt precisely when there was nothing to remove.
 * - block not found — pi changed its formatting, or another extension rewrote
 *   that region. Leaving the prompt untouched degrades to "scoping is not
 *   applied", which the `/skills` command can then report honestly. Editing on
 *   a guess would not be recoverable.
 */
export function swapSkillsBlock(prompt: string, oldBlock: string, newBlock: string): string {
	if (!oldBlock || oldBlock === newBlock) return prompt;
	const at = prompt.indexOf(oldBlock);
	if (at < 0) return prompt;
	return prompt.slice(0, at) + newBlock + prompt.slice(at + oldBlock.length);
}

/**
 * Whether `target` is `dir` itself or lies beneath it.
 *
 * Via `relative`, NOT `startsWith`: `/skills/foo` is a string prefix of
 * `/skills/foobar`, so the obvious version blocks reads of an unrelated
 * sibling skill. Both paths are resolved but never realpath'd — this module
 * does no I/O, so a symlink into a skill directory is not detected. That is a
 * documented limit of the read block, not an oversight; see the README.
 */
export function isInsideDir(dir: string, target: string): boolean {
	const rel = relative(resolve(dir), resolve(target));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface BlockedRead<T extends SkillPaths> {
	readonly skill: T;
	readonly scope: "manual" | "off";
}

/** pi's `UNICODE_SPACES` (utils/paths.js), copied so normalization matches byte for byte. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolve a read-tool `path` argument the way pi's read tool will.
 *
 * THIS IS LOAD-BEARING, not tidiness. `tool_call` fires with the model's RAW
 * arguments (`agent-session.js` passes `input: args` straight through), and pi's
 * read tool only normalizes afterwards, via `resolveToCwd` →
 * `normalizePath(input, { normalizeUnicodeSpaces: true, stripAtPrefix: true })`
 * with `expandTilde` defaulting to TRUE. A plain `path.resolve(cwd, "~/x")`
 * yields `<cwd>/~/x`, which matches no skill — so a model asking for
 * `~/.claude/skills/<name>/SKILL.md`, the most natural spelling for a
 * home-directory skill library, would sail straight past the block while pi
 * happily opened the file.
 *
 * Mirrors pi's order exactly: unicode spaces, then `@` prefix, then `~`, then
 * `file://`. `fileURLToPath` is a pure string function, but it throws on a
 * malformed URL — and a `tool_call` handler that throws makes pi abort the whole
 * turn ("Extension failed, blocking execution"), so a bad URL falls back to the
 * literal string instead. Windows shell-path normalization is not mirrored; this
 * repo's pi runs on Linux, and the cost of guessing wrong there is a missed
 * block, not a broken read.
 */
export function normalizeReadPath(requestedPath: string, cwd: string, homeDir: string): string {
	let normalized = requestedPath.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") normalized = homeDir;
	else if (normalized.startsWith("~/")) normalized = join(homeDir, normalized.slice(2));
	else if (/^file:\/\//.test(normalized)) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			/* not a usable file URL; pi's read will fail on it too */
		}
	}
	return resolve(cwd, normalized);
}

/**
 * Whether this skill OWNS its `baseDir`, and may therefore have the whole
 * directory blocked on its behalf.
 *
 * pi sets `baseDir = dirname(filePath)` for every skill, but it discovers skills
 * two ways (`loadSkillsFromDir`): a directory containing SKILL.md is a skill root
 * and is NOT recursed into — so that skill is alone in its directory — while a
 * loose `foo.md` sitting directly in a skills directory is ALSO a skill, and its
 * `baseDir` is the shared library directory it sits in, alongside every sibling
 * skill. Blocking a directory on behalf of the second kind would scope one skill
 * `off` and silently take the entire library with it.
 *
 * The `SKILL.md` filename is exactly pi's own discriminator, so this is not a
 * heuristic. Residual edge, accepted: a `skillPaths` entry aimed directly at a
 * `SKILL.md` in a repo root gives that skill the repo root as `baseDir`, and
 * `off` then blocks the repo. That follows pi's own reading of `baseDir` — it
 * tells the model "References are relative to ${skill.baseDir}" — so the skill
 * really does claim that tree.
 */
function ownsBaseDir(skill: SkillPaths): boolean {
	return basename(skill.filePath) === "SKILL.md";
}

/**
 * Decide whether a `read` of `requestedPath` must be blocked.
 *
 * THE ASYMMETRY IS THE WHOLE DESIGN, and it took walking the user's flow to see:
 *
 * - `manual` blocks SKILL.md ALONE. Auto-selection works by the model reading
 *   SKILL.md — pi's prompt block says so in as many words ("Use the read tool to
 *   load a skill's file when the task matches its description") — so blocking
 *   that one file blocks exactly the bypass. Blocking the whole directory would
 *   break the skill for the user who invoked it deliberately: `/skill:<name>`
 *   injects SKILL.md, whose whole point is to then send the model to
 *   `references/*.md` and `scripts/`. Those reads are model-initiated and must
 *   go through.
 * - `off` blocks the directory — but ONLY when the skill owns that directory
 *   (see `ownsBaseDir`). Nothing there is wanted in this project, and there is
 *   no legitimate invocation left to protect. For a loose `foo.md` skill, whose
 *   `baseDir` is the shared library directory, `off` blocks that one file: the
 *   alternative is scoping one skill off and taking every sibling with it.
 *
 * `cwd` and `homeDir` resolve the path exactly as pi's read tool will — see
 * `normalizeReadPath`, without which `~/...` walks straight past the block.
 */
export function blockedSkillRead<T extends SkillPaths>(
	requestedPath: string,
	cwd: string,
	homeDir: string,
	manual: readonly T[],
	off: readonly T[],
): BlockedRead<T> | undefined {
	if (!requestedPath) return undefined;
	const target = normalizeReadPath(requestedPath, cwd, homeDir);
	for (const skill of manual) {
		if (resolve(skill.filePath) === target) return { skill, scope: "manual" };
	}
	for (const skill of off) {
		if (resolve(skill.filePath) === target) return { skill, scope: "off" };
		if (ownsBaseDir(skill) && isInsideDir(skill.baseDir, target)) return { skill, scope: "off" };
	}
	return undefined;
}

/** Why a read was refused, in the terms the model needs to not retry it. */
export function blockedReadReason(blocked: BlockedRead<SkillPaths>): string {
	return blocked.scope === "manual"
		? `The "${blocked.skill.name}" skill is scoped MANUAL in this project: it is not yours to select. ` +
				`If it is genuinely what this task needs, say so and let the user run \`/skill:${blocked.skill.name}\`.`
		: `The "${blocked.skill.name}" skill is scoped OFF in this project. Its files are not available. ` +
				`Solve the task without it, or ask the user to re-scope it in skill-scope.json.`;
}

/** One `/skills` row per skill, load order preserved, so the report is inspectable. */
export function describeScopes(skills: readonly SkillLike[], config: ScopeConfig): string[] {
	const width = skills.reduce((max, skill) => Math.max(max, skill.name.length), 0);
	return skills.map((skill) => `${skill.name.padEnd(width)}  ${resolveScope(skill.name, config)}`);
}
