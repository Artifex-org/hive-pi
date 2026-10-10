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
			"For MCP discovery outside scripts, use `tool_search` when declared. " +
			"Inside `codemode`, use `await searchTools(\"<words>\")` and `await describeTool(\"<exact name>\")`; " +
			"never `tools.tool_search` (it is model-only). Deferred harness tools are already callable as " +
			"`tools.<name>(args)` inside scripts; they do not need `load_tools` first.",
		"",
		names.join(", "),
	].join("\n");
}

/**
 * How to call tools from a `codemode` script without guessing.
 *
 * MEASURED: in one long session 41 of 310 codemode calls failed inside the
 * script — a guessed member (`tools.tool_search`), a guessed path, an edit
 * whose old text matched more than once. pi's `tools` object is frozen in the
 * script prelude (`@earendil-works/pi-codemode`) and an extension cannot add
 * members to it, so `tools.exists()`/`tools.list()` would be one more guess;
 * the prelude already answers both questions with `in` and `ALL_TOOLS`. The
 * failed-read diagnosis is pretty-tools' `explainPathFailure`, which reaches a
 * script because nested calls run through the same registered `read`.
 */
export const CODEMODE_SCRIPT_GUIDANCE = [
	"## Codemode scripts",
	"",
	"- Check a tool name before calling it: `(\"<name>\" in tools)` is true only for a tool the script can call " +
		"(reading a missing member throws), and `ALL_TOOLS.map((t) => t.name)` lists them all, MCP names with `-` as `_`. " +
		"There is no `tools.exists`, `tools.list` or `tools.tool_search`.",
	"- Do not guess paths: list the directory first (`tools.ls`, `tools.find`) or use a path a tool printed. " +
		"A failed `tools.read` names what IS in the nearest existing directory — use that instead of guessing again.",
	"- `tools.edit` replaces text that must match exactly once: read the file first and include enough surrounding lines to be unique.",
	"- Calls made before a script fails have already run. Use `Promise.allSettled` for independent calls and inspect effects before retrying.",
].join("\n");

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

/**
 * Where MCP tools come from, said only as far as it is true. pi registers
 * tool_search only when MCP servers are configured, so pointing at it on a
 * machine with no mcp.json sent an agent hunting for a tool that does not
 * exist (andreas-mbp, 2026-10-07: "no tool_search callable is exposed").
 */
export function mcpHint(pi: Pick<ExtensionAPI, "getAllTools">): string {
	return pi.getAllTools().some((tool) => tool.name === "tool_search")
		? "MCP tools load with tool_search outside codemode; inside scripts use await searchTools(query)."
		: "this session has no MCP servers configured (no ~/.pi/agent/mcp.json), so there are no MCP tools to load.";
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
				lines.push(`Not loadable here: ${refused.join(", ")}. Use a name from 'Tools loaded on demand'; ${mcpHint(pi)}`);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { loaded: load, already, refused },
				isError: load.length === 0 && already.length === 0,
			};
		},
	});

	pi.on("before_agent_start", (event) => {
		const active = pi.getActiveTools();
		// Only when the loader itself is declared: a role worker restricted by
		// `--tools` has no way to load anything, and its grants are already active.
		const sections = [
			active.includes(LOAD_TOOL) ? loadoutPrompt(deferredToolNames(pi.getAllTools())) : "",
			active.includes("codemode") ? CODEMODE_SCRIPT_GUIDANCE : "",
		].filter(Boolean);
		if (sections.length === 0) return;
		return { systemPrompt: [event.systemPrompt, ...sections].join("\n\n") };
	});
}
