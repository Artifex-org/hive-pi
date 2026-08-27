/**
 * The property this extension lives or dies on: installing it changes NOTHING
 * until it is configured. A scoping feature that silently hides a skill the user
 * was relying on is worse than no scoping at all — the failure is invisible from
 * inside the session (the model just never reaches for it) and looks like the
 * model getting worse.
 *
 * So most of what is asserted here is restraint: absent config, malformed
 * config, unknown skill names, a `default` nobody set — all of them resolve to
 * `auto`, and the prompt comes back byte-identical.
 */

import { describe, expect, it } from "vitest";

import { createFakePi } from "./fake-pi.ts";
import { wireSkillScope, type ScopeSources } from "../extensions/skillscope/index.ts";
import {
	blockedSkillRead,
	describeScopes,
	EMPTY_CONFIG,
	isConfigured,
	isInsideDir,
	mergeScopeConfigs,
	normalizeReadPath,
	parseScopeConfig,
	partitionSkills,
	resolveScope,
	swapSkillsBlock,
	type ScopeConfig,
	type SkillPaths,
} from "../extensions/skillscope/scope.ts";

const config = (entries: Record<string, string>): ScopeConfig => parseScopeConfig(entries);

const skill = (name: string, baseDir = `/home/u/.claude/skills/${name}`): SkillPaths => ({
	name,
	baseDir,
	filePath: `${baseDir}/SKILL.md`,
});

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

describe("parseScopeConfig", () => {
	it("treats an absent config as no configuration at all", () => {
		expect(isConfigured(parseScopeConfig(null))).toBe(false);
		expect(isConfigured(parseScopeConfig(undefined))).toBe(false);
	});

	it("refuses shapes that are not an object of scopes", () => {
		expect(isConfigured(parseScopeConfig("auto"))).toBe(false);
		expect(isConfigured(parseScopeConfig(["narrate"]))).toBe(false);
		expect(isConfigured(parseScopeConfig(42))).toBe(false);
	});

	// A typo must cost the user that ONE line, not the whole file. Dropping the
	// file would silently restore "everything auto" for the other ninety skills.
	it("drops the offending entry on a bad value, keeping the rest", () => {
		const parsed = parseScopeConfig({ audit: "off", "craft-ui": null, deploy: "sometimes", linear: "manual", refs: true });
		expect(resolveScope("audit", parsed)).toBe("off");
		expect(resolveScope("linear", parsed)).toBe("manual");
		expect(resolveScope("deploy", parsed)).toBe("auto");
		expect(resolveScope("craft-ui", parsed)).toBe("auto");
		expect(resolveScope("refs", parsed)).toBe("auto");
	});

	it("ignores inherited keys, so a hand-edited __proto__ cannot become a scope", () => {
		const parsed = parseScopeConfig(JSON.parse('{"__proto__": {"audit": "off"}, "linear": "off"}'));
		expect(resolveScope("audit", parsed)).toBe("auto");
		expect(resolveScope("linear", parsed)).toBe("off");
	});
});

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

describe("resolveScope", () => {
	it("defaults an unknown skill to auto — today's behaviour", () => {
		expect(resolveScope("never-heard-of-it", EMPTY_CONFIG)).toBe("auto");
		expect(resolveScope("never-heard-of-it", config({ audit: "off" }))).toBe("auto");
	});

	it("falls back to the reserved default key", () => {
		const c = config({ default: "off", audit: "auto" });
		expect(resolveScope("anything", c)).toBe("off");
		expect(resolveScope("audit", c)).toBe("auto");
	});

	// The intended shape for a focused project: nothing but what this repo needs.
	it("supports default:off with an explicit allowlist", () => {
		const c = config({ default: "off", "e2e-tests": "auto", deploy: "manual" });
		expect(resolveScope("e2e-tests", c)).toBe("auto");
		expect(resolveScope("deploy", c)).toBe("manual");
		expect(resolveScope("borealis-hedge-review", c)).toBe("off");
	});
});

describe("project over user", () => {
	it("lets the project override one skill without discarding the user's other opinions", () => {
		const user = config({ audit: "off", linear: "off", deploy: "manual" });
		const project = config({ linear: "auto" });
		const merged = mergeScopeConfigs(user, project);
		expect(resolveScope("linear", merged)).toBe("auto");
		expect(resolveScope("audit", merged)).toBe("off");
		expect(resolveScope("deploy", merged)).toBe("manual");
	});

	it("overrides only the fallback when the project sets only a default", () => {
		const merged = mergeScopeConfigs(config({ default: "auto", audit: "off" }), config({ default: "off" }));
		expect(resolveScope("unlisted", merged)).toBe("off");
		expect(resolveScope("audit", merged)).toBe("off");
	});

	it("leaves the user config untouched when the project file is empty", () => {
		const user = config({ audit: "manual" });
		expect(resolveScope("audit", mergeScopeConfigs(user, EMPTY_CONFIG))).toBe("manual");
	});
});

/* -------------------------------------------------------------------------- */
/* Partition                                                                   */
/* -------------------------------------------------------------------------- */

describe("partitionSkills", () => {
	const skills = [skill("audit"), skill("deploy"), skill("linear"), skill("narrate")];

	it("puts everything in auto when nothing is configured", () => {
		const p = partitionSkills(skills, EMPTY_CONFIG);
		expect(p.auto.map((s) => s.name)).toEqual(["audit", "deploy", "linear", "narrate"]);
		expect(p.manual).toEqual([]);
		expect(p.off).toEqual([]);
	});

	it("splits by resolved scope", () => {
		const p = partitionSkills(skills, config({ audit: "off", deploy: "manual", default: "auto" }));
		expect(p.auto.map((s) => s.name)).toEqual(["linear", "narrate"]);
		expect(p.manual.map((s) => s.name)).toEqual(["deploy"]);
		expect(p.off.map((s) => s.name)).toEqual(["audit"]);
	});

	// pi's prompt block is built from this array in order; a partition that
	// reordered would make the block differ from pi's by more than subtraction.
	it("preserves load order within each bucket", () => {
		const p = partitionSkills([skill("z"), skill("a"), skill("m")], config({ default: "auto" }));
		expect(p.auto.map((s) => s.name)).toEqual(["z", "a", "m"]);
	});

	it("handles an empty skill list", () => {
		expect(partitionSkills([], config({ audit: "off" })).auto).toEqual([]);
	});
});

describe("describeScopes", () => {
	it("reports every loaded skill, including the ones nobody configured", () => {
		const lines = describeScopes([skill("audit"), skill("linear")], config({ audit: "off" }));
		expect(lines[0]).toContain("audit");
		expect(lines[0]).toContain("off");
		expect(lines[1]).toContain("auto");
	});
});

/* -------------------------------------------------------------------------- */
/* Prompt surgery                                                              */
/* -------------------------------------------------------------------------- */

describe("swapSkillsBlock", () => {
	const prompt = "You are pi.\n\n<available_skills>\n  <skill>a</skill>\n</available_skills>\nCwd: /x";

	it("replaces the block in place, leaving everything around it alone", () => {
		const out = swapSkillsBlock(prompt, "<available_skills>\n  <skill>a</skill>\n</available_skills>", "<available_skills>\n</available_skills>");
		expect(out).toBe("You are pi.\n\n<available_skills>\n</available_skills>\nCwd: /x");
	});

	// `"x".replace("", "y")` INSERTS at index 0. Without this guard, the case
	// where there is nothing to remove is the case that corrupts the prompt.
	it("does not insert when the old block is empty", () => {
		expect(swapSkillsBlock(prompt, "", "INJECTED")).toBe(prompt);
	});

	it("returns the prompt untouched when the block is not found", () => {
		expect(swapSkillsBlock(prompt, "<available_skills>\n  <skill>b</skill>\n</available_skills>", "")).toBe(prompt);
	});

	it("is a no-op when nothing was removed", () => {
		expect(swapSkillsBlock(prompt, "<available_skills>", "<available_skills>")).toBe(prompt);
	});

	it("replaces only the first occurrence", () => {
		expect(swapSkillsBlock("aXbXc", "X", "-")).toBe("a-bXc");
	});
});

/* -------------------------------------------------------------------------- */
/* Read enforcement                                                            */
/* -------------------------------------------------------------------------- */

describe("isInsideDir", () => {
	// The reason this is not `startsWith`.
	it("does not treat a sibling with a shared prefix as inside", () => {
		expect(isInsideDir("/skills/foo", "/skills/foobar/SKILL.md")).toBe(false);
		expect(isInsideDir("/skills/foo", "/skills/foo/refs/a.md")).toBe(true);
		expect(isInsideDir("/skills/foo", "/skills/foo")).toBe(true);
		expect(isInsideDir("/skills/foo", "/skills")).toBe(false);
	});
});

const HOME = "/home/u";

/**
 * pi's read tool normalizes its `path` argument before opening the file, and
 * `tool_call` fires with the RAW argument — so every spelling pi accepts is a
 * bypass unless the block accepts it too. `~` is not exotic here: the library
 * this extension exists to scope lives at `~/.claude/skills`.
 */
describe("normalizeReadPath", () => {
	it("expands a leading ~ the way pi's read tool does", () => {
		expect(normalizeReadPath("~/.claude/skills/a/SKILL.md", "/repo", HOME)).toBe("/home/u/.claude/skills/a/SKILL.md");
		expect(normalizeReadPath("~", "/repo", HOME)).toBe(HOME);
	});

	it("does not expand a ~ that is not the whole first segment", () => {
		expect(normalizeReadPath("~backup/x.md", "/repo", HOME)).toBe("/repo/~backup/x.md");
	});

	it("strips pi's @ prefix, before expanding ~", () => {
		expect(normalizeReadPath("@~/skills/a/SKILL.md", "/repo", HOME)).toBe("/home/u/skills/a/SKILL.md");
		expect(normalizeReadPath("@/abs/a.md", "/repo", HOME)).toBe("/abs/a.md");
	});

	it("accepts a file:// URL", () => {
		expect(normalizeReadPath("file:///home/u/skills/a/SKILL.md", "/repo", HOME)).toBe("/home/u/skills/a/SKILL.md");
	});

	// A throwing tool_call handler makes pi abort the turn, so a bad URL must
	// degrade to "no match", never to an exception.
	it("does not throw on a malformed file URL", () => {
		expect(() => normalizeReadPath("file://", "/repo", HOME)).not.toThrow();
	});

	it("normalizes the unicode spaces pi normalizes", () => {
		// U+00A0 written as an escape: an invisible character in a test is a test nobody can read.
		expect(normalizeReadPath("/a/b\u00A0c.md", "/repo", HOME)).toBe("/a/b c.md");
	});

	it("still resolves an ordinary relative path against cwd", () => {
		expect(normalizeReadPath("src/a.ts", "/repo", HOME)).toBe("/repo/src/a.ts");
	});
});

describe("blockedSkillRead", () => {
	const manualSkill = skill("deploy");
	const offSkill = skill("borealis-audit");
	const check = (path: string, cwd = "/repo") => blockedSkillRead(path, cwd, HOME, [manualSkill], [offSkill]);

	it("allows an unrelated file", () => {
		expect(check("/repo/src/index.ts")).toBeUndefined();
		expect(check("src/index.ts")).toBeUndefined();
	});

	// The bypass this cost: the model spells the library path the way a human
	// would, and the block never fires while pi opens the file regardless.
	it("blocks a tilde-spelled path to an off skill", () => {
		expect(check("~/.claude/skills/borealis-audit/SKILL.md")?.scope).toBe("off");
		expect(check("~/.claude/skills/deploy/SKILL.md")?.scope).toBe("manual");
	});

	it("blocks the model from loading a manual skill's SKILL.md", () => {
		expect(check(manualSkill.filePath)?.scope).toBe("manual");
	});

	/**
	 * The asymmetry that makes `manual` usable at all. `/skill:deploy` injects
	 * SKILL.md, which then tells the model to read the skill's references and run
	 * its scripts. Blocking the directory would break the skill for the user who
	 * asked for it by name.
	 */
	it("still lets the model read a manual skill's supporting files", () => {
		expect(check(`${manualSkill.baseDir}/references/ladder.md`)).toBeUndefined();
		expect(check(`${manualSkill.baseDir}/scripts/run.sh`)).toBeUndefined();
	});

	it("blocks everything under an off skill's directory", () => {
		expect(check(offSkill.filePath)?.scope).toBe("off");
		expect(check(`${offSkill.baseDir}/references/checklist.md`)?.scope).toBe("off");
	});

	it("resolves a relative path against the session cwd before deciding", () => {
		expect(blockedSkillRead("skills/gone/SKILL.md", "/repo", HOME, [], [skill("gone", "/repo/skills/gone")])?.scope).toBe("off");
	});

	it("is not fooled by a traversal that lands inside an off skill", () => {
		expect(check(`${offSkill.baseDir}/../borealis-audit/SKILL.md`)?.scope).toBe("off");
	});

	it("blocks nothing when nothing is scoped", () => {
		expect(blockedSkillRead(offSkill.filePath, "/repo", HOME, [], [])).toBeUndefined();
		expect(blockedSkillRead("", "/repo", HOME, [manualSkill], [offSkill])).toBeUndefined();
	});

	/**
	 * pi loads a loose `foo.md` sitting directly in a skills directory as a skill
	 * too, and sets `baseDir = dirname(filePath)` for it — i.e. the SHARED library
	 * directory. Blocking that directory would mean scoping one skill `off` and
	 * silently taking every sibling skill with it, which is the opposite of a
	 * per-skill feature. So a skill only gets its directory blocked when it owns
	 * it, and pi's own discriminator for that is the SKILL.md filename.
	 */
	describe("a loose .md skill, whose baseDir is shared with its siblings", () => {
		const loose: SkillPaths = { name: "notes", baseDir: "/home/u/.claude/skills", filePath: "/home/u/.claude/skills/notes.md" };
		const sibling = skill("craft-ui");
		const checkLoose = (path: string) => blockedSkillRead(path, "/repo", HOME, [], [loose]);

		it("blocks its own file", () => {
			expect(checkLoose(loose.filePath)?.scope).toBe("off");
		});

		it("does NOT block a sibling skill that merely shares the directory", () => {
			expect(checkLoose(sibling.filePath)).toBeUndefined();
			expect(checkLoose(`${sibling.baseDir}/references/a.md`)).toBeUndefined();
			expect(checkLoose("/home/u/.claude/skills/other.md")).toBeUndefined();
		});

		// The SKILL.md kind is unaffected: pi never recurses into a directory that
		// has one, so that skill provably owns its directory.
		it("still blocks the whole directory for a SKILL.md skill", () => {
			expect(check(`${offSkill.baseDir}/references/checklist.md`)?.scope).toBe("off");
		});
	});
});

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

const sources = (
	user: Record<string, string> = {},
	project: Record<string, string> = {},
	enabled = true,
): ScopeSources => ({
	user: config(user),
	project: config(project),
	userPath: "/home/u/.pi/agent/hive-telemetry/skill-scope.config.json",
	projectPath: "/repo/.pi/skill-scope.json",
	enabled,
});

const loaded = [skill("audit"), skill("deploy")].map((s) => ({
	...s,
	description: `the ${s.name} skill`,
	sourceInfo: { type: "user" as const },
	disableModelInvocation: false,
}));

/** pi's own block, as `buildSystemPrompt` appends it. */
function promptWith(names: string[]): string {
	const entries = names
		.map((name) => `  <skill>\n    <name>${name}</name>\n    <description>the ${name} skill</description>\n    <location>/home/u/.claude/skills/${name}/SKILL.md</location>\n  </skill>`)
		.join("\n");
	return `SYSTEM\n\n\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n${entries}\n</available_skills>\nCurrent working directory: /repo`;
}

async function startedPi(user: Record<string, string> = {}, project: Record<string, string> = {}) {
	const pi = createFakePi();
	wireSkillScope(pi.api, sources(user, project));
	await pi.emit({ type: "session_start", reason: "startup" }, { cwd: "/repo" });
	return pi;
}

describe("wiring", () => {
	// README idiom: the factory runs once, so an early return can never be
	// undone. The no-op belongs inside the handler, not around registration.
	it("registers its handlers even with no config at all", () => {
		const pi = createFakePi();
		wireSkillScope(pi.api, sources());
		expect(pi.handlers.has("before_agent_start")).toBe(true);
		expect(pi.handlers.has("tool_call")).toBe(true);
		expect(pi.commands.has("skills")).toBe(true);
	});

	// The `/toggles` kill switch. Distinct from "nothing configured": that
	// registers handlers that decline to act, this registers nothing at all, so
	// neither the prompt splice nor the read block exists to go wrong.
	it("registers NOTHING when disabled, even with scopes configured", () => {
		const pi = createFakePi();
		wireSkillScope(pi.api, sources({ audit: "off" }, {}, false));
		expect(pi.handlers.has("before_agent_start")).toBe(false);
		expect(pi.handlers.has("tool_call")).toBe(false);
		expect(pi.commands.has("skills")).toBe(false);
	});

	it("still registers when enabled with scopes configured", () => {
		const pi = createFakePi();
		wireSkillScope(pi.api, sources({ audit: "off" }, {}, true));
		expect(pi.handlers.has("tool_call")).toBe(true);
	});

	it("leaves the system prompt byte-identical when nothing is configured", async () => {
		const pi = await startedPi();
		const prompt = promptWith(["audit", "deploy"]);
		const results = await pi.emit({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: prompt,
			systemPromptOptions: { cwd: "/repo", skills: loaded },
		});
		expect(results.filter(Boolean)).toEqual([]);
	});

	it("removes a scoped-out skill from the prompt and leaves the rest", async () => {
		const pi = await startedPi({ audit: "off" });
		const results = await pi.emit({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: promptWith(["audit", "deploy"]),
			systemPromptOptions: { cwd: "/repo", skills: loaded },
		});
		const replaced = (results.find(Boolean) as { systemPrompt: string }).systemPrompt;
		expect(replaced).toBe(promptWith(["deploy"]));
	});

	it("drops the whole block when every skill is scoped away", async () => {
		const pi = await startedPi({ default: "off" });
		const results = await pi.emit({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: promptWith(["audit", "deploy"]),
			systemPromptOptions: { cwd: "/repo", skills: loaded },
		});
		const replaced = (results.find(Boolean) as { systemPrompt: string }).systemPrompt;
		expect(replaced).not.toContain("<available_skills>");
		expect(replaced).toContain("SYSTEM");
		expect(replaced).toContain("Current working directory: /repo");
	});

	// The whole point of the second lever: the prompt is advisory, so a model
	// that learned the path anyway must still be refused.
	it("blocks a read of an off skill after the prompt has been scoped", async () => {
		const pi = await startedPi({ audit: "off" });
		await pi.emit({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: promptWith(["audit", "deploy"]),
			systemPromptOptions: { cwd: "/repo", skills: loaded },
		});
		const results = await pi.emit(
			{ type: "tool_call", toolName: "read", toolCallId: "1", input: { path: "/home/u/.claude/skills/audit/SKILL.md" } },
			{ cwd: "/repo" },
		);
		expect(results.find(Boolean)).toMatchObject({ block: true });
	});

	it("does not block reads of skills that are still auto", async () => {
		const pi = await startedPi({ audit: "off" });
		await pi.emit({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: promptWith(["audit", "deploy"]),
			systemPromptOptions: { cwd: "/repo", skills: loaded },
		});
		const results = await pi.emit(
			{ type: "tool_call", toolName: "read", toolCallId: "1", input: { path: "/home/u/.claude/skills/deploy/SKILL.md" } },
			{ cwd: "/repo" },
		);
		expect(results.filter(Boolean)).toEqual([]);
	});

	it("blocks nothing before the first turn has told it what is loaded", async () => {
		const pi = await startedPi({ audit: "off" });
		const results = await pi.emit(
			{ type: "tool_call", toolName: "read", toolCallId: "1", input: { path: "/home/u/.claude/skills/audit/SKILL.md" } },
			{ cwd: "/repo" },
		);
		expect(results.filter(Boolean)).toEqual([]);
	});

	it("applies the project file over the user file in a trusted checkout", async () => {
		const pi = await startedPi({ default: "off" }, { audit: "auto" });
		const results = await pi.emit({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: promptWith(["audit", "deploy"]),
			systemPromptOptions: { cwd: "/repo", skills: loaded },
		});
		const replaced = (results.find(Boolean) as { systemPrompt: string }).systemPrompt;
		expect(replaced).toBe(promptWith(["audit"]));
	});

	/**
	 * The fail-safe order, which nothing else exercises: the project file is a
	 * TRUST decision made in `session_start`, so until that has run the config is
	 * the user's alone. Here the project file would widen `audit` back to `auto`;
	 * before `session_start` it must not, and the user's `default: off` stands.
	 */
	it("does not apply the project file before session_start has vetted trust", async () => {
		const pi = createFakePi();
		wireSkillScope(pi.api, sources({ default: "off" }, { audit: "auto" }));
		const results = await pi.emit({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: promptWith(["audit", "deploy"]),
			systemPromptOptions: { cwd: "/repo", skills: loaded },
		});
		const replaced = (results.find(Boolean) as { systemPrompt: string }).systemPrompt;
		expect(replaced).not.toContain("<available_skills>");
	});

	// Degrading to "scoping not applied" is recoverable and reportable. Editing
	// a prompt we no longer recognise is not.
	it("leaves an unrecognised system prompt alone rather than guessing", async () => {
		const pi = await startedPi({ audit: "off" });
		const results = await pi.emit({
			type: "before_agent_start",
			prompt: "go",
			systemPrompt: "a system prompt with no skills block in it",
			systemPromptOptions: { cwd: "/repo", skills: loaded },
		});
		expect(results.filter(Boolean)).toEqual([]);
	});
});
