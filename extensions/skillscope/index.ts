/**
 * skillscope — per-skill, per-project scoping for a global skill library.
 *
 * See ./scope.ts for the problem and the three scopes. This file is the pi
 * wiring, and what it can and cannot do was decided by pi 0.84.1's actual
 * extension surface, not by what would have been convenient:
 *
 * THERE IS NO SKILL-FILTERING API. `ExtensionAPI` has `getActiveTools` /
 * `setActiveTools` for tools and nothing at all for skills; `resources_discover`
 * can only ADD `skillPaths`. So the tool-gating shape cannot be copied
 * directly — but its LESSON transfers exactly (extensions/plan/policy.ts): the
 * prompt is advisory, the call is where enforcement happens. Here that is:
 *
 *   ADVISORY   `before_agent_start` hands us `systemPromptOptions.skills` (the
 *              full loaded list) and lets us return a replacement systemPrompt.
 *              pi appends the skills block verbatim as
 *              `formatSkillsForPrompt(skills)`, so re-formatting the auto subset
 *              and splicing it over the original removes the descriptions of
 *              everything else from the prompt. That is the attention saving —
 *              the actual point of the feature.
 *
 *   ENFORCEMENT `tool_call` on `read`. The prompt block tells the model to
 *              auto-select a skill BY READING ITS SKILL.md, so refusing that one
 *              read is refusing auto-selection. Needed because the advisory half
 *              is only a prompt: a model that saw a skill described in an
 *              earlier turn, or in its own compacted summary, can still name the
 *              path.
 *
 * NOT ENFORCEABLE, and the README says so plainly: `/skill:<name>` typed by the
 * user. pi expands it inside `agent-session` before any event we can see, and it
 * never touches the read tool. A user's explicit invocation therefore wins over
 * `off`. `bash cat <skill>` is likewise not covered — this gates the documented
 * selection path, it is not a sandbox.
 *
 * HANDLERS ARE REGISTERED UNCONDITIONALLY and no-op on an empty config, per the
 * README idiom (the factory runs once, so an early `return` can never be undone
 * later — that shipped as a bug on 2026-08-05). narrate's conditional
 * registration is an exception justified by `context` being a transform pi skips
 * when unsubscribed; neither event used here is one of those.
 *
 * THE ONE MECHANICAL CONSTRAINT: pi awaits handlers serially. Both hot handlers
 * are a Map lookup and, at most, one `indexOf` over the system prompt; the
 * formatted blocks are computed once per skill-list identity and cached, so a
 * turn costs one string search and one splice. All file reads happen in the
 * factory, never in a handler.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { formatSkillsForPrompt, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";

import { configPathFor, readJSON } from "../hive-common/identity.ts";
import {
	blockedReadReason,
	blockedSkillRead,
	describeScopes,
	EMPTY_CONFIG,
	isConfigured,
	mergeScopeConfigs,
	parseScopeConfig,
	partitionSkills,
	swapSkillsBlock,
	type ScopeConfig,
	type SkillPartition,
} from "./scope.ts";

const CONFIG_NAME = "skill-scope";

/** Project-local config, alongside `.pi/skills/` and the other project resources pi reads. */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", `${CONFIG_NAME}.json`);
}

export interface ScopeSources {
	readonly user: ScopeConfig;
	readonly project: ScopeConfig;
	readonly userPath: string;
	readonly projectPath: string;
	/**
	 * Global kill switch, surfaced as the `per-skill scoping` row in `/toggles`.
	 *
	 * Defaults ON because absent config already means "everything auto" — i.e.
	 * enabled-with-no-entries is exactly today's behaviour, so the default
	 * changes nothing. Turning it OFF is the harder guarantee: it stops the
	 * prompt splice and the read block outright, without making you delete a
	 * config you spent time on.
	 *
	 * Safe to store in the same file as the scopes: `parseScopeConfig` only
	 * accepts keys whose value is a scope string, so a boolean here can never be
	 * mistaken for a skill named "enabled".
	 */
	readonly enabled: boolean;
}

/**
 * Both config files, read from disk. Blocking, and deliberately in the factory:
 * a config read from an event handler would be the agent loop.
 */
function loadSources(cwd: string): ScopeSources {
	const userPath = configPathFor(CONFIG_NAME);
	const projectPath = projectConfigPath(cwd);
	const userRaw = readJSON<Record<string, unknown>>(userPath);
	return {
		user: parseScopeConfig(userRaw),
		// Parsed eagerly, APPLIED only once the project is trusted (see below).
		// Parsing early keeps the trust check in `session_start` down to a boolean.
		project: existsSync(projectPath) ? parseScopeConfig(readJSON<unknown>(projectPath)) : EMPTY_CONFIG,
		userPath,
		projectPath,
		// Opt-out (`!== false`), read from the USER file only. A project must not
		// be able to switch scoping off for the whole session — that direction
		// weakens a control the user set, and the project file is already the
		// less-trusted of the two.
		enabled: userRaw?.enabled !== false,
	};
}

export default function (pi: ExtensionAPI) {
	wireSkillScope(pi, loadSources(process.cwd()));
}

/**
 * Exported so tests drive the real handlers with a synthetic config instead of
 * whatever happens to be in the developer's ~/.pi.
 */
export function wireSkillScope(pi: ExtensionAPI, sources: ScopeSources): void {
	// Kill switch first: registering nothing is the only honest "off". A
	// registered handler that early-returns still turns on the path it hangs
	// from, and here that path rewrites the system prompt.
	if (!sources.enabled) return;

	/**
	 * The user config alone until a `session_start` confirms project trust.
	 * FAIL-SAFE ORDER: a project file that widens a skill back to `auto` must not
	 * take effect in an untrusted checkout, and `session_start` is not guaranteed
	 * to have run before the first prompt in every mode. Starting from the user's
	 * own opinion is the answer that is wrong in the harmless direction.
	 */
	let config = sources.user;
	let projectApplied = false;

	interface Cache {
		/** Identity of the skill array this was computed from. */
		readonly skills: readonly Skill[];
		readonly partition: SkillPartition<Skill>;
		/** pi's own block, and ours. Both computed once. */
		readonly before: string;
		readonly after: string;
	}
	let cache: Cache | null = null;

	/**
	 * True when a swap was wanted and the block could not be found — pi changed
	 * its formatting, or another `before_agent_start` handler rewrote that
	 * region. Reported by `/skills`, because the failure is otherwise SILENT:
	 * the session looks configured and scopes nothing.
	 */
	let promptSwapFailed = false;

	// Resolved once. `homedir()` reads the environment on every call, and the read
	// block runs on every `read` the model makes — and the value cannot change
	// inside a process anyway. The block NEEDS it: pi's read tool expands `~`
	// itself, so a raw `~/.claude/skills/<name>/SKILL.md` is a live bypass unless
	// we expand it the same way (see `normalizeReadPath`).
	const homeDir = homedir();

	pi.on("session_start", (_event, ctx) => {
		// pi itself refuses to LOAD project skills from an untrusted checkout; a
		// project file that re-scopes them deserves the same bar.
		projectApplied = isConfigured(sources.project) && ctx.isProjectTrusted();
		config = projectApplied ? mergeScopeConfigs(sources.user, sources.project) : sources.user;
		// The skill list is rebuilt on /reload, and the config may have just
		// changed. Recompute both blocks on the next turn.
		cache = null;
	});

	/* ---------------------------------------------------------------------- */
	/* Advisory: what the prompt advertises                                    */
	/* ---------------------------------------------------------------------- */

	pi.on("before_agent_start", (event) => {
		if (!isConfigured(config)) return;
		const skills = event.systemPromptOptions.skills;
		if (!skills || skills.length === 0) return;

		if (!cache || cache.skills !== skills) {
			const partition = partitionSkills(skills, config);
			cache = {
				skills,
				partition,
				// pi filters `disable-model-invocation` skills inside
				// formatSkillsForPrompt, so formatting the SAME array it was given
				// reproduces the block it produced, byte for byte.
				before: formatSkillsForPrompt(skills),
				after: formatSkillsForPrompt(partition.auto),
			};
		}

		// Deterministic for a given skill list and config, which is what keeps the
		// prompt prefix cacheable across turns. A replacement that varied per turn
		// would cost a full cache miss on every request.
		const swapped = swapSkillsBlock(event.systemPrompt, cache.before, cache.after);
		if (swapped === event.systemPrompt) {
			// Unchanged for one of two very different reasons: there was nothing to
			// remove (every skill is auto), or the block was not where pi puts it.
			promptSwapFailed = cache.before !== cache.after;
			return;
		}
		promptSwapFailed = false;
		return { systemPrompt: swapped };
	});

	/* ---------------------------------------------------------------------- */
	/* Enforcement: what the model may actually load                           */
	/* ---------------------------------------------------------------------- */

	pi.on("tool_call", (event, ctx) => {
		if (!cache || !isToolCallEventType("read", event)) return;
		const { manual, off } = cache.partition;
		if (manual.length === 0 && off.length === 0) return;
		const blocked = blockedSkillRead(event.input.path, ctx.cwd, homeDir, manual, off);
		if (!blocked) return;
		return { block: true, reason: blockedReadReason(blocked) };
	});

	/* ---------------------------------------------------------------------- */
	/* Inspection                                                              */
	/* ---------------------------------------------------------------------- */

	// Registered even when nothing is configured: "everything is auto, and here
	// is where you would say otherwise" is the answer a user needs most on the
	// day they install this.
	pi.registerCommand("skills", {
		description: "List loaded skills with their resolved scope (auto/manual/off)",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const skills = ctx.getSystemPromptOptions().skills ?? [];
			const lines = [
				`user config:    ${sources.userPath}${isConfigured(sources.user) ? "" : " (absent or empty)"}`,
				`project config: ${sources.projectPath}${
					isConfigured(sources.project) ? (projectApplied ? "" : " (present, NOT applied: project not trusted)") : " (absent or empty)"
				}`,
				"",
				...(skills.length === 0 ? ["no skills loaded"] : describeScopes(skills, config)),
			];
			if (promptSwapFailed) {
				lines.push(
					"",
					"WARNING: pi's skills block was not found in the system prompt, so the scopes above are NOT being " +
						"applied to it. The read block still holds. Check whether pi changed how it formats skills.",
				);
			}
			ctx.ui.notify(lines.join("\n"));
		},
	});
}
