/** Native Meta provider + Hive's strict-tool override, without hooks or tools.
 * Workers with --no-extensions load this entry explicitly. The main session
 * registers the identical provider via meta-media/index.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hiveMetaProvider } from "./provider.ts";

export default function registerMetaProvider(pi: ExtensionAPI) {
	pi.registerProvider(hiveMetaProvider);
}
