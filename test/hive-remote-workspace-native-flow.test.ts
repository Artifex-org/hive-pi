import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkspaceTools } from "../extensions/hive-remote/workspace.ts";
import type { WorkspaceRepoGrant } from "../extensions/hive-remote/client.ts";

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(publicRead = true, existingRemote?: string) {
	vi.stubEnv("HIVE_TOKEN", "");
	const root = mkdtempSync(join(tmpdir(), "origin-workspace-client-"));
	roots.push(root);
	const grant: WorkspaceRepoGrant = {
		name: "harness", repo: "", branch: "main", target_dir: root,
		source_provider: "hive", clone_url: "https://origin.hiveci.io/origin/artifex/hive-pi.git",
		project: "harness-project", project_id: "11111111-1111-4111-8111-111111111111",
		repository_id: "22222222-2222-4222-8222-222222222222",
		workspace_grant_id: "33333333-3333-4333-8333-333333333333", public_read: publicRead,
	};
	const tools = new Map<string, { execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }> }>();
	const exec = vi.fn(async (_command: string, args: string[]) => ({ code: 0, stdout: args.includes("--get") ? existingRemote ?? "" : "", stderr: "" }));
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		const path = String(url);
		const body = path.endsWith("/workspace-catalog") ? { entries: [{ ...grant, default_branch: grant.branch }] } :
			path.endsWith("/workspace-grants/g/value") ? { repos: [grant] } :
			init?.method === "POST" ? { id: "g", verdict: "approve" } : { id: "g", verdict: "approve" };
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	}));
	registerWorkspaceTools({ registerTool: (tool: { name: string; execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool), exec } as never,
		{ enabled: true, getAuth: () => ({ url: "https://app.hiveci.io", token: "not-in-argv" }), getSessionID: () => "session" });
	return { root, grant, tools, exec };
}

describe("native workspace grant provisioning", () => {
	it("uses exact Origin URL with no GitHub fallback or credentials for public code", async () => {
		const f = fixture();
		const result = await f.tools.get("request_workspace")!.execute("call", { repo: "harness" });
		expect(result.content[0].text).toContain("cloned https://origin.hiveci.io/");
		const clone = f.exec.mock.calls.find(([, args]) => args.includes("clone"))![1];
		expect(clone).toContain(f.grant.clone_url);
		expect(clone).toContain("--branch=main");
		expect(clone.join(" ")).not.toContain("github.com");
		expect(clone.join(" ")).not.toContain("not-in-argv");
		expect(clone.join(" ")).not.toContain("git-credential");
		expect(clone).toContain("HIVE_TOKEN");
	});

	it("uses scoped helper for explicitly approved private source, storing only helper identity", async () => {
		const f = fixture(false);
		await f.tools.get("request_workspace")!.execute("call", { repo: "harness" });
		const clone = f.exec.mock.calls.find(([, args]) => args.includes("clone"))![1];
		expect(clone.join(" ")).toContain("--workspace-grant");
		expect(clone.join(" ")).toContain("--project 'harness-project'");
		expect(clone.join(" ")).toContain("--read-only");
		expect(f.exec.mock.calls.every(([, args]) => !args.join(" ").includes("not-in-argv"))).toBe(true);
		expect(f.exec.mock.calls.some(([, args]) => args.includes("--local") && args.some(value => value.includes("--workspace-grant")))).toBe(true);
	});

	it("refuses native URL redirection before starting any process", async () => {
		const f = fixture();
		f.grant.clone_url = "https://secret@evil.test/origin/artifex/hive-pi.git";
		const result = await f.tools.get("request_workspace")!.execute("call", { repo: "harness" });
		expect(result.content[0].text).toContain("refused");
		expect(f.exec).not.toHaveBeenCalled();
	});

	it("preserves an existing dirty checkout and refuses its mismatched remote", async () => {
		const f = fixture(false, "https://github.com/Artifex-org/hive-pi");
		mkdirSync(join(f.root, "harness"));
		const work = join(f.root, "harness", "local-work");
		writeFileSync(work, "do not reset");
		const result = await f.tools.get("request_workspace")!.execute("call", { repo: "harness" });
		expect(result.content[0].text).toContain("local work was preserved");
		expect(readFileSync(work, "utf8")).toBe("do not reset");
		expect(f.exec).toHaveBeenCalledTimes(1);
		expect(f.exec.mock.calls[0][1]).toContain("--get");
	});

	it("catalog displays the approved transport instead of an empty GitHub slug", async () => {
		const f = fixture();
		const result = await f.tools.get("list_workspace_catalog")!.execute("call", {});
		expect(result.content[0].text).toContain(f.grant.clone_url);
	});
});
