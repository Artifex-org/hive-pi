/**
 * The session browser and the flow tools, served to a Claude session:
 * `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
 * `browser_screenshot`, `browser_console`, `browser_evaluate`,
 * `browser_wait_for`, `report_dev_server`, `run_saved_agent_flow`,
 * `record_playwright_flow`, `run_playwright_flow_source`, `author_maestro_flow`.
 *
 * What each tool does is pi's own core — `extensions/browser/core.ts` and
 * `extensions/flows/core.ts`, which pi's extensions run too — with the same
 * names, wording and JSON schemas. This file is the host:
 *
 *  - ONE headless Chromium per MCP-server process (= per Claude session),
 *    launched on the first browser call and disposed by `stop()`, which the
 *    server's shutdown awaits. Playwright's own signal handlers are off (its
 *    SIGINT handler exits the process); Chromium leads its own process group,
 *    which Playwright kills when this process exits and `dispose()` kills if
 *    Chromium outlives its close.
 *  - The live view: the node's surface dir (HIVE_BROWSER_SURFACE_DIR …) gets
 *    the same frames, manifest and `latest-web.*` that pi writes
 *    (`BrowserSurfaceBridge`, read directly by the desktop app), and — because
 *    no hive-remote runs in a Claude session — this server also publishes the
 *    surface row and snapshots to Hive (`BrowserSurfacePublisher`, hive-remote's
 *    own class) every 2 s once the browser is up.
 *  - Screenshots go to the pr-attachments ledger keyed by HIVE_SESSION_ID; the
 *    result carries the PNG inline and its path in the text.
 *  - The flow tools' Hive calls use HIVE_URL/HIVE_TOKEN and the session uuid
 *    resolved from `/agent-sessions/by-run/{HIVE_SESSION_ID}`; the
 *    runtime-owner claim loop runs for the server's lifetime (launched
 *    sessions only, as in pi).
 */

import { randomUUID } from "node:crypto";
import { BROWSER_TOOL_SPECS, SessionBrowser, type BrowserOutput, type BrowserToolName, type ToolSpec } from "../../extensions/browser/core.ts";
import { createFlowRuntime, FLOW_TOOL_SPECS, type FlowBinding, type FlowToolName } from "../../extensions/flows/core.ts";
import { resolveSession } from "../../extensions/hive-remote/client.ts";
import { BrowserSurfacePublisher } from "../../extensions/hive-remote/surfaces.ts";
import { ScreenshotLedger } from "../../extensions/pr-attachments/manifest.ts";
import { hiveAuth, stateDir, type AdapterEnv } from "../env.ts";
import { serverSessionId } from "../session.ts";
import type { ToolDefinition, ToolResult } from "./protocol.ts";

/** hive-remote's surface cadence (`SURFACE_TICK_MS`). */
const SURFACE_TICK_MS = 2_000;

const SPECS: Record<BrowserToolName | FlowToolName, ToolSpec> = { ...BROWSER_TOOL_SPECS, ...FLOW_TOOL_SPECS };

/** Tools that act on the one page: run one at a time, in arrival order. */
const PAGE_TOOLS: ReadonlySet<string> = new Set([...Object.keys(BROWSER_TOOL_SPECS), "record_playwright_flow", "run_playwright_flow_source"]);

export const BROWSER_TOOL_NAMES: readonly string[] = Object.keys(SPECS);

export const BROWSER_TOOLS: ToolDefinition[] = Object.entries(SPECS).map(([name, spec]) => ({
	name,
	description: spec.description,
	inputSchema: spec.inputSchema,
}));

interface PropertySchema {
	type?: string;
	minimum?: number;
	maximum?: number;
	anyOf?: { const: unknown }[];
}

/**
 * Check `args` against a tool's schema — the boundary pi's typebox validation
 * holds for pi. Covers the shapes these schemas use: required keys, string,
 * boolean, bounded integer, and a union of string constants.
 */
export function checkArgs(name: string, args: Record<string, unknown>): string | null {
	const schema = SPECS[name as BrowserToolName | FlowToolName].inputSchema as { required?: string[]; properties: Record<string, PropertySchema> };
	for (const key of schema.required ?? []) {
		if (args[key] === undefined) return `${name} needs "${key}".`;
	}
	for (const [key, property] of Object.entries(schema.properties)) {
		const value = args[key];
		if (value === undefined) continue;
		if (property.anyOf) {
			const allowed = property.anyOf.map((option) => option.const);
			if (!allowed.includes(value)) return `${name}: "${key}" must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`;
			continue;
		}
		if (property.type === "integer") {
			if (typeof value !== "number" || !Number.isInteger(value)) return `${name}: "${key}" must be an integer.`;
			if (property.minimum !== undefined && value < property.minimum) return `${name}: "${key}" must be at least ${property.minimum}.`;
			if (property.maximum !== undefined && value > property.maximum) return `${name}: "${key}" must be at most ${property.maximum}.`;
			continue;
		}
		if (typeof value !== property.type) return `${name}: "${key}" must be a ${property.type}.`;
	}
	return null;
}

/**
 * Resolve a call, or an abort: a cancelled call answers at once. Its
 * operation still runs to its end (or to the browser's close at shutdown);
 * page tools are serialized, so the next call starts only after it.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | "aborted"> {
	if (signal.aborted) {
		work.catch(() => {});
		return Promise.resolve("aborted");
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			// Nobody is waiting for this result any more; its failure (the
			// browser closing under it) has no one to be reported to.
			work.catch(() => {});
			resolve("aborted");
		};
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export class BrowserTools {
	private readonly browser: SessionBrowser;
	private readonly flows: ReturnType<typeof createFlowRuntime>;
	private readonly publisher: BrowserSurfacePublisher;
	private surfaceTimer: NodeJS.Timeout | null = null;
	private readonly ledgerSession: string;
	private readonly processEnv: NodeJS.ProcessEnv;
	private readonly env: AdapterEnv;
	private readonly log: (line: string) => void;
	private sessionId: string | null = null;
	private lastBindingError = "";
	private pageQueue: Promise<void> = Promise.resolve();
	private ticking = false;
	private stopping = false;

	constructor(env: AdapterEnv, log: (line: string) => void, processEnv: NodeJS.ProcessEnv = process.env) {
		this.env = env;
		this.log = log;
		this.processEnv = processEnv;
		// Keyed by the session, never the pid (see pr-attachments/manifest.ts).
		this.ledgerSession = env.sessionRunId ?? `claude-${randomUUID()}`;
		this.publisher = new BrowserSurfacePublisher(processEnv);
		this.browser = new SessionBrowser({
			// Imported on the first launch: the server must load (and answer
			// every other tool) even where the package is missing.
			chromium: async () => (await import("playwright-core")).chromium,
			env: processEnv,
			handleSignals: false,
			onAction: (action) => this.flows.record(action),
			onLaunch: () => this.startSurfacePublishing(),
		});
		this.flows = createFlowRuntime({ page: () => this.browser.page(), binding: () => this.binding(), env: processEnv });
	}

	has(name: string): boolean {
		return Object.hasOwn(SPECS, name);
	}

	/** Begin the runtime-owner claim loop (a launched session only). */
	start(): void {
		this.flows.start();
	}

	/**
	 * This session's Hive identity. Null when the launch has no Hive auth or
	 * run id, or the session is not attached yet (asked again next time).
	 */
	async binding(): Promise<FlowBinding | null> {
		const auth = hiveAuth(this.env);
		const runId = this.env.sessionRunId;
		if (!auth || !runId) return null;
		try {
			const dir = stateDir(this.env);
			if (dir) {
				const resolved = await serverSessionId(auth, runId, dir);
				return resolved.ok ? { auth, sessionID: resolved.id } : null;
			}
			this.sessionId ??= await resolveSession(auth, runId);
			return this.sessionId ? { auth, sessionID: this.sessionId } : null;
		} catch (error) {
			// The claim loop and the surface tick call this on timers: a throw
			// there would be an unhandled rejection. Said once per distinct cause.
			const message = error instanceof Error ? error.message : String(error);
			if (message !== this.lastBindingError) this.log(`hive-pi mcp: cannot resolve the Hive session: ${message}`);
			this.lastBindingError = message;
			return null;
		}
	}

	/** Run `work` after every page operation already queued, cancelled ones included. */
	private onPage<T>(work: () => Promise<T>): Promise<T> {
		const result = this.pageQueue.then(work);
		this.pageQueue = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private startSurfacePublishing(): void {
		if (this.surfaceTimer) return;
		this.surfaceTimer = setInterval(() => void this.tickSurface(), SURFACE_TICK_MS);
		this.surfaceTimer.unref();
	}

	private async tickSurface(): Promise<void> {
		// One tick at a time (a slow Hive must not stack them), and none once
		// shutdown has begun: a late `ready` would overwrite the `ended` row.
		if (this.ticking || this.stopping) return;
		this.ticking = true;
		try {
			const binding = await this.binding();
			if (!this.stopping) await this.publisher.tick(binding?.auth ?? null, binding?.sessionID ?? null);
		} finally {
			this.ticking = false;
		}
	}

	async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
		const invalid = checkArgs(name, args);
		if (invalid) return { text: invalid, isError: true };
		const run = () => this.dispatch(name as BrowserToolName | FlowToolName, args);
		const result = await untilAborted(PAGE_TOOLS.has(name) ? this.onPage(run) : run(), signal);
		if (result === "aborted") return { text: `${name} was cancelled.`, isError: true };
		return { text: result.text, ...(result.image ? { images: [result.image] } : {}) };
	}

	private dispatch(name: BrowserToolName | FlowToolName, args: Record<string, unknown>): Promise<BrowserOutput> {
		// checkArgs has held every argument to its schema; these casts restate it.
		const str = (key: string) => args[key] as string;
		const optStr = (key: string) => args[key] as string | undefined;
		const optBool = (key: string) => args[key] as boolean | undefined;
		switch (name) {
			case "browser_navigate":
				return this.browser.navigate({ url: str("url") });
			case "browser_snapshot":
				return this.browser.snapshot();
			case "browser_click":
				return this.browser.click({ selector: str("selector") });
			case "browser_type":
				return this.browser.type({ selector: str("selector"), value: str("value"), submit: optBool("submit") });
			case "browser_screenshot":
				return this.browser.screenshot({ full_page: optBool("full_page"), label: optStr("label") }, new ScreenshotLedger(this.processEnv, this.ledgerSession));
			case "browser_console":
				return this.browser.console({ clear: optBool("clear") });
			case "browser_evaluate":
				return this.browser.evaluate({ expression: str("expression") });
			case "browser_wait_for":
				return this.browser.waitFor({
					selector: str("selector"),
					state: args.state as "visible" | "hidden" | undefined,
					timeout_ms: args.timeout_ms as number | undefined,
				});
			case "report_dev_server":
				return this.flows.reportDevServer({ base_url: str("base_url") });
			case "run_saved_agent_flow":
				return this.flows.runSavedFlow({ flow_id: str("flow_id"), call_id: str("call_id") });
			case "record_playwright_flow":
				return this.flows.recordFlow({ action: args.action as "start" | "stop" });
			case "run_playwright_flow_source":
				return this.flows.runFlowSource({ source: str("source"), base_url: str("base_url") });
			case "author_maestro_flow":
				return this.flows.authorMaestro({ yaml: str("yaml") });
		}
	}

	/**
	 * End of the session: the claim loop and dev-server report end, the
	 * browser closes for good (its live view writes `ended`), and the Hive
	 * surface row is ended.
	 */
	async stop(): Promise<void> {
		this.stopping = true;
		// The browser's close never waits on Hive: both run at once, and a
		// failing dev-server report does not stop the rest.
		const [flows, browser] = await Promise.allSettled([this.flows.stop(), this.browser.dispose()]);
		for (const outcome of [flows, browser]) {
			if (outcome.status === "rejected") this.log(`hive-pi mcp: browser shutdown: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
		}
		if (this.surfaceTimer) {
			clearInterval(this.surfaceTimer);
			this.surfaceTimer = null;
			const binding = await this.binding();
			await this.publisher.end(binding?.auth ?? null, binding?.sessionID ?? null);
		}
	}
}
