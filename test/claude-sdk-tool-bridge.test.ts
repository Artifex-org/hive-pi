import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiToolBridge } from "../extensions/claude-sdk/tool-bridge.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	try { for (const close of cleanup.splice(0)) await close(); }
	finally { vi.useRealTimers(); }
});

async function fixture(registrationTimeout = 0) {
	const controller = new AbortController();
	const bridge = new PiToolBridge([
		{ name: "read", description: "Pi-owned read", parameters: Type.Object({ path: Type.String() }) },
		{ name: "bash", description: "Pi-owned bash", parameters: Type.Object({ command: Type.String() }) },
	], controller.signal, registrationTimeout);
	const client = new Client({ name: "offline-fixture", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await bridge.config.instance.connect(serverTransport);
	await client.connect(clientTransport);
	cleanup.push(async () => { bridge.close(); await client.close(); await bridge.config.instance.close(); });
	const call = (id: string, name = "read", args: Record<string, unknown> = { path: "/fixture" }) =>
		client.callTool({ name, arguments: args, _meta: { "claudecode/toolUseId": id } });
	const complete = (id: string, text: string, name = "read", isError = false) =>
		bridge.complete({ toolCallId: id, toolName: name, content: [{ type: "text", text }], isError });
	return { controller, bridge, client, call, complete };
}

describe("actual MCP over in-memory transports, not a Claude query", () => {
	it("parks SDK dispatch that overtakes an awaited stream observer, then validates registration", async () => {
		const { bridge, call, complete } = await fixture(1000);
		let settled = false;
		const early = call("overtook").then(result => { settled = true; return result; });
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		bridge.expectCall("overtook", "read", { path: "/fixture" });
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual(["overtook"]));
		complete("overtook", "guarded Pi output");
		expect(await early).toMatchObject({ isError: false, content: [{ text: "guarded Pi output" }] });
	});
	it("bounds unknown pre-registration requests and settles them on shutdown", async () => {
		const { bridge, call } = await fixture(10);
		expect(await call("unknown")).toMatchObject({ isError: true });
		const pending = call("shutdown-before-registration");
		bridge.close();
		expect(await pending).toMatchObject({ isError: true });
	});
	it("never exposes a timed-out pre-registration call to Pi", async () => {
		const { bridge, call, complete } = await fixture(10);
		expect(await call("late-effect")).toMatchObject({ isError: true });
		const execute = vi.fn();
		expect(() => { bridge.expectCall("late-effect", "read", { path: "/fixture" }); execute(); }).toThrow(/registration/);
		expect(execute).not.toHaveBeenCalled();
		expect(bridge.pendingCallIds).toEqual([]);
		expect(() => complete("late-effect", "late")).toThrow(/correlation/);
		expect(await call("late-effect")).toMatchObject({ isError: true });
	});
	it.each(["cancel", "timeout"])("remembers pre-registration MCP %s before a late stream event", async mode => {
		const { bridge, client } = await fixture(10_000);
		const abort = new AbortController();
		vi.useFakeTimers();
		const pending = client.callTool({ name: "read", arguments: { path: "/fixture" },
			_meta: { "claudecode/toolUseId": "late-cancel" } }, undefined,
			mode === "cancel" ? { signal: abort.signal } : { timeout: 1000 });
		const rejected = expect(pending).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(1);
		if (mode === "cancel") abort.abort(); else await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		await vi.advanceTimersByTimeAsync(1);
		expect(() => bridge.expectCall("late-cancel", "read", { path: "/fixture" })).toThrow(/registration/);
		expect(bridge.pendingCallIds).toEqual([]);
	});
	it("bounds failed registration memory without evicting IDs that could execute late", async () => {
		const { bridge, call } = await fixture();
		for (let index = 0; index < 257; index++) expect(await call(`unknown-${index}`)).toMatchObject({ isError: true });
		expect(() => bridge.expectCall("unknown-0", "read")).toThrow(/closed/);
		expect(() => bridge.expectCall("fresh", "read")).toThrow(/closed/);
	});
	it("rejects duplicate unregistered dispatch without unbounded waiters", async () => {
		const { bridge, call, complete } = await fixture(1000);
		const first = call("waiting");
		// MCP transports dispatch in order; the second response proves both reached the bridge.
		expect(await call("waiting")).toMatchObject({ isError: true });
		bridge.expectCall("waiting", "read", { path: "/fixture" });
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual(["waiting"]));
		complete("waiting", "Pi result");
		expect(await first).toMatchObject({ isError: false });
	});
	it("advertises Pi schemas and parks a correlated call until Pi supplies the result", async () => {
		const { bridge, client, call, complete } = await fixture();
		const listed = await client.listTools();
		expect(listed.tools.map(tool => tool.name)).toEqual(["read", "bash"]);
		expect(listed.tools[0].inputSchema.required).toEqual(["path"]);
		bridge.expectCall("one", "read", { path: "/fixture" });
		let settled = false;
		const pending = call("one").then(result => { settled = true; return result; });
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual(["one"]));
		expect(settled).toBe(false);
		complete("one", "Pi's result");
		expect(await pending).toMatchObject({ content: [{ type: "text", text: "Pi's result" }], isError: false });
	});
	it("returns a Pi guard denial without executing anything inside the SDK bridge", async () => {
		const { bridge, call, complete } = await fixture();
		bridge.expectCall("denied", "bash", { command: "forbidden" });
		const pending = call("denied", "bash", { command: "forbidden" });
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual(["denied"]));
		complete("denied", "Pi guard refused", "bash", true);
		expect(await pending).toMatchObject({ isError: true, content: [{ type: "text", text: "Pi guard refused" }] });
	});
	it("correlates parallel and early results by tool-use ID, not arrival order", async () => {
		const { bridge, call, complete } = await fixture();
		bridge.expectCall("first", "read", { path: "/fixture" });
		bridge.expectCall("second", "read", { path: "/fixture" });
		complete("second", "result two");
		const first = call("first");
		const second = call("second");
		expect(await second).toMatchObject({ content: [{ type: "text", text: "result two" }] });
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual(["first"]));
		complete("first", "result one");
		expect(await first).toMatchObject({ content: [{ type: "text", text: "result one" }] });
	});
	it("rejects missing/forged metadata and changed tool names or arguments", async () => {
		const { bridge, client, call, complete } = await fixture();
		bridge.expectCall("known", "read", { path: "/fixture" });
		expect(await client.callTool({ name: "read", arguments: {} })).toMatchObject({ isError: true });
		expect(await call("unknown")).toMatchObject({ isError: true });
		expect(await call("known", "bash")).toMatchObject({ isError: true });
		expect(await call("known", "read", { path: "/different" })).toMatchObject({ isError: true });
		expect(() => complete("unknown", "bad")).toThrow("correlation");
		expect(() => complete("known", "bad", "bash")).toThrow("correlation");
		complete("known", "valid");
		expect(await call("known")).toMatchObject({ isError: false });
	});
	it("refuses duplicate calls/results instead of completing another call", async () => {
		const { bridge, call, complete } = await fixture();
		bridge.expectCall("one", "read", { path: "/fixture" });
		expect(() => bridge.expectCall("one", "read")).toThrow("Duplicate");
		const pending = call("one");
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual(["one"]));
		expect(await call("one")).toMatchObject({ isError: true });
		complete("one", "once");
		expect(await pending).toMatchObject({ isError: false });
		expect(() => complete("one", "twice")).toThrow("Duplicate");
	});
	it("preserves image and empty/error tool results", async () => {
		const { bridge, call } = await fixture();
		bridge.expectCall("image", "read", { path: "/fixture" });
		bridge.complete({ toolCallId: "image", toolName: "read",
			content: [{ type: "image", data: "Zml4dHVyZQ==", mimeType: "image/png" }], isError: false });
		expect(await call("image")).toMatchObject({ content: [{ type: "image", data: "Zml4dHVyZQ==", mimeType: "image/png" }] });
		bridge.expectCall("empty", "read", { path: "/fixture" });
		bridge.complete({ toolCallId: "empty", toolName: "read", content: [], isError: true });
		expect(await call("empty")).toMatchObject({ isError: true, content: [{ type: "text", text: "(no output)" }] });
	});
	it("settles parked promises on abort and closes idempotently", async () => {
		const { bridge, controller, call, complete } = await fixture();
		bridge.expectCall("one", "read", { path: "/fixture" });
		const pending = call("one");
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual(["one"]));
		controller.abort();
		expect(await pending).toMatchObject({ isError: true });
		expect(bridge.pendingCallIds).toEqual([]);
		expect(() => complete("one", "late")).toThrow("closed");
		expect(() => bridge.expectCall("next", "read")).toThrow("closed");
		expect(() => bridge.close()).not.toThrow();
	});
	it.each(["cancel", "timeout"])("settles an individual request on %s without closing its parallel sibling", async mode => {
		const { bridge, client, call, complete } = await fixture();
		bridge.expectCall("cancelled", "read", { path: "/fixture" });
		bridge.expectCall("sibling", "read", { path: "/fixture" });
		const requestController = new AbortController();
		if (mode === "timeout") vi.useFakeTimers();
		const pending = client.callTool({ name: "read", arguments: { path: "/fixture" },
			_meta: { "claudecode/toolUseId": "cancelled" } }, undefined,
			mode === "cancel" ? { signal: requestController.signal } : { timeout: 1000 });
		// Observe rejection immediately so the fixture never leaks an unhandled rejection.
		const rejected = expect(pending).rejects.toThrow();
		const sibling = call("sibling");
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual(["cancelled", "sibling"]));
		if (mode === "cancel") requestController.abort();
		else await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual(["sibling"]));
		expect(() => bridge.validateBatch(["sibling", "cancelled"])).toThrow(/cancelled/);
		expect(() => bridge.expectCall("cancelled", "read", { path: "/fixture" })).toThrow(/Duplicate/);
		expect(() => bridge.validateBatch(["sibling"])).not.toThrow();
		expect(() => complete("cancelled", "late result")).toThrow("reconcile");
		expect(await call("cancelled")).toMatchObject({ isError: true });
		complete("sibling", "still active");
		expect(await sibling).toMatchObject({ isError: false, content: [{ type: "text", text: "still active" }] });
	});

	it("settles parked calls when the MCP transport disconnects without a query abort", async () => {
		const { bridge, client, controller, call, complete } = await fixture();
		bridge.expectCall("disconnected", "read", { path: "/fixture" });
		const pending = call("disconnected");
		const rejected = expect(pending).rejects.toThrow("Connection closed");
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual(["disconnected"]));
		await client.close();
		await rejected;
		await vi.waitFor(() => expect(bridge.pendingCallIds).toEqual([]));
		expect(controller.signal.aborted).toBe(false);
		expect(() => complete("disconnected", "ambiguous late result")).toThrow("reconcile");
	});

	it("rejects invalid declarations and an already-aborted query step", async () => {
		const controller = new AbortController();
		controller.abort();
		const bridge = new PiToolBridge([], controller.signal);
		cleanup.push(() => bridge.config.instance.close());
		expect(() => bridge.expectCall("one", "read")).toThrow("closed");
		expect(() => new PiToolBridge([{ name: "bad.name", description: "", parameters: Type.Object({}) }], controller.signal)).toThrow("tool names");
	});
});
