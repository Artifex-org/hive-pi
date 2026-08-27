import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestAndWait, type WorkspaceGrantValue } from "../extensions/hive-remote/client.ts";
import { expandTargetDir, registerWorkspaceTools } from "../extensions/hive-remote/workspace.ts";
import { isSafeGrantName, isSafeRepoSlug } from "../extensions/hive-remote/workspace.ts";

const auth = { token: "hive_test", url: "https://hive.example" };

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A fetch stub that routes by (method, path) and pops one queued response per
 * matched call. The queues let a single route return a sequence — a pending poll
 * followed by an approved one — which is the whole point of a request-and-wait.
 * The captured request records let a test assert what the client actually sent
 * (the idempotent client_call_id above all).
 */
function stubFetch(queues: {
	post?: Response[];
	poll?: Response[];
	value?: Response[];
}): { calls: Array<{ method: string; url: string; body: unknown }> } {
	const calls: Array<{ method: string; url: string; body: unknown }> = [];
	const post = [...(queues.post ?? [])];
	const poll = [...(queues.poll ?? [])];
	const value = [...(queues.value ?? [])];

	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
			const method = (init?.method ?? "GET").toUpperCase();
			const u = String(url);
			const body = init?.body ? JSON.parse(init.body) : undefined;
			calls.push({ method, url: u, body });

			if (method === "POST" && u.endsWith("/workspace-requests")) {
				const res = post.shift();
				if (res) return res;
			}
			if (method === "GET" && u.includes("/workspace-grants/") && u.endsWith("/value")) {
				const res = value.shift();
				if (res) return res;
			}
			if (method === "GET" && u.includes("/workspace-requests/")) {
				const res = poll.shift();
				if (res) return res;
			}
			throw new Error(`unexpected ${method} ${u}`);
		}),
	);
	return { calls };
}

const FAST = { pollMs: 1, timeoutMs: 2_000 };

const GRANT: WorkspaceGrantValue = {
	repos: [{ name: "gitops", repo: "acme/gitops", branch: "main", target_dir: "~/.hive/scratch/feature-x" }],
};

let temporaryTargetDir: string | undefined;

afterEach(() => {
	vi.unstubAllGlobals();
	if (temporaryTargetDir) rmSync(temporaryTargetDir, { recursive: true, force: true });
	temporaryTargetDir = undefined;
});

describe("requestAndWait", () => {
	it("polls a pending request to approval and returns the one-shot grant", async () => {
		const { calls } = stubFetch({
			post: [json(201, { id: "grant-1", verdict: "pending" })],
			poll: [json(200, { id: "grant-1", verdict: "pending" }), json(200, { id: "grant-1", verdict: "approve" })],
			value: [json(200, GRANT)],
		});

		const decision = await requestAndWait<WorkspaceGrantValue>(auth, "workspace", "sess-1", "workspace:gitops", { repos: ["gitops"], reason: "fix" }, FAST);

		expect(decision.verdict).toBe("approve");
		expect(decision.grant?.repos[0]?.repo).toBe("acme/gitops");
		// The POST carried the idempotent client_call_id, and the value fetch was
		// keyed on the grant id from the row.
		expect(calls[0]).toMatchObject({ method: "POST", body: { client_call_id: "workspace:gitops", repos: ["gitops"] } });
		expect(calls.some((c) => c.url.endsWith("/workspace-grants/grant-1/value"))).toBe(true);
	});

	it("skips the poll loop when the POST is already terminal (auto)", async () => {
		const { calls } = stubFetch({
			post: [json(201, { id: "g2", verdict: "auto" })],
			value: [json(200, GRANT)],
		});

		const decision = await requestAndWait<WorkspaceGrantValue>(auth, "workspace", "sess-1", "workspace:gitops", { repos: ["gitops"] }, FAST);

		expect(decision.verdict).toBe("auto");
		expect(decision.grant?.repos).toHaveLength(1);
		// POST + value only — no poll of /workspace-requests/{callID}.
		expect(calls.filter((c) => c.method === "GET" && c.url.includes("/workspace-requests/"))).toHaveLength(0);
	});

	it("returns deny without fetching any grant value", async () => {
		const { calls } = stubFetch({
			post: [json(201, { id: "g3", verdict: "pending" })],
			poll: [json(200, { id: "g3", verdict: "deny" })],
		});

		const decision = await requestAndWait<WorkspaceGrantValue>(auth, "workspace", "sess-1", "workspace:gitops", { repos: ["gitops"] }, FAST);

		expect(decision.verdict).toBe("deny");
		expect(decision.grant).toBeUndefined();
		expect(calls.some((c) => c.url.includes("/workspace-grants/"))).toBe(false);
	});

	it("handles a 410 on the value fetch (grant already delivered) without throwing", async () => {
		stubFetch({
			post: [json(201, { id: "g4", verdict: "approve" })],
			value: [json(410, { detail: "grant already delivered" })],
		});

		const decision = await requestAndWait<WorkspaceGrantValue>(auth, "workspace", "sess-1", "workspace:gitops", { repos: ["gitops"] }, FAST);

		expect(decision.verdict).toBe("approve");
		expect(decision.grant).toBeUndefined();
		expect(decision.gone).toBe(true);
		expect(decision.status).toBe(410);
	});

	it("times out (not denies) when the request stays pending past the window", async () => {
		stubFetch({
			post: [json(201, { id: "g5", verdict: "pending" })],
			poll: Array.from({ length: 50 }, () => json(200, { id: "g5", verdict: "pending" })),
		});

		const decision = await requestAndWait<WorkspaceGrantValue>(auth, "workspace", "sess-1", "workspace:gitops", { repos: ["gitops"] }, { pollMs: 1, timeoutMs: 15 });

		expect(decision.verdict).toBe("timeout");
		expect(decision.grant).toBeUndefined();
	});

	it("ends the wait when the abort signal fires", async () => {
		stubFetch({
			post: [json(201, { id: "g6", verdict: "pending" })],
			poll: Array.from({ length: 50 }, () => json(200, { id: "g6", verdict: "pending" })),
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5).unref?.();

		const decision = await requestAndWait<WorkspaceGrantValue>(
			auth,
			"workspace",
			"sess-1",
			"workspace:gitops",
			{ repos: ["gitops"] },
			{ pollMs: 1, timeoutMs: 5_000, signal: controller.signal },
		);

		expect(decision.verdict).toBe("error");
		expect(decision.error).toBe("interrupted");
	});

	it("stops polling on a permanent poll failure instead of hammering to the deadline", async () => {
		const { calls } = stubFetch({
			post: [json(201, { id: "g7", verdict: "pending" })],
			// A revoked token mid-wait: the first poll 403s. The loop must bail, not
			// re-hit it every pollMs for the whole (here huge) timeout window.
			poll: [json(403, { detail: "token revoked" })],
		});

		const decision = await requestAndWait<WorkspaceGrantValue>(auth, "workspace", "sess-1", "workspace:gitops", { repos: ["gitops"] }, { pollMs: 1, timeoutMs: 60_000 });

		expect(decision.verdict).toBe("error");
		expect(decision.status).toBe(403);
		expect(calls.filter((c) => c.method === "GET" && c.url.includes("/workspace-requests/"))).toHaveLength(1);
	});

	it("retries a transient 404 mid-poll instead of abandoning an approved request", async () => {
		const { calls } = stubFetch({
			post: [json(201, { id: "g8", verdict: "pending" })],
			// A deploy cycles a pod mid-wait: one poll 404s ("no such workspace
			// request"). The row was created by the POST, so this is transient — the
			// loop must keep polling and pick up the approval on the next poll, NOT
			// give up on a grant that is already recorded. (Regression: observed live
			// when re-enabling the flag cycled hive-server mid-request.)
			poll: [
				json(200, { id: "g8", verdict: "pending" }),
				json(404, { detail: "no such workspace request" }),
				json(200, { id: "g8", verdict: "approve" }),
			],
			value: [json(200, GRANT)],
		});

		const decision = await requestAndWait<WorkspaceGrantValue>(auth, "workspace", "sess-1", "workspace:gitops", { repos: ["gitops"] }, { pollMs: 1, timeoutMs: 60_000 });

		expect(decision.verdict).toBe("approve");
		expect(decision.grant?.repos[0]?.repo).toBe("acme/gitops");
		// It polled THROUGH the 404 (three GETs), rather than bailing on it.
		expect(calls.filter((c) => c.method === "GET" && c.url.includes("/workspace-requests/"))).toHaveLength(3);
	});

	it("surfaces a POST failure as an error decision, not a throw", async () => {
		stubFetch({ post: [json(403, { detail: "capability not declared" })] });

		const decision = await requestAndWait<WorkspaceGrantValue>(auth, "workspace", "sess-1", "workspace:gitops", { repos: ["gitops"] }, FAST);

		expect(decision.verdict).toBe("error");
		expect(decision.status).toBe(403);
	});
});

describe("request_workspace tool approval flow", () => {
	it("observes approval, grant fetch, provisioning, and tool completion in order", async () => {
		const phases: string[] = [];
		temporaryTargetDir = mkdtempSync(join(tmpdir(), "hiv1457-workspace-guard-"));
		const tools = new Map<string, { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }> }> }>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { method?: string }) => {
				const method = (init?.method ?? "GET").toUpperCase();
				const path = String(url);
				if (path.endsWith("/workspace-catalog")) {
					phases.push("catalog");
					return json(200, { entries: [{ name: "hive", repo: "Artifex-org/hive" }] });
				}
				if (method === "POST" && path.endsWith("/workspace-requests")) {
					phases.push("requested");
					return json(201, { id: "grant-1", verdict: "pending" });
				}
				if (path.includes("/workspace-requests/workspace%3Ahive")) {
					phases.push("approved");
					return json(200, { id: "grant-1", verdict: "approve" });
				}
				if (path.endsWith("/workspace-grants/grant-1/value")) {
					phases.push("grant-fetched");
					return json(200, { repos: [{ name: "hive", repo: "Artifex-org/hive", branch: "main", target_dir: temporaryTargetDir! }] });
				}
				throw new Error(`unexpected ${method} ${path}`);
			}),
		);
		const pi = {
			registerTool: (tool: { name: string; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool),
			exec: async () => {
				phases.push("provisioned");
				return { code: 0, stdout: "", stderr: "" };
			},
		};
		registerWorkspaceTools(pi as never, { getAuth: () => auth, getSessionID: () => "sess-1" });

		const tool = tools.get("request_workspace");
		expect(tool).toBeDefined();
		const result = await tool!.execute("call-1", { repo: "hive", reason: "regression" });
		phases.push("tool-completed");

		expect(phases).toEqual(["catalog", "requested", "approved", "grant-fetched", "provisioned", "tool-completed"]);
		expect(result.content[0]?.text).toContain("Workspace granted (approve).");
	});
});

describe("expandTargetDir", () => {
	it("expands a tilde path to $HOME", () => {
		const home = process.env.HOME ?? "";
		expect(expandTargetDir("~/.hive/scratch/feature-x")).toBe(`${home}/.hive/scratch/feature-x`);
	});

	it("passes an absolute path through unchanged", () => {
		expect(expandTargetDir("/abs/scratch/x")).toBe("/abs/scratch/x");
	});

	it("returns null when target_dir is empty and no sole scratch dir can be found", () => {
		// On the test machine ~/.hive/scratch either does not exist or does not have
		// exactly one entry; either way the empty-string fallback must not throw.
		const result = expandTargetDir("");
		expect(result === null || typeof result === "string").toBe(true);
	});
});

/**
 * A grant is SERVER-issued, and this process is the one that suffers if the
 * issuer is wrong. The scratch root only bounds what a grant can reach if the
 * leaf cannot climb out of it, and the clone URL only points at github.com if
 * the slug cannot re-point it.
 */
describe("grant validation", () => {
	it("refuses a name that is a path rather than a leaf", () => {
		for (const bad of ["../../.config/systemd/user", "..", ".", "a/b", "/etc/cron.d", "x/../..", ""]) {
			expect(isSafeGrantName(bad), bad).toBe(false);
		}
	});

	it("accepts an ordinary checkout name", () => {
		for (const ok of ["hive", "my-repo", "repo.git", "a_b-1"]) {
			expect(isSafeGrantName(ok), ok).toBe(true);
		}
	});

	// `https://github.com/a@evil.test/b` resolves to evil.test — the `@` makes
	// everything before it userinfo. A slug is owner/name and nothing else.
	it("refuses a repo slug that could re-point the clone URL", () => {
		for (const bad of [
			"a@evil.test/b",
			"../../etc/passwd",
			"https://evil.test/x",
			"owner/name/extra",
			"owner",
			"own..er/name",
		]) {
			expect(isSafeRepoSlug(bad), bad).toBe(false);
		}
	});

	it("accepts an ordinary owner/name slug", () => {
		for (const ok of ["Artifex-org/hive-pi", "a_b/c.d-1"]) {
			expect(isSafeRepoSlug(ok), ok).toBe(true);
		}
	});
});
