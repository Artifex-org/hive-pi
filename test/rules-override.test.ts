/**
 * rules-override against pi's real prompt builder: the path rule is reworded
 * through `sections` while the prompt is structured, and in the string once an
 * earlier handler has forced it. Nothing else in the rules moves.
 */

import { describe, expect, it } from "vitest";

import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import rulesOverride, { CORE_PATH_RULE, PATH_LINE_RULE, renderedRules, rewordPathRule } from "../extensions/rules-override.ts";
import { createFakePi } from "./fake-pi.ts";

const baseOptions = () =>
	normalizeBuildSystemPromptOptions({
		cwd: "/repo",
		selectedTools: ["read", "bash", "edit", "write"],
		promptGuidelines: ["Use codemode to batch independent tool calls"],
	});

/** Run the handler the way pi's runner does: a live `systemPrompt` getter over mutable options. */
async function runHandler(options: ReturnType<typeof baseOptions>) {
	const pi = createFakePi();
	rulesOverride(pi.api);
	const handler = pi.handlers.get("before_agent_start")![0]!;
	const event = {
		type: "before_agent_start",
		prompt: "go",
		get systemPrompt() {
			return buildSystemPrompt(options);
		},
		systemPromptOptions: options,
	};
	return (await handler(event, {} as never)) as { systemPrompt?: string } | undefined;
}

describe("rules-override", () => {
	it("pi core still renders the rule this replaces", () => {
		expect(renderedRules(buildSystemPrompt(baseOptions()))).toContain(`- ${CORE_PATH_RULE}`);
	});

	it("replaces the rules section through `sections` on a structured prompt", async () => {
		const options = baseOptions();
		const before = renderedRules(buildSystemPrompt(options))!;
		expect(await runHandler(options)).toBeUndefined();
		const after = buildSystemPrompt(options);
		expect(after).toContain(`- ${PATH_LINE_RULE}`);
		expect(after).not.toContain(CORE_PATH_RULE);
		// Same rules, same order, one line reworded.
		expect(renderedRules(after)).toBe(before.replace(`- ${CORE_PATH_RULE}`, `- ${PATH_LINE_RULE}`));
		expect(after).toContain("- Be concise in your responses");
		expect(after).toContain("- Use codemode to batch independent tool calls");
	});

	it("rewrites a prompt an earlier handler already forced", async () => {
		const options = baseOptions();
		options.forceSystemPrompt = `${buildSystemPrompt(options)}\n\nExtension addendum`;
		const result = await runHandler(options);
		expect(result?.systemPrompt).toContain(`- ${PATH_LINE_RULE}`);
		expect(result?.systemPrompt).not.toContain(CORE_PATH_RULE);
		expect(result?.systemPrompt?.endsWith("Extension addendum")).toBe(true);
	});

	it("leaves a prompt without the rule alone", async () => {
		const options = baseOptions();
		options.forceSystemPrompt = "Custom prompt\n\n<rules>\n- Be concise in your responses\n</rules>";
		expect(await runHandler(options)).toBeUndefined();
		expect(rewordPathRule("- Show file paths clearly when working with files, always")).toBe(
			"- Show file paths clearly when working with files, always",
		);
	});
});
