import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = new URL("../workstation/.local/lib/hive-pi/source-git.mjs", import.meta.url);
const source = "https://origin.example.invalid/origin/fixture/base.git";
const privateSource = "https://origin.example.invalid/origin/fixture/overlay.git";
const metadata = { version: 1, server_url: "https://app.hiveci.io", base: { url: source, branch: "main", local_branch: "main", ref: "" }, overlay: { url: privateSource, branch: "production", local_branch: "production", project: "overlay-project" } };
const roots: string[] = [];
function prepare(role = "base", actual = source, config = "", operation = ["pull", "--ff-only"], env: Record<string, string> = {}, meta = metadata) {
	const code = `import{readFileSync}from"node:fs";import{prepareSourceGit}from ${JSON.stringify(helper.href)};console.log(JSON.stringify(prepareSourceGit(...JSON.parse(readFileSync(0,"utf8")))));`;
	return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { input: JSON.stringify([meta, role, "/checkout", actual, config, operation, env]), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
}
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("provisioner-bound timer source", () => {
	it("uses the verified URL and explicit branch, never an implicit upstream", () => {
		const selected = prepare("base", source, "branch.main.remote\nevil\0", ["pull", "--ff-only"], { HIVE_TOKEN: "not-a-real-test-token", GIT_CONFIG_PARAMETERS: "bad", GIT_OBJECT_DIRECTORY: "/foreign" });
		expect(selected.args.slice(-5)).toEqual(["pull", "--ff-only", "--no-recurse-submodules", source, "refs/heads/main"]);
		expect(selected.env.HIVE_TOKEN).toBeUndefined();
		expect(selected.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
		expect(selected.env.GIT_OBJECT_DIRECTORY).toBeUndefined();
		expect(selected.args.join(" ")).toContain("credential.helper=");
	});
	it("validates both branch refs using Git from the supplied sanitized PATH", () => {
		const root = mkdtempSync(join(tmpdir(), "hive-pi-ref-path-"));
		roots.push(root);
		const marker = join(root, "calls");
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		writeFileSync(join(root, "git"), '#!/bin/sh\ntest -z "${GIT_DIR+x}" && test -z "${GIT_CONFIG+x}" || exit 77\nprintf "%s\\n" "$*" >> ' + JSON.stringify(marker) + '\nexec ' + JSON.stringify(realGit) + ' "$@"\n', { mode: 0o755 });
		prepare("base", source, "", ["pull"], { PATH: root, GIT_DIR: "/foreign", GIT_CONFIG: "/foreign" });
		expect(existsSync(marker)).toBe(true);
		expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual(["check-ref-format refs/heads/main", "check-ref-format refs/heads/main"]);
	});
	it("preserves supported TLS and HTTP tuning configuration", () => {
		expect(() => prepare("base", source, "http.sslcainfo\n/fixture/trusted-ca.pem\0http.version\nHTTP/1.1\0")).not.toThrow();
	});
	it("accepts the encoder's slashless API base and binds private credentials read-only", () => {
		const selected = prepare("overlay", privateSource);
		expect(selected.env.HIVE_URL).toBe("https://app.hiveci.io");
		expect(selected.args.join(" ")).toContain("!hive git-credential --read-only --project overlay-project");
		expect(selected.args.join(" ")).not.toContain("workspace-grant");
	});
	it.each([
		["different root", source.replace("base.git", "other.git"), ""],
		["persistent header", source, "http.extraheader\nAuthorization: forbidden\0"],
		["URL-specific header", source, "http.https://origin.example.invalid/.extraheader\nsecret\0"],
		["URL-specific redirect", source, "http.https://origin.example.invalid/.followredirects\ntrue\0"],
		["URL rewrite", source, "url.https://wrong.invalid/.insteadof\nhttps://origin.example.invalid/\0"],
	])("rejects %s before transport", (_label, actual, config) => {
		expect(() => prepare("base", actual, config)).toThrow();
	});
	it("refuses guessed projects, API credential confusion and pinned-source advancement", () => {
		expect(() => prepare("overlay", privateSource, "", ["fetch"], {}, { ...metadata, overlay: { ...metadata.overlay, project: "" } })).toThrow();
		expect(() => prepare("overlay", privateSource, "", ["pull"], { HIVE_TOKEN: "not-a-real-test-token", HIVE_URL: "https://other.invalid" })).toThrow();
		expect(() => prepare("base", source, "", ["pull"], {}, { ...metadata, base: { ...metadata.base, ref: "v1" } })).toThrow();
		expect(() => prepare("overlay", privateSource, "", ["pull"], {}, { ...metadata, overlay: { ...metadata.overlay, branch: "" } })).toThrow();
		expect(() => prepare("overlay", privateSource, "", ["pull"], {}, { ...metadata, overlay: { ...metadata.overlay, branch: "../wrong" } })).toThrow();
	});
	it.each([{ role: "base", selectedURL: source, branch: "main", local: "main" }, { role: "base", selectedURL: source, branch: "production", local: "maintenance" }, { role: "overlay", selectedURL: privateSource, branch: "production", local: "production" }, { role: "base", selectedURL: source, branch: "main", local: "main", hashShaped: true }])("fast-forwards $role through its installed symlink only to the verified branch despite another upstream", ({ role, selectedURL, branch, local, hashShaped }) => {
		const root = mkdtempSync(join(tmpdir(), "hive-pi-origin-update-"));
		roots.push(root);
		const origin = join(root, "source.git");
		const author = join(root, "author");
		const checkout = join(root, "checkout");
		git(root, "init", "--bare", origin);
		git(root, "clone", origin, author);
		git(author, "config", "user.name", "fixture");
		git(author, "config", "user.email", "fixture@example.invalid");
		git(author, "checkout", "-b", branch);
		writeFileSync(join(author, "value"), "first");
		git(author, "add", ".");
		git(author, "commit", "-m", "first");
		if (hashShaped) {
			branch = git(author, "rev-parse", "HEAD");
			local = branch;
			git(author, "branch", "-m", branch);
		}
		git(author, "push", "origin", "HEAD:refs/heads/" + branch);
		git(root, "clone", "-b", branch, origin, checkout);
		if (local !== branch) git(checkout, "branch", "-m", local);
		writeFileSync(join(author, "value"), "verified");
		git(author, "commit", "-am", "verified");
		git(author, "push", "origin", "HEAD:refs/heads/" + branch);
		const expected = git(author, "rev-parse", "HEAD");
		git(checkout, "remote", "set-url", "origin", selectedURL);
		// A bare pull chooses this unreachable upstream, not the verified URL.
		git(checkout, "remote", "add", "evil", join(root, "must-never-contact.git"));
		git(checkout, "config", `branch.${local}.remote`, "evil");
		git(checkout, "config", `branch.${local}.merge`, "refs/heads/foreign");
		const bin = join(root, "bin");
		mkdirSync(bin);
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const ca = join(root, "fixture-ca.pem");
		writeFileSync(ca, "fixture CA path");
		const global = join(root, "global.config");
		git(root, "config", "--file", global, role === "base" ? "http.sslCAInfo" : "http." + selectedURL + ".sslCAInfo", ca);
		// Replace only the verified transport endpoint with a local fixture.
		// Git still parses the flags, upstream and refspec and performs the merge.
		writeFileSync(join(bin, "git"), `#!/bin/bash\nargs=("$@")\nfor i in "\${!args[@]}"; do\n if [[ "\${args[$i]}" == pull ]]; then [[ "$(${JSON.stringify(realGit)} "\${args[@]:0:$i}" config --get http.sslCAInfo)" == ${JSON.stringify(ca)} ]] || exit 66; fi\n if [[ " \${args[*]} " != *" config "* && "\${args[$i]}" == ${JSON.stringify(selectedURL)} ]]; then args[$i]=${JSON.stringify(origin)}; fi\ndone\nexec ${JSON.stringify(realGit)} "\${args[@]}"\n`, { mode: 0o755 });
		const installedHelper = join(root, "installed-source-git.mjs");
		symlinkSync(helper.pathname, installedHelper);
		const path = join(root, "update-sources.json");
		writeFileSync(path, JSON.stringify({ ...metadata, [role]: { ...(role === "base" ? metadata.base : metadata.overlay), branch, local_branch: local } }));
		const env = { ...process.env, HOME: root, PATH: bin + ":" + process.env.PATH, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: "https://wrong.invalid/repo.git", GIT_DIR: join(author, ".git"), GIT_WORK_TREE: author };
		const replacement = join(root, "replacement.config");
		writeFileSync(replacement, '[remote "origin"]\n url = ' + selectedURL + '\n');
		const foreign = join(root, "unapproved.git");
		git(root, "clone", "--bare", origin, foreign);
		writeFileSync(join(author, "value"), "unapproved");
		git(author, "commit", "-am", "unapproved");
		git(author, "push", foreign, "HEAD:refs/heads/" + branch);
		git(checkout, "config", "url." + foreign + ".insteadOf", selectedURL);
		const probeEnv = { ...env, PATH: process.env.PATH, GIT_CONFIG: replacement };
		const priorRemote = git(checkout, "rev-parse", "refs/remotes/origin/" + branch);
		expect(() => execFileSync(process.execPath, [installedHelper, path, role, checkout, "fetch"], { env: probeEnv, stdio: "pipe" })).toThrow(/inherited Git URL rewrite/);
		expect(git(checkout, "rev-parse", "refs/remotes/origin/" + branch)).toBe(priorRemote);
		git(checkout, "config", "--unset", "url." + foreign + ".insteadOf");
		const before = git(checkout, "rev-parse", "HEAD");
		git(checkout, "checkout", "-b", "unselected-local");
		expect(() => execFileSync(process.execPath, [installedHelper, path, role, checkout, "pull", "--ff-only"], { env, stdio: "pipe" })).toThrow(/checkout branch differs/);
		expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
		git(checkout, "switch", local);
		execFileSync(process.execPath, [installedHelper, path, role, checkout, "pull", "--ff-only"], { env, stdio: "pipe" });
		expect(git(checkout, "rev-parse", "HEAD")).toBe(expected);
		expect(readFileSync(join(checkout, "value"), "utf8")).toBe("verified");
		expect(git(checkout, "config", `branch.${local}.remote`)).toBe("evil");
		git(checkout, "config", `http.${selectedURL}.followRedirects`, "true");
		// Real Git proves the scoped setting overrides the generic no-redirect flag.
		expect(git(checkout, "-c", "http.followRedirects=false", "config", "--get-urlmatch", "http.followRedirects", selectedURL)).toBe("true");
		expect(() => execFileSync(process.execPath, [installedHelper, path, role, checkout, "pull", "--ff-only"], { env, stdio: "pipe" })).toThrow(/scoped HTTP configuration/);
		expect(git(checkout, "rev-parse", "HEAD")).toBe(expected);
	});
});
