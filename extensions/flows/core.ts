/**
 * The flow tools' core: dev-server resource reporting, saved-flow runs, the
 * Playwright recorder, source replay, Maestro authoring and the
 * runtime-owner claim loop — free of pi's ExtensionAPI.
 *
 * Two hosts run it: `register.ts` (pi's tools; the Hive binding from
 * hive-common's SessionPublisher) and the Claude adapter's MCP server
 * (`claude/mcp/browser-tools.ts`; the binding from HIVE_URL/HIVE_TOKEN and
 * `/agent-sessions/by-run/{HIVE_SESSION_ID}`). Names, wording and schemas are
 * `FLOW_TOOL_SPECS`. Errors are thrown, as pi's tools throw them; each host
 * renders a throw as a tool error.
 *
 * Erasable TypeScript only, no runtime import of pi or typebox.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Page } from "playwright-core";
import type { ToolSpec } from "../browser/core.ts";
import { request, type HiveAuth } from "../hive-common/http.ts";

export interface FlowBinding {
	auth: HiveAuth;
	sessionID: string;
}

export interface FlowRuntimeHost {
	/** The session browser's page (launches it on first use). */
	page(): Promise<Page>;
	/** This session's Hive identity, or null when it is not (yet) resolvable. */
	binding(): Promise<FlowBinding | null>;
	/**
	 * Run a claimed saved flow's page work exclusive of the host's other page
	 * work (the adapter's serialized browser tools). Default: run it directly.
	 * Tool calls are NOT routed through it — the host already orders those.
	 */
	exclusive?: <T>(work: () => Promise<T>) => Promise<T>;
	env?: NodeJS.ProcessEnv;
}

export interface DevServerReport {
	baseURL: URL;
	generation: string;
	sequence: number;
}

export type RecordedAction =
	| { kind: "navigate"; url: string }
	| { kind: "click"; selector: string }
	| { kind: "fill"; selector: string; value: string; submit: boolean }
	| { kind: "wait"; selector: string; state: "visible" | "hidden"; timeoutMS: number };

export interface FlowOutput {
	text: string;
	details: Record<string, unknown>;
}

export const FLOW_TOOL_SPECS = {
	report_dev_server: {
		label: "Flows: report dev server",
		description:
			"Report an already-running loopback HTTP dev server as the catalogued dev-server resource. Hive records only provider-reported state; it never starts or probes this process itself.",
		promptSnippet: "Publish this running loopback dev server as a resource",
		inputSchema: {
			type: "object",
			required: ["base_url"],
			properties: {
				base_url: { type: "string", description: "Explicit loopback HTTP URL of the already-running development server, including its port." },
			},
		},
	},
	run_saved_agent_flow: {
		label: "Flows: request saved run",
		description:
			"Request a saved Hive flow run and poll the same call ID. The designated runtime-owner sandbox automatically attempts to claim eligible runs every two seconds while its named resource is ready and healthy; Hive and hive-agent never execute source. Older Hive servers return a clear unsupported result.",
		promptSnippet: "Run a saved agent flow against its team dev server",
		inputSchema: {
			type: "object",
			required: ["flow_id", "call_id"],
			properties: {
				flow_id: { type: "string", description: "Saved Hive flow UUID." },
				call_id: { type: "string", description: "Stable idempotency key; repeat this exact call to poll." },
			},
		},
	},
	record_playwright_flow: {
		label: "Flows: record Playwright",
		description:
			"Start or stop recording browser navigation, click, type, and wait tools into relative Playwright source. Save the returned source with Hive's save_agent_flow tool.",
		promptSnippet: "Record browser actions as a Playwright flow",
		inputSchema: {
			type: "object",
			required: ["action"],
			properties: {
				action: {
					anyOf: [
						{ type: "string", const: "start" },
						{ type: "string", const: "stop" },
					],
				},
			},
		},
	},
	run_playwright_flow_source: {
		label: "Flows: run Playwright source",
		description:
			"Run agent-authored Playwright source in this session's isolated browser against a supplied runtime-resolved base URL. Hive and hive-agent never execute this source.",
		promptSnippet: "Run a Playwright flow source in the isolated browser",
		inputSchema: {
			type: "object",
			required: ["source", "base_url"],
			properties: {
				source: { type: "string", description: "Flow source previously saved in Hive." },
				base_url: { type: "string", description: "Resolved loopback base URL from this runtime owner's named dev-server resource." },
			},
		},
	},
	author_maestro_flow: {
		label: "Flows: author Maestro",
		description:
			"Validate and return Maestro YAML for storage. Linux agents store it but report execution as deferred to the Mac lane; the maestro binary is probed when available, never invoked by Hive.",
		promptSnippet: "Author a Maestro mobile flow",
		inputSchema: {
			type: "object",
			required: ["yaml"],
			properties: { yaml: { type: "string", description: "Maestro YAML with appId, --- separator, and commands." } },
		},
	},
} satisfies Record<string, ToolSpec>;

export type FlowToolName = keyof typeof FLOW_TOOL_SPECS;

function js(value: string): string {
	return JSON.stringify(value);
}

function relativeURL(url: string, origin: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.origin !== origin) return null;
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return null;
	}
}

export function sourceFor(actions: RecordedAction[], origin: string): string {
	const lines = [
		"// Recorded by Hive Pi. baseURL is resolved from the runtime-owner's named dev-server resource.",
		"// This source runs only in that owner session's sandbox browser.",
	];
	for (const action of actions) {
		switch (action.kind) {
			case "navigate": {
				const relative = relativeURL(action.url, origin);
				if (relative) lines.push(`await page.goto(new URL(${js(relative)}, baseURL).toString());`);
				break;
			}
			case "click":
				lines.push(`await page.click(${js(action.selector)});`);
				break;
			case "fill":
				lines.push(`await page.fill(${js(action.selector)}, ${js(action.value)});`);
				if (action.submit) lines.push(`await page.press(${js(action.selector)}, "Enter");`);
				break;
			case "wait":
				lines.push(`await page.waitForSelector(${js(action.selector)}, { state: ${js(action.state)}, timeout: ${action.timeoutMS} });`);
				break;
		}
	}
	return `${lines.join("\n")}\n`;
}

export function validatePlaywrightSource(source: string): string | null {
	if (!source.trim()) return "source is required";
	if (source.length > 65536) return "source exceeds 65536 characters";
	return null;
}

export function validateMaestroYAML(source: string): string | null {
	if (!source.trim()) return "YAML is required";
	if (source.length > 65536) return "YAML exceeds 65536 characters";
	if (!/^appId:\s*\S+/m.test(source)) return "Maestro YAML needs a non-empty appId";
	if (!/^---\s*$/m.test(source)) return "Maestro YAML needs a document separator (---) before commands";
	if (!/^\s*-\s+\S+/m.test(source)) return "Maestro YAML needs at least one command";
	return null;
}

// A resource generation fences a single provider lifetime. Re-reporting a
// warmed dev server is still that lifetime: resetting its generation would be
// refused while the prior heartbeat is live and would strand its run queue.
export function nextDevServerReport(previous: DevServerReport | null, baseURL: URL): DevServerReport {
	return {
		baseURL,
		generation: previous?.generation ?? randomUUID(),
		sequence: previous?.sequence ?? -1,
	};
}

/**
 * HEAD-free status probe over a DIRECT socket. The reported dev server lives on
 * the sandbox's own loopback; `fetch` honours the egress proxy environment, and
 * on a node whose allowlist names 127.0.0.1 (HIV-3157) loopback is deliberately
 * removed from NO_PROXY — so a proxied probe reaches the HOST's loopback and
 * reports the mux's 502 while the agent's own Vite answers 200 (second pyERP
 * demo, 2026-09-02). A raw `node:http` request never consults the proxy.
 */
export function probeLoopbackStatus(baseURL: URL, timeoutMs = 5_000): Promise<number> {
	const https = baseURL.protocol === "https:";
	const client = https ? httpsRequest : httpRequest;
	// A PRIVATE agent, not the global one: under Node 24's NODE_USE_ENV_PROXY
	// (set inside the srt sandbox) the global agent itself honours HTTP_PROXY, so
	// a plain http.request is proxied exactly like fetch — measured 2026-09-02:
	// `node -e http.get(127.0.0.1:3000)` → 502 while `curl --noproxy` → 200. An
	// agent constructed without proxyEnv always dials the socket directly.
	const agent = https ? new HttpsAgent({ rejectUnauthorized: false }) : new HttpAgent();
	return new Promise((resolve, reject) => {
		const req = client(baseURL, { method: "GET", timeout: timeoutMs, agent }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("timeout", () => req.destroy(new Error("probe timed out")));
		req.on("error", reject);
		req.end();
	});
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * The flow tools' state and handlers for one session. `record` is fed by the
 * session browser's actions; `start()` begins the runtime-owner claim loop
 * (a launched session only); `stop()` ends it and the dev-server report.
 */
export function createFlowRuntime(host: FlowRuntimeHost) {
	const env = host.env ?? process.env;
	let recording: { origin: string; actions: RecordedAction[] } | null = null;
	let devServer: (DevServerReport & { timer: ReturnType<typeof setInterval> }) | null = null;

	async function publishDevServer(state: "starting" | "ready" | "ended", health: "unknown" | "healthy" | "unhealthy", error = "") {
		const reported = devServer;
		if (!reported) return { ok: true, status: 200 };
		const binding = await host.binding();
		if (!binding) return { ok: false, status: null, error: "Hive session binding is unavailable" };
		reported.sequence += 1;
		const terminal = state === "ended";
		return request(binding.auth, "PUT", `/agent-sessions/${encodeURIComponent(binding.sessionID)}/resources/dev-server`, {
			generation: reported.generation,
			sequence: reported.sequence,
			state,
			health,
			database_name: "",
			...(terminal
				? {}
				: {
						host: reported.baseURL.hostname,
						port: Number(reported.baseURL.port),
						connection_url: reported.baseURL.toString(),
					}),
			error: error.slice(0, 4000),
			ttl_seconds: terminal ? 0 : 45,
		});
	}

	async function probeDevServer() {
		const reported = devServer;
		if (!reported) return { ok: true, status: 200 };
		try {
			const status = await probeLoopbackStatus(reported.baseURL);
			return publishDevServer("ready", status < 500 ? "healthy" : "unhealthy", status < 500 ? "" : `HTTP ${status}`);
		} catch {
			return publishDevServer("ready", "unhealthy", "loopback health probe failed");
		}
	}

	let flowPoll: ReturnType<typeof setInterval> | null = null;
	let flowPollBusy = false;
	let flowRunsSupported = true;

	async function runSource(source: string, baseURL: string): Promise<string> {
		const sourceError = validatePlaywrightSource(source);
		if (sourceError) throw new Error(sourceError);
		const resolved = new URL(baseURL);
		if (!["http:", "https:"].includes(resolved.protocol) || !LOOPBACK_HOSTS.includes(resolved.hostname)) {
			throw new Error("runtime flow base URL must be an HTTP(S) loopback address");
		}
		const page = await host.page();
		const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (page: Page, baseURL: string) => Promise<void>;
		const run = new AsyncFunction("page", "baseURL", `"use strict";\n${source}`);
		await run(page, resolved.toString());
		return page.url();
	}

	async function completeClaim(runID: string, claimToken: string, state: "succeeded" | "failed" | "deferred", summary: string, error = "", evidence: Record<string, string> = {}) {
		const binding = await host.binding();
		if (!binding) return;
		await request(binding.auth, "POST", `/agent-sessions/${encodeURIComponent(binding.sessionID)}/flow-runs/${encodeURIComponent(runID)}/complete`, {
			claim_token: claimToken,
			state,
			summary: summary.slice(0, 8000),
			error: error.slice(0, 4000),
			evidence,
		});
	}

	async function pollSavedFlowRuns() {
		if (!flowRunsSupported || flowPollBusy || !env.HIVE_LAUNCH_ID) return;
		flowPollBusy = true;
		try {
			const binding = await host.binding();
			if (!binding) return;
			const claimed = await request<{ items?: Array<{ run?: { id?: string; format?: string; source?: string }; claim_token?: string; connection_url?: string }> }>(
				binding.auth,
				"POST",
				`/agent-sessions/${encodeURIComponent(binding.sessionID)}/flow-runs/claim`,
			);
			if (claimed.status === 404) {
				flowRunsSupported = false;
				return;
			}
			if (!claimed.ok) return;
			for (const claim of claimed.body?.items ?? []) {
				const run = claim.run;
				if (!run?.id || !run.format || !run.source || !claim.claim_token) continue;
				if (run.format === "maestro" && process.platform !== "darwin") {
					await completeClaim(run.id, claim.claim_token, "deferred", "Maestro execution is deferred to the Mac lane.");
					continue;
				}
				try {
					const source = run.source;
					const url = await (host.exclusive ?? ((work) => work()))(() => runSource(source, claim.connection_url ?? ""));
					await completeClaim(run.id, claim.claim_token, "succeeded", "Playwright flow completed.", "", { url });
				} catch (error) {
					const message = error instanceof Error ? error.message : "flow execution failed";
					await completeClaim(run.id, claim.claim_token, "failed", "Playwright flow failed.", message);
				}
			}
		} finally {
			flowPollBusy = false;
		}
	}

	function record(action: RecordedAction): void {
		if (!recording) return;
		if (action.kind === "navigate" && recording.origin === "null") {
			try {
				recording.origin = new URL(action.url).origin;
			} catch {
				// The recorded action remains unavailable for base-URL rewriting.
			}
		}
		recording.actions.push(action);
	}

	async function reportDevServer(params: { base_url: string }): Promise<FlowOutput> {
		let baseURL: URL;
		try {
			baseURL = new URL(params.base_url);
		} catch {
			throw new Error("base_url must be a valid HTTP URL");
		}
		if (!["http:", "https:"].includes(baseURL.protocol) || !LOOPBACK_HOSTS.includes(baseURL.hostname) || !baseURL.port || baseURL.username || baseURL.password) {
			throw new Error("base_url must be a credential-free loopback HTTP URL with an explicit port");
		}
		const previous = devServer;
		if (previous) clearInterval(previous.timer);
		devServer = {
			...nextDevServerReport(previous, baseURL),
			timer: setInterval(() => void probeDevServer(), 15_000),
		};
		devServer.timer.unref?.();
		if (!previous) {
			const starting = await publishDevServer("starting", "unknown");
			if (!starting.ok) {
				const status = starting.status === 404 ? "This Hive server predates dev-server resource reporting." : (starting.error ?? "resource report failed");
				clearInterval(devServer.timer);
				devServer = null;
				throw new Error(status);
			}
		}
		const ready = await probeDevServer();
		if (!ready.ok) throw new Error(ready.error ?? "resource report failed");
		return {
			text: `${previous ? "Re-reporting" : "Reporting"} dev-server at ${baseURL.origin} as the catalogued resource name "dev-server".`,
			details: {
				resource: "dev-server",
				base_url: baseURL.origin,
				note: "Flows retain only the resource name; runtime connection details stay in this sandbox's resource report.",
			},
		};
	}

	async function runSavedFlow(params: { flow_id: string; call_id: string }): Promise<FlowOutput> {
		const binding = await host.binding();
		if (!binding) throw new Error("Hive session binding is unavailable; saved flows require a Hive-launched session.");
		const result = await request<{ run?: { state?: string } }>(
			binding.auth,
			"POST",
			`/agent-sessions/${encodeURIComponent(binding.sessionID)}/flows/${encodeURIComponent(params.flow_id)}/runs`,
			{ call_id: params.call_id },
		);
		if (!result.ok) {
			if (result.status === 404) {
				return {
					text: "This Hive server does not support saved flow runs yet. You can still record or author source locally and save it after the server upgrades.",
					details: { supported: false },
				};
			}
			throw new Error(result.error ?? "requesting saved flow run failed");
		}
		return {
			text: `Saved flow run is ${result.body?.run?.state ?? "pending"}. The designated runtime-owner sandbox automatically claims eligible runs every two seconds; repeat this exact call_id to poll and do not wait for browser execution.`,
			details: { supported: true, run: result.body?.run },
		};
	}

	async function recordFlow(params: { action: "start" | "stop" }): Promise<FlowOutput> {
		if (params.action === "start") {
			const page = await host.page();
			recording = { origin: new URL(page.url()).origin, actions: [] };
			return { text: 'Recording browser actions. Use browser tools, then call record_playwright_flow with action "stop".', details: { recording: true } };
		}
		if (!recording) throw new Error("No Playwright recording is active. Start one before stopping it.");
		const completed = recording;
		recording = null;
		const source = sourceFor(completed.actions, completed.origin);
		return {
			text: source,
			details: {
				recording: false,
				action_count: completed.actions.length,
				source,
				note: 'Save this with save_agent_flow using resource "dev-server". Its baseURL is resolved only at sandbox run time.',
			},
		};
	}

	async function runFlowSource(params: { source: string; base_url: string }): Promise<FlowOutput> {
		const url = await runSource(params.source, params.base_url);
		return { text: `Flow completed at ${url}`, details: { ok: true, url } };
	}

	async function authorMaestro(params: { yaml: string }): Promise<FlowOutput> {
		const invalid = validateMaestroYAML(params.yaml);
		if (invalid) throw new Error(invalid);
		// Asynchronously: a host serving other calls (the adapter's MCP server)
		// must not stall on a slow binary.
		const maestroAvailable = await new Promise<boolean>((resolve) => {
			execFile("maestro", ["--version"], { timeout: 5_000 }, (error) => resolve(error === null));
		});
		const mac = process.platform === "darwin";
		return {
			text: params.yaml,
			details: {
				yaml: params.yaml,
				maestro_available: maestroAvailable,
				execution: mac && maestroAvailable ? "mac_lane_ready" : "deferred_to_mac",
				note:
					mac && maestroAvailable
						? "Save this YAML as a maestro flow; execution must still be requested through Hive's sandbox run queue."
						: "Stored Maestro flows are not executable in this Linux sandbox. Run them on the Mac lane with Android/iOS tooling.",
			},
		};
	}

	/** Begin the runtime-owner claim loop (every 2 s) — a Hive-launched session only. */
	function start(): void {
		if (flowPoll || !env.HIVE_LAUNCH_ID) return;
		flowPoll = setInterval(() => void pollSavedFlowRuns(), 2_000);
		flowPoll.unref?.();
		void pollSavedFlowRuns();
	}

	/** End the claim loop and the dev-server report (published as `ended`). */
	async function stop(): Promise<void> {
		if (flowPoll) clearInterval(flowPoll);
		flowPoll = null;
		if (devServer) {
			clearInterval(devServer.timer);
			await publishDevServer("ended", "unknown");
			devServer = null;
		}
	}

	return { record, reportDevServer, runSavedFlow, recordFlow, runFlowSource, authorMaestro, start, stop };
}

export type FlowRuntime = ReturnType<typeof createFlowRuntime>;
