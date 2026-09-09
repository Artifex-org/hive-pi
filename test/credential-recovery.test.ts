import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import credentialRecovery from "../extensions/credential-recovery/index.ts";
import { createFakePi } from "./fake-pi.ts";

const model: Model<"openai-codex-responses"> = {
	id: "test", name: "test", provider: "openai-codex", api: "openai-codex-responses",
	baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1000,
};
const oldAccount = { type: "oauth", accountId: "a", access: "a", refresh: "a", expires: 9999999999999 };
const newAccount = { ...oldAccount, accountId: "b", access: "b", refresh: "b" };
const failure = { role: "assistant", stopReason: "error", errorMessage: "The usage limit has been reached" };

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

async function fixture(status = 200) {
	const dir = await mkdtemp(join(tmpdir(), "recovery-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	const path = join(dir, "auth.json");
	await writeFile(path, JSON.stringify({ "openai-codex": oldAccount, xai: { type: "api_key", key: "keep" } }));
	const requests: unknown[] = [];
	let responseStatus = status;
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk.toString();
		requests.push(JSON.parse(body));
		res.writeHead(responseStatus, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ "openai-codex": newAccount }));
	});
	await new Promise<void>((resolve) => server.listen(path + ".hive-recovery.sock", resolve));
	const pi = createFakePi();
	credentialRecovery(pi.api);
	await pi.emit({ type: "session_start" }, { model });
	return { pi, path, requests, setStatus(value: number) { responseStatus = value; }, async close() {
		await pi.emit({ type: "session_shutdown" });
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(dir, { recursive: true });
	} };
}

describe("credential recovery", () => {
	it("switches accounts and continues the existing transcript exactly once", async () => {
		const f = await fixture();
		try {
			await f.pi.emit({ type: "turn_start" }, { model });
			const completedTools = [{ role: "toolResult", toolCallId: "already-done", content: [{ type: "text", text: "saved" }] }];
			await f.pi.emit({ type: "agent_end", messages: [...completedTools, failure] }, { model });
			expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ "openai-codex": newAccount, xai: { type: "api_key", key: "keep" } });
			expect(f.requests).toEqual([{ provider: "openai-codex", credential: oldAccount, failed: true }]);
			expect(f.pi.messages).toHaveLength(1);
			expect(f.pi.messages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
			expect(f.pi.userMessages).toEqual([]);
			await f.pi.emit({ type: "agent_end", messages: [...completedTools, failure] }, { model });
			expect(f.pi.messages).toHaveLength(1);
		} finally { await f.close(); }
	});

	it("does not inject when all assigned accounts are exhausted", async () => {
		const f = await fixture(409);
		try {
			await f.pi.emit({ type: "turn_start" }, { model });
			await f.pi.emit({ type: "agent_end", messages: [failure] }, { model });
			expect(f.pi.messages).toEqual([]);
			expect(f.pi.statuses.at(-1)?.text).toContain("All assigned accounts exhausted");
			expect(JSON.parse(await readFile(f.path, "utf8"))["openai-codex"]).toEqual(oldAccount);
		} finally { await f.close(); }
	});

	it("automatically retries a quota recovery interrupted by a broker outage", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const f = await fixture(503);
		try {
			await f.pi.emit({ type: "turn_start" }, { model });
			await f.pi.emit({ type: "agent_end", messages: [failure] }, { model });
			expect(f.pi.messages).toEqual([]);
			expect(f.pi.statuses.at(-1)?.text).toContain("Account recovery failed");
			f.setStatus(200);
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			await vi.waitFor(() => expect(f.pi.messages).toHaveLength(1));
			expect(f.requests).toHaveLength(2);
			expect(f.requests[1]).toMatchObject({ provider: "openai-codex", failed: true });
		} finally { await f.close(); }
	});

	it.each(["429 rate limit", "401 unauthorized"])("does not rotate on %s", async (errorMessage) => {
		const f = await fixture();
		try {
			await f.pi.emit({ type: "turn_start" }, { model });
			await f.pi.emit({ type: "agent_end", messages: [{ ...failure, errorMessage }] }, { model });
			expect(f.requests).toEqual([]);
			expect(f.pi.messages).toEqual([]);
		} finally { await f.close(); }
	});
});
