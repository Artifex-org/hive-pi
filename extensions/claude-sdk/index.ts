/** Discovery entry: no SDK import, lease or child process unless explicitly enabled. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { launchConfig } from "./runtime.ts";

export default async function claudeSdk(pi: ExtensionAPI): Promise<void> {
	const config = launchConfig(process.env, process.cwd());
	if (!config) return;
	const { createClaudeSdkRuntime } = await import("./provider.ts");
	let runtime = createClaudeSdkRuntime(config);
	pi.registerProvider(runtime.provider);
	// Registering is side-effect free. Real resources start at the first model request.
	const reset = async () => {
		await runtime.close();
		runtime = createClaudeSdkRuntime(config);
		pi.registerProvider(runtime.provider);
	};
	pi.on("session_shutdown", async () => { await runtime.close(); });
	pi.on("session_start", reset);
	pi.on("session_compact", reset);
	pi.on("session_tree", reset);
	pi.on("model_select", reset);
}
