/**
 * rules-override — one line of pi core's `<rules>`, reworded.
 *
 * pi core always ends its rules with "Show file paths clearly when working with
 * files" (`buildRules` in core/system-prompt.js). In the HIV-3906 eval pi's
 * final reports carried 46 code spans to Claude Code's 24 for the same task,
 * an identifier checklist rather than a description of the change, and that
 * rule is one of the causes the prose review traced (research C). Claude Code
 * asks for a reference only when pointing at code, in `path:line` form, so the
 * reader can open it. That is the replacement.
 *
 * HOW, without forking pi. `before_agent_start` hands every handler the
 * mutable prompt options, and a custom `sections` entry named like a built-in
 * one REPLACES it (`buildSystemPromptSections` applies custom sections last).
 * So while the prompt is still structured, this sets `sections.rules` to pi's
 * own rendered rules with the one line swapped: same rules, same order, and
 * pi still renders the section.
 *
 * Once an earlier handler has returned a full `systemPrompt` (several hive-pi
 * extensions do, and pi loads extensions in directory order) the prompt is
 * opaque and `sections` no longer reaches it, so the same one-line swap is made
 * on that string instead. Either way only that line changes; a prompt without
 * it (a custom prompt, or pi rewording its rule) is left alone.
 *
 * "Be concise in your responses" stays: the global instructions define what
 * concise means for a report.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CORE_PATH_RULE = "Show file paths clearly when working with files";
export const PATH_LINE_RULE = "Reference code as path:line when you point at it.";

const RULE_LINE = `- ${CORE_PATH_RULE}`;

/** The body of a rendered `<rules>` section, or null when the prompt has none. */
export function renderedRules(prompt: string): string | null {
	const match = /<rules>\n([\s\S]*?)\n<\/rules>/.exec(prompt);
	return match ? match[1]! : null;
}

/** `rules` with pi's path rule reworded; unchanged when the rule is absent. */
export function rewordPathRule(rules: string): string {
	return rules
		.split("\n")
		.map((line) => (line === RULE_LINE ? `- ${PATH_LINE_RULE}` : line))
		.join("\n");
}

export default function rulesOverride(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		if (options.forceSystemPrompt === undefined) {
			const rules = renderedRules(event.systemPrompt);
			if (rules === null) return;
			const reworded = rewordPathRule(rules);
			if (reworded !== rules) options.sections.rules = reworded;
			return;
		}
		const rules = renderedRules(options.forceSystemPrompt);
		if (rules === null) return;
		const reworded = rewordPathRule(rules);
		if (reworded === rules) return;
		return { systemPrompt: options.forceSystemPrompt.replace(`<rules>\n${rules}\n</rules>`, () => `<rules>\n${reworded}\n</rules>`) };
	});
}
