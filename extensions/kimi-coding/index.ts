/** Native Kimi Code provider plus the K3.1 models pi does not ship yet.
 * Provider only — no tools, no hooks — so --no-extensions workers load this
 * same entry (subagent/worker.ts WORKER_EXTENSIONS).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hiveKimiProvider } from "./provider.ts";

export default function registerKimiProvider(pi: ExtensionAPI) {
	pi.registerProvider(hiveKimiProvider);
}
