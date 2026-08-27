import { mcpLaunchers, projectFor } from "../profile-common/profile.ts";

/**
 * MCP readiness helpers: which configured servers belong to THIS session,
 * and whether a stdio server can actually be spawned.
 *
 * The adapter's config is GLOBAL (`~/.pi/agent/mcp.json`). That is a real
 * choice — a ticket tracker or an error reporter is useful from any checkout —
 * but some entries are a *product*: they talk to ONE project's backend, and a
 * session in a different checkout that reports "mcp <other-product> · 353
 * tools" is describing another project's cache, not itself. HIV-2639.
 *
 * WHICH servers those are is not knowable here. It comes from the house
 * profile (`profile-common/profile.ts`); with no profile nothing is a product
 * server and every configured server is reported everywhere, which is the right
 * answer for a machine that has not been told otherwise.
 *
 * Spawnability is a separate lie. A product server typically looks for a built
 * artefact inside its own checkout; when that file is gone the adapter cannot
 * connect, and "no cached tool list — the first call will discover it" is the
 * opposite of what happens (exit 1). A row that has not checked the entrypoint
 * is guessing.
 */

/**
 * The project a checkout belongs to, by the house profile's own tokens — the
 * SAME lookup `brief/lanes.ts` uses, so one worktree cannot be classified two
 * ways by two drifting matchers. `null` for an unmapped checkout.
 */
export function projectKind(cwd: string): string | null {
	return projectFor(cwd)?.token ?? null;
}

/**
 * False only for a product MCP whose project is not the cwd. Servers no project
 * claims — and every server when there is no profile — belong everywhere.
 */
export { mcpBelongsHere } from "../profile-common/profile.ts";

export interface McpServerDef {
	lifecycle?: string;
	command?: unknown;
	args?: unknown;
	url?: unknown;
	[key: string]: unknown;
}

/**
 * Local files a stdio spawn will try. Empty means there is nothing on disk to
 * check (HTTP, `npx`, mcp-remote) and spawnability is not this probe's job.
 *
 * Expands `$HOME` / `~` and a `for p in "a" "b"` loop the way the house's
 * borealis/aurorasvc entries are written. It does not run the shell.
 */
export function stdioEntrypoints(def: McpServerDef, home: string): string[] {
	if (typeof def.url === "string" && def.url) return [];
	const parts = [def.command, ...(Array.isArray(def.args) ? def.args : [])].filter(
		(p): p is string => typeof p === "string",
	);
	if (parts.length === 0) return [];
	const blob = parts.join("\n").replaceAll("$HOME", home).replaceAll(/~(?=\/)/g, home);

	const loops: { name: string; values: string[] }[] = [];
	for (const m of blob.matchAll(/for\s+(\w+)\s+in\s+((?:"[^"]+"\s*)+)/g)) {
		loops.push({ name: m[1], values: [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]) });
	}

	const quoted = [...blob.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	const out = new Set<string>();
	for (const raw of quoted) {
		if (!looksLikeFile(raw) && !isLoopRelative(raw, loops)) continue;
		const expanded = expandLoopVar(raw, loops);
		for (const path of expanded) {
			if (looksLikeFile(path)) out.add(path);
		}
	}
	return [...out];
}

function isLoopRelative(value: string, loops: { name: string }[]): boolean {
	return loops.some((loop) => value.includes(`$${loop.name}`));
}

function expandLoopVar(value: string, loops: { name: string; values: string[] }[]): string[] {
	for (const loop of loops) {
		const token = `$${loop.name}`;
		if (!value.includes(token)) continue;
		return loop.values.map((base) => value.split(token).join(base));
	}
	return [value];
}

function looksLikeFile(value: string): boolean {
	if (!value.includes("/")) return false;
	if (/\s/.test(value)) return false;
	if (/\.(?:js|mjs|cjs)$/.test(value)) return true;
	// An extensionless launcher is only recognisable as a file if the profile
	// named it. With no profile this returns false, and the probe reports
	// "cannot tell" rather than inventing a missing entrypoint.
	return launcherProduct(value) !== null;
}

function launcherProduct(path: string): string | null {
	for (const launcher of mcpLaunchers()) {
		if (new RegExp(`(^|/)${launcher.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(path)) {
			return launcher;
		}
	}
	return null;
}

function launcherSeeds(path: string, home: string): string[] {
	const product = launcherProduct(path);
	if (!product) return [];
	const dir = path.replace(/\/[^/]+$/, "");
	return [`${home}/.local/share/${product}/current.js`, `${dir}/../dist/mcp-server.js`];
}

/**
 * Why a stdio server cannot start, or null when this probe cannot tell
 * (HTTP / npx) or when at least one candidate is actually runnable.
 *
 * A launcher shim is not enough: the ones this pattern exists for copy
 * `../dist/mcp-server.js` into `~/.local/share/<product>/current.js` on first
 * run, and exit 1 if neither exists. Reporting the launcher as present is how a
 * product server became "the first call will discover it" while every connect
 * failed.
 */
export function stdioMissing(
	def: McpServerDef,
	home: string,
	exists: (path: string) => boolean,
): string[] | null {
	const candidates = stdioEntrypoints(def, home);
	if (candidates.length === 0) return null;
	const missing: string[] = [];
	for (const path of candidates) {
		if (!exists(path)) {
			missing.push(path);
			continue;
		}
		const seeds = launcherSeeds(path, home);
		if (seeds.length === 0) return null;
		if (seeds.some((seed) => exists(seed))) return null;
		missing.push(...seeds);
	}
	return missing.length > 0 ? [...new Set(missing)] : null;
}
