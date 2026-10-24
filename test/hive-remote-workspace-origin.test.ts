import { describe, expect, it } from "vitest";
import type { WorkspaceRepoGrant } from "../extensions/hive-remote/client.ts";
import { nativeWorkspaceSource, nativeWorkspaceGitConfig, nativeWorkspaceGitEnv } from "../extensions/hive-remote/workspace-origin.ts";

const native: WorkspaceRepoGrant = {
	name: "overlay", repo: "", branch: "main", target_dir: "/scratch",
	source_provider: "hive", clone_url: "https://origin.hiveci.io/origin/artifex/artifex-pi.git",
	project: "private-overlay-project", project_id: "11111111-1111-4111-8111-111111111111",
	repository_id: "22222222-2222-4222-8222-222222222222",
	workspace_grant_id: "33333333-3333-4333-8333-333333333333", public_read: false,
};

describe("native workspace source identity", () => {
	it("uses explicit project identity and grant-scoped read-only helper, never URL leaf", () => {
		const source = nativeWorkspaceSource(native);
		expect(source.url).toBe(native.clone_url);
		expect(source.helper).toContain("--project 'private-overlay-project'");
		expect(source.helper).toContain("--workspace-grant '33333333-3333-4333-8333-333333333333'");
		expect(source.helper).toContain("--read-only");
		expect(nativeWorkspaceGitConfig(source)).toContainEqual(["credential." + native.clone_url + ".helper", source.helper]);
	});

	it("public native sources clone without any credential helper", () => {
		const source = nativeWorkspaceSource({ ...native, public_read: true, workspace_grant_id: undefined });
		expect(source.helper).toBeUndefined();
		expect(nativeWorkspaceGitConfig(source)).toContainEqual(["credential.helper", ""]);
		expect(nativeWorkspaceGitConfig(source)).toContainEqual(["credential." + native.clone_url + ".helper", ""]);
		expect(nativeWorkspaceGitConfig(source).some(([key, value]) => key.endsWith(".helper") && value !== "")).toBe(false);
	});

	it.each([
		{ source_provider: "github" }, { project_id: undefined }, { repository_id: undefined },
		{ project: undefined }, { public_read: undefined }, { workspace_grant_id: undefined },
		{ clone_url: "https://secret@origin.hiveci.io/origin/artifex/artifex-pi.git" },
		{ clone_url: "http://origin.hiveci.io/origin/artifex/artifex-pi.git" },
		{ clone_url: "https://origin.hiveci.io/origin/artifex/artifex-pi.git?token=secret" },
		{ clone_url: "https://origin.hiveci.io/origin/artifex/artifex-pi.git#x" },
		{ clone_url: "https://origin.hiveci.io/origin/a%2fb/repo.git" },
		{ clone_url: "https://origin.hiveci.io/origin/artifex/../repo.git" },
		{ clone_url: "file:///tmp/repo.git" }, { clone_url: "https://github.com/a/b" },
		{ project: "p\ncommand" }, { repository_id: "00000000-0000-0000-0000-000000000000" },
	])("fails closed for malformed or incomplete native grant %j", (patch) => {
		expect(() => nativeWorkspaceSource({ ...native, ...patch } as WorkspaceRepoGrant)).toThrow();
	});

	it("quotes a registered project name as shell data", () => {
		const helper = nativeWorkspaceSource({ ...native, project: "project's $(command)" }).helper;
		expect(helper).toContain("--project 'project'\\''s $(command)' --read-only");
	});
});

describe("native workspace Git transport", () => {
	it("never forwards an inherited token to a different API, while public clone drops the token", () => {
		expect(() => nativeWorkspaceGitEnv("https://other.test", { HIVE_TOKEN: "sensitive", HIVE_URL: "https://app.hiveci.io" })).toThrow("not bound");
		expect(() => nativeWorkspaceGitEnv("https://app.hiveci.io", { HIVE_TOKEN: "sensitive" })).toThrow("not bound");
		const env = nativeWorkspaceGitEnv("https://other.test", { HIVE_TOKEN: "sensitive", HIVE_URL: "https://app.hiveci.io" }, false);
		expect(env).toContain("HIVE_TOKEN");
		expect(env.join(" ")).not.toContain("sensitive");
	});
	it("ignores inherited rewrites/headers/alternates and never puts auth tokens in argv", () => {
		const env = nativeWorkspaceGitEnv("https://app.hiveci.io/api/v1", {});
		expect(env).toContain("HIVE_URL=https://app.hiveci.io");
		expect(env).toContain("GIT_CONFIG_GLOBAL=/dev/null");
		expect(env).toContain("GIT_CONFIG_NOSYSTEM=1");
		expect(env).toContain("GIT_CONFIG_COUNT=0");
		expect(env).toContain("GIT_CONFIG_PARAMETERS");
		expect(env).toContain("GIT_ALTERNATE_OBJECT_DIRECTORIES");
		expect(env.join(" ")).not.toContain("HIVE_TOKEN");
		const config = nativeWorkspaceGitConfig(nativeWorkspaceSource(native));
		expect(config).toContainEqual(["http.followRedirects", "false"]);
		expect(config).toContainEqual(["http.extraHeader", ""]);
	});

	it.each(["https://token@app.hiveci.io", "https://app.hiveci.io?token=secret", "file:///tmp/api"])("rejects credential-bearing or non-HTTP API base %s", (url) => {
		expect(() => nativeWorkspaceGitEnv(url, {})).toThrow();
	});
});
