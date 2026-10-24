// Source identity comes from the provisioner, never a guessed URL leaf. Only
// non-secret metadata is stored; the private helper revalidates the live source.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NATIVE_PATH = /^\/origin\/[a-z0-9][a-z0-9_-]{0,62}\/[a-z0-9][a-z0-9_-]{0,62}\.git$/;

function canonicalURL(raw) {
	const url = new URL(raw);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href !== raw) {
		throw new Error("updater source must be a canonical credential-free HTTPS URL");
	}
	return url;
}

function sourceGitEnvironment(metadata, role, environment) {
	const env = { ...environment, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
	for (const key of ["GIT_CONFIG", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_TEMPLATE_DIR"]) delete env[key];
	if (NATIVE_PATH.test(canonicalURL(metadata[role]?.url).pathname)) {
		delete env.GIT_CONFIG_PARAMETERS;
		Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" });
		if (role === "base") delete env.HIVE_TOKEN;
	}
	return env;
}

export function prepareSourceGit(metadata, role, checkout, actual, config, operation, environment = process.env) {
	if (metadata.version !== 1 || !["base", "overlay"].includes(role)) throw new Error("unknown updater source metadata");
	const source = metadata[role];
	if (!source) throw new Error("updater has no provisioner-verified source for this checkout");
	const url = canonicalURL(source.url);
	const native = NATIVE_PATH.test(url.pathname);
	const same = native ? actual.trim() === source.url : actual.trim().replace(/\.git$/, "").toLowerCase() === source.url.replace(/\.git$/, "").toLowerCase();
	if (!same) throw new Error("updater origin differs from its verified source; preserve local work and reprovision explicitly");
	if (!native && (url.hostname !== "github.com" || !/^\/[^/]+\/[^/]+\.git$/.test(url.pathname))) throw new Error("unsupported updater source");
	if (source.ref) throw new Error("configured source is pinned; use the Hive-managed revision verifier instead of this timer");
	const branch = source.branch;
	if (typeof branch !== "string" || !branch) throw new Error("updater needs the provisioner-verified branch; reprovision before retrying");
	runGit(["check-ref-format", "refs/heads/" + branch], {});
	if (typeof source.local_branch !== "string" || !source.local_branch) throw new Error("updater needs its provisioner-verified local branch; reprovision before retrying");
	const localRef = "refs/heads/" + source.local_branch;
	runGit(["check-ref-format", localRef], {});
	if (!["fetch", "pull", "remote-head"].includes(operation[0]) || (operation[0] === "remote-head" && operation.length !== 1) || operation.slice(1).some(arg => !["--prune", "--ff-only", "origin", "main"].includes(arg))) throw new Error("unsupported updater Git operation");
	for (const entry of config.split("\0")) {
		const split = entry.indexOf("\n");
		const key = entry.slice(0, split).toLowerCase();
		const value = entry.slice(split + 1);
		if ((key.startsWith("url.") && key.endsWith(".insteadof") && source.url.startsWith(value)) ||
			(key.startsWith("http.") && key.endsWith("extraheader") && value) ||
			(key.startsWith("http.") && key.endsWith(".followredirects") && key !== "http.followredirects")) {
			throw new Error("inherited Git URL rewrite, HTTP header or scoped HTTP configuration prevents verified source access");
		}
	}
	const env = sourceGitEnvironment(metadata, role, environment);
	const flags = ["-c", "http.followRedirects=false"];
	if (native) {
		flags.push("-c", "credential.helper=", "-c", "credential.useHttpPath=true", "-c", "http.extraHeader=");
		if (role === "overlay") {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.project ?? "")) throw new Error("private updater source needs its verified project identity");
			const api = new URL(metadata.server_url);
			if (!["https:", "http:"].includes(api.protocol) || api.username || api.password || api.search || api.hash) throw new Error("invalid verified Hive API identity");
			if (environment.HIVE_TOKEN && environment.HIVE_URL?.replace(/\/$/, "") !== api.href.replace(/\/$/, "")) throw new Error("inherited credential belongs to another Hive API");
			env.HIVE_URL = api.href.replace(/\/$/, "");
			flags.push("-c", "credential." + source.url + ".helper=!hive git-credential --read-only --project " + source.project);
		} else {
			delete env.HIVE_TOKEN;
		}
	} else if (role === "base") {
		flags.push("-c", "credential.helper=");
	}
	// Never let branch.<name>.remote or an alternate upstream choose the
	// network source. Network operations name the exact verified URL and branch.
	let selectedOperation = ["rev-parse", "--verify", "refs/remotes/origin/" + branch + "^{commit}"];
	if (operation[0] === "fetch") selectedOperation = ["fetch", "--prune", "--no-recurse-submodules", source.url, "+refs/heads/" + branch + ":refs/remotes/origin/" + branch];
	if (operation[0] === "pull") selectedOperation = ["pull", "--ff-only", "--no-recurse-submodules", source.url, "refs/heads/" + branch];
	return { args: [...flags, "-C", checkout, ...selectedOperation], env, localRef };
}

function runGit(args, env) {
	const result = spawnSync("git", args, { env, encoding: "utf8", timeout: 300_000, maxBuffer: 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error("verified updater Git operation failed; inspect source permissions without changing the selected provider");
	return result.stdout;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	try {
		const [metadataPath, role, checkout, ...operation] = process.argv.slice(2);
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
		const probeEnv = sourceGitEnvironment(metadata, role, process.env);
		const actual = runGit(["-C", checkout, "config", "--get-all", "remote.origin.url"], probeEnv);
		const config = runGit(["-C", checkout, "config", "--null", "--list"], probeEnv);
		const selected = prepareSourceGit(metadata, role, checkout, actual, config, operation);
		const currentRef = runGit(["-C", checkout, "symbolic-ref", "--quiet", "HEAD"], selected.env).trim();
		if (currentRef !== selected.localRef) throw new Error("checkout branch differs from verified metadata; preserve local work and reprovision explicitly");
		process.stdout.write(runGit(selected.args, selected.env));
	} catch (error) {
		console.error("hive-pi-update: " + (error instanceof Error ? error.message : "source verification failed"));
		process.exitCode = 1;
	}
}
