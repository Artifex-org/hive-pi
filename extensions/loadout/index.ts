/**
 * Tell the model which harness tools exist but are loaded on demand.
 *
 * `policy.ts` defers most harness tools so their definitions stop riding on
 * every request. A deferred tool is invisible to the model: probed on pi 1.0.2,
 * a model told "call zebra_probe" with the tool deferred ran `bash zebra_probe`
 * instead, because a tool that is not declared cannot be called. pi's
 * `tool_search` loads it, but only if the model thinks to search, and a BM25
 * search on a vague query loads up to eight unrelated tools.
 *
 * So the system prompt carries the NAMES — a few hundred characters instead of
 * ~45k of definitions — and the instruction to load one by exact name. The list
 * is every deferred harness tool, active or not, so the text does not change
 * when a tool is loaded and the cached prompt prefix survives.
 *
 * MCP tools are not listed: pi's built-in MCP already describes each server in
 * its own prompt section. Mode tools are not listed either: their mode
 * activates them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MODE_TOOLS } from "./policy.ts";

/** The deferred harness tools worth naming, sorted for a stable prompt. */
export function deferredToolNames(tools: ReadonlyArray<{ name: string; exposure?: string }>): string[] {
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
		"These harness tools exist but are not declared until loaded. Before the first call, load one with " +
			'`tool_search` using its exact name and `limit: 1` (e.g. `{"query": "browser_navigate", "limit": 1}`); ' +
			"it is callable from your next turn. Codemode scripts can call them without loading.",
		"",
		names.join(", "),
	].join("\n");
}

export default function loadout(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const prompt = loadoutPrompt(deferredToolNames(pi.getAllTools()));
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
}
