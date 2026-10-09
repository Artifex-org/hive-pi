/**
 * The probes — everything that touches the world, behind one injectable seam.
 *
 * WHY DEPENDENCY-INJECTED. A probe that spawns `gh` and fetches OpenRouter is
 * untestable in the way that matters: the interesting cases are the *failures*
 * (no key, 402, timeout, binary missing) and none of them are reproducible by
 * calling the real thing. `ProbeDeps` is small enough that a test supplies it
 * whole, so every branch here is exercised without a network or a subprocess.
 *
 * WHY EVERY PROBE RETURNS RATHER THAN THROWS. This runs on a detached timer at
 * session start; an unhandled rejection there is an extension error in a path
 * nobody is watching. `runProbe` converts a throw or a timeout into
 * `status: "unknown"`, which is a real answer — see `state.ts` on why that is
 * not `absent`.
 *
 * COST DISCIPLINE. `resolveProject`-style probes are documented as never
 * callable from an event handler (800 ms `execFileSync` each). Nothing here is
 * called from a handler body: `index.ts` kicks the whole set off a detached
 * timer, exactly as `agmsg` does for identity resolution.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hiveBaseURL, readJSON } from "../hive-common/identity.ts";
import { mcpConfigPath as sharedConfigPath } from "../mcp-common/config.ts";
import { baseDirCandidates, pgPaths } from "../devservices/pg.ts";
import { DIR_PREFIX, HEARTBEAT_FILE, STALE_AFTER_MS } from "../devservices/reap.ts";
import { mcpBelongsHere, stdioMissing, type McpServerDef } from "./mcp.ts";
import { GIT_NO_OPTIONAL_LOCKS } from "../hive-common/git.ts";
import { nativeMcpServer } from "../mcp-common/names.ts";
import { mcpLauncherFor } from "../profile-common/profile.ts";
import type { ProbeResult, ProbeStatus } from "./state.ts";

/** Every probe is bounded. A slow answer is the same as no answer here. */
export const PROBE_TIMEOUT_MS = 4_000;
/** Below this many dollars, OpenRouter delegation is one worker away from 402. */
export const OPENROUTER_CREDIT_FLOOR = 2;

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export interface HttpResult {
	ok: boolean;
	status: number;
	body: unknown;
}

export interface ProbeDeps {
	now: () => number;
	env: Record<string, string | undefined>;
	home: string;
	/** process.platform when omitted; injected so a test can be any OS. */
	platform?: NodeJS.Platform;
	cwd: string;
	exists: (path: string) => boolean;
	listDir: (path: string) => string[];
	readJson: <T>(path: string) => T | null;
	/** Whole-file text read, empty string when unreadable. */
	readText: (path: string) => string;
	/** Last-modified time in epoch ms, null when the file is missing or unreadable. */
	mtimeMs: (path: string) => number | null;
	exec: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
	getJson: (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<HttpResult>;
	/** Names of every tool registered in this session, e.g. `mcp__hive__get_run`. */
	toolNames: () => string[];
	/**
	 * MCP servers extensions registered with `pi.registerMcpServer` this session
	 * (hive-pi's `mcp-products`). They are not in `mcp.json`, so without this a
	 * product server has no row even while it is connected. Optional so a test
	 * that does not care stays as it was.
	 */
	registeredMcpServers?: () => { name: string; config: McpServerDef }[];
	/**
	 * Absolute path of a file inside an installed package, or null.
	 *
	 * Resolution rather than a guessed path: the probe must read the SAME
	 * playwright-core the browser extension imports, and where that lives
	 * depends on how hive-pi was installed (a repo checkout, a global package,
	 * a factory container). A hardcoded `node_modules/...` would be right in one
	 * of those and silently wrong in the rest.
	 */
	resolveModuleFile: (specifier: string) => string | null;
	/**
	 * Listen on a fresh unix-socket path in the temp dir, then close it and
	 * remove the path. Optional so a test that does not care stays as it was;
	 * absent, the unix-socket row is `unknown`.
	 */
	listenUnix?: () => Promise<UnixListenResult>;
}

/** What one unix-socket listen attempt established. */
export type UnixListenResult = { ok: true } | { ok: false; code: string; message: string };

export type Probe = (deps: ProbeDeps) => Promise<Omit<ProbeResult, "at">>;

/** Wrap a probe so it always answers, and always within the deadline. */
export async function runProbe(id: string, label: string, probe: Probe, deps: ProbeDeps): Promise<ProbeResult> {
	const at = deps.now();
	try {
		const outcome = await withDeadline(probe(deps), PROBE_TIMEOUT_MS + 1_000);
		return { ...outcome, id: outcome.id ?? id, label: outcome.label ?? label, at };
	} catch {
		return { id, label, status: "unknown", detail: "probe failed or timed out", at };
	}
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("probe deadline")), ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

interface McpConfig {
	mcpServers?: Record<string, McpServerDef | undefined>;
}

/**
 * One row per configured MCP server, from pi's built-in MCP (HIV-3745).
 *
 * Native MCP registers every tool of a connected server as
 * `mcp__<server>__<tool>`, so the LIVE REGISTRY answers "is it connected and
 * what can it do" directly — no cache file, no TTL to second-guess. Servers
 * connect in the background at session start (`direct`-tool servers are
 * awaited up to 10 s before the first prompt), so a server with no tools yet
 * reads `warming`; the delayed re-probe in `index.ts` turns that into the real
 * answer, and a server that never connects keeps saying where to look.
 */
export function mcpConfigPath(deps: ProbeDeps): string {
	return sharedConfigPath(deps.env, deps.home);
}

/** How many tools pi has registered for `server`. */
export function nativeToolCount(toolNames: readonly string[], server: string): number {
	return toolNames.filter((name) => nativeMcpServer(name) === server.replace(/[^A-Za-z0-9_]/g, "_")).length;
}

export function mcpServerProbes(deps: ProbeDeps): { id: string; label: string; probe: Probe }[] {
	const fileConfig = deps.readJson<McpConfig>(mcpConfigPath(deps));
	// File-configured servers take precedence over registered ones of the same
	// name — pi's own rule (docs/mcp.md §Add servers from extensions).
	const config: McpConfig = { mcpServers: { ...Object.fromEntries((deps.registeredMcpServers?.() ?? []).map((s) => [s.name, s.config])), ...(fileConfig?.mcpServers ?? {}) } };
	const servers = Object.keys(config.mcpServers ?? {});
	if (servers.length === 0) return [];
	// Product servers stay in the global file so a session that actually needs
	// the other product can still connect. They are not a capability of THIS
	// checkout, so they do not get a row (HIV-2639). Which servers are a product
	// comes from the house profile; with none configured, every server is
	// reported everywhere.
	return servers.filter((name) => mcpBelongsHere(name, deps.cwd)).map((name) => ({
		id: `mcp.${name}`,
		label: `mcp ${name}`,
		probe: async (d: ProbeDeps) => {
			const id = `mcp.${name}`;
			const label = `mcp ${name}`;
			const def = config?.mcpServers?.[name] ?? {};
			if (def.enabled === false) {
				return { id, label, status: "unknown" as ProbeStatus, detail: "disabled in mcp.json" };
			}
			const missing = stdioMissing(def, d.home, d.exists);
			if (missing) {
				return {
					id,
					label,
					status: "absent" as ProbeStatus,
					detail: `entrypoint missing (${missing[0]})`,
					hint: `the stdio spawn cannot start until ${missing[0]} exists — build the project CLI (or stage ~/.local/share/${mcpLauncherFor(name) ?? name}/current.js)`,
				};
			}
			const count = nativeToolCount(d.toolNames(), name);
			if (count === 0) {
				return {
					id,
					label,
					status: "warming" as ProbeStatus,
					detail: "connecting — no tools registered yet",
					hint: "`/mcp` shows the connection state and the last error; servers connect in the background",
				};
			}
			const exposure = typeof def.exposure === "string" ? def.exposure : "codemode";
			return {
				id,
				label,
				status: "ready" as ProbeStatus,
				detail: `${count} tools · ${exposure}`,
				tool: exposure === "direct" ? `mcp__${name}__*` : exposure === "deferred" ? "tool_search" : "codemode",
			};
		},
	}));
}

// ---------------------------------------------------------------------------
// Credentials and services
// ---------------------------------------------------------------------------

export const hiveProbe: Probe = async (deps) => {
	const base = hiveBaseURL();
	if (!base) {
		return { id: "hive", label: "hive", status: "absent", detail: "no Hive configured", hint: "run `/hive-login`" };
	}
	if (!deps.env.HIVE_TOKEN) {
		return {
			id: "hive",
			label: "hive",
			status: "degraded",
			detail: "no HIVE_TOKEN in the environment",
			hint: "MCP calls will 401 — export HIVE_TOKEN before launching",
		};
	}
	const res = await deps.getJson(`${base}/readyz`, {}, PROBE_TIMEOUT_MS);
	return res.ok
		? { id: "hive", label: "hive", status: "ready", detail: base, tool: "mcp__hive__*" }
		: {
				id: "hive",
				label: "hive",
				status: "degraded",
				detail: `readyz ${res.status || "unreachable"}`,
				hint: "the knowledge tools are unavailable until it answers",
			};
};

/**
 * OpenRouter credit, because running out is the fleet's loudest silent failure.
 *
 * Measured twice: a whole fleet froze mid-turn on HTTP 402 with byte-identical
 * turn counts, and on 2026-08-16 two subagent delegations died with
 * "requested up to 131072 tokens, but can only afford 1283". Both were
 * discovered by a worker dying, which is the most expensive possible place to
 * learn it.
 */
export const openrouterProbe: Probe = async (deps) => {
	const key = deps.env.OPENROUTER_API_KEY;
	if (!key) {
		return {
			id: "openrouter",
			label: "openrouter",
			status: "unknown",
			detail: "no OPENROUTER_API_KEY in the environment",
		};
	}
	const res = await deps.getJson(
		"https://openrouter.ai/api/v1/credits",
		{ Authorization: `Bearer ${key}` },
		PROBE_TIMEOUT_MS,
	);
	if (!res.ok) {
		// `credits 0` is what this used to say when the REQUEST failed, because
		// getJson reports an unreachable host as status 0. It reads as "no money
		// left" — a resource verdict produced by a network failure, which is the
		// same misread class as the gh probe above (HIV-1978/1979). Name the
		// transport when there was no response at all.
		return {
			id: "openrouter",
			label: "openrouter",
			status: "unknown",
			detail: res.status ? `credits HTTP ${res.status}` : "credits endpoint unreachable — balance unknown",
		};
	}
	const data = (res.body as { data?: { total_credits?: number; total_usage?: number } } | undefined)?.data;
	const total = typeof data?.total_credits === "number" ? data.total_credits : null;
	const used = typeof data?.total_usage === "number" ? data.total_usage : null;
	if (total === null || used === null) {
		return { id: "openrouter", label: "openrouter", status: "unknown", detail: "credits response unrecognised" };
	}
	const left = Math.round((total - used) * 100) / 100;
	if (left <= 0) {
		return {
			id: "openrouter",
			label: "openrouter",
			status: "absent",
			detail: `$${left} left`,
			hint: "every subagent and fallback call will 402 — top up before delegating",
		};
	}
	if (left < OPENROUTER_CREDIT_FLOOR) {
		return {
			id: "openrouter",
			label: "openrouter",
			status: "degraded",
			detail: `$${left} left`,
			hint: "a large subagent context can exhaust this mid-run",
		};
	}
	return { id: "openrouter", label: "openrouter", status: "ready", detail: `$${left} left` };
};

/**
 * Is there a GitHub credential — and separately, can this session REACH GitHub?
 *
 * ## The bug this shape exists to prevent, measured 2026-08-16
 *
 * The first version of this probe ran `gh auth status` and reported a non-zero
 * exit as "not authenticated — run `gh auth login`". That is wrong inside a
 * sandboxed agent, and it is wrong in the most expensive possible direction.
 *
 * `gh auth status` makes a NETWORK CALL. With egress blocked it prints
 *
 *     X Failed to log in to github.com account octocat (keyring)
 *     - The token in keyring is invalid.
 *     - To re-authenticate, run: gh auth refresh -h github.com
 *
 * — gh's own misdiagnosis of a network failure as a bad credential. A launched
 * agent runs under srt, which has its own network namespace and no DNS (egress
 * rides an injected proxy), so every sandboxed session saw that.
 *
 * The consequence was not theoretical: session `efb2830c` finished a fix,
 * committed it, read this row, told its operator to run `gh auth login`, and
 * stopped — with a perfectly valid token in its environment. The probe was the
 * proximate cause of a stalled agent, and the advice it gave would have had
 * someone re-authenticate a healthy credential.
 *
 * So executable/token discovery is asked first, without a network call:
 * `gh auth token` reads the config/keyring and returns in ~60 ms. The returned
 * token then authenticates `GET /user`, which proves both the active credential
 * and GitHub reachability. `gh auth status` is deliberately NOT used: it
 * aggregates every saved profile, so an unrelated stale profile can make it fail
 * while the active injected token works. Only when `/user` fails is a public
 * GitHub request needed to distinguish transport failure from credential denial.
 *
 * ## And the third question, which the first fix still got wrong (HIV-1979)
 *
 * There is a failure BEFORE either of those: `gh` may not run at all. On a node
 * that manages tools with mise, `gh` on PATH is a shim that reinstalls before
 * exec'ing, and reinstalling is a write:
 *
 *     mise ERROR Failed to install aqua:cli/cli@latest: Read-only file system
 *
 * That is a non-zero exit from `gh auth token`, so the version of this probe
 * that shipped for HIV-1978 called it "no credential" and advised `gh auth
 * login` — committing the exact sin HIV-1978 was written to stop, one branch
 * further along. It was ALSO the true cause of the stall that motivated the
 * ticket: the sandbox's network was fine, the token was fine, and the binary
 * never ran.
 *
 * The rule this file now follows: **a tool that could not execute has told you
 * nothing about your credentials.** Say so without echoing arbitrary process
 * output — readiness is durable session state and must not carry credentials.
 */

/** Tells "the binary never ran" apart from "the binary answered no", without retaining process output. */
export function execFailureDetail(result: ExecResult): string | null {
	const text = `${result.stdout}\n${result.stderr}`;
	if (/mise ERROR/i.test(text)) return "mise shim failed to execute";
	if (/command not found|ENOENT|No such file or directory/i.test(text)) return "executable not found";
	if (/Permission denied/i.test(text)) return "executable permission denied";
	return null;
}

export const ghProbe: Probe = async (deps) => {
	const token = await deps.exec("gh", ["auth", "token"], PROBE_TIMEOUT_MS);
	if (token.code !== 0) {
		const failed = execFailureDetail(token);
		if (failed) {
			return {
				id: "gh",
				label: "gh auth",
				status: "unknown",
				detail: `gh could not run — ${failed}`,
				hint:
					"this says NOTHING about your credentials — re-authenticating is not the fix. The binary on PATH " +
					"did not execute: on a mise-managed node the PATH entry is a shim that reinstalls before running, " +
					"and reinstalling fails on a read-only sandbox. A real `gh` is usually still present — try " +
					"`/usr/bin/gh`, or `mise which gh` on the host.",
			};
		}
		return {
			id: "gh",
			label: "gh auth",
			status: "degraded",
			detail: "no credential",
			hint: "`gh auth login` — PR and review commands will fail without it",
		};
	}

	const credential = token.stdout.trim();
	if (!credential) {
		return {
			id: "gh",
			label: "gh auth",
			status: "degraded",
			detail: "no credential",
			hint: "`gh auth login` — PR and review commands will fail without it",
		};
	}
	const authenticated = await deps.getJson(
		"https://api.github.com/user",
		{ Authorization: `Bearer ${credential}` },
		PROBE_TIMEOUT_MS,
	);
	if (authenticated.ok) {
		const account =
			typeof authenticated.body === "object" &&
			authenticated.body !== null &&
			typeof (authenticated.body as { login?: unknown }).login === "string"
				? (authenticated.body as { login: string }).login
				: null;
		return { id: "gh", label: "gh auth", status: "ready", ...(account ? { detail: account } : {}) };
	}

	// Any HTTP response from the authenticated request proves transport works;
	// do not let a later public fallback overwrite that fact.
	if (authenticated.status === 401) {
		return {
			id: "gh",
			label: "gh auth",
			status: "degraded",
			detail: "GitHub rejected the active credential (401)",
			hint:
				"GitHub is reachable, but the active token was rejected. Refresh the launch credential and start a new " +
				"session; use `gh auth login` only when the host's own credential is the intended source.",
		};
	}
	if (authenticated.status === 403) {
		return {
			id: "gh",
			label: "gh auth",
			status: "degraded",
			detail: "GitHub denied the active credential (403)",
			hint: "GitHub is reachable; check token policy, scopes, or rate limits before changing authentication.",
		};
	}
	if (authenticated.status !== 0) {
		return {
			id: "gh",
			label: "gh auth",
			status: "degraded",
			detail: `GitHub authentication failed (HTTP ${authenticated.status})`,
			hint: "GitHub is reachable; inspect the authenticated API response before changing credentials.",
		};
	}

	const transport = await deps.getJson("https://api.github.com", {}, PROBE_TIMEOUT_MS);
	if (transport.status === 0) {
		return {
			id: "gh",
			label: "gh auth",
			status: "degraded",
			detail: "credential present, GitHub unreachable",
			hint:
				"do NOT re-authenticate — the credential was found, but neither authenticated nor public GitHub " +
				"requests reached an HTTP server. Check the sandbox proxy and allowlist before concluding you cannot deliver.",
		};
	}
	return {
		id: "gh",
		label: "gh auth",
		status: "degraded",
		detail: "GitHub authentication failed",
		hint: "GitHub is reachable; inspect the authenticated API response before changing credentials.",
	};
};

/**
 * Live devservices clusters on this workstation, split into THIS session's
 * and other sessions': `pi-devservices-<pid>-<token>` directories under the
 * roots devservices creates them in, whose heartbeat (or, failing one, the
 * directory itself) is fresher than the reaper's staleness bound — the same
 * evidence `devservices/reap.ts` keeps a cluster alive on.
 *
 * The split is the point. A workstation hosts several launched agents at
 * once, and a database one of them started is not a database this session
 * can reach (its DATABASE_URL was printed to a different transcript, on a
 * port this session was never told). Counting every live cluster would hand
 * every neighbour a stronger `✓ dev postgres` than the one this row exists
 * to retract. devservices runs in this same pi process, so the pid in the
 * directory name is the ownership test.
 */
export function liveDevservicesClusters(deps: ProbeDeps, ownPid: number = process.pid): { own: number; others: number } {
	const tmp = deps.env.TMPDIR?.trim() || "/tmp";
	const ownPrefix = `${DIR_PREFIX}${ownPid}-`;
	let own = 0;
	let others = 0;
	for (const root of baseDirCandidates(deps.env, deps.home, tmp)) {
		for (const name of deps.listDir(root)) {
			if (!name.startsWith(DIR_PREFIX)) continue;
			const dir = join(root, name);
			const beat = deps.mtimeMs(join(dir, HEARTBEAT_FILE)) ?? deps.mtimeMs(dir);
			if (beat === null || deps.now() - beat >= STALE_AFTER_MS) continue;
			if (name.startsWith(ownPrefix)) own++;
			else others++;
		}
	}
	return { own, others };
}

export const postgresProbe: Probe = async (deps) => {
	const paths = pgPaths(deps.env, deps.home);
	if (deps.exists(paths.bin)) {
		// "ready" ONLY when a database server is actually running. The row
		// used to be ready on the binaries alone, with the qualifier in
		// `detail` — and 29 papercuts in seven days read `✓ dev postgres`,
		// ran the repo's tests against 127.0.0.1:54322, and got connection
		// refused; one measured a 4m20s gate run spent on that. A workstation
		// with the binaries and no server is `degraded`: usable, not up.
		const live = liveDevservicesClusters(deps);
		if (live.own > 0) {
			return {
				id: "devservices.postgres",
				label: "dev postgres",
				status: "ready",
				detail:
					"this session's devservices database server is running; " +
					"`dev_db_start` reuses it and prints its DATABASE_URL (a loopback port of its own, not your repo's configured one)",
				tool: "dev_db_start",
			};
		}
		const foreign = live.others > 0 ? ` (${live.others} running for OTHER sessions on this workstation — not reachable as yours)` : "";
		return {
			id: "devservices.postgres",
			label: "dev postgres",
			status: "degraded",
			detail: `server binaries installed, but this session has no database server running${foreign} — nothing answers on your repo's configured port`,
			hint:
				"call `dev_db_start` first (it prints a DATABASE_URL on a fresh loopback port); in a Hive-managed session it hands you " +
				'to the hive MCP tool `hive_request_resource` ({resource:"postgres", action:"start"}). A host Postgres on 127.0.0.1 is ' +
				"unreachable from a sandbox — for DB-backed tests there, use a focused Hive check instead of waiting on the port",
			tool: "dev_db_start",
		};
	}
	return {
		id: "devservices.postgres",
		label: "dev postgres",
		status: "absent",
		detail: "server binaries not installed",
		hint: "run `install-devservices-postgres` on the host (a sandboxed session cannot download them)",
		tool: "dev_db_start",
	};
};

/**
 * What playwright-core will actually look for, and under what version.
 *
 * `browsers.json` ships inside playwright-core and is where playwright itself
 * reads the revision from, so this cannot drift from the browser the extension
 * launches — which a hardcoded number, or a scan of whatever is installed,
 * both can.
 *
 * Returns nulls rather than throwing: an unresolvable playwright-core is a
 * shape this probe does not understand (a container without the optional dep,
 * a bundled build), and a probe that reports a capability broken because it
 * could not read its own metadata is worse than one that falls back.
 */
export function playwrightPin(deps: ProbeDeps): { revision: string | null; version: string | null } {
	// Resolve `package.json` and read browsers.json BESIDE it, rather than
	// resolving browsers.json directly. playwright-core's `exports` map does not
	// export browsers.json, so asking for it answers ERR_PACKAGE_PATH_NOT_EXPORTED
	// — measured, and it would have made this whole probe fall back forever while
	// its unit tests passed on an injected resolver. `package.json` is exported by
	// every package (Node requires it), so it is the reliable way to find a
	// package's directory.
	const pkgPath = deps.resolveModuleFile("playwright-core/package.json");
	if (!pkgPath) return { revision: null, version: null };
	const version = deps.readJson<{ version?: string }>(pkgPath)?.version ?? null;

	const browsersPath = `${pkgPath.slice(0, pkgPath.lastIndexOf("/"))}/browsers.json`;
	const doc = deps.readJson<{ browsers?: { name?: string; revision?: string | number }[] }>(browsersPath);
	const entry = doc?.browsers?.find((b) => b.name === "chromium-headless-shell");
	const revision = entry?.revision == null ? null : String(entry.revision);
	return { revision, version };
}

/** The install command, with the real version in it rather than `<pinned>`. */
function installHint(version: string | null): string {
	return `run \`npx playwright-core@${version ?? "<pinned>"} install chromium-headless-shell\` on the host`;
}

/**
 * Where playwright keeps its browsers, resolved the way playwright does:
 * PLAYWRIGHT_BROWSERS_PATH, else `~/Library/Caches/ms-playwright` on macOS,
 * else `$XDG_CACHE_HOME/ms-playwright` or `~/.cache/ms-playwright`. Reading
 * only the Linux path told every Mac its installed browser was absent
 * (andreas-mbp, 2026-10-07). "0" means "inside node_modules", which this
 * probe does not resolve, so it falls back to the default.
 */
export function playwrightCacheRoot(deps: Pick<ProbeDeps, "env" | "home" | "platform">): string {
	const override = deps.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
	if (override && override !== "0") return override;
	if ((deps.platform ?? process.platform) === "darwin") return `${deps.home}/Library/Caches/ms-playwright`;
	const xdg = deps.env.XDG_CACHE_HOME?.trim();
	return `${xdg || `${deps.home}/.cache`}/ms-playwright`;
}

export const browserProbe: Probe = async (deps) => {
	const root = playwrightCacheRoot(deps);
	if (!deps.exists(root)) {
		return {
			id: "browser",
			label: "browser",
			status: "absent",
			detail: "no playwright browsers installed",
			hint: "run `npx playwright-core@<pinned> install chromium-headless-shell` on the host",
			tool: "browser_*",
		};
	}
	const shells = deps.listDir(root).filter((entry) => entry.startsWith("chromium_headless_shell-"));
	if (shells.length === 0) {
		return {
			id: "browser",
			label: "browser",
			status: "absent",
			detail: "playwright cache has no headless shell",
			hint: "run `npx playwright-core@<pinned> install chromium-headless-shell` on the host",
			tool: "browser_*",
		};
	}
	// A DIRECTORY is not an install.
	//
	// This probe used to answer `ready` on the strength of the folder's name,
	// and an interrupted or half-deleted download leaves exactly that: a
	// `chromium_headless_shell-<v>/` with no binary under it. The session then
	// reads `✓ browser`, calls browser_navigate, and gets
	//
	//	Executable doesn't exist at …/chromium_headless_shell-1234/
	//	chrome-headless-shell-linux64/chrome-headless-shell
	//
	// which is where 2026-08-19T03:39 stopped, on a task whose whole point was a
	// deployed-DOM verification. A readiness row that is green for a capability
	// the session cannot use is worse than no row: it is consulted precisely so
	// the failure does not happen later, and it moved the failure later.
	//
	// `INSTALLATION_COMPLETE` is playwright's own marker, written at the end of a
	// successful install and checked by playwright itself before reusing a cached
	// browser. Preferred over probing for the executable because the binary's
	// path is platform-shaped (`chrome-headless-shell-linux64/…`,
	// `-mac-arm64/…`, `.exe` on Windows) and this probe should not carry a table
	// of those; the marker means the same thing everywhere.
	const complete = shells.filter((dir) => deps.exists(`${root}/${dir}/INSTALLATION_COMPLETE`));

	// ANY complete shell was the wrong question.
	//
	// playwright-core does not look for "a headless shell". It looks for one
	// exact revision, pinned in its own browsers.json, and answers
	//
	//	Executable doesn't exist at …/chromium_headless_shell-1234/…
	//
	// when that one is missing — however many others are installed and complete.
	// Measured 2026-08-19: the cache held `chromium_headless_shell-1228`, whole,
	// with its INSTALLATION_COMPLETE marker (installed for Aurora, whose
	// playwright-core pins 1228), while hive-pi's playwright-core 1.62.1 pins
	// 1234. The probe read `1228`, reported `✓ browser`, and browser_navigate
	// failed on 1234 — twice in one day, both blocking, the second AFTER the
	// INSTALLATION_COMPLETE check landed.
	//
	// That earlier fix was right about its own case and wrong about this one: it
	// read the same 1234 in the error and concluded a download had been
	// interrupted. Nothing was interrupted. 1234 was never fetched, and 1228 was
	// sitting there complete. The check's LOGIC was sound; what it read was not
	// the thing playwright asks for.
	//
	// `browser/index.ts` already warns that `playwright install` garbage-collects
	// other versions' revisions, so "keep the version in lockstep" — this is the
	// probe finally checking that lockstep instead of assuming it.
	const { revision, version } = playwrightPin(deps);
	if (revision) {
		const wanted = `chromium_headless_shell-${revision}`;
		if (deps.exists(`${root}/${wanted}/INSTALLATION_COMPLETE`)) {
			return { id: "browser", label: "browser", status: "ready", detail: wanted, tool: "browser_*" };
		}
		if (deps.exists(`${root}/${wanted}`)) {
			return {
				id: "browser",
				label: "browser",
				status: "absent",
				detail: `${wanted} present but incomplete`,
				hint: `the directory exists with no INSTALLATION_COMPLETE marker, so a download was interrupted — re-${installHint(version)}`,
				tool: "browser_*",
			};
		}
		return {
			id: "browser",
			label: "browser",
			status: "absent",
			// BOTH numbers. "no headless shell" in front of a cache that visibly
			// has one reads as a broken probe, and the person looking at it needs
			// to know it is a version mismatch, not a missing install.
			detail:
				complete.length > 0
					? `installed ${complete.sort().at(-1)}, but playwright-core${version ? ` ${version}` : ""} needs ${wanted}`
					: `${wanted} not installed`,
			hint: installHint(version),
			tool: "browser_*",
		};
	}

	// playwright-core could not be resolved, so there is no pin to check against.
	// Fall back to the previous question — a complete shell of any revision —
	// rather than reporting a capability broken on the strength of metadata this
	// probe could not read.
	if (complete.length === 0) {
		return {
			id: "browser",
			label: "browser",
			status: "absent",
			// Name what IS there. "No headless shell" would be read as "nothing
			// installed" by someone looking at a directory that plainly exists,
			// and the remedy differs: this one needs the install re-run, not run.
			detail: `headless shell present but incomplete (${shells.sort().at(-1)})`,
			hint:
				"the directory exists with no INSTALLATION_COMPLETE marker, so a download was interrupted — " +
				`re-${installHint(version)}`,
			tool: "browser_*",
		};
	}
	return { id: "browser", label: "browser", status: "ready", detail: complete.sort().at(-1), tool: "browser_*" };
};

/**
 * Where the session is standing. Cheap by construction — two porcelain git
 * calls, no network, no PR lookup: the session-context hook already does the
 * workspace evaluation, and duplicating it here would pay for it twice.
 */
export const repoProbe: Probe = async (deps) => {
	const branch = await deps.exec("git", [GIT_NO_OPTIONAL_LOCKS, "-C", deps.cwd, "rev-parse", "--abbrev-ref", "HEAD"], PROBE_TIMEOUT_MS);
	if (branch.code !== 0) {
		return { id: "repo", label: "repo", status: "unknown", detail: "not a git checkout" };
	}
	const name = branch.stdout.trim();
	const status = await deps.exec("git", [GIT_NO_OPTIONAL_LOCKS, "-C", deps.cwd, "status", "--porcelain"], PROBE_TIMEOUT_MS);
	const dirty = status.code === 0 ? status.stdout.split("\n").filter((line) => line.trim()).length : 0;
	return {
		id: "repo",
		label: "repo",
		status: "ready",
		detail: dirty > 0 ? `${name} · ${dirty} changed` : name,
	};
};

/** The fixed probes, in registration order. MCP rows are added per server. */
/**
 * Is the harness this session is running actually current? (HIV-1974)
 *
 * `~/.pi/agent/settings.json` tracks hive-pi UNPINNED, so a merge is supposed
 * to reach every session within one `hive-pi-update.timer` period (~17 min).
 * On 2026-08-16 that unit failed three runs in a row on a stale `index.lock`
 * and the harness sat two merges behind for hours — visible only to
 * `systemctl --user status`, which nobody runs. The symptom it produces is
 * nastier than "old code": stow-symlinked config stops tracking `main`, so a
 * merged config change appears to do nothing, and the search starts in
 * completely the wrong place.
 *
 * So the updater now records every run and this reads that record. It reports
 * on the AGE of the last success, not on the last exit status: a unit that has
 * not run at all (timer disabled, masked, or never installed) is the same
 * problem and would report "ok" forever if we only read the status.
 */
export const HARNESS_UPDATE_STALE_S = 45 * 60;

export const harnessUpdateProbe: Probe = async (deps) => {
	const stateHome = deps.env.XDG_STATE_HOME ?? `${deps.home}/.local/state`;
	const updateDir = `${stateHome}/hive-pi-update`;
	const file = `${updateDir}/last-run`;
	if (!deps.exists(file)) {
		// Not every machine runs the updater (a factory container does not), so
		// its absence is not a fault — it is simply unknown.
		return { id: "harness.update", label: "harness update", status: "unknown", detail: "no run recorded" };
	}
	const raw = deps.readText(file).trim();
	const [stamp, status, ...rest] = raw.split(/\s+/);
	const at = Date.parse(stamp ?? "");
	if (!Number.isFinite(at)) {
		return { id: "harness.update", label: "harness update", status: "unknown", detail: "unreadable run record" };
	}
	const ageS = Math.max(0, Math.round((deps.now() - at) / 1000));
	const ageText = ageS < 3600 ? `${Math.round(ageS / 60)}m ago` : `${(ageS / 3600).toFixed(1)}h ago`;
	const activated = `${updateDir}/activated-revision`;
	const available = `${updateDir}/available-revision`;
	if (deps.exists(activated) && deps.exists(available)) {
		const activeRevision = deps.readText(activated).trim();
		const availableRevision = deps.readText(available).trim();
		if (activeRevision && availableRevision && activeRevision !== availableRevision) {
			return {
				id: "harness.update",
				label: "harness update",
				status: "degraded",
				detail: `upstream ${availableRevision.slice(0, 9)} not activated (${activeRevision.slice(0, 9)})`,
				hint: "this session may be running an older harness — `journalctl --user -u hive-pi-update`",
			};
		}
	}
	if (status === "failed") {
		return {
			id: "harness.update",
			label: "harness update",
			status: "degraded",
			detail: `last run FAILED ${ageText}${rest.length ? ` (${rest.join(" ")})` : ""}`,
			hint: "this session may be running an older harness — `journalctl --user -u hive-pi-update`",
		};
	}
	if (ageS > HARNESS_UPDATE_STALE_S) {
		return {
			id: "harness.update",
			label: "harness update",
			status: "degraded",
			detail: `last success ${ageText}`,
			hint: "the ~17m timer has not landed a run — check `systemctl --user status hive-pi-update`",
		};
	}
	return { id: "harness.update", label: "harness update", status: "ready", detail: `ok ${ageText}` };
};

/**
 * Can this session listen on a unix socket? (HIV-3802 eval, 2026-10-08)
 *
 * srt's seccomp filter refuses `socket(AF_UNIX)` outright — the browser,
 * credential-recovery, kernel and devservices extensions all document it — and
 * the pi process runs under the same filter as every command it spawns. A
 * sandboxed agent therefore cannot run any test that listens on a socket PATH.
 * Measured in the HIV-3802 A/B eval: the pi arm's vitest unix-socket transport
 * suite timed out 7×5 s, because its harness never surfaced the `listen EPERM`,
 * and the agent spent the next minutes proving the sandbox was the cause; the
 * Claude arm's `go test` failed `listen unix …: socket: operation not
 * permitted` on two unrelated socket tests.
 *
 * The answer is a real listen, not a sandbox-detection heuristic: whatever the
 * policy, this is the call those tests make. The remedy is generic on purpose —
 * the repo's own fleet steps are what `quality_gate` already knows.
 */
export const UNIX_SOCKET_REFUSED_HINT =
	"the sandbox refuses socket(AF_UNIX): every test or tool that listens on or connects to a unix-socket PATH " +
	"fails here with EPERM — or just times out, when its harness swallows the listen error. Do not debug that " +
	"locally or weaken the test: run those tests on the fleet with `quality_gate` (it lists this repo's steps) " +
	"or `hive check --step <step>`, and report them as not run locally. TCP on 127.0.0.1 is unaffected";

export const unixSocketProbe: Probe = async (deps) => {
	const row = { id: "unix-sockets", label: "unix sockets" } as const;
	if (!deps.listenUnix) return { ...row, status: "unknown", detail: "no listener probe in this process" };
	const outcome = await deps.listenUnix();
	if (outcome.ok) return { ...row, status: "ready", detail: "a unix-socket listen succeeds here" };
	// EPERM is the seccomp refusal; EACCES is the same answer from an LSM
	// policy. Anything else (ENOSPC, a temp dir we could not create) says
	// nothing about the policy, so it is `unknown`, never `absent`.
	if (outcome.code === "EPERM" || outcome.code === "EACCES") {
		return { ...row, status: "absent", detail: `listen on a unix-socket path: ${outcome.code}`, hint: UNIX_SOCKET_REFUSED_HINT };
	}
	return { ...row, status: "unknown", detail: `unix-socket listen probe failed: ${outcome.code}` };
};

/** One real listen on a throwaway path; the path and its directory are always removed. */
export function listenUnixSocket(base: string = tmpdir()): Promise<UnixListenResult> {
	let dir: string;
	try {
		dir = mkdtempSync(join(base, "pi-readiness-"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "ERROR";
		return Promise.resolve({ ok: false, code: `temp dir ${code}`, message: (error as Error).message });
	}
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	return new Promise<UnixListenResult>((resolve) => {
		const server = createServer();
		server.once("error", (error: NodeJS.ErrnoException) => {
			cleanup();
			resolve({ ok: false, code: error.code ?? "ERROR", message: error.message });
		});
		server.listen(join(dir, "probe.sock"), () => {
			server.close(() => {
				cleanup();
				resolve({ ok: true });
			});
		});
		server.unref();
	});
}

/**
 * The delegation lane: which model a `subagent` worker will run on, and
 * whether THIS machine holds a credential for its provider.
 *
 * Every other row here is about the session. A worker runs on
 * `PI_SUBAGENT_MODEL` / `subagentDefaultModel`, which is routinely a different
 * provider — and the measured contradiction, seven times in the week to
 * 2026-09-10, was "readiness reported OpenRouter ready with $34 left; the
 * subagent failed with `No API key found for xai`". Both were true. This row
 * is the one that would have said so before the delegation.
 *
 * Credential presence is judged the way pi judges it: a provider entry in
 * `auth.json`, or the provider's `*_API_KEY` in the environment. Presence,
 * not validity — a drained or throttled key is the subagent tool's own
 * fallback to handle (subagent/model.ts).
 */
export const delegationProbe: Probe = async (deps) => {
	const agentDir = deps.env.PI_CODING_AGENT_DIR?.trim() || join(deps.home, ".pi", "agent");
	const fromEnv = deps.env.PI_SUBAGENT_MODEL?.trim();
	const settings = deps.readJson<{ subagentDefaultModel?: string }>(join(agentDir, "settings.json"));
	const model = fromEnv || settings?.subagentDefaultModel?.trim() || "";
	if (!model) {
		return {
			id: "delegation",
			label: "delegation",
			status: "unknown",
			detail: "no delegation model configured — workers run on pi's own default",
			hint: "set PI_SUBAGENT_MODEL or subagentDefaultModel to pin the cheap lane",
		};
	}
	const at = model.indexOf("/");
	if (at <= 0) {
		return { id: "delegation", label: "delegation", status: "degraded", detail: `delegation model "${model}" is not provider/id` };
	}
	const provider = model.slice(0, at);
	const auth = deps.readJson<Record<string, unknown>>(join(agentDir, "auth.json"));
	const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
	const configured = Boolean(auth && typeof auth === "object" && provider in auth) || Boolean(deps.env[envKey]);
	const source = fromEnv ? "PI_SUBAGENT_MODEL" : "subagentDefaultModel";
	if (!configured) {
		return {
			id: "delegation",
			label: "delegation",
			status: "degraded",
			detail: `worker model ${model} (${source}): no credential for provider "${provider}" here`,
			hint: `every subagent falls back to another configured model or refuses — add ${provider} to auth.json / $${envKey}, or point ${source} at a provider this machine has`,
		};
	}
	return { id: "delegation", label: "delegation", status: "ready", detail: `worker model ${model} (${source}), ${provider} credential present`, tool: "subagent" };
};

export const BASE_PROBES: { id: string; label: string; probe: Probe }[] = [
	{ id: "repo", label: "repo", probe: repoProbe },
	{ id: "harness.update", label: "harness update", probe: harnessUpdateProbe },
	{ id: "hive", label: "hive", probe: hiveProbe },
	{ id: "openrouter", label: "openrouter", probe: openrouterProbe },
	{ id: "delegation", label: "delegation", probe: delegationProbe },
	{ id: "gh", label: "gh auth", probe: ghProbe },
	{ id: "devservices.postgres", label: "dev postgres", probe: postgresProbe },
	{ id: "browser", label: "browser", probe: browserProbe },
	{ id: "unix-sockets", label: "unix sockets", probe: unixSocketProbe },
];

/** Every probe for this session: the fixed set plus one row per MCP server. */
export function probeSet(deps: ProbeDeps): { id: string; label: string; probe: Probe }[] {
	return [...BASE_PROBES, ...mcpServerProbes(deps)];
}

/** Run them all concurrently. One slow probe never holds up the others. */
export async function runAll(deps: ProbeDeps): Promise<ProbeResult[]> {
	return Promise.all(probeSet(deps).map(({ id, label, probe }) => runProbe(id, label, probe, deps)));
}

// ---------------------------------------------------------------------------
// The real dependency set
// ---------------------------------------------------------------------------

export function realDeps(
	toolNames: () => string[],
	cwd: string = process.cwd(),
	registeredMcpServers?: () => { name: string; config: McpServerDef }[],
): ProbeDeps {
	return {
		...(registeredMcpServers ? { registeredMcpServers } : {}),
		now: () => Date.now(),
		env: process.env,
		home: process.env.HOME ?? "",
		cwd,
		exists: (path) => {
			try {
				return existsSync(path);
			} catch {
				return false;
			}
		},
		listDir: (path) => {
			try {
				return readdirSync(path);
			} catch {
				return [];
			}
		},
		readJson: readJSON,
		resolveModuleFile: (specifier) => {
			try {
				return createRequire(import.meta.url).resolve(specifier);
			} catch {
				return null;
			}
		},
		readText: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return "";
			}
		},
		mtimeMs: (path) => {
			try {
				return statSync(path).mtimeMs;
			} catch {
				return null;
			}
		},
		exec: (file, args, timeoutMs) =>
			new Promise<ExecResult>((resolve) => {
				execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
					const errorCode = error && (error as { code?: unknown }).code;
					const failure =
						typeof errorCode === "string" ? errorCode : error instanceof Error ? error.message : "";
					resolve({
						code: typeof errorCode === "number" ? errorCode : error ? 1 : 0,
						stdout: stdout ?? "",
						stderr: [stderr, failure].filter(Boolean).join("\n"),
					});
				});
			}),
		getJson: async (url, headers, timeoutMs) => {
			try {
				const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
				let body: unknown = null;
				try {
					body = await res.json();
				} catch {
					/* readyz answers with text, and callers that need a body check `ok` first */
				}
				return { ok: res.ok, status: res.status, body };
			} catch {
				return { ok: false, status: 0, body: null };
			}
		},
		toolNames,
		listenUnix: () => listenUnixSocket(),
	};
}
