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
 *     ranks with BM25 and loads its top hits: measured over the real
 *     registrations, `artifact_read` ranks `artifact_list` first and
 *     `orchestrate` ranks `orchestrate_result` first, and in the HIV-3906 eval
 *     one keyword search loaded 8 unrelated hive tools (13.7k characters) and
 *     forced a 142k-token cache rewrite. So this extension turns `tool_search`
 *     into discovery only: its matches are un-loaded again before the model
 *     sees the result, which names them and points at `load_tools`. pi core's
 *     tool is not forked; the wrapper is a `tool_call`/`tool_result` pair.
 *   - the system prompt names every deferred harness tool, a few hundred
 *     characters instead of ~45k of definitions. The list is the same whether
 *     or not a tool has been loaded, so the cached prompt prefix survives.
 *
 * Only `deferred` tools load here, plus a gated tool its owner OFFERS (see
 * GATED_OFFER_CHANNEL): for those `load_tools` asks the owner, which activates
 * it through its own gate or declines. A gated tool nobody offers is
 * registered `direct` and inactive, so this loader cannot reach it. Neither can
 * a `hidden` one.
 *
 * MCP tools are not listed: pi's built-in MCP describes each server in its own
 * prompt section, and `tool_search` is the way to them. Mode tools are not
 * listed either: their mode activates them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { exposureFor, GATED_LOAD_REQUEST_CHANNEL, GATED_OFFER_CHANNEL, type GatedToolsEvent, LOAD_TOOL, MODE_TOOLS } from "./policy.ts";

export { LOAD_TOOL };

/** pi core's discovery tool (`extensions/tool-search`), wrapped below rather than forked. */
const TOOL_SEARCH = "tool_search";

type ToolLike = { name: string; exposure?: string; description?: string };

/**
 * The on-demand harness tools worth naming, sorted for a stable prompt: every
 * deferred one, plus the gated tools their owner offers. Offered names stay
 * listed after they load, like deferred ones, so the prompt does not change.
 */
export function deferredToolNames(tools: readonly ToolLike[], offered: ReadonlySet<string> = new Set()): string[] {
	return tools
		.filter(
			(tool) =>
				(tool.exposure === "deferred" && !tool.name.startsWith("mcp__") && !(tool.name in MODE_TOOLS)) ||
				(tool.exposure === "direct" && offered.has(tool.name)),
		)
		.map((tool) => tool.name)
		.sort();
}

/**
 * `tool_search` ranks with BM25, so an exact name can come back behind an
 * unrelated tool. Here it only finds names (see `searchResultText`); loading
 * is always `load_tools`, which takes names and cannot pick a neighbour.
 */
export const EXACT_NAME_LOADING =
	"For a deferred MCP tool whose exact name (`mcp__<server>__<tool>`) you know, pass it to `load_tools`. " +
	"`tool_search` only finds names and loads nothing: pass the ones you need to `load_tools`. " +
	"A tool exposed to codemode needs no loading: call it as `tools.mcp__<server>__<tool>(...)` inside a script.";

/**
 * What a `tool_search` call returns once this extension has un-loaded its
 * matches: the names, each with its description's first line, and how to
 * load one by exact name. Pure, for the hook and its test.
 */
export function searchResultText(found: readonly string[], tools: readonly ToolLike[]): string {
	if (found.length === 0) return "No matching tools found.";
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const lines = found.map((name) => {
		const summary = (byName.get(name)?.description ?? "").trim().split(/\r?\n/)[0];
		return summary ? `- ${name}: ${summary}` : `- ${name}`;
	});
	return [
		`Found ${found.length} tool${found.length === 1 ? "" : "s"}; none is loaded yet:`,
		...lines,
		`Load only the ones this task needs, by exact name: \`${LOAD_TOOL}\` with ` +
			`\`${JSON.stringify({ names: [found[0]] })}\`. They are callable from your next turn.`,
	].join("\n");
}

/**
 * A codemode script that calls `tools.tool_search` / `tools.describeTool` fails
 * only after its earlier calls have run. Neither is a member of `tools`; the
 * prelude exposes `searchTools` / `describeTool` as globals. Returns the
 * rejection reason, or null when the script does not use them.
 */
export function codemodeDiscoveryMisuse(code: string): string | null {
	const used = new Set<string>();
	for (const m of code.matchAll(/\btools\s*(?:\.\s*|\[\s*["'`])(tool_search|describeTool)["'`]?\s*\]?\s*\(/g)) used.add(m[1]!);
	if (used.size === 0) return null;
	const names = [...used].map((n) => `tools.${n}`).join(" and ");
	return (
		`Not run: ${names} does not exist inside codemode, and calls made before it would fail have already run. ` +
		"Use the globals instead: `await searchTools(\"<words>\")` and `await describeTool(\"<exact name>\")` " +
		"(both async; `tool_search` is model-only). " +
		"If the text is only a string or comment (for example a search pattern), run it with the bash or edit tool directly. " +
		EXACT_NAME_LOADING
	);
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
			"never `tools.tool_search` or `tools.describeTool` (they do not exist; a script that uses them is rejected). " +
			"Deferred harness tools are already callable as `tools.<name>(args)` inside scripts; they do not need " +
			"`load_tools` first. " + EXACT_NAME_LOADING,
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
	"- `store()` writes are discarded when the script throws, although the tool calls it made have already run: " +
		"catch or `allSettled` fallible calls (`bash` rejects on a nonzero exit) before `store()`.",
	"- Calls made before a script fails have already run. Use `Promise.allSettled` for independent calls and inspect effects before retrying.",
].join("\n");

/**
 * What `load_tools` does with a list of names: pure, for the tool and its test.
 * Loadable: `deferred` tools, `codemode` ones (pi's default MCP exposure, which
 * `tool_search` used to load and now only names), and an offered gated tool,
 * for which the tool asks its owner rather than activating it.
 */
export function planLoad(
	requested: readonly string[],
	tools: readonly ToolLike[],
	active: readonly string[],
	offered: ReadonlySet<string> = new Set(),
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
		else if (tool?.exposure === "deferred" || tool?.exposure === "codemode" || (tool && offered.has(name))) load.push(name);
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
		? `Find MCP tool names with tool_search outside codemode (inside scripts use await searchTools(query)), then load them with load_tools. ${EXACT_NAME_LOADING}`
		: "this session has no MCP servers configured (no ~/.pi/agent/mcp.json), so there are no MCP tools to load.";
}

export default function loadout(pi: ExtensionAPI) {
	/** Gated tools their owner currently offers to `load_tools` (GATED_OFFER_CHANNEL). */
	let offered = new Set<string>();
	/** Names the model asked `load_tools` for: a concurrent `tool_search` never un-loads them. */
	const requested = new Set<string>();
	pi.events.on(GATED_OFFER_CHANNEL, (data) => {
		offered = new Set((data as GatedToolsEvent | undefined)?.names ?? []);
	});

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
			const planned = planLoad(params.names, pi.getAllTools(), pi.getActiveTools(), offered);
			for (const name of [...planned.load, ...planned.already]) requested.add(name);
			const { already } = planned;
			const gated = planned.load.filter((name) => offered.has(name));
			// The owner decides, synchronously on the bus; whatever it did not
			// activate is reported as not loadable.
			if (gated.length > 0) pi.events.emit(GATED_LOAD_REQUEST_CHANNEL, { names: gated } satisfies GatedToolsEvent);
			const deferred = planned.load.filter((name) => !offered.has(name));
			if (deferred.length > 0) pi.setActiveTools([...pi.getActiveTools(), ...deferred]);
			const nowActive = pi.getActiveTools();
			const load = planned.load.filter((name) => nowActive.includes(name));
			const refused = [...planned.refused, ...gated.filter((name) => !nowActive.includes(name))];
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

	// tool_search as discovery only. pi's tool activates its matches inside
	// execute; the active set before the call is the one to give back. Keyed by
	// call id because a batch may hold several searches. Only when `load_tools`
	// is declared: a worker restricted by `--tools` to `tool_search` has no other
	// way to load anything, so there pi's own behaviour stands.
	const beforeSearch = new Map<string, string[]>();
	pi.on("tool_call", (event) => {
		if (event.toolName === TOOL_SEARCH) {
			const active = pi.getActiveTools();
			if (active.includes(LOAD_TOOL)) beforeSearch.set(event.toolCallId, active);
			return;
		}
		if (event.toolName !== "codemode") return;
		const code = (event.input as { code?: unknown } | undefined)?.code;
		const reason = typeof code === "string" ? codemodeDiscoveryMisuse(code) : null;
		return reason ? { block: true, reason } : undefined;
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== TOOL_SEARCH) return;
		const before = beforeSearch.get(event.toolCallId);
		beforeSearch.delete(event.toolCallId);
		const loaded = (event.details as { loaded?: unknown } | undefined)?.loaded;
		if (!before || !Array.isArray(loaded) || event.isError) return;
		const found = loaded.filter((name): name is string => typeof name === "string");
		const added = found.filter((name) => !before.includes(name) && !requested.has(name));
		if (added.length > 0) pi.setActiveTools(pi.getActiveTools().filter((name) => !added.includes(name)));
		return {
			content: [{ type: "text" as const, text: searchResultText(found, pi.getAllTools()) }],
			details: { loaded: [], found },
		};
	});

	pi.on("before_agent_start", (event) => {
		const active = pi.getActiveTools();
		// Only when the loader itself is declared: a role worker restricted by
		// `--tools` has no way to load anything, and its grants are already active.
		const sections = [
			active.includes(LOAD_TOOL) ? loadoutPrompt(deferredToolNames(pi.getAllTools(), offered)) : "",
			active.includes("codemode") ? CODEMODE_SCRIPT_GUIDANCE : "",
		].filter(Boolean);
		if (sections.length === 0) return;
		return { systemPrompt: [event.systemPrompt, ...sections].join("\n\n") };
	});
}
