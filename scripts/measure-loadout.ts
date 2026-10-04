/**
 * Measure what a session declares to the model before it does anything.
 *
 * Load it next to the harness and ask for one word:
 *
 *   pi -e scripts/measure-loadout.ts -p "Reply with just: ok" --no-session
 *
 * On the first `before_agent_start` it prints one `LOADOUT {json}` line on
 * stderr: the system prompt size, the declared (active) tools with their
 * definition sizes, and how many tools are registered but deferred. The
 * provider's input token count for the same request is the other half of the
 * measurement — read it from `--mode json` (`message_end.message.usage.input`).
 *
 * stderr rather than a file because the sandboxed harness may not be able to
 * write where the caller expects, and a measurement that silently does not
 * land is worse than none.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function measureLoadout(pi: ExtensionAPI) {
	let done = false;
	pi.on("before_agent_start", (event) => {
		if (done) return;
		done = true;
		const active = new Set(pi.getActiveTools());
		const tools = pi.getAllTools();
		const declared = tools
			.filter((tool) => active.has(tool.name))
			.map((tool) => ({ name: tool.name, chars: (tool.description ?? "").length + JSON.stringify(tool.parameters ?? {}).length }))
			.sort((a, b) => b.chars - a.chars);
		process.stderr.write(
			`LOADOUT ${JSON.stringify({
				systemPromptChars: event.systemPrompt.length,
				declaredTools: declared.length,
				declaredChars: declared.reduce((sum, tool) => sum + tool.chars, 0),
				deferredTools: tools.filter((tool) => !active.has(tool.name)).length,
				declared,
			})}\n`,
		);
	});
}
