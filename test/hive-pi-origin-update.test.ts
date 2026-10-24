import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = new URL("../workstation/.local/lib/hive-pi/source-git.mjs", import.meta.url);
const source = "https://origin.example.invalid/origin/fixture/base.git";
const privateSource = "https://origin.example.invalid/origin/fixture/overlay.git";
const metadata = { version: 1, server_url: "https://app.hiveci.io", base: { url: source, ref: "" }, overlay: { url: privateSource, project: "overlay-project" } };
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
		expect(selected.args.slice(-5)).toEqual(["pull", "--ff-only", "--no-recurse-submodules", source, "main"]);
		expect(selected.env.HIVE_TOKEN).toBeUndefined();
		expect(selected.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
		expect(selected.env.GIT_OBJECT_DIRECTORY).toBeUndefined();
		expect(selected.args.join(" ")).toContain("credential.helper=");
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
		["URL rewrite", source, "url.https://wrong.invalid/.insteadof\nhttps://origin.example.invalid/\0"],
	])("rejects %s before transport", (_label, actual, config) => {
		expect(() => prepare("base", actual, config)).toThrow();
	});
	it("refuses guessed projects, API credential confusion and pinned-source advancement", () => {
		expect(() => prepare("overlay", privateSource, "", ["fetch"], {}, { ...metadata, overlay: { url: privateSource, project: "" } })).toThrow();
		expect(() => prepare("overlay", privateSource, "", ["pull"], { HIVE_TOKEN: "not-a-real-test-token", HIVE_URL: "https://other.invalid" })).toThrow();
		expect(() => prepare("base", source, "", ["pull"], {}, { ...metadata, base: { url: source, ref: "v1" } })).toThrow();
	});
	it("fast-forwards only the verified source with real Git despite another upstream", () => {
		const root = mkdtempSync(join(tmpdir(), "hive-pi-origin-update-"));
		roots.push(root);
		const origin = join(root, "source.git");
		const author = join(root, "author");
		const checkout = join(root, "checkout");
		git(root, "init", "--bare", origin);
		git(root, "clone", origin, author);
		git(author, "config", "user.name", "fixture");
		git(author, "config", "user.email", "fixture@example.invalid");
		git(author, "checkout", "-b", "main");
		writeFileSync(join(author, "value"), "first");
		git(author, "add", ".");
		git(author, "commit", "-m", "first");
		git(author, "push", "origin", "main");
		git(root, "clone", "-b", "main", origin, checkout);
		writeFileSync(join(author, "value"), "verified");
		git(author, "commit", "-am", "verified");
		git(author, "push", "origin", "main");
		const expected = git(author, "rev-parse", "HEAD");
		git(checkout, "remote", "set-url", "origin", source);
		// A bare pull chooses this unreachable upstream, not the verified URL.
		git(checkout, "remote", "add", "evil", join(root, "must-never-contact.git"));
		git(checkout, "config", "branch.main.remote", "evil");
		git(checkout, "config", "branch.main.merge", "refs/heads/foreign");
		const bin = join(root, "bin");
		mkdirSync(bin);
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		// Replace only the verified transport endpoint with a local fixture.
		// Git still parses the flags, upstream and refspec and performs the merge.
		writeFileSync(join(bin, "git"), `#!/bin/bash\nargs=("$@")\nfor i in "\${!args[@]}"; do\n if [[ "\${args[$i]}" == ${JSON.stringify(source)} ]]; then args[$i]=${JSON.stringify(origin)}; fi\ndone\nexec ${JSON.stringify(realGit)} "\${args[@]}"\n`, { mode: 0o755 });
		const path = join(root, "update-sources.json");
		writeFileSync(path, JSON.stringify(metadata));
		execFileSync(process.execPath, [helper.pathname, path, "base", checkout, "pull", "--ff-only"], { env: { ...process.env, HOME: root, PATH: bin + ":" + process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" }, stdio: "pipe" });
		expect(git(checkout, "rev-parse", "HEAD")).toBe(expected);
		expect(readFileSync(join(checkout, "value"), "utf8")).toBe("verified");
		expect(git(checkout, "config", "branch.main.remote")).toBe("evil");
	});
});
