import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import {
	bindCredentialSession, clearCredentialBinding, clearCredentialGrants, credentialChildEnv, credentialChildState,
	credentialOperations, installCredentialGrant, LiteralSecretRedactor, registerCredentialConsumer,
	validCredentialSet,
} from "../extensions/hive-remote/credential-runtime.ts";

afterEach(() => clearCredentialGrants());
// Deliberately repetitive, unmistakable fixture data; no credential material.
const secret = "fixture-fixture-fixture";
const item = (value = secret) => ({ name: "fixture", env_var: "FIXTURE_CREDENTIAL", value });

 describe("credential runtime", () => {
	it("rejects malformed, duplicate, reserved, identity and provider/runtime environment mappings", () => {
		for (const [name, env_var, value] of [
			["bad name!", "FIXTURE", "x"], ["n", "PATH", "x"], ["n", "HOME", "x"], ["n", "PI_MODEL", "x"],
			["n", "HIVE_TOKEN", "x"], ["n", "AWS_SECRET_ACCESS_KEY", "x"], ["n", "OPENAI_API_KEY", "x"],
			["n", "NODE_OPTIONS", "x"], ["n", "BASH_ENV", "x"], ["n", "FIXTURE", ""], ["n", "FIXTURE", "bad\0value"],
			["n", "FIXTURE", "\ud800"], ["n", "FIXTURE", "x".repeat(16_385)],
		] as string[][]) expect(validCredentialSet([{ name, env_var, value }])).toBe(false);
		expect(validCredentialSet([item(), item("another")])).toBe(false);
		expect(validCredentialSet([{ name: "same", env_var: "FIRST", value: "a" }, { name: "same", env_var: "SECOND", value: "b" }])).toBe(false);
		expect(validCredentialSet([{ name: "a", env_var: "SAME", value: "a" }, { name: "b", env_var: "SAME", value: "b" }])).toBe(false);
	});

	it("replaces bindings, isolates local sessions and restores base env on expiry and detach", () => {
		const first = bindCredentialSession("local-a", "hive-a", 1);
		expect(installCredentialGrant(first, "grant-a", Date.now() + 60_000, [item()] )).toBe(true);
		const base = { ...process.env, FIXTURE_CREDENTIAL: "base" };
		expect(credentialChildEnv("local-b", base).FIXTURE_CREDENTIAL).toBe("base");
		const replaced = bindCredentialSession("local-a", "hive-b", 2);
		expect(installCredentialGrant(first, "stale", Date.now() + 60_000, [item()])).toBe(false);
		expect(installCredentialGrant(replaced, "grant-b", Date.now() + 60_000, [item("new-fixture")])).toBe(true);
		expect(credentialChildEnv("local-a", base).FIXTURE_CREDENTIAL).toBe("new-fixture");
		const expired = bindCredentialSession("local-exp", "hive-exp", 3);
		installCredentialGrant(expired, "exp", Date.now() - 1, [item()]);
		expect(credentialChildEnv("local-exp", base).FIXTURE_CREDENTIAL).toBe("base");
		clearCredentialGrants();
		expect(credentialChildEnv("local-a", base).FIXTURE_CREDENTIAL).toBe("base");
	});

	it("expires installed grants and does not let stale cleanup erase a newer binding", () => {
		vi.useFakeTimers();
		try {
			const old = bindCredentialSession("expiry-local", "old-hive", 1);
			const current = bindCredentialSession("expiry-local", "new-hive", 2);
			expect(installCredentialGrant(current, "ttl", Date.now() + 1000, [item()])).toBe(true);
			const child = credentialChildState("expiry-local", {});
			clearCredentialBinding(old);
			expect(credentialChildEnv("expiry-local", {}).FIXTURE_CREDENTIAL).toBe(secret);
			vi.advanceTimersByTime(1001);
			expect(credentialChildEnv("expiry-local", { FIXTURE_CREDENTIAL: "base" }).FIXTURE_CREDENTIAL).toBe("base");
			expect(child.push("stdout", Buffer.from(secret)).toString()).toBe("[credential redacted]");
		} finally { clearCredentialGrants(); vi.useRealTimers(); }
	});

	it("deduplicates consumers and redacts complete, split UTF-8 and overlapping literals", () => {
		const release = registerCredentialConsumer("bash");
		const releaseAgain = registerCredentialConsumer("bash");
		expect(release()).toBeUndefined(); expect(releaseAgain()).toBeUndefined();
		const redactor = new LiteralSecretRedactor(["abc", "abcdef"]);
		expect(Buffer.concat([redactor.push(Buffer.from("xxabc")), redactor.push(Buffer.from("defyy")), redactor.flush()]).toString()).toBe("xx[credential redacted]yy");
		const utf8 = new LiteralSecretRedactor(["π-safe"]);
		const bytes = Buffer.from("π-safe!");
		expect(Buffer.concat([utf8.push(bytes.subarray(0, 1)), utf8.push(bytes.subarray(1, 4)), utf8.push(bytes.subarray(4)), utf8.flush()]).toString()).toBe("[credential redacted]!");
	});

	it("protects real SDK bash results and stream interleaving before accumulation", async () => {
		const binding = bindCredentialSession("sdk-local", "sdk-hive", 1);
		installCredentialGrant(binding, "sdk-grant", Date.now() + 60_000, [item()]);
		let seenEnv: NodeJS.ProcessEnv | undefined;
		const ops = credentialOperations({ exec: async (_command, _cwd, options) => {
			seenEnv = options.env;
			const stdout = new Readable({ read() {} }), stderr = new Readable({ read() {} });
			options.onData.call(stdout, Buffer.from(secret.slice(0, 7)));
			options.onData.call(stderr, Buffer.from("diagnostic\n"));
			options.onData.call(stdout, Buffer.from(secret.slice(7)));
			options.onData.call(stdout, Buffer.from("!"));
			return { exitCode: 0 };
		} }, "sdk-local");
		const tool = createBashTool(process.cwd(), { operations: ops });
		const result = await tool.execute("call", { command: "true" }, undefined, undefined);
		expect(seenEnv?.FIXTURE_CREDENTIAL).toBe(secret);
		const exposed = JSON.stringify(result);
		expect(exposed).not.toContain(secret);
		expect(exposed).toContain("[credential redacted]");
		expect(exposed).toContain("diagnostic");
		expect(process.env.FIXTURE_CREDENTIAL).toBeUndefined();
	});

	it("keeps running-child output protected after grant expiry and detach", () => {
		const binding = bindCredentialSession("running-child", "hive", 1);
		installCredentialGrant(binding, "grant", Date.now() + 60_000, [item()]);
		const child = credentialChildState("running-child", process.env);
		clearCredentialGrants();
		expect(child.env.FIXTURE_CREDENTIAL).toBe(secret);
		expect(Buffer.concat([child.push("stdout", Buffer.from(secret)), child.flush()]).toString()).toBe("[credential redacted]");
		expect(credentialChildEnv("running-child", process.env).FIXTURE_CREDENTIAL).toBeUndefined();
	});
});
