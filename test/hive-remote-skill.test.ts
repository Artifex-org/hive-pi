import { describe, expect, it } from "vitest";
import {
	parseSkillActivation,
	parseSkillCommand,
	readPathOf,
	resolveSkillCommand,
	skillActivationNotice,
	skillNameFromReadPath,
	type SkillCommandInfo,
} from "../extensions/hive-remote/skill.ts";

const catalog: SkillCommandInfo[] = [
	{
		name: "skill:kb-aware-development",
		source: "skill",
		sourceInfo: { path: "/home/dev/.claude/skills/kb-aware-development/SKILL.md" },
	},
	{
		name: "skill:craft-ui",
		source: "skill",
		sourceInfo: { path: "skills/craft-ui/SKILL.md" },
	},
	{ name: "hive-remote-on", source: "extension" },
];

describe("parseSkillCommand", () => {
	it("reads /skill:name and optional args", () => {
		expect(parseSkillCommand("/skill:craft-ui")).toEqual({ name: "craft-ui", args: "" });
		expect(parseSkillCommand("  /skill:craft-ui restyle the rail ")).toEqual({
			name: "craft-ui",
			args: "restyle the rail",
		});
	});

	it("rejects a non-skill slash, a bad name, and a buried mention", () => {
		expect(parseSkillCommand("/hive-remote-on")).toBeNull();
		expect(parseSkillCommand("/skill:Not-A-Skill")).toBeNull();
		expect(parseSkillCommand("please run /skill:craft-ui")).toBeNull();
	});
});

describe("resolveSkillCommand", () => {
	it("accepts a catalogued skill and refuses an unknown one", () => {
		expect(resolveSkillCommand("/skill:craft-ui", catalog)).toBe("craft-ui");
		expect(resolveSkillCommand("/skill:missing", catalog)).toBeNull();
	});

	it("treats a skill: name as a skill even when source is omitted", () => {
		expect(
			resolveSkillCommand("/skill:craft-ui", [{ name: "skill:craft-ui", source: "" }]),
		).toBe("craft-ui");
	});

	it("does not treat an extension command as a skill", () => {
		expect(resolveSkillCommand("/skill:hive-remote-on", catalog)).toBeNull();
	});
});

describe("skillNameFromReadPath", () => {
	it("matches a catalogued sourceInfo.path, including a cwd-relative suffix", () => {
		expect(
			skillNameFromReadPath("/home/dev/.claude/skills/kb-aware-development/SKILL.md", catalog),
		).toBe("kb-aware-development");
		expect(
			skillNameFromReadPath("/repo/skills/craft-ui/SKILL.md", catalog),
		).toBe("craft-ui");
	});

	it("does not guess from a SKILL.md the catalog does not own", () => {
		expect(skillNameFromReadPath("/tmp/other/SKILL.md", catalog)).toBeNull();
		expect(skillNameFromReadPath("SKILL.md", catalog)).toBeNull();
	});
});

describe("readPathOf", () => {
	it("reads path from read / artifact_read and ignores other tools", () => {
		expect(readPathOf("read", { path: "/a/SKILL.md" })).toBe("/a/SKILL.md");
		expect(readPathOf("artifact_read", { ref: "artifact://7" })).toBe("artifact://7");
		expect(readPathOf("bash", { command: "cat SKILL.md" })).toBe("");
	});
});

describe("skillActivationNotice", () => {
	it("round-trips the prefix the workspace parses", () => {
		expect(parseSkillActivation(skillActivationNotice("craft-ui"))).toBe("craft-ui");
		expect(parseSkillActivation("Turn finished · 2s")).toBeNull();
	});
});
