import { callGateway, loadGatewayRuntime } from "../../extensions/mcp-common/gateway.ts";
import { readControl, DEFAULT_CONTROL } from "../state.ts";
import { stateDir, type AdapterEnv } from "../env.ts";
import { piPackageRoot } from "../pi-runtime.ts";
import type { ToolResult } from "./protocol.ts";

export async function dispatchNativeMcp(env: AdapterEnv, cwd: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
	if (!env.piAgentDir || !env.piBin) return { text: "MCP gateway requires HIVE_PI_AGENT_DIR and HIVE_PI_BIN; no machine-level fallback is used.", isError: true };
	try {
		const dir = stateDir(env);
		const currentMode = () => (dir ? readControl(dir) : DEFAULT_CONTROL).opMode;
		const mode = currentMode();
		const modules = await loadGatewayRuntime(piPackageRoot(env.piBin));
		const { result, server, tool } = await callGateway(input, { agentDir: env.piAgentDir, cwd, projectTrusted: false, mode, currentMode, signal }, modules);
		const converted = await modules.tools.convertMcpResult(server, tool, result);
		return {
			text: converted.content.filter(part => part.type === "text").map(part => part.text).join("\n"),
			images: converted.content.filter(part => part.type === "image").map(part => ({ data: part.data, mimeType: part.mimeType })),
			isError: result.isError,
		};
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), isError: true };
	}
}
