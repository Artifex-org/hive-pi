/**
 * The argv a subagent worker is spawned with.
 *
 * `--no-extensions` is deliberate: a worker must not run agenda policies, must
 * not re-enter its own loop, and must not inherit the interactive session's
 * context pack. But it is a blunt instrument — it also strips the extensions a
 * worker genuinely needs, and pi drops an unknown name from `--tools` SILENTLY,
 * so the loss shows up as a role that simply never used the tool.
 *
 * That is not hypothetical. Nine roles were granted only the names of a local
 * fallback stood down against a reachable Hive brain, and those roles ran with
 * no knowledge access at all — `research` and `retriever` among them. Fixing the
 * grants was not enough: the native `knowledge_*` tools live in an extension,
 * and `--no-extensions` meant a worker could not see those either. Measured:
 * a worker spawned with exactly these args and `--tools read,grep,knowledge_search`
 * reported its tools as `read, grep`.
 *
 * So the shape is `--no-extensions` PLUS an explicit allowlist of `-e` paths —
 * the same pattern the Code Factory uses (HIV-887: "disable implicit extension
 * discovery while preserving lane coverage with explicit repeated -e"). Adding
 * to WORKER_EXTENSIONS is how a capability becomes available to roles; nothing
 * else in `extensions/` loads.
 */

import { fileURLToPath } from "node:url";

import { ensureWorkerAgentDir } from "../mcp-common/config.ts";

/**
 * Extensions a worker loads explicitly.
 *
 * Keep this list SHORT and justify each entry: everything here runs in every
 * delegated worker, and an extension that registers a hook (rather than plain
 * tools) would put that hook in the worker's loop, which `--no-extensions`
 * exists to prevent.
 *
 * - `knowledge-tools.ts` — registers tools only, no hooks. A worker's knowledge
 *   path that does not depend on MCP being granted or connected.
 * - `edit-common/rowtool.ts` (HIV-1884) — the row-script `edit` override. THIS
 *   LIST IS THE WORKER-SCOPING MECHANISM: because `--no-extensions` strips
 *   everything else, naming it here is what makes the format reach workers
 *   *without* reaching the orchestrator, whose model is post-trained on its
 *   native `apply_patch` and where the expected delta is small or negative.
 *   It is additionally opt-in (`enabled === true`), so listing it here changes
 *   nothing until the flag is set.
 * - `opmode/index.ts` — the explicit, reviewed exception to the no-hooks
 *   default for `bugfix` workers. It observes tool results to bind evidence:
 *   necessary enforcement, not ambient policy, and
 *   `test/subagent-worker.test.ts` pins it as the only owned hook-bearing
 *   worker extension.
 *
 *   `workflow/index.ts` stood beside it until HIV-2904 merged that document
 *   into the plan, and it is NOT replaced by `plan/index.ts`. The reason is a
 *   real difference rather than an oversight: the workflow extension carried
 *   one narrow projection, while the plan extension carries plan-MODE
 *   enforcement — a `tool_call` denial hook and a read-only posture — and
 *   loading that into a worker would let a subagent inherit or enter a mode
 *   nobody reviewed it for. So bugfix workers lose the workflow projection for
 *   now. Restoring it means extracting the tool registration into a hook-free
 *   module a worker can load, which is a deliberate follow-up and not a thing
 *   to do by widening this list.
 * - `meta-media/provider-only.ts` — registers the `meta` PROVIDER only, no
 *   tools, no hooks. `meta` has no models.json entry, so a worker without it
 *   resolves `meta/muse-spark-*` by bare id — which the OpenRouter catalogue
 *   also carries — and every delegation on the fleet's meta `low` rung died on
 *   OpenRouter's `404 … Paid model training violation` while readiness said
 *   ready (22 papercuts, 2026-09-20..22). Any provider that exists only via
 *   `registerProvider` must be listed here for workers to run on it.
 * - `fast/worker.ts` — OpenAI Fast mode for delegations, when the launch sets
 *   `PI_SUBAGENT_FAST=1` (otherwise it returns before registering anything). It
 *   wraps the OpenAI providers only — no tools, no commands — and needs ONE hook,
 *   session_start, because the model registry is unreachable before a ctx
 *   exists. Without it a delegation could never run at the priority tier, since
 *   the parent's wrapped provider lives in the parent's process.
 */
const WORKER_EXTENSIONS = [
	"../knowledge-tools.ts",
	"../edit-common/rowtool.ts",
	"../opmode/index.ts",
	"../meta-media/provider-only.ts",
	"../fast/worker.ts",
];

/**
 * pi's built-in MCP support, loaded explicitly into workers that can reach MCP.
 *
 * Since pi 0.99, `--no-extensions` also strips the built-in extensions, so a
 * worker has no MCP unless these are named. Together they replace what
 * `pi-mcp-adapter` gave workers (HIV-1581, HIV-3745):
 *
 * - `builtin:mcp` — connects the servers in the worker's `mcp.json`. That file
 *   is the HTTP-only mirror `mcp-common/config.ts` builds (no lazy lifecycle
 *   exists natively, so the mirror is what keeps a fan-out of eight from
 *   spawning eight copies of every stdio server).
 * - `builtin:codemode` — the `codemode` tool: scripts call MCP tools (default
 *   exposure) and built-ins, in parallel, and every nested call still passes the
 *   `tool_call` pipeline.
 * - `builtin:tool-search` — `tool_search`, for servers with `deferred` exposure.
 */
export const WORKER_BUILTIN_MCP_EXTENSIONS = ["builtin:mcp", "builtin:codemode", "builtin:tool-search"] as const;

/** The tools the built-ins contribute: what a role must grant to reach MCP. */
export const NATIVE_MCP_TOOLS = ["codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] as const;

/**
 * pi-mcp-adapter's tool names, still granted by role files written for it.
 * `mcp` was the proxy (search, describe, call) and `mcpScript` ran a script —
 * `codemode` is the native form of both, and `tool_search` of the discovery
 * half. Translated rather than rejected so a role file and this package can be
 * updated in either order without silently stripping a worker's MCP.
 */
const LEGACY_MCP_GRANTS: Record<string, readonly string[]> = {
	mcp: ["codemode", "tool_search"],
	mcpScript: ["codemode"],
};

/** A role's `--tools` list in native terms: legacy MCP grants translated, order kept, no duplicates. */
export function nativeToolGrants(tools: readonly string[]): string[] {
	const out: string[] = [];
	for (const tool of tools) {
		for (const name of LEGACY_MCP_GRANTS[tool] ?? [tool]) if (!out.includes(name)) out.push(name);
	}
	return out;
}

/**
 * Does this worker need MCP at all? An unrestricted worker (no `--tools`) gets
 * every tool, so yes; a restricted one only when it grants a native MCP tool
 * (after translation). A worker that cannot reach MCP gets no built-in and no
 * mirror — zero connections, which is the cheapest correct answer.
 */
export function workerNeedsMcp(tools: readonly string[] | undefined): boolean {
	if (!tools || tools.length === 0) return true;
	const grants = nativeToolGrants(tools);
	return grants.some((t) => (NATIVE_MCP_TOOLS as readonly string[]).includes(t) || t.startsWith("mcp__"));
}

/**
 * Absolute paths, resolved from this module rather than from cwd — a worker is
 * spawned with the TARGET repo as cwd, which is not where hive-pi lives.
 */
export function workerExtensionPaths(): string[] {
	return WORKER_EXTENSIONS.map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
}

/**
 * The environment a worker needs on top of the parent's: an agent dir whose
 * `mcp.json` is the HTTP-only mirror. Empty when the worker has no MCP or the
 * mirror could not be built (the worker then reads the parent's config — some
 * extra connects, never a failed delegation).
 */
export function workerMcpEnv(tools: readonly string[] | undefined, mirror: () => string | null = ensureWorkerAgentDir): Record<string, string> {
	if (!workerNeedsMcp(tools)) return {};
	const dir = mirror();
	return dir ? { PI_CODING_AGENT_DIR: dir } : {};
}

/**
 * WHAT ENFORCES THIS: `test/worker-tool-universe.test.ts`.
 *
 * It derives the worker's real tool set — pi's own tool factories plus whatever
 * the extensions above register — and fails when any role grants something
 * outside it. Derived rather than listed, deliberately: a hardcoded list of
 * "tools a worker lacks" would go stale exactly the way the role grants did,
 * and the failure mode is silence in both directions.
 *
 * That test is the reason this file has no runtime guard. One was written and
 * removed: with the MCP built-ins loaded there is no known parent-only tool, so a
 * dispatch-time check would have been an empty list behind a branch that could
 * never fire — the "declared but inert" shape this wave exists to delete.
 */
export function buildSubagentWorkerArgs(
	model: string | undefined,
	tools: string[] | undefined,
	opMode?: string,
): string[] {
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	for (const path of workerExtensionPaths()) args.push("-e", path);
	if (workerNeedsMcp(tools)) for (const builtin of WORKER_BUILTIN_MCP_EXTENSIONS) args.push("-e", builtin);
	if (model) args.push("--model", model);
	if (opMode) args.push("--op-mode", opMode);
	if (tools && tools.length > 0) args.push("--tools", nativeToolGrants(tools).join(","));
	return args;
}
