/**
 * mcp-products — register a project's own MCP servers only in that project.
 *
 * pi's built-in MCP connects every enabled server in `mcp.json` when a session
 * starts; it has no lazy lifecycle (pi-mcp-adapter's `lazy-keep-alive` is gone,
 * HIV-3745). For an HTTP server that is one request. For a PRODUCT server —
 * asfam's node bundle, freecad's `uv run` — it is a process tree, spawned in
 * every interactive session on the machine whatever the checkout, for tools
 * that only one project uses (HIV-2639 is the same mismatch, seen from the
 * readiness card).
 *
 * So product servers are not in `mcp.json`. Their definitions live in the house
 * profile (`productMcpServers`), next to the project→server mapping that already
 * said who owns them, and this extension registers a server with
 * `pi.registerMcpServer` — pi's documented route for "servers based on the
 * extension's own settings" — only when the session's checkout belongs to its
 * project. A launched agent gets the same answer from the same files: its agent
 * dir mirrors the house profile, and its cwd is the project worktree.
 *
 * Workers never load this extension (subagent/worker.ts allowlist), so a
 * delegation never spawns a product server either.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { houseProfile, projectFor, type HouseProfile } from "../profile-common/profile.ts";

type ServerConfig = Parameters<ExtensionAPI["registerMcpServer"]>[1];

/** The product servers a checkout should have, with their definitions. */
export function productServersFor(cwd: string, profile: HouseProfile = houseProfile()): [string, ServerConfig][] {
	const project = projectFor(cwd, profile);
	if (!project) return [];
	const out: [string, ServerConfig][] = [];
	for (const name of project.mcpServers ?? []) {
		const def = profile.productMcpServers?.[name];
		if (def && typeof def === "object") out.push([name, def as unknown as ServerConfig]);
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	if (typeof pi.registerMcpServer !== "function") return; // pi < 0.99: nothing to register into
	for (const [name, config] of productServersFor(process.cwd())) {
		try {
			pi.registerMcpServer(name, config);
		} catch (err) {
			// An invalid definition or a name another extension owns. pi reports
			// it; one product server must not take the session's others down.
			console.warn(`mcp-products: could not register "${name}": ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
