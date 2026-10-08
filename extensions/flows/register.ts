import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Page } from "playwright-core";
import { Type } from "typebox";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { CAPTURABLE_CHANNEL } from "../pr-attachments/logic.ts";
import { SessionPublisher } from "../hive-common/session-publisher.ts";
import { createFlowRuntime, FLOW_TOOL_SPECS, type FlowOutput, type RecordedAction } from "./core.ts";

export {
	nextDevServerReport,
	probeLoopbackStatus,
	sourceFor,
	validateMaestroYAML,
	validatePlaywrightSource,
	type DevServerReport,
	type RecordedAction,
} from "./core.ts";

export interface FlowBrowserHost {
	page(): Promise<Page>;
}

const FLOW_CAPABILITY = {
	executes: true,
	writesExemptBecause: "Maestro validation and execution use only a per-process temporary file under /tmp",
};

function toolText(output: FlowOutput) {
	return { content: [{ type: "text" as const, text: output.text }], details: output.details };
}

/**
 * Register flow authoring/replay tools inside extensions/browser's own module
 * graph. Pi loads extension entrypoints with isolated caches, so this module is
 * intentionally imported by the browser extension rather than registered as a
 * second entrypoint: only that extension owns the in-memory Page.
 *
 * The tools' behaviour is `core.ts`, shared with the Claude adapter; this is
 * pi's registration, its Hive binding (SessionPublisher) and the
 * pr-attachments event.
 */
export function registerFlowTools(pi: ExtensionAPI, host: FlowBrowserHost): { record(action: RecordedAction): void } {
	const publisher = new SessionPublisher(pi);
	const flows = createFlowRuntime({ page: () => host.page(), binding: () => publisher.binding() });
	const spec = FLOW_TOOL_SPECS;

	registerGuardedTool(pi, {
		capability: FLOW_CAPABILITY,
		name: "report_dev_server",
		label: spec.report_dev_server.label,
		description: spec.report_dev_server.description,
		promptSnippet: spec.report_dev_server.promptSnippet,
		parameters: Type.Object({
			base_url: Type.String({ description: spec.report_dev_server.inputSchema.properties.base_url.description }),
		}),
		async execute(_id, params) {
			const output = await flows.reportDevServer(params);
			// A dev server is now reachable, so a `before` screenshot is possible —
			// let pr-attachments upgrade its BEFORE reminder to a just-in-time block.
			pi.events.emit(CAPTURABLE_CHANNEL, { source: "report_dev_server", baseURL: output.details.base_url });
			return toolText(output);
		},
	});

	registerGuardedTool(pi, {
		capability: FLOW_CAPABILITY,
		name: "run_saved_agent_flow",
		label: spec.run_saved_agent_flow.label,
		description: spec.run_saved_agent_flow.description,
		promptSnippet: spec.run_saved_agent_flow.promptSnippet,
		parameters: Type.Object({
			flow_id: Type.String({ description: spec.run_saved_agent_flow.inputSchema.properties.flow_id.description }),
			call_id: Type.String({ description: spec.run_saved_agent_flow.inputSchema.properties.call_id.description }),
		}),
		async execute(_id, params) {
			return toolText(await flows.runSavedFlow(params));
		},
	});

	registerGuardedTool(pi, {
		capability: FLOW_CAPABILITY,
		name: "record_playwright_flow",
		label: spec.record_playwright_flow.label,
		description: spec.record_playwright_flow.description,
		promptSnippet: spec.record_playwright_flow.promptSnippet,
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("stop")]),
		}),
		async execute(_id, params) {
			return toolText(await flows.recordFlow(params));
		},
	});

	registerGuardedTool(pi, {
		capability: FLOW_CAPABILITY,
		name: "run_playwright_flow_source",
		label: spec.run_playwright_flow_source.label,
		description: spec.run_playwright_flow_source.description,
		promptSnippet: spec.run_playwright_flow_source.promptSnippet,
		parameters: Type.Object({
			source: Type.String({ description: spec.run_playwright_flow_source.inputSchema.properties.source.description }),
			base_url: Type.String({ description: spec.run_playwright_flow_source.inputSchema.properties.base_url.description }),
		}),
		async execute(_id, params) {
			return toolText(await flows.runFlowSource(params));
		},
	});

	registerGuardedTool(pi, {
		capability: FLOW_CAPABILITY,
		name: "author_maestro_flow",
		label: spec.author_maestro_flow.label,
		description: spec.author_maestro_flow.description,
		promptSnippet: spec.author_maestro_flow.promptSnippet,
		parameters: Type.Object({
			yaml: Type.String({ description: spec.author_maestro_flow.inputSchema.properties.yaml.description }),
		}),
		async execute(_id, params) {
			return toolText(await flows.authorMaestro(params));
		},
	});

	pi.on("session_start", () => {
		flows.start();
	});

	pi.on("session_shutdown", async () => {
		await flows.stop();
		publisher.dispose();
	});

	return { record: flows.record };
}
