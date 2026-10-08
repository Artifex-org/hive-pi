import { discoverAgents, resolveAgent, selectableAgents, type AgentScope } from "../harness/roles.ts";
import { nativeToolGrants, workerExtensionPaths, workerNeedsMcp, WORKER_BUILTIN_MCP_EXTENSIONS } from "../subagent/worker.ts";

/** Configuration evidence only: never build an MCP mirror or launch a worker. */
export function inspectRole(cwd: string, scope: AgentScope, name: string, trusted: boolean, registry: readonly string[] | null) {
	const discovery = discoverAgents(cwd, scope);
	const requested = resolveAgent(discovery.agents, name);
	if (requested?.source === "project" && !trusted) {
		throw new Error("Project-local role withheld: this project is not trusted.");
	}
	const role = resolveAgent(selectableAgents(discovery.agents, trusted), name);
	if (!role) throw new Error(`Unknown or withheld role: ${name}`);
	// Missing/empty tools means no --tools argument, NOT an empty tool set.
	const grants = role.tools?.length ? nativeToolGrants(role.tools) : null;
	const observed = registry !== null && registry.length > 0;
	return {
		role: { name: role.name, aliases: role.aliases ?? [], source: role.source, filePath: role.filePath },
		declaredTools: role.tools ?? null,
		translatedGrants: grants,
		parentRegistration: {
			status: observed ? "observed" : "unknown",
			tools: grants?.map((name) => ({ name, status: observed ? (registry?.includes(name) ? "registered" : "not_registered") : "unknown" })) ?? [],
		},
		worker: {
			toolSelection: grants ? "explicit_grants" : "default",
			extensionPaths: workerExtensionPaths(),
			builtinExtensions: workerNeedsMcp(role.tools) ? [...WORKER_BUILTIN_MCP_EXTENSIONS] : [],
			mcp: workerNeedsMcp(role.tools) ? "configured" : "not_configured",
			registration: "unknown",
			serviceHealth: "unknown",
		},
	};
}

export function renderRoleInspection(report: ReturnType<typeof inspectRole>): string {
	return [
		`Role ${report.role.name} (${report.role.source}) — ${report.role.filePath}`,
		`Declared tools: ${report.declaredTools?.join(", ") || "no explicit restriction (worker defaults)"}`,
		`Translated grants: ${report.translatedGrants?.join(", ") || "worker defaults; not enumerated"}`,
		`Parent registrations (${report.parentRegistration.status}): ${report.parentRegistration.tools.map((tool) => `${tool.name}=${tool.status}`).join(", ") || "not enumerated"}`,
		`Configured worker extensions: ${report.worker.extensionPaths.join(", ")}`,
		`Worker MCP: ${report.worker.mcp}; built-ins: ${report.worker.builtinExtensions.join(", ") || "none"}`,
		"Worker registration and service health: unknown. Parent registration is not worker availability, authentication, permission, or service-health evidence.",
		"Inspection only: no worker, MCP mirror, probe, or model call was started. Role prompt content is not included; inspection does not grant permission to run it.",
	].join("\n");
}
