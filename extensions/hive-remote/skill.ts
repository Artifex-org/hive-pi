/**
 * Skill activation — the durable signal that a skill was actually applied.
 *
 * Pi's command catalog (`getCommands`) is availability: every `/skill:name`
 * the session could invoke. Applying one is a different fact. Two producer
 * paths, both folded as a system notice with origin `skill`:
 *
 *   1. The `input` event, which fires BEFORE skill-command expansion, so
 *      `/skill:foo` is still visible. Browser steers only reach this when
 *      `sendUserMessage` opts into `expandPromptTemplates`.
 *   2. A `read` (or `artifact_read`) of a path that `getCommands` already
 *      named as that skill's `sourceInfo.path` — the automatic progressive-
 *      disclosure load. Filename guessing is refused: a SKILL.md the catalog
 *      does not own is an edit or an audit, not an activation.
 *
 * The notice text is the contract the Hive workspace parses. Keep the prefix
 * in step with `web/src/lib/skillActivation.ts`.
 */

export const SKILL_ACTIVATION_PREFIX = "skill activated · ";

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface SkillCommandInfo {
	name: string;
	source: string;
	sourceInfo?: { path?: string };
}

export function isSkillName(name: string): boolean {
	return SKILL_NAME.test(name);
}

export function stripSkillPrefix(name: string): string {
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

/**
 * Parse an input line that is a skill command (`/skill:name` or
 * `/skill:name args`). Returns null for anything else, including a skill
 * name that would not survive Pi's own frontmatter rules.
 */
export function parseSkillCommand(text: string): { name: string; args: string } | null {
	const line = text.trim().split("\n", 1)[0]?.trim() ?? "";
	const match = /^\/skill:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\s+(.*))?$/.exec(line);
	if (!match) return null;
	return { name: match[1], args: (match[2] ?? "").trim() };
}

export function skillActivationNotice(name: string): string {
	return `${SKILL_ACTIVATION_PREFIX}${name}`;
}

export function parseSkillActivation(text: string): string | null {
	if (!text.startsWith(SKILL_ACTIVATION_PREFIX)) return null;
	const name = text.slice(SKILL_ACTIVATION_PREFIX.length).trim().split(/\s/, 1)[0] ?? "";
	return isSkillName(name) ? name : null;
}

/**
 * Resolve `/skill:name` against the session catalog. An unknown name is not
 * an activation — factory sessions launch `--no-skills`, and a typo must not
 * mint a card.
 */
export function resolveSkillCommand(text: string, commands: readonly SkillCommandInfo[]): string | null {
	const parsed = parseSkillCommand(text);
	if (!parsed) return null;
	return catalogSkillName(parsed.name, commands);
}

/**
 * Map a read path onto a catalogued skill via `sourceInfo.path`.
 *
 * Exact match first; then one-side-relative (absolute vs cwd-relative) when
 * one path is a suffix of the other at a `/` boundary. A bare `SKILL.md`
 * never matches — that would claim every skill file the agent opened.
 */
/** Path argument of a progressive-disclosure read. Empty for any other tool. */
export function readPathOf(toolName: string, args: unknown): string {
	if (toolName !== "read" && toolName !== "artifact_read") return "";
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "ref"] as const) {
		const value = a[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

export function skillNameFromReadPath(path: string, commands: readonly SkillCommandInfo[]): string | null {
	const normalized = normalizePath(path);
	if (!normalized) return null;
	for (const command of commands) {
		if (!isSkillCommand(command)) continue;
		const listed = normalizePath(command.sourceInfo?.path ?? "");
		if (!listed) continue;
		if (listed === normalized || isPathSuffix(normalized, listed) || isPathSuffix(listed, normalized)) {
			return catalogSkillName(stripSkillPrefix(command.name), [command]);
		}
	}
	return null;
}

function isSkillCommand(command: SkillCommandInfo): boolean {
	return command.source === "skill" || command.name.startsWith("skill:");
}

function catalogSkillName(name: string, commands: readonly SkillCommandInfo[]): string | null {
	const bare = stripSkillPrefix(name);
	if (!isSkillName(bare)) return null;
	const want = `skill:${bare}`;
	for (const command of commands) {
		if (!isSkillCommand(command)) continue;
		if (command.name === want || command.name === bare || stripSkillPrefix(command.name) === bare) {
			return bare;
		}
	}
	return null;
}

function normalizePath(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function isPathSuffix(longer: string, shorter: string): boolean {
	if (!shorter.includes("/")) return false;
	return longer.length > shorter.length && longer.endsWith(`/${shorter}`);
}
