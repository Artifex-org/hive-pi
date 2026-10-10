import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { agentDir } from "../mcp-common/config.ts";
import { canonicalMcpToolName } from "../mcp-common/names.ts";
import { callGateway, loadGatewayRuntime, gatewayToolVerdict } from "../mcp-common/gateway.ts";
import { OP_MODE_STATE_CHANNEL, PLAN_MODE_STATE_CHANNEL, type OpModeStateEvent, type PlanModeStateEvent } from "../hive-common/channels.ts";
import { isOpMode, type OpMode } from "../opmode/modes.ts";

export default function (pi: ExtensionAPI) {
	let mode: OpMode = "plan", planActive = false;
	const controllers = new Map<AbortController, Record<string, unknown> | undefined>();
	const calls = new Set<Promise<unknown>>();
	const effectiveMode = () => planActive ? "plan" : mode;
	const cancelDenied = () => {
		for (const [controller, bound] of controllers) {
			if (bound && !gatewayToolVerdict(effectiveMode(), bound).allowed) controller.abort(new Error("MCP posture changed"));
		}
	};
	pi.events.on(OP_MODE_STATE_CHANNEL, payload => {
		const state = payload as OpModeStateEvent;
		if (isOpMode(state.mode) && state.mode !== mode) { mode = state.mode; cancelDenied(); }
	});
	pi.events.on(PLAN_MODE_STATE_CHANNEL, payload => {
		const state = payload as PlanModeStateEvent;
		const active = state.readOnly ?? state.active;
		if (active !== planActive) { planActive = active; cancelDenied(); }
	});
	pi.on("session_shutdown", async () => {
		for (const controller of controllers.keys()) controller.abort(new Error("MCP session closed"));
		await Promise.allSettled([...calls]);
	});
	registerGuardedTool(pi, {
		name: "mcp", label: "MCP gateway",
		capability: { executes: true, writesExemptBecause: "Native authentication may run trusted configured credential helpers and update its OAuth store; HTTP RPC uses the exact mode policy, stdio servers are never spawned, and result spills are native temporary artifacts, not repository content." },
		description: "Call one configured MCP tool by canonical or native spelling, with raw server/tool binding. Restricted modes allow only reviewed reads or fixed coordination. HTTP only; OAuth sign-in remains in Pi /mcp. Discovery/auth actions are unsupported.",
		parameters: Type.Object({ tool: Type.String(), server: Type.Optional(Type.String()), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
		async execute(_id, input, signal, onUpdate, ctx) {
			const controller = new AbortController(); controllers.set(controller, undefined);
			const task = (async () => {
				try {
					const modules = await loadGatewayRuntime(import.meta.resolve("@earendil-works/pi-coding-agent"));
					const result = await callGateway(input, {
						agentDir: agentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), mode: planActive ? "plan" : mode,
						currentMode: effectiveMode,
						onBound: bound => { controllers.set(controller, bound); },
						onProgress: progress => onUpdate?.({ content: [{ type: "text", text: progress.message ?? `Progress ${progress.progress}` }], details: undefined }),
						signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]),
						providerToken: provider => ctx.modelRegistry.getApiKeyForProvider(provider),
					}, modules);
					const canonical = canonicalMcpToolName(input.tool);
					return modules.tools.convertMcpResult(canonical.slice(0, canonical.indexOf("_")), canonical.slice(canonical.indexOf("_") + 1), result);
				} catch (error) {
					const reason = controller.signal.aborted && controller.signal.reason instanceof Error ? `${controller.signal.reason.message} ` : "";
					return { content: [{ type: "text" as const, text: reason + (error instanceof Error ? error.message : String(error)) }], details: undefined, isError: true };
				}
			})();
			calls.add(task);
			try { return await task; } finally { calls.delete(task); controllers.delete(controller); }
		},
	});
}
