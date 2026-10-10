/**
 * Which pi's native MCP runtime the gateways load.
 *
 * The pi gateway used to resolve `@earendil-works/pi-coding-agent` from this
 * checkout, which finds hive-pi's devDependency copy (or nothing, in an
 * install without dev dependencies) rather than the pi running the extension.
 * Here the running pi is a fixture root distinct from that copy, and its stub
 * runtime announces itself, so loading the devDependency instead cannot pass.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import gateway from "../extensions/mcp-gateway/index.ts";
import { loadGatewayRuntime } from "../extensions/mcp-common/gateway.ts";
import { OP_MODE_STATE_CHANNEL } from "../extensions/hive-common/channels.ts";
import { dispatchNativeMcp } from "../claude/mcp/native-gateway.ts";
import { createFakePi } from "./fake-pi.ts";

const running = vi.hoisted(() => ({ root: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	// pi's loader binds this import to the running pi; the fixture plays that pi.
	getPackageDir: () => running.root,
}));

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gateway-runtime-"));
	running.root = join(dir, "running-pi");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A pi install whose native MCP modules say where they were loaded from. */
function installRunningPi(name = "@earendil-works/pi-coding-agent"): void {
	const root = running.root;
	mkdirSync(join(root, "dist", "extensions", "mcp"), { recursive: true });
	mkdirSync(join(root, "dist", "core"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name, type: "module" }));
	writeFileSync(join(root, "dist", "cli.js"), "");
	writeFileSync(join(root, "dist", "extensions", "mcp", "config.js"),
		'export const origin = "running-pi"; export function loadMcpConfig() { throw new Error("running pi runtime loaded"); }\n');
	for (const module of ["extensions/mcp/runtime.js", "extensions/mcp/tools.js", "core/auth-storage.js"]) {
		writeFileSync(join(root, "dist", module), 'export const origin = "running-pi";\n');
	}
}

it("loads the native modules from the given package root", async () => {
	installRunningPi();
	const modules = await loadGatewayRuntime(running.root);
	for (const module of [modules.config, modules.runtime, modules.tools, modules.auth]) {
		expect((module as unknown as { origin?: string }).origin).toBe("running-pi");
	}
});

it("refuses a root that is not a pi install instead of falling back to another copy", async () => {
	await expect(loadGatewayRuntime(running.root)).rejects.toThrow(`${running.root} is not an installed @earendil-works/pi-coding-agent package`);
	installRunningPi("some-other-package");
	await expect(loadGatewayRuntime(running.root)).rejects.toThrow("is not an installed");
});

it("the pi gateway resolves the RUNNING pi's package root, not this checkout's dependency", async () => {
	installRunningPi();
	const pi = createFakePi();
	gateway(pi.api);
	pi.api.events.emit(OP_MODE_STATE_CHANNEL, { mode: "build" });
	const tool = pi.tools.find((candidate) => candidate.name === "mcp")!.definition as unknown as ToolDefinition;
	const ctx = { cwd: dir, isProjectTrusted: () => false, modelRegistry: { getApiKeyForProvider: async () => undefined } } as unknown as ExtensionToolContext;
	const result = await tool.execute("id", { tool: "hive_get_run" }, undefined, undefined, ctx);
	expect(result).toHaveProperty("isError", true);
	expect(JSON.stringify(result)).toContain("running pi runtime loaded");

	rmSync(running.root, { recursive: true, force: true });
	const missing = await tool.execute("id", { tool: "hive_get_run" }, undefined, undefined, ctx);
	expect(JSON.stringify(missing)).toContain("is not an installed @earendil-works/pi-coding-agent package");
});

it("the Claude gateway resolves the pinned pi binary's package root", async () => {
	installRunningPi();
	const result = await dispatchNativeMcp({ piBin: join(running.root, "dist", "cli.js"), piAgentDir: dir }, dir, { tool: "hive_get_run" }, new AbortController().signal);
	expect(result).toEqual({ text: "running pi runtime loaded", isError: true });
});
