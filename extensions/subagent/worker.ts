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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { ensureWorkerMcpConfig } from "../mcp-common/config.ts";

/**
 * Extensions a worker loads explicitly.
 *
 * Keep this list SHORT and justify each entry: everything here runs in every
 * delegated worker, and an extension that registers a hook (rather than plain
 * tools) would put that hook in the worker's loop, which `--no-extensions`
 * exists to prevent.
 *
 * - `knowledge-tools.ts` — registers tools only, no hooks. It is the sole
 *   knowledge path a worker has: the `mcp` adapter is itself an extension that
 *   `--no-extensions` strips.
 * - `edit-common/rowtool.ts` (HIV-1884) — the row-script `edit` override. THIS
 *   LIST IS THE WORKER-SCOPING MECHANISM: because `--no-extensions` strips
 *   everything else, naming it here is what makes the format reach workers
 *   *without* reaching the orchestrator, whose model is post-trained on its
 *   native `apply_patch` and where the expected delta is small or negative.
 *   It is additionally opt-in (`enabled === true`), so listing it here changes
 *   nothing until the flag is set.
 * - `opmode/index.ts` and `workflow/index.ts` — the explicit, reviewed
 *   exception to the no-hooks default for `bugfix` workers. Opmode observes
 *   tool results to bind evidence; workflow projects the same state into the
 *   visible protocol. Their hooks are necessary enforcement, not ambient
 *   policy, and `test/subagent-worker.test.ts` pins this pair as the only
 *   owned hook-bearing worker extensions.
 */
const WORKER_EXTENSIONS = [
	"../knowledge-tools.ts",
	"../edit-common/rowtool.ts",
	"../opmode/index.ts",
	"../workflow/index.ts",
];

/**
 * Extensions that are installed PACKAGES rather than files in this repo.
 *
 * `pi-mcp-adapter` provides `mcp` and `mcpScript`. Six roles grant them and
 * name `mcp__<server>__<tool>` calls in their bodies, and every one of those
 * grants was silently dropped: the adapter is an extension, `--no-extensions`
 * strips it, and pi discards an unknown `--tools` name without a word. A
 * delegated `incident-responder` could not reach sentry — it proceeded without
 * the data (HIV-1581).
 *
 * The cost is real and accepted rather than hidden: the adapter registers
 * `session_start`, `session_shutdown` and `tool_result` hooks, so those now run
 * in every delegated worker, which is the sort of thing `--no-extensions`
 * exists to prevent. What makes it tolerable is that connections are LAZY —
 * `startLoadTimeInitialization` returns immediately unless a server declares
 * `lifecycle: eager|keep-alive`. A worker that never calls `mcp` pays for a
 * config parse and a metadata-cache read, not for five MCP servers.
 *
 * REVISITED 2026-08-16 (HIV-1969), on precisely the trigger this comment named.
 * `hive` and `linear` are now `eager` in the workstation config, because a
 * prewarmed connection removes a mid-task stall the human waits through. That
 * is right for an interactive session and wrong for a worker: one bounded task,
 * often eight at once, and `linear` spawns an `npx` subprocess per connection.
 * So the lifecycle is a property of the session KIND, not of the server, and
 * workers are handed a derived config with every prewarming lifecycle stripped
 * (`mcp-common/config.ts`). If that derivation returns null the worst case is
 * the behaviour this comment warned about — never a failed delegation.
 */
const WORKER_PACKAGE_EXTENSIONS = [
	{
		spec: "pi-mcp-adapter/index.ts",
		/**
		 * The tools this package contributes, DECLARED — because the package is
		 * installed into pi's agent dir and is absent from a CI container, where
		 * the tool-universe test would otherwise derive a smaller universe and
		 * blame six roles for it.
		 *
		 * This is not taken on trust. Wherever the package IS resolvable — any
		 * machine that actually runs workers — the test reads its source and
		 * fails if this list and the registrations disagree. The declaration is
		 * the contract in the one environment that cannot check it, and checked
		 * everywhere it can be.
		 */
		provides: ["mcp", "mcpScript"],
	},
];

/**
 * Absolute paths, resolved from this module rather than from cwd — a worker is
 * spawned with the TARGET repo as cwd, which is not where hive-pi lives.
 *
 * A package extension that is not installed is SKIPPED rather than passed to
 * `-e`, because pi treats an unresolvable `-e` as a hard error and that would
 * break every delegation on a machine without the adapter. The tool-universe
 * test asserts the adapter is present here, so its absence cannot pass
 * unnoticed on a machine that does have it.
 */
export function workerExtensionPaths(): string[] {
	const paths = WORKER_EXTENSIONS.map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
	for (const pkg of WORKER_PACKAGE_EXTENSIONS) {
		const resolved = packageExtensionPath(pkg.spec);
		if (resolved) paths.push(resolved);
	}
	return paths;
}

/** Where an installed package extension lives, or null when it is not installed. */
export function packageExtensionPath(spec: string): string | null {
	const resolved = join(getAgentDir(), "npm", "node_modules", spec);
	return existsSync(resolved) ? resolved : null;
}

/** What each package extension contributes, for environments that cannot read it. */
export function workerPackageExtensions(): readonly { spec: string; provides: readonly string[] }[] {
	return WORKER_PACKAGE_EXTENSIONS;
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
 * removed: with the adapter restored there is no known parent-only tool, so a
 * dispatch-time check would have been an empty list behind a branch that could
 * never fire — the "declared but inert" shape this wave exists to delete.
 */
export function buildSubagentWorkerArgs(
	model: string | undefined,
	tools: string[] | undefined,
	/**
	 * A config with every prewarming lifecycle stripped (HIV-1969). Null when
	 * nothing prewarms, in which case no flag is passed and the worker reads
	 * exactly what the adapter would have read on its own.
	 */
	mcpConfigPath: string | null = ensureWorkerMcpConfig(),
	opMode?: string,
): string[] {
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	for (const path of workerExtensionPaths()) args.push("-e", path);
	if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
	if (model) args.push("--model", model);
	if (opMode) args.push("--op-mode", opMode);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));
	return args;
}
