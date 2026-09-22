import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import credentialRecovery, { RECOVERY_CHANNEL } from "../extensions/credential-recovery/index.ts";
import { exchangeViaMailbox } from "../extensions/credential-recovery/client.ts";
import { createFakePi } from "./fake-pi.ts";

// HIV-3452. srt's seccomp blocks socket(AF_UNIX), so a sandboxed agent cannot
// reach the recovery socket; the lease holder (pilease, Go) serves the same
// exchange through `auth.json.hive-recovery.d/`. These play that holder.
const model: Model<"openai-codex-responses"> = {
	id: "test", name: "test", provider: "openai-codex", api: "openai-codex-responses",
	baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1000,
};
const oldAccount = { type: "oauth", accountId: "a", access: "a", refresh: "a", expires: 9999999999999 };
const newAccount = { ...oldAccount, accountId: "b", access: "b", refresh: "b" };
const failure = { role: "assistant", stopReason: "error", errorMessage: "The usage limit has been reached" };

afterEach(() => { vi.unstubAllEnvs(); });

/** A minimal lease holder: answer every `<id>.req` with `reply`, like pilease. */
function holder(box: string, reply: (req: { provider: string; failed: boolean }) => object) {
	const requests: { provider: string; failed: boolean }[] = [];
	let stopped = false;
	const loop = (async () => {
		while (!stopped) {
			for (const name of await readdir(box).catch(() => [] as string[])) {
				if (!name.endsWith(".req")) continue;
				const path = join(box, name);
				const req = JSON.parse(await readFile(path, "utf8"));
				await rm(path);
				requests.push(req);
				const id = name.slice(0, -".req".length);
				await writeFile(join(box, `${id}.resp.tmp`), JSON.stringify(reply(req)));
				await rename(join(box, `${id}.resp.tmp`), join(box, `${id}.resp`));
			}
			await new Promise((r) => setTimeout(r, 20));
		}
	})();
	return { requests, async stop() { stopped = true; await loop; } };
}

it("recovers a sandboxed quota failure through the mailbox when the socket is blocked", async () => {
	const dir = await mkdtemp(join(tmpdir(), "recovery-mailbox-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	const path = join(dir, "auth.json");
	await writeFile(path, JSON.stringify({ "openai-codex": oldAccount }));
	await writeFile(path + ".hive-recovery.sock", ""); // visible, not connectable — the sandbox shape
	const box = path + ".hive-recovery.d";
	await mkdir(box, { mode: 0o700 });
	const h = holder(box, () => ({ status: 200, document: { "openai-codex": newAccount } }));
	const pi = createFakePi();
	credentialRecovery(pi.api);
	try {
		await pi.emit({ type: "session_start" }, { model });
		await pi.emit({ type: "turn_start" }, { model });
		await pi.emit({ type: "agent_end", messages: [failure] }, { model });
		expect(h.requests).toEqual([{ provider: "openai-codex", credential: oldAccount, failed: true }]);
		expect(JSON.parse(await readFile(path, "utf8"))["openai-codex"]).toEqual(newAccount);
		expect(pi.messages).toHaveLength(1);
		const states = pi.busEvents.filter((e) => e.name === RECOVERY_CHANNEL).map((e) => (e.payload as { state: string }).state);
		expect(states).not.toContain("unavailable");
		expect(states).not.toContain("error");
		expect(await readdir(box)).toEqual([]);
	} finally {
		await pi.emit({ type: "session_shutdown" });
		await h.stop();
		await rm(dir, { recursive: true });
	}
});

it("reads the holder's statuses exactly as the socket does", async () => {
	const box = await mkdtemp(join(tmpdir(), "recovery-mailbox-status-"));
	let status = 409;
	const h = holder(box, () => ({ status, error: "all assigned accounts tried" }));
	try {
		const credential = { type: "api_key" as const, key: "k" };
		expect(await exchangeViaMailbox(box, "xai", credential, true, { pollMs: 10 })).toEqual({ status: "exhausted" });
		status = 422;
		expect(await exchangeViaMailbox(box, "xai", credential, true, { pollMs: 10 })).toEqual({ status: "unavailable" });
		status = 502;
		await expect(exchangeViaMailbox(box, "xai", credential, true, { pollMs: 10 })).rejects.toThrow(/HTTP 502/);
	} finally {
		await h.stop();
		await rm(box, { recursive: true });
	}
});

it("withdraws an unanswered request when the holder is gone", async () => {
	const box = await mkdtemp(join(tmpdir(), "recovery-mailbox-dead-"));
	try {
		await expect(exchangeViaMailbox(box, "xai", { type: "api_key", key: "k" }, true, { timeoutMs: 150, pollMs: 10 }))
			.rejects.toThrow(/timed out/);
		expect(await readdir(box)).toEqual([]);
	} finally { await rm(box, { recursive: true }); }
});
