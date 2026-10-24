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
	const exec = vi.fn(async (_command: string, args: string[]) => ({ code: 0, stdout: args.includes("--get-all") ? existingRemote ?? "" : "", stderr: "" }));
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
	it("refuses inherited cookie files before cloning", async () => {
		const f = fixture();
		const global = join(f.root, "gitconfig");
		execFileSync("git", ["config", "--file", global, "http.cookieFile", "/fixture/cookies"]);
		vi.stubEnv("GIT_CONFIG_GLOBAL", global);
		f.exec.mockImplementation(async (command, args) => {
			const r = spawnSync(command, args, { encoding: "utf8" });
			return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		});
		const result = await f.tools.get("request_workspace")!.execute("cookie", { repo: "harness" });
		expect(result.content[0].text).toContain("conflicting inherited Git transport");
		expect(f.exec.mock.calls.some(([, args]) => args.includes("clone"))).toBe(false);
	});
	it("creates an approved missing scratch root before real Git preflight", async () => {
		const f = fixture();
		const root = join(f.root, "missing", "scratch");
		f.grant.target_dir = root;
		f.exec.mockImplementation(async (command, args) => {
			if (args.includes("clone")) {
				expect(existsSync(root)).toBe(true);
				execFileSync("git", ["init", join(root, "harness")]);
				return { code: 0, stdout: "", stderr: "" };
			}
			const r = spawnSync(command, args, { encoding: "utf8" });
			return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		});
		const result = await f.tools.get("request_workspace")!.execute("missing-root", { repo: "harness" });
		expect(result.content[0].text).toContain("cloned https://origin.hiveci.io/");
	});

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
		expect(f.exec.mock.calls[0][1]).toContain("--get-all");
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
			return { code: 0, stdout: args.includes("--get-all") ? f.grant.clone_url! : args.includes("--show-toplevel") ? join(f.root, "harness") : "", stderr: "" };
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
		["masked-rewrite", "url.https://other.example/.insteadOf", "https://origin.hiveci.io/"],
		["header", "http.https://origin.hiveci.io/.extraHeader", "X-Unwanted: yes"],
		["cookie", "http.cookieFile", "/fixture/cookies"],
		["scoped cookie", "http.https://origin.hiveci.io/.cookieFile", "/fixture/cookies"],
		["redirect", "http.https://origin.hiveci.io/.followRedirects", "true"],
		["helper", "credential.https://origin.hiveci.io/.helper", "!unwanted-helper"],
	])("checks real Git configuration before reusing a checkout: %s", async (_name, key, value) => {
		const f = fixture(false);
		const dest = join(f.root, "harness");
		execFileSync("git", ["init", dest]);
		execFileSync("git", ["-C", dest, "remote", "add", "origin", f.grant.clone_url!]);
		if (key) execFileSync("git", ["-C", dest, "config", key, value]);
		writeFileSync(join(dest, "local-work"), "preserve me");
		const replacement = join(f.root, "replacement.config");
		writeFileSync(replacement, '[remote "origin"]\n url = ' + f.grant.clone_url + '\n');
		f.exec.mockImplementation(async (command, args) => {
			const env = _name === "masked-rewrite" ? { ...process.env, GIT_CONFIG: replacement } : process.env;
			const result = spawnSync(command, args, { encoding: "utf8", env });
			return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		});
		const result = await f.tools.get("request_workspace")!.execute("existing", { repo: "harness" });
		expect(result.content[0].text).toContain(key ? "conflicting Git transport configuration" : "scoped Git configuration verified");
		expect(readFileSync(join(dest, "local-work"), "utf8")).toBe("preserve me");
		expect(f.exec.mock.calls.some(([, args]) => args.includes("clone") || args.includes("fetch"))).toBe(false);
		if (key) expect(execFileSync("git", ["-C", dest, "config", "--get", key], { encoding: "utf8" }).trim()).toBe(value);
	});

	it("refuses multiple origin URLs without changing checkout configuration or work", async () => {
		const f = fixture(false);
		const dest = join(f.root, "harness");
		execFileSync("git", ["init", dest]);
		execFileSync("git", ["-C", dest, "remote", "add", "origin", "https://other.example/unapproved.git"]);
		execFileSync("git", ["-C", dest, "config", "--add", "remote.origin.url", f.grant.clone_url!]);
		const config = readFileSync(join(dest, ".git/config"), "utf8");
		writeFileSync(join(dest, "local-work"), "preserve me");
		f.exec.mockImplementation(async (command, args) => {
			const result = spawnSync(command, args, { encoding: "utf8" });
			return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		});
		const result = await f.tools.get("request_workspace")!.execute("multiple", { repo: "harness" });
		expect(result.content[0].text).toContain("existing checkout does not match the approved Origin URL");
		expect(readFileSync(join(dest, ".git/config"), "utf8")).toBe(config);
		expect(readFileSync(join(dest, "local-work"), "utf8")).toBe("preserve me");
		expect(f.exec.mock.calls.some(([, args]) => args.includes("clone") || args.includes("fetch") || args.includes("--local"))).toBe(false);
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

	it.each(["new", "existing", "conditional"])("refuses inherited rewrites before ordinary Git use (%s)", async (mode) => {
		const existing = mode === "existing";
		const f = fixture();
		const dest = join(f.root, "harness");
		const foreign = join(f.root, "foreign");
		execFileSync("git", ["init", "-b", "main", foreign]);
		writeFileSync(join(foreign, "unapproved"), "not the approved source");
		execFileSync("git", ["-C", foreign, "add", "."]);
		execFileSync("git", ["-C", foreign, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "foreign"]);
		const global = join(f.root, "global.config");
		execFileSync("git", ["config", "--file", global, "url." + foreign + ".insteadOf", f.grant.clone_url!]);
		if (mode === "conditional") {
			const included = join(f.root, "included.config");
			writeFileSync(included, readFileSync(global));
			writeFileSync(global, "");
			execFileSync("git", ["config", "--file", global, "includeIf.gitdir:" + dest + "/.path", included]);
		}
		const env = { ...process.env, HOME: f.root, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
		if (existing) {
			execFileSync("git", ["init", dest]);
			execFileSync("git", ["-C", dest, "remote", "add", "origin", f.grant.clone_url!]);
			writeFileSync(join(dest, "local-work"), "preserve me");
		}
		f.exec.mockImplementation(async (command, args) => {
			if (args.includes("clone")) {
				execFileSync("git", ["init", dest]);
				execFileSync("git", ["-C", dest, "remote", "add", "origin", f.grant.clone_url!]);
				return { code: 0, stdout: "", stderr: "" };
			}
			const result = spawnSync(command, args, { encoding: "utf8", env });
			return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		});
		const result = await f.tools.get("request_workspace")!.execute("rewrite", { repo: "harness" });
		// A claimed usable checkout must not silently read the rewritten source.
		if (!result.content[0].text.includes("refused")) {
			execFileSync("git", ["-C", dest, "fetch", "origin"], { env });
			expect(spawnSync("git", ["-C", dest, "rev-parse", "--verify", "refs/remotes/origin/main"], { env }).status).not.toBe(0);
		}
		expect(result.content[0].text).toContain("conflicting inherited Git transport configuration");
		expect(f.exec.mock.calls.some(([, args]) => args.includes("clone"))).toBe(mode === "conditional");
		if (existing) expect(readFileSync(join(dest, "local-work"), "utf8")).toBe("preserve me");
	});

	it.each(["normal", "generic override", "scoped override", "host override", "worktree override", "worktree public override"])("repairs reversed credential sections or refuses environment override (%s)", async (mode) => {
		const f = fixture(false);
		const dest = join(f.root, "harness");
		execFileSync("git", ["init", dest]);
		execFileSync("git", ["-C", dest, "remote", "add", "origin", f.grant.clone_url!]);
		execFileSync("git", ["-C", dest, "config", "credential." + f.grant.clone_url + ".helper", "!false"]);
		execFileSync("git", ["-C", dest, "config", "credential.helper", ""]);
		const bin = join(f.root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "hive"), mode === "host override" ? "#!/bin/sh\nexit 0\n" : '#!/bin/sh\nprintf "username=fixture\\npassword=fixture\\n"\n', { mode: 0o755 });
		const marker = join(f.root, "legacy-helper-ran");
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: f.root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", PATH: bin + ":" + process.env.PATH };
		if (mode.startsWith("worktree")) {
			f.grant.public_read = mode === "worktree public override";
			execFileSync("git", ["-C", dest, "config", "extensions.worktreeConfig", "true"]);
			execFileSync("git", ["-C", dest, "config", "--worktree", "--add", "credential.helper", ""]);
			execFileSync("git", ["-C", dest, "config", "--worktree", "--add", "credential.helper", `!f() { touch ${JSON.stringify(marker)}; echo username=legacy; echo password=legacy; }; f`]);
		}
		if (mode !== "normal" && !mode.startsWith("worktree")) Object.assign(env, {
			GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: mode === "host override" ? "credential.https://origin.hiveci.io.helper" : "credential.helper", GIT_CONFIG_VALUE_0: "",
			GIT_CONFIG_KEY_1: mode === "generic override" ? "credential.helper" : "credential." + (mode === "host override" ? "https://origin.hiveci.io" : f.grant.clone_url) + ".helper",
			GIT_CONFIG_VALUE_1: `!f() { touch ${JSON.stringify(marker)}; echo username=legacy; echo password=legacy; }; f`,
		});
		f.exec.mockImplementation(async (command, args) => {
			const result = spawnSync(command, args, { encoding: "utf8", env });
			return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		});
		const result = await f.tools.get("request_workspace")!.execute("repair", { repo: "harness" });
		if (mode !== "normal" && result.content[0].text.includes("refused")) {
			expect(result.content[0].text).toContain("conflicting inherited Git transport configuration");
			expect(existsSync(marker)).toBe(false);
			return;
		}
		expect(result.content[0].text).toContain("scoped Git configuration verified");
		const fill = spawnSync("git", ["-C", dest, "credential", "fill"], { env, encoding: "utf8", input: "url=" + f.grant.clone_url + "\n\n" });
		expect(fill.status, fill.stderr).toBe(0);
		expect(existsSync(marker)).toBe(false);
		expect(fill.stdout).toContain("password=fixture");
	});

	it.each([false, true])("passes the global fixture CA to isolated clone transport (scoped=%s)", async (scoped) => {
		const f = fixture();
		const global = join(f.root, "global.config");
		const ca = join(f.root, "fixture-ca.pem");
		writeFileSync(ca, "fixture CA path");
		execFileSync("git", ["config", "--file", global, scoped ? "http." + f.grant.clone_url + ".sslCAInfo" : "http.sslCAInfo", ca]);
		const env = { ...process.env, GIT_CONFIG_GLOBAL: global };
		let observed = "";
		f.exec.mockImplementation(async (command, args) => {
			const clone = args.indexOf("clone");
			if (clone >= 0) {
				const transport = spawnSync(command, [...args.slice(0, clone), "config", "--get", "http.sslCAInfo"], { env, encoding: "utf8" });
				observed = transport.stdout.trim();
				const dest = join(f.root, "harness");
				execFileSync("git", ["init", dest]);
				execFileSync("git", ["-C", dest, "remote", "add", "origin", f.grant.clone_url!]);
				return { code: 0, stdout: "", stderr: "" };
			}
			const result = spawnSync(command, args, { env, encoding: "utf8" });
			return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		});
		const result = await f.tools.get("request_workspace")!.execute("tls", { repo: "harness" });
		expect(result.content[0].text).toContain("cloned https://origin.hiveci.io/");
		expect(observed).toBe(ca);
	});

	it("refuses a plain subdirectory without modifying its matching parent checkout", async () => {
		const f = fixture();
		execFileSync("git", ["init", f.root]);
		execFileSync("git", ["-C", f.root, "remote", "add", "origin", f.grant.clone_url!]);
		execFileSync("git", ["-C", f.root, "config", "credential.helper", "!parent-helper"]);
		mkdirSync(join(f.root, "harness"));
		const before = readFileSync(join(f.root, ".git/config"), "utf8");
		f.exec.mockImplementation(async (command, args) => {
			const r = spawnSync(command, args, { encoding: "utf8" });
			return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		});
		const result = await f.tools.get("request_workspace")!.execute("parent", { repo: "harness" });
		expect(result.content[0].text).toContain("destination is not the checkout root");
		expect(readFileSync(join(f.root, ".git/config"), "utf8")).toBe(before);
	});

	it("catalog displays the approved transport instead of an empty GitHub slug", async () => {
		const f = fixture();
		const result = await f.tools.get("list_workspace_catalog")!.execute("call", {});
		expect(result.content[0].text).toContain(f.grant.clone_url);
	});
});
