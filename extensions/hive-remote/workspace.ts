/**
 * hive-remote — the mid-session workspace grant tools.
 *
 * A session is launched scoped to ONE repo: the sandbox's writable paths and
 * network allowlist are frozen at spawn and there is no server→node channel to
 * widen them later. But work drifts — mid-conversation the agent needs to also
 * touch another repo. The seam that makes this solvable without restarting the
 * sandbox: the pi agent's per-session scratch dir is already writable, repo
 * sources are readable, and github.com + the injected gh token are already
 * available. So a granted repo is provisioned BY THE AGENT ITSELF, cloned into
 * scratch; the grant only authorizes it and hands back the repo identity.
 *
 * `request_workspace(repo, reason?)` asks (the owner approves in the same widget
 * credentials use, or the handsfree judge does), waits, and on approval clones
 * the granted repo(s) into scratch. `list_workspace_catalog` shows what is
 * grantable. Both are gated on `allowAddWorkspace` at execution — off by
 * default. When off the tools only explain the missing opt-in; no network or
 * clone work runs, and no workspace capability is declared.
 *
 * These tools do subprocess and network work, but they are TOOLS, not event
 * handlers — pi runs a tool's `execute` off the agent loop and hands it the
 * turn's AbortSignal — so unlike everything else in this extension they may
 * block and await. What they must never do is throw: a thrown tool is a turn
 * the model cannot recover from, so every failure returns a structured message
 * the agent can read and adapt to.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { HiveAuth } from "../hive-common/http.ts";
import { fetchWorkspaceCatalog, requestAndWait, type WorkspaceGrantValue, type WorkspaceRepoGrant } from "./client.ts";
import { registerGuardedTool } from "../guards-common/capability.ts";
import { exposureFor } from "../loadout/policy.ts";
import { nativeWorkspaceSource, nativeWorkspaceGitConfig, nativeWorkspaceGitContextEnv, nativeWorkspaceGitEnv, nativeWorkspaceTransportConflict, type WorkspaceCloneSource } from "./workspace-origin.ts";

/** How often the pending request is polled while waiting for a decision. */
const POLL_MS = 3_000;
/**
 * How long to wait for a decision before giving up the tool call.
 *
 * Generous because a human (or the handsfree timer) is on the other end, bounded
 * because a tool call that never returns is worse than one that says "no answer
 * yet, try later". A `timeout` verdict is NOT a denial — the request stays
 * pending server-side and a later `request_workspace` for the same repo rejoins
 * it (the call id is deterministic).
 */
const DECISION_TIMEOUT_MS = 10 * 60_000;
/** Upper bound on a single clone, so a stuck credential prompt cannot wedge the tool. */
const CLONE_TIMEOUT_MS = 5 * 60_000;

interface WorkspaceDeps {
	/** Frozen operator opt-in. False keeps both tools diagnostic-only. */
	enabled: boolean;
	/** The live auth, or null before this session has attached. */
	getAuth: () => HiveAuth | null;
	/** The live server session id, or null before attach. */
	getSessionID: () => string | null;
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function fail(text: string) {
	// Not a thrown error and not `isError`: a denied or un-cloneable repo is a
	// normal outcome the agent should read and route around, not a tool crash.
	return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * Expand a grant's `target_dir` to an absolute path.
 *
 * The server sends a TILDE path (`~/.hive/scratch/<safe>`); `~` is the client's
 * $HOME. An empty string means the server could not compute the scratch root, so
 * fall back to the sole directory under `~/.hive/scratch/` — which is what a
 * single-session sandbox has. Zero or several entries is ambiguous, so return
 * null and let the caller tell the agent to place the checkout itself.
 */
export function expandTargetDir(targetDir: string): string | null {
	const dir = (targetDir ?? "").trim();
	if (dir === "~") return homedir();
	if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
	if (dir !== "") return dir;

	const scratch = join(homedir(), ".hive", "scratch");
	try {
		const dirs = readdirSync(scratch, { withFileTypes: true }).filter((e) => e.isDirectory());
		if (dirs.length === 1) return join(scratch, dirs[0].name);
	} catch {
		/* no scratch root on this machine */
	}
	return null;
}

/**
 * A grant name must be ONE path segment. Not a traversal, not absolute, not a
 * nested path — the scratch root only bounds what a grant can reach if the leaf
 * cannot climb out of it.
 */
export function isSafeGrantName(name: unknown): name is string {
	return typeof name === "string" && /^[\w.-]+$/.test(name) && name !== "." && name !== "..";
}

/**
 * `owner/name`, and nothing that could re-point the clone URL: no `@` (which
 * would make `https://github.com/a@evil/b` resolve to `evil`), no scheme, no
 * traversal, no second slash.
 */
export function isSafeRepoSlug(repo: unknown): repo is string {
	return typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.includes("..");
}

/**
 * Clone one granted repo into scratch, reporting the outcome as a line.
 *
 * Never throws. Existing files and refs remain untouched; native checkouts
 * have their source-scoped transport configuration repaired on retry. The clone runs through `env
 * GIT_TERMINAL_PROMPT=0` so a private repo with no working credential fails fast
 * instead of blocking on a prompt no one can answer inside the sandbox.
 */
async function cloneOne(pi: ExtensionAPI, r: WorkspaceRepoGrant, auth: HiveAuth, signal: AbortSignal | undefined): Promise<string> {
	const root = expandTargetDir(r.target_dir);
	if (!root) {
		return `- ${r.name}: could not resolve a scratch directory (target_dir=${JSON.stringify(r.target_dir)}). Clone ${r.repo} yourself under ~/.hive/scratch/.`;
	}
	// `name` and `repo` arrive in a SERVER-issued grant, and until now went
	// straight into a path join and a URL. A grant naming `../../.config/systemd/user`
	// places a clone outside the scratch root; a `repo` carrying `@` or `..`
	// redirects the clone's origin away from github.com entirely.
	//
	// That needs a compromised or hostile control plane to exploit, so it is
	// defence in depth rather than a live hole — but the whole point of a scratch
	// root is that it bounds what a grant can touch, and an unvalidated join does
	// not bound anything. Validate here rather than trusting the issuer: this
	// process is the one that suffers if the issuer is wrong.
	if (!isSafeGrantName(r.name)) {
		return `- ${r.name}: refused — a grant name must be a single path segment, not a path.`;
	}
	let source: WorkspaceCloneSource;
	try {
		if (r.source_provider === "hive") source = nativeWorkspaceSource(r);
		else {
			if (r.source_provider !== undefined && r.source_provider !== "github") throw new Error("Unsupported repository provider.");
			if (!isSafeRepoSlug(r.repo)) throw new Error("Repository is not an owner/name slug.");
			const expected = `https://github.com/${r.repo}`;
			if (r.clone_url && r.clone_url.replace(/\.git$/, "") !== expected) throw new Error("GitHub clone URL does not match the approved repository.");
			source = { url: r.clone_url || expected, native: false };
		}
	} catch (error) {
		return `- ${r.name}: refused — ${error instanceof Error ? error.message : "invalid workspace identity"}`;
	}
	const dest = join(root, r.name);
	try {
		const prefix = source.native ? nativeWorkspaceGitEnv(auth.url, process.env, Boolean(source.helper)) : ["GIT_TERMINAL_PROMPT=0"];
		const config = source.native ? nativeWorkspaceGitConfig(source) : [["http.followRedirects", "false"]];
		const git = ["git", ...config.flatMap(([key, value]) => ["-c", key + "=" + value])];
		if (existsSync(dest)) {
			if (source.native) {
				const remote = await pi.exec("env", [...prefix, ...git, "-C", dest, "config", "--get-all", "remote.origin.url"], { signal, timeout: CLONE_TIMEOUT_MS });
				if (remote.code !== 0 || remote.stdout.trim() !== source.url) {
					return `- ${r.name}: refused — existing checkout does not match the approved Origin URL; local work was preserved.`;
				}
				const existing = await pi.exec("env", [...prefix, "git", "-C", dest, "config", "--null", "--list"], { signal, timeout: CLONE_TIMEOUT_MS });
				if (existing.code !== 0 || nativeWorkspaceTransportConflict(source, existing.stdout)) {
					return `- ${r.name}: refused — existing checkout has conflicting Git transport configuration; local work was preserved.`;
				}
				if (!await ordinaryNativeTransportSafe(pi, dest, source, signal)) {
					return `- ${r.name}: refused — conflicting inherited Git transport configuration; local work was preserved.`;
				}
				if (!await configureNativeCheckout(pi, prefix, dest, source, signal)) {
					return `- ${r.name}: scoped Git configuration failed; local work was preserved. Do not use the checkout until repaired.`;
				}
			}
			return source.native
				? `- ${r.name}: already present at ${dest} — scoped Git configuration verified; files and refs preserved.`
				: `- ${r.name}: already present at ${dest} — left as-is (nothing re-cloned).`;
		}
		const tls = source.native ? await ordinaryNativeTransportSafe(pi, root, source, signal) : [];
		if (!tls) {
			return `- ${r.name}: refused — conflicting inherited Git transport configuration; no clone was attempted.`;
		}
		const args = [...prefix, ...git, ...tls.flatMap(([key, value]) => ["-c", key + "=" + value]), "clone"];
		if (r.branch) args.push("--branch=" + r.branch);
		args.push("--", source.url, dest);
		const res = await pi.exec("env", args, { signal, timeout: CLONE_TIMEOUT_MS });
		if (res.code !== 0) {
			const why = (res.stderr || res.stdout || "").trim().slice(0, 300);
			return source.native ? `- ${r.name}: native clone failed (git exit ${res.code}); check explicit workspace read approval and the exact project source. No GitHub fallback was attempted.` : `- ${r.name}: clone failed (git exit ${res.code})${why ? `: ${why}` : ""}`;
		}
		if (source.native && !await configureNativeCheckout(pi, prefix, dest, source, signal)) {
			return `- ${r.name}: cloned into ${dest}, but scoped Git configuration failed; do not use the checkout until repaired.`;
		}
		if (source.native && !await ordinaryNativeTransportSafe(pi, dest, source, signal)) {
			return `- ${r.name}: refused — cloned into ${dest}, but conflicting inherited Git transport configuration prevents ordinary use. Do not use the checkout until repaired.`;
		}
		return `- ${r.name}: cloned ${source.native ? source.url : r.repo}${r.branch ? ` (branch ${r.branch})` : ""} into ${dest}`;
	} catch (err) {
		return `- ${r.name}: clone failed: ${err instanceof Error ? err.message : "error"}`;
	}
}

async function ordinaryNativeTransportSafe(pi: ExtensionAPI, directory: string, source: WorkspaceCloneSource, signal: AbortSignal | undefined): Promise<Array<[string, string]> | undefined> {
	const effective = await pi.exec("env", [...nativeWorkspaceGitContextEnv(), "git", "-C", directory, "config", "--show-scope", "--null", "--list"], { signal, timeout: CLONE_TIMEOUT_MS });
	if (effective.code !== 0) return undefined;
	const entries = effective.stdout.split("\0");
	for (let i = 0; i + 1 < entries.length; i += 2) {
		const split = entries[i + 1].indexOf("\n");
		const key = entries[i + 1].slice(0, split).toLowerCase();
		if (key.startsWith("url.") && key.endsWith(".insteadof") && source.url.startsWith(entries[i + 1].slice(split + 1))) return undefined;
		// Command-scope resets run after the persisted helper, regardless of URL specificity.
		if (entries[i] === "command" && /^credential\.[^.]+$/.test(key)) return undefined;
	}
	const credential = await pi.exec("env", [...nativeWorkspaceGitContextEnv(), "git", "-C", directory, "config", "--show-scope", "--null", "--get-urlmatch", "credential", source.url], { signal, timeout: CLONE_TIMEOUT_MS });
	if (credential.code !== 0 && credential.code !== 1) return undefined;
	if (credential.stdout.split("\0").some((entry, index) => index % 2 === 0 && entry === "command")) return undefined;
	// Let Git resolve URL patterns and precedence rather than approximating them.
	const http = await pi.exec("env", [...nativeWorkspaceGitContextEnv(), "git", "-C", directory, "config", "--null", "--get-urlmatch", "http", source.url], { signal, timeout: CLONE_TIMEOUT_MS });
	if (http.code !== 0 && http.code !== 1) return undefined;
	const tls: Array<[string, string]> = [];
	for (const entry of http.stdout.split("\0")) {
		const split = entry.indexOf("\n");
		const key = entry.slice(0, split), value = entry.slice(split + 1);
		if ((key === "http.extraheader" && Boolean(value)) || (key === "http.followredirects" && value !== "false")) return undefined;
		if (["http.sslcainfo", "http.sslcapath", "http.version"].includes(key)) tls.push([key, value]);
	}
	return tls;
}

async function configureNativeCheckout(pi: ExtensionAPI, prefix: string[], dest: string, source: WorkspaceCloneSource, signal: AbortSignal | undefined): Promise<boolean> {
	// Recreate the scoped helper after the generic reset, not in its old section.
	const removed = await pi.exec("env", [...prefix, "git", "-C", dest, "config", "--local", "--unset-all", "credential." + source.url + ".helper"], { signal, timeout: CLONE_TIMEOUT_MS });
	if (removed.code !== 0 && removed.code !== 5) return false;
	for (const [key, value] of nativeWorkspaceGitConfig(source)) {
		const configured = await pi.exec("env", [...prefix, "git", "-C", dest, "config", "--local", "--replace-all", key, value], { signal, timeout: CLONE_TIMEOUT_MS });
		if (configured.code !== 0) return false;
	}
	return true;
}

const DEPS_NOTE =
	"Dependencies are NOT installed by a plain clone (there is no setup step on a raw checkout) — " +
	"run the repo's own install step (e.g. npm install / pnpm install / uv sync / go mod download) before you build or test it.";

/**
 * registerWorkspaceTools wires the agent-callable request + catalog tools.
 *
 * Registered even when explicitly disabled so CLI guidance names a discoverable tool.
 * `enabled` gates all I/O; registration alone never grants access.
 * `getAuth`/`getSessionID` are read live at each call rather than
 * captured, because a session attaches AFTER the tools register (and can
 * re-attach to a new row on resume) — a captured null would strand the tool.
 */
export function registerWorkspaceTools(pi: ExtensionAPI, deps: WorkspaceDeps): void {
	const disabled =
		"Workspace grants are disabled for this client (allowAddWorkspace is off). " +
		"Ask the operator to re-enable it via ~/.pi/agent/hive-telemetry/hive-remote.config.json " +
		"and restart the session; /hive-remote-on alone does not enable workspace grants. " +
		"Do not change this setting or widen access yourself. No request or clone was made.";
	pi.registerTool({
		name: "list_workspace_catalog", exposure: exposureFor("list_workspace_catalog"),
		label: "List grantable repos",
		description:
			"List the repos this session can request mid-session with request_workspace. " +
			"Read-only. Repo names are not secret. Use it to discover the exact catalog name to pass to request_workspace.",
		promptSnippet: "List the repos you can request access to mid-session",
		parameters: Type.Object({}),
		async execute() {
			if (deps.enabled !== true) return fail(disabled);
			const auth = deps.getAuth();
			const sessionID = deps.getSessionID();
			if (!auth || !sessionID) {
				return fail("This session is not attached to the Hive agents workspace yet, so the workspace catalog is unavailable. Check /hive-remote-status.");
			}
			const catalog = await fetchWorkspaceCatalog(auth, sessionID);
			if (!catalog.ok) return fail(`Could not read the workspace catalog: ${catalog.error}.`);
			if (catalog.entries.length === 0) return ok("No repos are configured as grantable in this Hive.");
			const lines = catalog.entries.map(
				(e) => `- ${e.name} (${e.clone_url || e.repo}${e.default_branch ? `, default branch ${e.default_branch}` : ""})${e.description ? ` — ${e.description}` : ""}`,
			);
			return ok(["Grantable repos:", ...lines].join("\n"));
		},
	});

	registerGuardedTool(pi, {
		capability: { executes: true, writesExemptBecause: "clones into an operator-approved destination; the approval IS the gate" },
		name: "request_workspace",
		label: "Request a workspace repo",
		description:
			"Request mid-session access to ANOTHER repo and, once granted, clone it into this session's scratch directory so you can work in it. " +
			"Use when your task needs a repo this session was not launched with. `repo` must be a catalog name from list_workspace_catalog. " +
			"An owner (or the handsfree judge) approves the request; this call BLOCKS until a decision or a timeout. " +
			"On approval the repo is cloned and you get the checkout path. On denial, expiry, or timeout you get a plain message — continue without it. " +
			"The clone lands in scratch (~/.hive/scratch/...), NOT at ~/repos/<repo>; dependencies are not installed for you.",
		promptSnippet: "Request access to another repo mid-session and clone it into scratch",
		promptGuidelines: [
			"Only request a repo you actually need for the current task; give a one-line `reason` so the approver has context. If a request is denied or times out, do not spam re-requests — adapt.",
		],
		parameters: Type.Object({
			repo: Type.String({ description: "Catalog name of the repo to request (from list_workspace_catalog), e.g. 'gitops'." }),
			reason: Type.Optional(Type.String({ description: "One sentence: why this task needs the repo. Shown to the approver." })),
			request_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", description: "A fresh ID to deliberately open new consent after expiry. Reuse the same ID to retry/rejoin that request; omit to rejoin the original request." })),
		}),
		async execute(_id, params, signal) {
			if (deps.enabled !== true) return fail(disabled);
			const auth = deps.getAuth();
			const sessionID = deps.getSessionID();
			if (!auth || !sessionID) {
				return fail("This session is not attached to the Hive agents workspace yet, so a workspace grant cannot be requested. Check /hive-remote-status and try again shortly.");
			}

			const repoName = String(params.repo ?? "").trim();
			if (!repoName) return fail("No repo name given. Call list_workspace_catalog to see the grantable repos, then pass one of those names.");

			// Validate against the catalog before spending a request on a name the
			// server would reject anyway — and so the error names the real options.
			const catalog = await fetchWorkspaceCatalog(auth, sessionID);
			if (!catalog.ok) return fail(`Could not read the workspace catalog: ${catalog.error}.`);
			const entry = catalog.entries.find((e) => e.name === repoName);
			if (!entry) {
				const names = catalog.entries.map((e) => e.name).join(", ") || "(none configured)";
				return fail(`"${repoName}" is not a grantable repo. Available: ${names}.`);
			}

			// Rejoin by default, including pending requests and one-shot delivery retries.
			// An explicit fresh ID starts new consent without mutating the old verdict.
			const clientCallID = params.request_id ? `workspace:${repoName}:${params.request_id}` : `workspace:${repoName}`;

			const decision = await requestAndWait<WorkspaceGrantValue>(
				auth,
				"workspace",
				sessionID,
				clientCallID,
				{ repos: [repoName], reason: params.reason ?? "" },
				{ pollMs: POLL_MS, timeoutMs: DECISION_TIMEOUT_MS, signal },
			);

			switch (decision.verdict) {
				case "deny":
					return fail(`The request to add "${repoName}" was denied. Continue without it.`);
				case "expired":
					return fail(`The request to add "${repoName}" expired without a decision. To open a new consent card, call request_workspace with a fresh request_id. Reuse that ID on retries; otherwise continue without it.`);
				case "timeout":
					return fail(`No decision on "${repoName}" within the wait window — it may still be pending. Continue with other work; request it again later to rejoin the decision.`);
				case "error":
					return fail(`The workspace request for "${repoName}" could not be completed: ${decision.error ?? "unknown error"}.${decision.status === 409 ? " The approved source identity changed. Open fresh consent with a new explicit request_id; reuse that ID while pending. The old grant was not retargeted." : ""}`);
			}

			// approve | auto. A failed value fetch retains the approved verdict.
			if (decision.gone) {
				return fail(`"${repoName}" was already granted and delivered once in this session. Check the earlier request_workspace result for its checkout path or clone error. Delivery does not prove the clone succeeded; if no checkout exists, ask the operator for a new grant. Nothing was cloned by this call.`);
			}
			if (decision.error) {
				return fail(`"${repoName}" was approved, but the grant could not be fetched: ${decision.error}. No repo was cloned; ${decision.status === 409 ? "the approved source identity changed. Open fresh consent with a new explicit request_id; the old grant was not retargeted." : "retry this request to rejoin the same decision."}`);
			}
			const grant = decision.grant;
			if (!grant || !Array.isArray(grant.repos) || grant.repos.length === 0) {
				return fail(`"${repoName}" was granted but Hive returned no repo to clone${decision.error ? ` (${decision.error})` : ""}. Nothing was cloned.`);
			}

			const clones: string[] = [];
			for (const r of grant.repos) {
				clones.push(await cloneOne(pi, r, auth, signal));
			}
			return ok([`Workspace granted (${decision.verdict}).`, ...clones, "", DEPS_NOTE].join("\n"));
		},
	});
}
