import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Page } from "playwright-core";
import { Type } from "typebox";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { request } from "../hive-common/http.ts";
import { SessionPublisher } from "../hive-common/session-publisher.ts";

export interface FlowBrowserHost {
  page(): Promise<Page>;
}

export type RecordedAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; value: string; submit: boolean }
  | { kind: "wait"; selector: string; state: "visible" | "hidden"; timeoutMS: number };

const FLOW_CAPABILITY = {
  executes: true,
  writesExemptBecause: "Maestro validation and execution use only a per-process temporary file under /tmp",
};

function toolText(body: string, details: unknown) {
  return { content: [{ type: "text" as const, text: body }], details };
}

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

/**
 * Register flow authoring/replay tools inside extensions/browser's own module
 * graph. Pi loads extension entrypoints with isolated caches, so this module is
 * intentionally imported by the browser extension rather than registered as a
 * second entrypoint: only that extension owns the in-memory Page.
 */
export function registerFlowTools(pi: ExtensionAPI, host: FlowBrowserHost) {
  let recording: { origin: string; actions: RecordedAction[] } | null = null;
  const publisher = new SessionPublisher(pi);
  let devServer: { baseURL: URL; generation: string; sequence: number; timer: ReturnType<typeof setInterval> } | null = null;

  async function publishDevServer(state: "starting" | "ready" | "ended", health: "unknown" | "healthy" | "unhealthy", error = "") {
    const reported = devServer;
    if (!reported) return { ok: true, status: 200 };
    const binding = await publisher.binding();
    if (!binding) return { ok: false, status: null, error: "Hive session binding is unavailable" };
    reported.sequence += 1;
    const terminal = state === "ended";
    return request(binding.auth, "PUT", `/agent-sessions/${encodeURIComponent(binding.sessionID)}/resources/dev-server`, {
      generation: reported.generation,
      sequence: reported.sequence,
      state,
      health,
      database_name: "",
      ...(terminal ? {} : {
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
    if (!reported) return;
    try {
      const response = await fetch(reported.baseURL, { signal: AbortSignal.timeout(5_000) });
      await publishDevServer("ready", response.status < 500 ? "healthy" : "unhealthy", response.status < 500 ? "" : `HTTP ${response.status}`);
    } catch {
      await publishDevServer("ready", "unhealthy", "loopback health probe failed");
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

  registerGuardedTool(pi, {
    capability: FLOW_CAPABILITY,
    name: "report_dev_server",
    label: "Flows: report dev server",
    description: "Report an already-running loopback HTTP dev server as the catalogued dev-server resource. Hive records only provider-reported state; it never starts or probes this process itself.",
    promptSnippet: "Publish this running loopback dev server as a resource",
    parameters: Type.Object({
      base_url: Type.String({ description: "Explicit loopback HTTP URL of the already-running development server, including its port." }),
    }),
    async execute(_id, params) {
      let baseURL: URL;
      try {
        baseURL = new URL(params.base_url);
      } catch {
        throw new Error("base_url must be a valid HTTP URL");
      }
      if (!["http:", "https:"].includes(baseURL.protocol) || !["127.0.0.1", "localhost", "::1"].includes(baseURL.hostname) || !baseURL.port || baseURL.username || baseURL.password) {
        throw new Error("base_url must be a credential-free loopback HTTP URL with an explicit port");
      }
      if (devServer) clearInterval(devServer.timer);
      devServer = { baseURL, generation: randomUUID(), sequence: -1, timer: setInterval(() => void probeDevServer(), 15_000) };
      devServer.timer.unref?.();
      const starting = await publishDevServer("starting", "unknown");
      if (!starting.ok) {
        const status = starting.status === 404 ? "This Hive server predates dev-server resource reporting." : (starting.error ?? "resource report failed");
        clearInterval(devServer.timer);
        devServer = null;
        throw new Error(status);
      }
      await probeDevServer();
      return toolText(`Reporting dev-server at ${baseURL.origin} as the catalogued resource name "dev-server".`, {
        resource: "dev-server",
        base_url: baseURL.origin,
        note: "Flows retain only the resource name; runtime connection details stay in this sandbox's resource report.",
      });
    },
  });

  registerGuardedTool(pi, {
    capability: FLOW_CAPABILITY,
    name: "record_playwright_flow",
    label: "Flows: record Playwright",
    description: "Start or stop recording browser navigation, click, type, and wait tools into relative Playwright source. Save the returned source with Hive's save_agent_flow tool.",
    promptSnippet: "Record browser actions as a Playwright flow",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("stop")]),
    }),
    async execute(_id, params) {
      if (params.action === "start") {
        const page = await host.page();
        recording = { origin: new URL(page.url()).origin, actions: [] };
        return toolText("Recording browser actions. Use browser tools, then call record_playwright_flow with action \"stop\".", { recording: true });
      }
      if (!recording) throw new Error("No Playwright recording is active. Start one before stopping it.");
      const completed = recording;
      recording = null;
      const source = sourceFor(completed.actions, completed.origin);
      return toolText(source, {
        recording: false,
        action_count: completed.actions.length,
        source,
        note: "Save this with save_agent_flow using resource \"dev-server\". Its baseURL is resolved only at sandbox run time.",
      });
    },
  });

  registerGuardedTool(pi, {
    capability: FLOW_CAPABILITY,
    name: "run_playwright_flow_source",
    label: "Flows: run Playwright source",
    description: "Run agent-authored Playwright source in this session's isolated browser against a supplied runtime-resolved base URL. Hive and hive-agent never execute this source.",
    promptSnippet: "Run a Playwright flow source in the isolated browser",
    parameters: Type.Object({
      source: Type.String({ description: "Flow source previously saved in Hive." }),
      base_url: Type.String({ description: "Resolved loopback base URL from this runtime owner's named dev-server resource." }),
    }),
    async execute(_id, params) {
      const sourceError = validatePlaywrightSource(params.source);
      if (sourceError) throw new Error(sourceError);
      const baseURL = new URL(params.base_url);
      if (baseURL.protocol !== "http:" && baseURL.protocol !== "https:") throw new Error("base_url must be HTTP(S)");
      if (!["127.0.0.1", "localhost", "::1"].includes(baseURL.hostname)) {
        throw new Error("base_url must resolve to the runtime owner's loopback dev server");
      }
      const page = await host.page();
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (page: Page, baseURL: string) => Promise<void>;
      const run = new AsyncFunction("page", "baseURL", `"use strict";\n${params.source}`);
      await run(page, baseURL.toString());
      return toolText(`Flow completed at ${page.url()}`, { ok: true, url: page.url() });
    },
  });

  registerGuardedTool(pi, {
    capability: FLOW_CAPABILITY,
    name: "author_maestro_flow",
    label: "Flows: author Maestro",
    description: "Validate and return Maestro YAML for storage. Linux agents store it but report execution as deferred to the Mac lane; the maestro binary is probed when available, never invoked by Hive.",
    promptSnippet: "Author a Maestro mobile flow",
    parameters: Type.Object({
      yaml: Type.String({ description: "Maestro YAML with appId, --- separator, and commands." }),
    }),
    async execute(_id, params) {
      const invalid = validateMaestroYAML(params.yaml);
      if (invalid) throw new Error(invalid);
      const probe = spawnSync("maestro", ["--version"], { encoding: "utf8", timeout: 5_000 });
      const maestroAvailable = probe.status === 0;
      const mac = process.platform === "darwin";
      return toolText(params.yaml, {
        yaml: params.yaml,
        maestro_available: maestroAvailable,
        execution: mac && maestroAvailable ? "mac_lane_ready" : "deferred_to_mac",
        note: mac && maestroAvailable
          ? "Save this YAML as a maestro flow; execution must still be requested through Hive's sandbox run queue."
          : "Stored Maestro flows are not executable in this Linux sandbox. Run them on the Mac lane with Android/iOS tooling.",
      });
    },
  });

  pi.on("session_shutdown", async () => {
    if (devServer) {
      clearInterval(devServer.timer);
      await publishDevServer("ended", "unknown");
      devServer = null;
    }
    publisher.dispose();
  });

  return { record };
}
