import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { nativeWorkspaceGitConfig, nativeWorkspaceGitEnv, nativeWorkspaceTransportConflict } from "../extensions/hive-remote/workspace-origin.ts";

const exec = promisify(execFile);
const updater = new URL("../workstation/.local/lib/hive-pi/source-git.mjs", import.meta.url);

it.each([false, true])("refuses netrc before workspace and updater transport (private=%s)", async (privateRead) => {
	const home = mkdtempSync(join(tmpdir(), "native-netrc-"));
	const authorization: boolean[] = [];
	const server = createServer((request, response) => {
		authorization.push(Boolean(request.headers.authorization));
		response.writeHead(request.headers.authorization ? 404 : 401, { "WWW-Authenticate": 'Basic realm="fixture"' });
		response.end();
	});
	try {
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing fixture address");
		const path = "/origin/fixture/repo.git";
		const url = `http://127.0.0.1:${address.port}${path}`;
		writeFileSync(join(home, ".netrc"), "machine 127.0.0.1 login fixture password fixture\n", { mode: 0o600 });
		const source = { native: true, url, ...(privateRead ? { helper: "!true" } : {}) };
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
		delete env.GIT_CONFIG_PARAMETERS;
		// Real libcurl regression witness: helper resets alone do not prevent netrc.
		const flags = nativeWorkspaceGitConfig(source).flatMap(([key, value]) => ["-c", key + "=" + value]);
		await exec("git", [...flags, "ls-remote", url], { env }).catch(() => undefined);
		expect(authorization).toEqual([false, true]);
		authorization.length = 0;
		expect(() => nativeWorkspaceGitEnv("https://app.hiveci.io", env, privateRead)).toThrow("netrc authentication");
		const role = privateRead ? "overlay" : "base";
		const canonical = "https://127.0.0.1" + path;
		const metadata = { version: 1, server_url: "https://app.hiveci.io", [role]: { url: canonical, branch: "main", local_branch: "main", project: "fixture" } };
		const code = `import {prepareSourceGit} from ${JSON.stringify(updater.href)}; prepareSourceGit(${JSON.stringify(metadata)},${JSON.stringify(role)},${JSON.stringify(home)},${JSON.stringify(canonical)},'', ['fetch'], process.env);`;
		await expect(exec(process.execPath, ["--input-type=module", "-e", code], { env })).rejects.toThrow("netrc authentication");
		expect(authorization).toEqual([]);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(home, { recursive: true, force: true });
	}
});

it.each([false, true])("refuses cookie-file authentication (private=%s)", async (privateRead) => {
	const home = mkdtempSync(join(tmpdir(), "native-cookie-"));
	const cookies: boolean[] = [];
	const server = createServer((request, response) => {
		cookies.push(Boolean(request.headers.cookie));
		response.writeHead(404);
		response.end();
	});
	try {
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing fixture address");
		const path = "/origin/fixture/repo.git";
		const url = `http://127.0.0.1:${address.port}${path}`;
		const jar = join(home, "cookies");
		writeFileSync(jar, "# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\tfixture\n");
		const source = { native: true, url, ...(privateRead ? { helper: "!true" } : {}) };
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" };
		delete env.GIT_CONFIG_PARAMETERS;
		const flags = nativeWorkspaceGitConfig(source).flatMap(([key, value]) => ["-c", key + "=" + value]);
		await exec("git", [...flags, "-c", "http.cookieFile=" + jar, "ls-remote", url], { env }).catch(() => undefined);
		expect(cookies).toEqual([true]);
		const config = "http.cookiefile\n" + jar + "\0";
		expect(nativeWorkspaceTransportConflict(source, config)).toBe(true);
		const role = privateRead ? "overlay" : "base";
		const canonical = "https://127.0.0.1" + path;
		const metadata = { version: 1, server_url: "https://app.hiveci.io", [role]: { url: canonical, branch: "main", local_branch: "main", project: "fixture" } };
		const code = `import {prepareSourceGit} from ${JSON.stringify(updater.href)}; prepareSourceGit(${JSON.stringify(metadata)},${JSON.stringify(role)},${JSON.stringify(home)},${JSON.stringify(canonical)},${JSON.stringify(config)}, ['fetch'], process.env);`;
		await expect(exec(process.execPath, ["--input-type=module", "-e", code], { env })).rejects.toThrow("prevents verified source access");
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(home, { recursive: true, force: true });
	}
});

it.each([".netrc", "_netrc", "NETRC"])("refuses alternate netrc configuration: %s", (name) => {
	const home = mkdtempSync(join(tmpdir(), "native-netrc-path-"));
	try {
		mkdirSync(join(home, "custom"));
		if (name !== "NETRC") writeFileSync(join(home, name), "");
		expect(() => nativeWorkspaceGitEnv("https://app.hiveci.io", { HOME: home, ...(name === "NETRC" ? { NETRC: join(home, "custom/credentials") } : {}) }, false)).toThrow("netrc authentication");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
