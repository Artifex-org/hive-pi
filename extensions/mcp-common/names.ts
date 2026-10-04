/**
 * MCP tool names across the two clients this harness has run.
 *
 * pi-mcp-adapter promoted a server tool as `<server>_<tool>` (`hive_get_run`,
 * `asfam_asfam_deploy_last`). pi's built-in MCP registers it as
 * `mcp__<server>__<tool>` (`mcp__hive__get_run`), with every character other
 * than letters, digits and `_` replaced by `_` (docs/mcp.md §Configuration
 * rules).
 *
 * Every reviewed list in this harness — plan/discussion/orchestrate allowlists,
 * the house profile's `readOnlyMcpTools` — is keyed by the adapter form. A
 * rename that misses one list fails CLOSED and SILENTLY: the mode simply
 * denies the coordination verb it exists to permit (session cb62a18c is that
 * failure on the old envelope). So lookups canonicalise instead: a native name
 * is mapped to the adapter form before any list is consulted, and both forms
 * are honoured for as long as either client can be running.
 */

const NATIVE = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/;

/** `mcp__hive__get_run` → `hive_get_run`. Any other name is returned unchanged. */
export function canonicalMcpToolName(name: string): string {
	const match = NATIVE.exec(name);
	if (!match) return name;
	return `${match[1]}_${match[2]}`;
}

/** The server a native MCP tool name belongs to, or null for any other tool. */
export function nativeMcpServer(name: string): string | null {
	return NATIVE.exec(name)?.[1] ?? null;
}

/** `("hive", "get_run")` → `mcp__hive__get_run`, sanitised the way pi does. */
export function nativeMcpToolName(server: string, tool: string): string {
	const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
	return `mcp__${clean(server)}__${clean(tool)}`;
}
