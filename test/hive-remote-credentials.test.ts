import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialReceiver } from "../extensions/hive-remote/credentials.ts";
import { clearCredentialGrants, credentialChildEnv, registerCredentialConsumer } from "../extensions/hive-remote/credential-runtime.ts";

afterEach(() => { vi.unstubAllGlobals(); clearCredentialGrants(); });
const auth = { url: "https://fixture.invalid", token: "fixture-token" };
function response(status: number, body: unknown = {}) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

describe("Hive remote credential receiver", () => {
	it.each([200, 409])("advertises only receiver-probe status %s", async (status) => {
		const release = registerCredentialConsumer("bash");
		vi.stubGlobal("fetch", vi.fn(async () => response(status, status === 200 ? { items: [] } : { error: "needs attachment" })));
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "local", isCurrent: () => true, consumersReady: () => true });
		expect(await receiver.probe(auth, "hive")).toBe(true);
		release();
	});
	it.each([200])("rejects incompatible probe body at status %s", async status => {
		vi.stubGlobal("fetch", vi.fn(async () => response(status)));
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "local", isCurrent: () => true, consumersReady: () => true });
		expect(await receiver.probe(auth, "hive")).toBe(false);
	});
	it.each(["detach", "local", "generation"])("discards an in-flight recovery after independent %s replacement", async kind => {
		let resolve!: (value: Response) => void;
		vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(r => { resolve = r; })));
		let local = "local", generation = 1;
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => local, isCurrent: binding => binding.generation === generation, consumersReady: () => true });
		const recovery = receiver.recover(auth, "hive", 1);
		if (kind === "detach") receiver.detach();
		if (kind === "local") local = "replacement";
		if (kind === "generation") generation++;
		resolve(response(409, { error: "needs attachment" }));
		expect(await recovery).toBe(false);
		expect(receiver.ready()).toBe(false);
	});
	it.each([404, 503])("does not advertise when probe returns %s", async (status) => {
		const release = registerCredentialConsumer("bash");
		vi.stubGlobal("fetch", vi.fn(async () => response(status)));
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "local", isCurrent: () => true, consumersReady: () => true });
		expect(await receiver.probe(auth, "hive")).toBe(false);
		release();
	});
	it("does not probe while disabled or without local identity and consumers", async () => {
		const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
		for (const deps of [
			{ enabled: false, localSessionID: () => "local", isCurrent: () => true, consumersReady: () => true },
			{ enabled: true, localSessionID: () => null, isCurrent: () => true, consumersReady: () => true },
			{ enabled: true, localSessionID: () => "local", isCurrent: () => true, consumersReady: () => false },
		]) expect(await new CredentialReceiver(deps).probe(auth, "hive")).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("shows database scope and network requirements without operator refs or values", async () => {
		vi.stubGlobal("fetch", async () => response(200, { entries: [{
			name: "audit-db-ro", env_var: "AUDIT_PGPASSWORD", description: "SELECT-only hive_audit_ro on Hive, NOT ASFAM",
			requires_hosts: ["fixture-host"], op_ref: "private-operator-ref", value: "private-value", created_by: "private-owner",
		}] }));
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "catalog-local", isCurrent: () => true, consumersReady: () => true });
		receiver.bind(auth, "hive", 1);
		const result = await receiver.list();
		expect(result).toContain("NOT ASFAM"); expect(result).toContain("fixture-host"); expect(result).toContain("AUDIT_PGPASSWORD");
		for (const secret of ["private-operator-ref", "private-value", "private-owner"]) expect(result).not.toContain(secret);
	});

	it.each([400, 403, 409, 503])("preserves request refusal at HTTP %s without claiming a consumed grant", async status => {
		const fetcher = vi.fn(async () => response(status, { detail: "Launch did not declare this credential; relaunch with request_credentials." }));
		vi.stubGlobal("fetch", fetcher);
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "refused-local", isCurrent: () => true, consumersReady: () => true });
		receiver.bind(auth, "hive", 1);
		const result = await receiver.request("nested-call/1", ["fixture"], "test");
		expect(result).toContain(`Credential request failed (HTTP ${status})`);
		expect(result).toContain("relaunch with request_credentials");
		expect(result).toContain("client_call_id: nested-call/1");
		expect(result).not.toContain("delivery failed"); expect(result).not.toContain("fresh call ID");
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(credentialChildEnv("refused-local", {}).FIXTURE_CREDENTIAL).toBeUndefined();
	});

	it("does not claim nothing installed when a lost POST races background delivery", async () => {
		let rejectPost!: (error: Error) => void;
		const pendingPost = new Promise<Response>((_resolve, reject) => { rejectPost = reject; });
		const grant = { id: "racing-grant", verdict: "auto", credentials: ["fixture"], expires_at: new Date(Date.now() + 60_000).toISOString() };
		vi.stubGlobal("fetch", async (raw: string, init?: RequestInit) => {
			if (init?.method === "POST") return pendingPost;
			if (raw.endsWith("/credential-grants")) return response(200, { items: [grant] });
			if (raw.endsWith("/credential-catalog")) return response(200, { entries: [{ name: "fixture", env_var: "FIXTURE_CREDENTIAL" }] });
			if (raw.endsWith("/value")) return response(200, { env: { FIXTURE_CREDENTIAL: "race-value" }, resolved: ["fixture"] });
			return response(404);
		});
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "race-local", isCurrent: () => true, consumersReady: () => true });
		receiver.bind(auth, "hive", 1);
		const result = receiver.request("race-call", ["fixture"], "test");
		await receiver.poll();
		expect(credentialChildEnv("race-local", {}).FIXTURE_CREDENTIAL).toBe("race-value");
		rejectPost(new Error("lost POST"));
		const diagnostic = await result;
		expect(diagnostic).toContain("installation is not confirmed by this call");
		expect(diagnostic).not.toContain("nothing installed"); expect(diagnostic).not.toContain("race-value");
	});

	it("distinguishes a failed verdict poll from one-shot delivery", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			vi.stubGlobal("fetch", async () => ++calls === 1 ? response(200, { id: "pending", verdict: "pending" }) : response(403, { detail: "request access revoked" }));
			const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "poll-local", isCurrent: () => true, consumersReady: () => true });
			receiver.bind(auth, "hive", 1);
			const pending = receiver.request("poll-call", ["fixture"], "test");
			await vi.advanceTimersByTimeAsync(3000);
			const result = await pending;
			expect(result).toContain("Credential poll failed (HTTP 403)"); expect(result).toContain("request access revoked");
			expect(result).not.toContain("delivery failed"); expect(calls).toBe(2);
		} finally { vi.useRealTimers(); }
	});

	it("never exposes fetched values in result or notice and installs only on future children", async () => {
		const release = registerCredentialConsumer("bash");
		const notice: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/credential-requests")) return response(200, { id: "grant-id", verdict: "approve", credentials: ["fixture"], expires_at: new Date(Date.now() + 60_000).toISOString() });
			if (url.endsWith("/credential-catalog")) return response(200, { entries: [{ name: "fixture", env_var: "FIXTURE_CREDENTIAL" }] });
			if (url.endsWith("/credential-grants/grant-id/value")) return response(200, { env: { FIXTURE_CREDENTIAL: "synthetic-safe-value" }, resolved: ["fixture"] });
			return response(500);
		}));
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "local", isCurrent: () => true, consumersReady: () => true, notice: text => notice.push(text) });
		receiver.bind(auth, "hive", 1);
		const result = await receiver.request("call", ["fixture"], "test");
		expect(result).not.toContain("synthetic-safe-value");
		expect(notice.join(" ")).not.toContain("synthetic-safe-value");
		expect(receiver.ready()).toBe(true);
		release();
	});

	it("coordinates native and MCP-discovered grants with one fetch and retries only before consumption", async () => {
		const row = { id: "shared", verdict: "approve", credentials: ["fixture"], expires_at: new Date(Date.now() + 60_000).toISOString() };
		let catalogFailure = true, valueCalls = 0;
		let releaseValue!: () => void;
		const pending = new Promise<void>(resolve => { releaseValue = resolve; });
		vi.stubGlobal("fetch", async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/credential-requests")) return response(200, row);
			if (url.endsWith("/credential-grants")) return response(200, { items: [row] });
			if (url.endsWith("/credential-catalog")) return catalogFailure ? response(503) : response(200, { entries: [{ name: "fixture", env_var: "FIXTURE_CREDENTIAL" }] });
			if (url.endsWith("/value")) { valueCalls++; await pending; return response(200, { env: { FIXTURE_CREDENTIAL: "coordinator-fixture" }, resolved: ["fixture"] }); }
			throw new Error("unexpected path");
		});
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "shared-local", isCurrent: () => true, consumersReady: () => true });
		receiver.bind(auth, "hive", 1);
		expect(await receiver.request("call", ["fixture"], "test")).toContain("nothing installed");
		expect(valueCalls).toBe(0);
		catalogFailure = false;
		const native = receiver.request("call", ["fixture"], "test");
		const discovery = receiver.poll();
		await vi.waitFor(() => expect(valueCalls).toBe(1));
		releaseValue();
		expect(await native).toContain("Installed"); await discovery;
		await receiver.poll();
		expect(valueCalls).toBe(1);
		expect(credentialChildEnv("shared-local", {}).FIXTURE_CREDENTIAL).toBe("coordinator-fixture");
		expect(credentialChildEnv("other-local", {}).FIXTURE_CREDENTIAL).toBeUndefined();
	});

	it("drops delayed values after local/Hive generation replacement without exposing them", async () => {
		let local = "old-local", current = true, started = false;
		let releaseValue!: () => void;
		const pending = new Promise<void>(resolve => { releaseValue = resolve; });
		vi.stubGlobal("fetch", async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/credential-requests")) return response(200, { id: "late", verdict: "approve", credentials: ["fixture"], expires_at: new Date(Date.now() + 60_000).toISOString() });
			if (url.endsWith("/credential-catalog")) return response(200, { entries: [{ name: "fixture", env_var: "FIXTURE_CREDENTIAL" }] });
			started = true; await pending;
			return response(200, { env: { FIXTURE_CREDENTIAL: "stale-fixture" }, resolved: ["fixture"] });
		});
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => local, isCurrent: () => current, consumersReady: () => true });
		receiver.bind(auth, "old-hive", 1);
		const result = receiver.request("call", ["fixture"], "test");
		await vi.waitFor(() => expect(started).toBe(true));
		current = false; receiver.detach(); local = "new-local"; current = true; receiver.bind(auth, "new-hive", 2);
		releaseValue();
		expect(await result).not.toContain("stale-fixture");
		expect(credentialChildEnv("old-local", {}).FIXTURE_CREDENTIAL).toBeUndefined();
		expect(credentialChildEnv("new-local", {}).FIXTURE_CREDENTIAL).toBeUndefined();
	});

	it.each([
		{ env: { FIXTURE_CREDENTIAL: "synthetic-safe-value", EXTRA: "extra" }, resolved: ["fixture"] },
		{ env: { FIXTURE_CREDENTIAL: "synthetic-safe-value" }, resolved: ["fixture", "fixture"] },
		{ env: { FIXTURE_CREDENTIAL: "synthetic-safe-value" }, resolved: ["other"] },
	])("rejects inconsistent value mappings without installing", async body => {
		vi.stubGlobal("fetch", async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/credential-requests")) return response(200, { id: "bad", verdict: "approve", credentials: ["fixture"], expires_at: new Date(Date.now() + 60_000).toISOString() });
			if (url.endsWith("/credential-catalog")) return response(200, { entries: [{ name: "fixture", env_var: "FIXTURE_CREDENTIAL" }] });
			return response(200, body);
		});
		const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "bad-local", isCurrent: () => true, consumersReady: () => true });
		receiver.bind(auth, "hive", 1);
		expect(await receiver.request("call", ["fixture"], "test")).toContain("nothing installed");
		expect(credentialChildEnv("bad-local", {}).FIXTURE_CREDENTIAL).toBeUndefined();
	});

	it("offers fresh-call guidance after catalog/value failures without leaking response bodies", async () => {
		for (const failureStatus of [502, 410]) {
			const release = registerCredentialConsumer("bash");
			const calls: string[] = [];
			vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
				const url = String(input); calls.push(url);
				if (url.endsWith("/credential-requests")) return response(200, { id: "grant-id", verdict: "approve", credentials: ["fixture"], expires_at: new Date(Date.now() + 60_000).toISOString() });
				if (url.endsWith("/credential-catalog")) return response(200, { entries: [{ name: "fixture", env_var: "FIXTURE_CREDENTIAL" }] });
				return response(failureStatus, { detail: "synthetic-safe-value" });
			}));
			const receiver = new CredentialReceiver({ enabled: true, localSessionID: () => "local", isCurrent: () => true, consumersReady: () => true });
			receiver.bind(auth, "hive", 1);
			const result = await receiver.request("call", ["fixture"], "test");
			expect(result).toContain("fresh call ID"); expect(result).not.toContain("synthetic-safe-value");
			expect(calls.filter(url => url.endsWith("/value"))).toHaveLength(1);
			release(); vi.unstubAllGlobals();
		}
	});
});
