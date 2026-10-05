/**
 * Load harness tools on demand, by exact name.
 *
 * `policy.ts` defers most harness tools so their definitions stop riding on
 * every request. A deferred tool is invisible to the model: probed on pi 1.0.2,
 * a model told "call zebra_probe" with the tool deferred ran `bash zebra_probe`
 * instead, because a tool that is not declared cannot be called.
 *
 * So this extension does two things:
 *
 *   - `load_tools` activates deferred tools by EXACT name. pi's `tool_search`
 *     can load them too, but it ranks with BM25 and loads its top hits:
 *     measured over the real registrations, `artifact_read` ranks
 *     `artifact_list` first and `orchestrate` ranks `orchestrate_result` first.
 *     A loader that takes names cannot pick the wrong one.
 *   - the system prompt names every deferred harness tool, a few hundred
 *     characters instead of ~45k of definitions. The list is the same whether
 *     or not a tool has been loaded, so the cached prompt prefix survives.
 *
 * Only `deferred` tools load here. A tool kept inactive by its owner until
 * consent is registered `direct` (see GATED_TOOLS), so this loader cannot reach
 * it. Neither can a `hidden` one.
 *
 * MCP tools are not listed: pi's built-in MCP describes each server in its own
 * prompt section, and `tool_search` is the way to them. Mode tools are not
 * listed either: their mode activates them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { exposureFor, LOAD_TOOL, MODE_TOOLS } from "./policy.ts";

export { LOAD_TOOL };

type ToolLike = { name: string; exposure?: string };

/** The deferred harness tools worth naming, sorted for a stable prompt. */
export function deferredToolNames(tools: readonly ToolLike[]): string[] {
	return tools
		.filter((tool) => tool.exposure === "deferred" && !tool.name.startsWith("mcp__") && !(tool.name in MODE_TOOLS))
		.map((tool) => tool.name)
		.sort();
}

export function loadoutPrompt(names: readonly string[]): string {
	if (names.length === 0) return "";
	return [
		"## Tools loaded on demand",
		"",
		`These harness tools exist but are not declared until loaded. Load the ones you need with \`${LOAD_TOOL}\` ` +
			`(e.g. \`{"names": ["browser_navigate", "browser_snapshot"]}\`); they are callable from your next turn. ` +
			"MCP server tools are found with `tool_search` instead.",
		"",
		names.join(", "),
	].join("\n");
}

/** What `load_tools` does with a list of names: pure, for the tool and its test. */
export function planLoad(
	requested: readonly string[],
	tools: readonly ToolLike[],
	active: readonly string[],
): { load: string[]; already: string[]; refused: string[] } {
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const load: string[] = [];
	const already: string[] = [];
	const refused: string[] = [];
	for (const raw of requested) {
		const name = raw.trim();
		if (!name || load.includes(name) || already.includes(name) || refused.includes(name)) continue;
		const tool = byName.get(name);
		if (active.includes(name)) already.push(name);
		else if (tool?.exposure === "deferred") load.push(name);
		else refused.push(name);
	}
	return { load, already, refused };
}

export default function loadout(pi: ExtensionAPI) {
	pi.registerTool({
		name: LOAD_TOOL,
		exposure: exposureFor(LOAD_TOOL),
		label: "Load tools",
		description:
			"Load harness tools that are not declared yet, by exact name (the system prompt lists them under " +
			"'Tools loaded on demand'). They are callable from your next turn.",
		parameters: Type.Object({
			names: Type.Array(Type.String(), { minItems: 1, description: "Exact tool names, e.g. [\"session_grep\"]." }),
		}),
		async execute(_id, params) {
			const { load, already, refused } = planLoad(params.names, pi.getAllTools(), pi.getActiveTools());
			if (load.length > 0) pi.setActiveTools([...pi.getActiveTools(), ...load]);
			const lines: string[] = [];
			if (load.length > 0) lines.push(`Loaded: ${load.join(", ")}. Call them from your next turn.`);
			if (already.length > 0) lines.push(`Already available: ${already.join(", ")}.`);
			if (refused.length > 0) {
				lines.push(
					`Not loadable here: ${refused.join(", ")}. Use a name from 'Tools loaded on demand'; ` +
						"MCP tools load with tool_search.",
				);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { loaded: load, already, refused },
				isError: load.length === 0 && already.length === 0,
			};
		},
	});

	pi.on("before_agent_start", (event) => {
		// Only when the loader itself is declared: a role worker restricted by
		// `--tools` has no way to load anything, and its grants are already active.
		if (!pi.getActiveTools().includes(LOAD_TOOL)) return;
		const prompt = loadoutPrompt(deferredToolNames(pi.getAllTools()));
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}
