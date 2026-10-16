/** Discovery entry: no SDK import, lease or child process unless explicitly enabled. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { launchConfig } from "./runtime.ts";

export default async function claudeSdk(pi: ExtensionAPI): Promise<void> {
	const config = launchConfig(process.env, process.cwd());
	if (!config) return;
	const { createClaudeSdkRuntime } = await import("./provider.ts");
	const replayProtection = new Set<string>();
	const pilot = config.pilot ? new (await import("./pilot-budget.ts")).PilotQueryBudget() : undefined;
	let runtime = createClaudeSdkRuntime(config, { replayProtection, pilot });
	pi.registerProvider(runtime.provider);
	let terminal = false;
	let transitions: Promise<void> = Promise.resolve();
	const reset = () => {
		const operation = transitions.then(async () => {
			if (terminal) throw new Error("Claude SDK lifecycle closed");
			await runtime.close();
			runtime = createClaudeSdkRuntime(config, { replayProtection, pilot });
			pi.registerProvider(runtime.provider);
		});
		transitions = operation.catch(() => { terminal = true; pilot?.close(); });
		return operation;
	};
	const close = async () => { terminal = true; await transitions; await runtime.close(); };
	const protocol = pilot ? (await import("./pilot.ts")).registerPilot(pi, config, pilot, reset, close) : undefined;
	pi.on("session_shutdown", async () => {
		protocol?.cancel(); pilot?.close();
		const closing = close();
		const outcomes = await Promise.allSettled([protocol ? protocol.observeCleanup(closing) : closing, protocol?.done()]);
		if (outcomes.some(result => result.status === "rejected")) throw new Error("Claude SDK lifecycle cleanup failed");
	});
	pi.on("session_start", reset);
	const changed = async () => { protocol?.cancel(); await reset(); };
	pi.on("session_compact", changed);
	pi.on("session_tree", changed);
	pi.on("model_select", changed);
}
