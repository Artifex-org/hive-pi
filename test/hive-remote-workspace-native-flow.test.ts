import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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

	it("accepts an explicit GitHub clone URL ending in .git", async () => {
		const f = fixture();
		Object.assign(f.grant, { source_provider: "github", repo: "acme/tools", clone_url: "https://github.com/acme/tools.git" });
		const result = await f.tools.get("request_workspace")!.execute("github", { repo: "harness" });
		expect(result.content[0].text).toContain("cloned acme/tools");
		expect(f.exec.mock.calls.find(([, args]) => args.includes("clone"))![1]).toContain(f.grant.clone_url);
	});

	it("repairs interrupted native configuration on retry without replacing local work", async () => {
		const f = fixture(false);
		let fail = true;
		f.exec.mockImplementation(async (_command, args) => {
			if (args.includes("clone")) mkdirSync(join(f.root, "harness"));
			if (args.includes("--local") && fail) {
				fail = false;
				return { code: 1, stdout: "", stderr: "config locked" };
			}
			return { code: 0, stdout: args.includes("--get") ? f.grant.clone_url! : "", stderr: "" };
		});
		const first = await f.tools.get("request_workspace")!.execute("first", { repo: "harness" });
		expect(first.content[0].text).toContain("scoped Git configuration failed");
		const work = join(f.root, "harness", "local-work");
		writeFileSync(work, "preserve me");
		f.exec.mockClear();
		const retry = await f.tools.get("request_workspace")!.execute("retry", { repo: "harness", request_id: "fresh" });
		expect(retry.content[0].text).toContain("already present");
		expect(f.exec.mock.calls.some(([, args]) => args.includes("clone"))).toBe(false);
		expect(f.exec.mock.calls.some(([, args]) => args.includes("--replace-all") && args.some(arg => arg.includes("--workspace-grant")))).toBe(true);
		expect(readFileSync(work, "utf8")).toBe("preserve me");
	});

	it.each([
		["clean", "", ""],
		["rewrite", "url.https://other.example/.insteadOf", "https://origin.hiveci.io/"],
		["header", "http.https://origin.hiveci.io/.extraHeader", "X-Unwanted: yes"],
		["redirect", "http.https://origin.hiveci.io/.followRedirects", "true"],
		["helper", "credential.https://origin.hiveci.io/.helper", "!unwanted-helper"],
	])("checks real Git configuration before reusing a checkout: %s", async (_name, key, value) => {
		const f = fixture(false);
		const dest = join(f.root, "harness");
		execFileSync("git", ["init", dest]);
		execFileSync("git", ["-C", dest, "remote", "add", "origin", f.grant.clone_url!]);
		if (key) execFileSync("git", ["-C", dest, "config", key, value]);
		writeFileSync(join(dest, "local-work"), "preserve me");
		f.exec.mockImplementation(async (command, args) => {
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		});
		const result = await f.tools.get("request_workspace")!.execute("existing", { repo: "harness" });
		expect(result.content[0].text).toContain(key ? "conflicting Git transport configuration" : "scoped Git configuration verified");
		expect(readFileSync(join(dest, "local-work"), "utf8")).toBe("preserve me");
		expect(f.exec.mock.calls.some(([, args]) => args.includes("clone") || args.includes("fetch"))).toBe(false);
		if (key) expect(execFileSync("git", ["-C", dest, "config", "--get", key], { encoding: "utf8" }).trim()).toBe(value);
	});

	it("requires fresh consent when identity changes before approved grant delivery", async () => {
		const f = fixture();
		vi.stubGlobal("fetch", vi.fn(async (url: string) => {
			if (String(url).endsWith("/value")) return new Response("source identity changed", { status: 409 });
			const body = String(url).endsWith("/workspace-catalog") ? { entries: [f.grant] } : { id: "g", verdict: "approve" };
			return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
		}));
		const result = await f.tools.get("request_workspace")!.execute("changed", { repo: "harness" });
		expect(result.content[0].text).toContain("new explicit request_id");
		expect(result.content[0].text).not.toContain("retry this request");
		expect(f.exec).not.toHaveBeenCalled();
	});

	it("removes active private helpers when an existing checkout becomes public", async () => {
		const f = fixture(false);
		const dest = join(f.root, "harness");
		execFileSync("git", ["init", dest]);
		execFileSync("git", ["-C", dest, "remote", "add", "origin", f.grant.clone_url!]);
		f.exec.mockImplementation(async (command, args) => {
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		});
		await f.tools.get("request_workspace")!.execute("private", { repo: "harness" });
		const marker = join(f.root, "helper-ran");
		const key = "credential." + f.grant.clone_url + ".helper";
		execFileSync("git", ["-C", dest, "config", key, `!f() { touch ${JSON.stringify(marker)}; echo username=fixture; echo password=fixture; }; f`]);
		f.grant.public_read = true;
		const result = await f.tools.get("request_workspace")!.execute("public", { repo: "harness", request_id: "public" });
		expect(result.content[0].text).toContain("scoped Git configuration verified");
		spawnSync("env", ["GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_COUNT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "git", "-C", dest, "credential", "fill"], {
			input: "protocol=https\nhost=origin.hiveci.io\npath=origin/artifex/hive-pi.git\n\n", encoding: "utf8",
		});
		expect(existsSync(marker)).toBe(false);
		expect(execFileSync("git", ["-C", dest, "config", "--get", key], { encoding: "utf8" }).trim()).toBe("");
	});

	it("catalog displays the approved transport instead of an empty GitHub slug", async () => {
		const f = fixture();
		const result = await f.tools.get("list_workspace_catalog")!.execute("call", {});
		expect(result.content[0].text).toContain(f.grant.clone_url);
	});
});
