import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerWorkspaceTools } from "../extensions/hive-remote/workspace.ts";

let targetDir: string | undefined;

afterEach(() => {
	if (targetDir) rmSync(targetDir, { recursive: true, force: true });
	targetDir = undefined;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("opens fresh consent after expiry only with an explicit new ID and reuses it on retries", async () => {
	vi.useFakeTimers();
	targetDir = mkdtempSync(join(tmpdir(), "hive-pi-workspace-retry-"));
	const requests = new Map<string, string>([["workspace:hive-pi", "expired"]]);
	const grantIDs = new Map<string, string>([["workspace:hive-pi", "expired-grant"]]);
	const posts: string[] = [];
	const polls: string[] = [];
	const deliveries: string[] = [];
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname;
		if (path.endsWith("/workspace-catalog")) {
			return json({ entries: [{ name: "hive-pi", repo: "Artifex-org/hive-pi" }] });
		}
		if (init?.method === "POST") {
			const { client_call_id } = JSON.parse(String(init.body));
			posts.push(client_call_id);
			if (!requests.has(client_call_id)) {
				requests.set(client_call_id, "pending");
				grantIDs.set(client_call_id, "reopened-grant");
			}
			return json({ id: grantIDs.get(client_call_id), verdict: requests.get(client_call_id) });
		}
		if (path.includes("/workspace-requests/")) {
			const id = decodeURIComponent(path.split("/").at(-1)!);
			polls.push(id);
			return json({ id: grantIDs.get(id), verdict: requests.get(id) });
		}
		if (path === "/api/v1/agent-sessions/sess-1/workspace-grants/reopened-grant/value") {
			deliveries.push(path);
			return deliveries.length === 1
				? json({ repos: [{ name: "hive-pi", repo: "Artifex-org/hive-pi", branch: "main", target_dir: targetDir }] })
				: new Response("already delivered", { status: 410 });
		}
		throw new Error(`Unexpected request: ${path}`);
	}));
	type Tool = { name: string; execute: (id: string, params: { repo: string; request_id?: string }) => Promise<{ content: Array<{ text: string }> }> };
	const tools = new Map<string, Tool>();
	const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
	registerWorkspaceTools({ registerTool: (tool: Tool) => tools.set(tool.name, tool), exec } as never, {
		enabled: true, getAuth: () => ({ token: "test", url: "https://hive.example" }), getSessionID: () => "sess-1",
	});
	const tool = tools.get("request_workspace")!;
	const expired = await tool.execute("original", { repo: "hive-pi" });
	expect(expired.content[0].text).toContain("expired");
	expect(polls).toHaveLength(0);
	expect(deliveries).toHaveLength(0);

	const params = { repo: "hive-pi", request_id: "operator-reopen-1" };
	const reopened = tool.execute("reopened", params);
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersToNextTimerAsync();
	expect(posts).toEqual(["workspace:hive-pi", "workspace:hive-pi:operator-reopen-1"]);
	expect(polls).toEqual(["workspace:hive-pi:operator-reopen-1"]);
	expect(requests.get("workspace:hive-pi")).toBe("expired");
	expect(deliveries).toHaveLength(0);
	expect(exec).not.toHaveBeenCalled();

	// A second invocation during the wait rejoins the same pending consent.
	const pendingRetry = tool.execute("pending-retry", params);
	await vi.advanceTimersByTimeAsync(0);
	expect(posts.slice(1)).toEqual(Array(2).fill("workspace:hive-pi:operator-reopen-1"));
	expect(requests.size).toBe(2);
	expect(deliveries).toHaveLength(0);
	expect(exec).not.toHaveBeenCalled();

	// The owner must actually approve; then an invocation retry rejoins that row.
	requests.set("workspace:hive-pi:operator-reopen-1", "approve");
	await vi.advanceTimersByTimeAsync(3_000);
	const granted = await reopened;
	expect(granted.content[0].text).toContain("Workspace granted (approve).");
	expect(granted.content[0].text).toContain(`cloned Artifex-org/hive-pi (branch main) into ${join(targetDir!, "hive-pi")}`);
	expect(exec).toHaveBeenCalledExactlyOnceWith("env", ["GIT_TERMINAL_PROMPT=0", "git", "clone", "--branch", "main", "https://github.com/Artifex-org/hive-pi", join(targetDir!, "hive-pi")], expect.anything());
	const concurrentRetry = await pendingRetry;
	expect(concurrentRetry.content[0].text).toContain("already granted and delivered");
	const retry = await tool.execute("retry", params);
	expect(retry.content[0].text).toContain("already granted and delivered");
	expect(posts.slice(1)).toEqual(Array(3).fill("workspace:hive-pi:operator-reopen-1"));
	expect(requests.size).toBe(2);

	// Omitting the ID still rejoins the expired original, never silently renews it.
	await tool.execute("default-retry", { repo: "hive-pi" });
	expect(posts.at(-1)).toBe("workspace:hive-pi");
	// Nor does a denied request get silently reopened on a later invocation.
	requests.set("workspace:hive-pi:operator-reopen-1", "deny");
	const denied = await tool.execute("denied-retry", params);
	expect(denied.content[0].text).toContain("denied");
	expect(requests.size).toBe(2);
	expect(deliveries).toEqual(Array(3).fill("/api/v1/agent-sessions/sess-1/workspace-grants/reopened-grant/value"));
	expect(exec).toHaveBeenCalledTimes(1);
});
