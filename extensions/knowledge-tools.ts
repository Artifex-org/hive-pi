/**
 * knowledge-tools — the Hive knowledge brain as NATIVE tools (HIV-1560 wave 5).
 *
 * ## The bug this closes
 *
 * The harness used to carry a second, local knowledge surface that
 * de-registered itself whenever the Hive knowledge brain was reachable — the
 * normal case — reasoning that "sessions then have only the Hive knowledge
 * path". That was true for the MAIN session, which holds the `mcp` adapter
 * proxy. It was false for subagents:
 *
 * Nine of nineteen roles were granted only that surface's tool names and NOT
 * `mcp`, the only route to Hive knowledge. At runtime those tool names did not
 * exist, so the roles silently had **no knowledge access at all** and fell back
 * to `grep`.
 * Among them were `research` and `retriever` — the two roles the global
 * AGENTS.md routes every context-gathering task to.
 *
 * Nothing caught it: pi drops unknown `--tools` names silently, and role
 * frontmatter is an unvalidated string. Same shape as that stand-down itself — a
 * capability declared by name, never checked against reality. The local surface
 * is now gone entirely; these are the only knowledge tools.
 *
 * ## Why these are native rather than an `mcp` grant
 *
 * Granting the nine roles the `mcp` proxy would have worked and been a smaller
 * diff, but it hands a read-only `retriever` every other configured
 * server too and pays the proxy's schema in every worker. Native tools are the
 * narrow grant.
 *
 * Transport and the provenance argument live in `hive-common/mcp.ts`: these call
 * Hive's MCP endpoint rather than its REST knowledge routes because only the MCP
 * handlers record the session provenance that fills the `/agents` knowledge rail,
 * and because `knowledge_multi_get` has no REST route at all.
 *
 * ## Naming
 *
 * The tool names match the MCP server's exactly, so skill bodies, learned
 * reflexes and role prompts referring to `knowledge_search` keep working
 * verbatim whether they run in the main session (through the adapter) or in a
 * worker (through these).
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveAuth } from "./hive-common/identity.ts";
import { callMcpTool } from "./hive-common/mcp.ts";

/** Generous: a knowledge search crosses the tailnet and fans out server-side. */
const TIMEOUT_MS = 45_000;

/**
 * The session id for `/agents` provenance.
 *
 * `hive-telemetry` already exports this for pi-mcp-adapter's `${PI_HIVE_RUN_ID}`
 * header, and subagent/orchestrate spawn children with `{...process.env}` — so a
 * worker inherits its parent's run id and its knowledge reads attribute to the
 * session that delegated the work. No extra plumbing, and read per call rather
 * than captured, because telemetry sets it after `/hive-login` mid-session.
 */
function sessionId(): string | undefined {
	const id = process.env.PI_HIVE_RUN_ID?.trim();
	return id || undefined;
}

function text(s: string, isError = false) {
	return { content: [{ type: "text" as const, text: s }], details: {}, ...(isError ? { isError: true } : {}) };
}

export default function (pi: ExtensionAPI) {
	// No Hive credential on this machine → register nothing. A tool that would
	// fail on every call is worse than an absent one: the model spends a turn
	// discovering what the harness already knew at startup.
	const auth = resolveAuth();
	if (!auth) return;

	const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
		const res = await callMcpTool(auth, name, args, { sessionId: sessionId(), timeoutMs: TIMEOUT_MS, signal });
		if (!res.ok) {
			// Name the tool and the cause. A knowledge tool that fails silently
			// teaches an agent the KB is empty, which is worse than an error.
			return text(`${name} failed: ${res.error ?? "unknown error"}`, true);
		}
		return text(res.text || "(no results)");
	};

	pi.registerTool({
		name: "knowledge_search",
		label: "Knowledge search",
		promptSnippet: "Hybrid search over the knowledge base",
		description:
			"Hybrid search (lexical + semantic, rank-fused) over your knowledge collections. This is the " +
			"DEFAULT way to consult the knowledge base — prefer it over grepping the filesystem. " +
			"Few terms beat many: the lexical arm ANDs, so a 6-word question can return nothing where " +
			"2-3 keywords return the right document.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query — a few keywords, not a sentence" }),
			collections: Type.Optional(
				Type.Array(Type.String(), { description: "Restrict to these collections (default: all visible)" }),
			),
			limit: Type.Optional(Type.Number({ description: "Max hits (default 20, cap 50)" })),
			include_dormant: Type.Optional(
				Type.Boolean({ description: "Also return archived/decaying memories that default search hides" }),
			),
		}),
		execute: (_id, params, signal) => call("knowledge_search", params, signal),
	});

	pi.registerTool({
		name: "knowledge_grep",
		label: "Knowledge grep",
		promptSnippet: "Regex over the knowledge base's raw markdown",
		description:
			"Case-insensitive regex over the raw markdown of your knowledge collections. Use this for an " +
			"exact token — an error string, a flag, a ticket key — where search's ranking would bury it.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regular expression (case-insensitive)" }),
			collections: Type.Optional(Type.Array(Type.String(), { description: "Restrict to these collections" })),
			limit: Type.Optional(Type.Number({ description: "Max matching documents (default 20, cap 50)" })),
		}),
		execute: (_id, params, signal) => call("knowledge_grep", params, signal),
	});

	pi.registerTool({
		name: "knowledge_get",
		label: "Knowledge get",
		promptSnippet: "Read one knowledge document",
		description:
			"Read ONE full knowledge document by collection + path, as returned by knowledge_search or " +
			"knowledge_grep. Use after a search to read a promising hit in full.",
		parameters: Type.Object({
			collection: Type.String({ description: "Collection name" }),
			path: Type.String({ description: "Document path within the collection" }),
		}),
		execute: (_id, params, signal) => call("knowledge_get", params, signal),
	});

	pi.registerTool({
		name: "knowledge_multi_get",
		label: "Knowledge multi-get",
		promptSnippet: "Read several knowledge documents at once",
		description:
			"Read SEVERAL documents from one collection: a comma-separated list of exact paths, or a glob " +
			"with * and ?. `pattern` is a GLOB, not a list of paths under another name.",
		parameters: Type.Object({
			collection: Type.String({ description: "Collection name" }),
			pattern: Type.String({ description: "Comma-separated exact paths, or a glob with * and ?" }),
			limit: Type.Optional(Type.Number({ description: "Max documents (default 10, cap 20)" })),
		}),
		execute: (_id, params, signal) => call("knowledge_multi_get", params, signal),
	});

	pi.registerTool({
		name: "knowledge_collections",
		label: "Knowledge collections",
		promptSnippet: "List visible knowledge collections",
		description:
			"Your visible knowledge collections with doc counts and sync freshness. Use it when you do not " +
			"know which collection holds what, or to check whether an expected collection is visible at all.",
		parameters: Type.Object({}),
		execute: (_id, _params, signal) => call("knowledge_collections", {}, signal),
	});
}
