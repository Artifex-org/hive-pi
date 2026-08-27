/**
 * The probes, driven entirely through `ProbeDeps`.
 *
 * The cases that matter are the failures — no key, 402-shaped credit, a missing
 * binary, a lazy MCP server — because those are what the extension exists to
 * report and none of them are reproducible against the real world on demand.
 */

import { describe, expect, it } from "vitest";
import { setHouseProfileForTest } from "../extensions/profile-common/profile.ts";

import {
	browserProbe,
	ghProbe,
	harnessUpdateProbe,
	mcpCacheStaleness,
	mcpConfigPath,
	mcpServerProbes,
	MCP_CACHE_MAX_AGE_MS,
	openrouterProbe,
	postgresProbe,
	repoProbe,
	runProbe,
	type ProbeDeps,
	type ExecResult,
	type HttpResult,
} from "../extensions/readiness/probes.ts";

const NOW = 1_700_000_000_000;

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
	return {
		now: () => NOW,
		env: {},
		home: "/home/test",
		cwd: "/repo",
		exists: () => false,
		listDir: () => [],
		readJson: () => null,
		// No playwright-core by default, so the pin is unknown and the probe
		// falls back — every pre-existing browser case keeps its old meaning.
		resolveModuleFile: () => null,
		readText: () => "",
		mtimeMs: () => null,
		exec: async (): Promise<ExecResult> => ({ code: 1, stdout: "", stderr: "" }),
		getJson: async (): Promise<HttpResult> => ({ ok: false, status: 0, body: null }),
		toolNames: () => [],
		...overrides,
	};
}

describe("runProbe", () => {
	it("converts a throwing probe into `unknown`, never a crash", async () => {
		const out = await runProbe(
			"boom",
			"boom",
			async () => {
				throw new Error("nope");
			},
			deps(),
		);
		// `unknown` and not `absent`: a probe that could not tell must not make the
		// agent stop using a capability it actually has.
		expect(out.status).toBe("unknown");
		expect(out.id).toBe("boom");
		expect(out.at).toBe(NOW);
	});

	it("stamps the result with the probe's own id and label when it supplies them", async () => {
		const out = await runProbe("x", "x", async () => ({ id: "y", label: "why", status: "ready" }), deps());
		expect(out.id).toBe("y");
		expect(out.label).toBe("why");
	});
});

describe("mcp probes", () => {
	const config = {
		mcpServers: { hive: { lifecycle: "eager" }, linear: {}, sentry: { lifecycle: "keep-alive" } },
	};
	// `cachedAt` is not decoration: the adapter rejects an entry without one, so
	// a fixture missing it would describe a cache no session ever has.
	const cache = {
		servers: {
			hive: { cachedAt: NOW - 60_000, tools: [{ name: "get_run" }, { name: "list_runs" }] },
			linear: { cachedAt: NOW - 60_000, tools: [{ name: "get_issue" }] },
		},
	};
	/** pi routes MCP through ONE proxy tool named `mcp` — measured, see probes.ts. */
	const base = deps({
		readJson: ((path: string) => (path.endsWith("mcp-cache.json") ? cache : config)) as never,
		toolNames: () => ["read", "bash", "mcp"],
	});

	it("uses PI_MCP_CONFIG when set, else the pi agent dir", () => {
		expect(mcpConfigPath(deps())).toBe("/home/test/.pi/agent/mcp.json");
		expect(mcpConfigPath(deps({ env: { PI_MCP_CONFIG: "/tmp/mcp.json" } }))).toBe("/tmp/mcp.json");
	});

	it("makes one row per configured server", () => {
		expect(mcpServerProbes(base).map((p) => p.id)).toEqual(["mcp.hive", "mcp.linear", "mcp.sentry"]);
	});

	it("reports an eager server as ready, counting the cached tool list", async () => {
		const [hive] = mcpServerProbes(base);
		const out = await hive.probe(base);
		expect(out.status).toBe("ready");
		expect(out.detail).toBe("2 tools · eager");
		expect(out.tool).toBe("mcp");
	});

	it("reports a lazy server as WARMING, and says the first call pays the connect", async () => {
		// The distinction the whole probe exists for: the adapter knows a server's
		// tools from its on-disk cache long before anything has connected.
		const linear = mcpServerProbes(base)[1];
		const out = await linear.probe(base);
		expect(out.status).toBe("warming");
		expect(out.detail).toContain("first call pays the connect");
		expect(out.hint).toContain("eager");
	});

	describe("a cached tool list the adapter will not use", () => {
		// The regression this suite exists for. Session `a78c92ef` (2026-08-17)
		// read "9 tools known · lazy-keep-alive: first call pays the connect" for
		// `sentry`, believed it, and then paid three turns and 39 s on
		// bounce → connect → four `describe` calls. The file did hold 9 tools; the
		// adapter had already discarded the entry.
		it("names the TTL, and never calls the server ready", async () => {
			const old = deps({
				readJson: ((path: string) =>
					path.endsWith("mcp-cache.json")
						? { servers: { hive: { cachedAt: NOW - MCP_CACHE_MAX_AGE_MS - 1, tools: [{ name: "get_run" }] } } }
						: config) as never,
				toolNames: () => ["mcp"],
			});
			const out = await mcpServerProbes(old)[0].probe(old);
			// `hive` is EAGER — the lifecycle that would otherwise read `ready`.
			expect(out.status).toBe("warming");
			expect(out.detail).toContain("the adapter ignores the entry");
			expect(out.detail).toContain("7d TTL");
			expect(out.hint).toContain("startup connect rebuilds it");
		});

		it("catches the config edit that silently rehashes server identity", async () => {
			// What actually invalidated `sentry`: pinning `@sentry/mcp-server@0.37.0`
			// changed `args`, so `computeServerHash` no longer matched. The hash is
			// not recomputable here, so a config newer than the entry stands in.
			const edited = deps({
				readJson: ((path: string) => (path.endsWith("mcp-cache.json") ? cache : config)) as never,
				mtimeMs: () => NOW - 30_000,
				toolNames: () => ["mcp"],
			});
			const out = await mcpServerProbes(edited)[1].probe(edited);
			expect(out.status).toBe("warming");
			expect(out.detail).toContain("mcp.json changed after it was cached");
			// The move the session had to find by trial, stated up front.
			expect(out.hint).toContain('mcp({ connect: "linear" })');
		});

		it("stats mcp.json once per pass, not once per server", () => {
			const stats: string[] = [];
			const counting = deps({
				readJson: ((path: string) => (path.endsWith("mcp-cache.json") ? cache : config)) as never,
				mtimeMs: (path) => {
					stats.push(path);
					return null;
				},
				toolNames: () => ["mcp"],
			});
			mcpServerProbes(counting);
			expect(stats).toHaveLength(1);
		});

		it("says nothing when the entry is fresh and the config predates it", () => {
			expect(mcpCacheStaleness(NOW - 60_000, NOW - 120_000, NOW)).toBeNull();
			// An entry with no timestamp is one the adapter rejects outright.
			expect(mcpCacheStaleness(undefined, null, NOW)).toBe("no cache timestamp");
		});
	});

	it("is unknown for a server with no cached tool list — it has simply never connected", async () => {
		const sentry = mcpServerProbes(base)[2];
		const out = await sentry.probe(base);
		expect(out.status).toBe("unknown");
		expect(out.detail).toContain("first call will discover it");
	});

	it("does not treat another project's cached MCP as this session being ready", async () => {
		// HIV-2639: a launch in one project's checkout showed ANOTHER project's
		// server as 353 tools cached / warming, because the global mcp.json always
		// registers it. That cache is another project's inventory, not a
		// capability of this checkout — so there is no row, rather than an
		// `absent` one every session would then have to ignore.
		//
		// Which servers are a product is the house profile's answer, so the test
		// supplies one. With no profile there is no filtering at all, which the
		// case below pins.
		setHouseProfileForTest({ projects: [{ token: "beta", mcpServers: ["beta-api"] }] });
		const product = {
			mcpServers: {
				"beta-api": {
					lifecycle: "lazy-keep-alive",
					command: "bash",
					args: ["-c", 'exec "$HOME/repos/Beta-Platform/frontend/cli/bin/beta-mcp"'],
				},
				hive: { lifecycle: "eager" },
			},
		};
		const productCache = {
			servers: {
				"beta-api": { cachedAt: NOW - 60_000, tools: Array.from({ length: 353 }, (_, i) => ({ name: `t${i}` })) },
				hive: { cachedAt: NOW - 60_000, tools: [{ name: "get_run" }] },
			},
		};
		const alpha = deps({
			cwd: "/home/dev/repos/Alpha__worktrees/agents-alpha-32704f29",
			readJson: ((path: string) => (path.endsWith("mcp-cache.json") ? productCache : product)) as never,
			exists: () => true,
			toolNames: () => ["mcp"],
		});
		try {
			expect(mcpServerProbes(alpha).map((p) => p.id)).toEqual(["mcp.hive"]);
			const [hive] = mcpServerProbes(alpha);
			const out = await hive.probe(alpha);
			expect(out.status).toBe("ready");

			// No profile → nothing is a product, so BOTH rows appear.
			setHouseProfileForTest({});
			expect(mcpServerProbes(alpha).map((p) => p.id)).toEqual(["mcp.beta-api", "mcp.hive"]);
		} finally {
			setHouseProfileForTest(null);
		}
	});

	it("reports an unspawnable stdio MCP as absent, not as a first-call discovery", async () => {
		// The AuroraSvc row said "no cached tool list — the first call will discover
		// it" while every connect exited 1: dist/mcp-server.js is gone.
		const product = {
			mcpServers: {
				aurorasvc: {
					lifecycle: "lazy-keep-alive",
					command: "bash",
					args: [
						"-c",
						'for p in "$HOME/repos/Aurora__worktrees/feature" "$HOME/repos/Aurora"; do [ -f "$p/frontend/cli/dist/mcp-server.js" ] && exec node "$p/frontend/cli/dist/mcp-server.js"; done; exit 1',
					],
				},
			},
		};
		const aurora = deps({
			cwd: "/home/dev/repos/Aurora__worktrees/agents-aurora-32704f29",
			readJson: ((path: string) => (path.endsWith("mcp-cache.json") ? { servers: {} } : product)) as never,
			exists: () => false,
			toolNames: () => ["mcp"],
		});
		const [aurorasvc] = mcpServerProbes(aurora);
		const out = await aurorasvc.probe(aurora);
		expect(out.status).toBe("absent");
		expect(out.detail).toContain("entrypoint missing");
		expect(out.detail).toContain("mcp-server.js");
	});

	it("is UNKNOWN for every server when the adapter is not loaded", async () => {
		// Found by the first headless smoke run (`pi -p -ne`): with no adapter
		// there is no `mcp` proxy tool, and reporting five servers as missing
		// would be a false alarm about the harness's most-used tool surface.
		const cold = deps({ readJson: (() => config) as never, toolNames: () => ["read", "bash"] });
		const rows = await Promise.all(mcpServerProbes(cold).map((p) => p.probe(cold)));
		expect(rows.map((r) => r.status)).toEqual(["unknown", "unknown", "unknown"]);
		expect(rows[0].detail).toBe("mcp adapter not loaded");
	});

	it("makes no rows when there is no config", () => {
		expect(mcpServerProbes(deps())).toEqual([]);
	});

	it("reads the 754 KB cache once per pass, not once per server", () => {
		const reads: string[] = [];
		const counting = deps({
			readJson: ((path: string) => {
				reads.push(path);
				return path.endsWith("mcp-cache.json") ? cache : config;
			}) as never,
			toolNames: () => ["mcp"],
		});
		mcpServerProbes(counting);
		expect(reads.filter((p) => p.endsWith("mcp-cache.json"))).toHaveLength(1);
	});
});

describe("openrouter", () => {
	function credits(total: number, usage: number) {
		return deps({
			env: { OPENROUTER_API_KEY: "sk-test" },
			getJson: async () => ({ ok: true, status: 200, body: { data: { total_credits: total, total_usage: usage } } }),
		});
	}

	it("is unknown without a key — absence of evidence, not evidence of absence", async () => {
		const out = await openrouterProbe(deps());
		expect(out.status).toBe("unknown");
	});

	it("is ready with headroom", async () => {
		const out = await openrouterProbe(credits(20, 5));
		expect(out.status).toBe("ready");
		expect(out.detail).toBe("$15 left");
	});

	it("is degraded below the floor", async () => {
		const out = await openrouterProbe(credits(10, 8.5));
		expect(out.status).toBe("degraded");
		expect(out.hint).toContain("subagent");
	});

	it("is absent at zero — the measured fleet-freeze case", async () => {
		const out = await openrouterProbe(credits(10, 10));
		expect(out.status).toBe("absent");
		expect(out.hint).toContain("402");
	});

	it("is unknown when the response shape is not what we expect", async () => {
		const out = await openrouterProbe(
			deps({ env: { OPENROUTER_API_KEY: "k" }, getJson: async () => ({ ok: true, status: 200, body: {} }) }),
		);
		expect(out.status).toBe("unknown");
	});

	it("never renders an unreachable endpoint as a BALANCE (HIV-1979)", async () => {
		// getJson reports "no response at all" as status 0, and the old detail
		// string interpolated it — producing `credits 0`, which reads as "you are
		// out of money". A network failure must not look like a resource verdict;
		// that is the same misread that stalled a live agent on the gh row.
		const out = await openrouterProbe(
			deps({ env: { OPENROUTER_API_KEY: "k" }, getJson: async () => ({ ok: false, status: 0, body: null }) }),
		);
		expect(out.status).toBe("unknown");
		expect(out.detail).not.toBe("credits 0");
		expect(out.detail).toContain("unreachable");
	});

	it("still names a real HTTP status when the server DID answer", async () => {
		const out = await openrouterProbe(
			deps({ env: { OPENROUTER_API_KEY: "k" }, getJson: async () => ({ ok: false, status: 401, body: null }) }),
		);
		expect(out.detail).toContain("401");
	});
});

describe("gh", () => {
	/** `gh auth token` is the offline question; `gh auth status` is the network one. */
	function gh(tokenCode: number, statusCode: number, statusText = "") {
		return deps({
			exec: async (_file, args) =>
				args.includes("token")
					? { code: tokenCode, stdout: "gho_x", stderr: "" }
					: { code: statusCode, stdout: "", stderr: statusText },
		});
	}

	it("is ready and names the account", async () => {
		const out = await ghProbe(gh(0, 0, "✓ Logged in to github.com account octocat (keyring)"));
		expect(out.status).toBe("ready");
		expect(out.detail).toBe("octocat");
	});

	it("is degraded with the login hint ONLY when there is no credential", async () => {
		const out = await ghProbe(gh(1, 1));
		expect(out.status).toBe("degraded");
		expect(out.detail).toBe("no credential");
		expect(out.hint).toContain("gh auth login");
	});

	it("does NOT tell a sandboxed agent to re-authenticate a valid credential", async () => {
		// The measured failure this test exists for: `gh auth status` makes a
		// network call, and with egress blocked it prints "The token in keyring is
		// invalid. To re-authenticate, run: gh auth refresh". A launched agent has
		// its own netns and no DNS, so EVERY sandboxed session saw that — and
		// session efb2830c stopped work and asked its operator to `gh auth login`
		// while holding a token that authenticates fine on the host.
		const out = await ghProbe(gh(0, 1, "X Failed to log in to github.com account octocat (keyring)\n- The token in keyring is invalid."));
		expect(out.status).toBe("degraded");
		expect(out.detail).toBe("credential present, GitHub unreachable");
		expect(out.hint).toContain("do NOT re-authenticate");
		expect(out.hint).not.toContain("gh auth login");
	});

	it("does NOT call a failed EXEC a missing credential (HIV-1979)", async () => {
		// The true cause of session efb2830c's stall, and a bug the HIV-1978 fix
		// still had: on a mise-managed node `gh` is a shim that reinstalls before
		// exec'ing, and reinstalling fails read-only. `gh auth token` then exits
		// non-zero having learned NOTHING about the credential — which the first
		// fix reported as "no credential" plus `gh auth login`, the exact sin it
		// was written to stop.
		const out = await ghProbe(
			deps({
				exec: async () => ({
					code: 1,
					stdout: "",
					stderr: "mise ERROR Failed to install aqua:cli/cli@latest: Read-only file system (os error 30)",
				}),
			}),
		);
		expect(out.status).toBe("unknown");
		expect(out.detail).toContain("could not run");
		expect(out.hint).not.toContain("gh auth login");
		expect(out.hint).toContain("/usr/bin/gh");
	});

	it("does not tell a sandboxed agent that delivery is impossible (HIV-1979)", async () => {
		// The corrected half of the HIV-1978 hint. The sandbox CAN reach GitHub —
		// api.github.com is allowlisted and answers 200 through the injected proxy
		// — so "delivery needs a session that can reach GitHub" trained agents to
		// abandon a pull request they were perfectly able to open.
		const out = await ghProbe(gh(0, 1, "The token in keyring is invalid."));
		expect(out.hint).toContain("api.github.com");
		expect(out.hint).not.toMatch(/delivery needs a session/i);
	});

	it("asks the cheap offline question FIRST", async () => {
		// Ordering is the fix, not an optimisation: if `gh auth status` ran first
		// its network verdict would colour everything after it.
		const calls: string[][] = [];
		await ghProbe(
			deps({
				exec: async (_f, args) => {
					calls.push(args);
					return { code: 0, stdout: "", stderr: "" };
				},
			}),
		);
		expect(calls[0]).toContain("token");
	});
});

describe("devservices postgres", () => {
	it("is ready when the server binaries are present", async () => {
		const out = await postgresProbe(deps({ exists: (p) => p.includes(".hive/tools/postgres") }));
		expect(out.status).toBe("ready");
		expect(out.tool).toBe("dev_db_start");
	});

	it("is absent with the host install command — the HIV-1966 papercut, pre-empted", async () => {
		const out = await postgresProbe(deps());
		expect(out.status).toBe("absent");
		expect(out.hint).toContain("install-devservices-postgres");
	});
});

describe("browser", () => {
	// The healthy shape on disk, verified against a real ~/.cache/ms-playwright:
	// the version directory holds the platform binary folder alongside
	// playwright's own INSTALLATION_COMPLETE marker.
	const installed = (versions: string[]) =>
		deps({
			exists: (p) =>
				p.endsWith("ms-playwright") || versions.some((v) => p === `/home/test/.cache/ms-playwright/${v}/INSTALLATION_COMPLETE`),
			listDir: () => [...versions, "ffmpeg-1011"],
		});

	// A pinned playwright: browsers.json is where playwright-core itself reads
	// the revision, so a probe that reads the same file cannot disagree with the
	// browser the extension launches.
	//
	// Shaped like the REAL resolution: only `package.json` is resolvable (the
	// package's exports map does not export browsers.json), and browsers.json is
	// read from beside it. A fake that resolved browsers.json directly would have
	// let every test below pass against a probe that never worked on a real host.
	const pinned = (revision: string, version = "1.62.1") => ({
		resolveModuleFile: (spec: string) => (spec === "playwright-core/package.json" ? "/pkg/playwright-core/package.json" : null),
		readJson: <T,>(path: string): T | null => {
			if (path === "/pkg/playwright-core/browsers.json") {
				return { browsers: [{ name: "chromium", revision: "999" }, { name: "chromium-headless-shell", revision }] } as T;
			}
			if (path === "/pkg/playwright-core/package.json") return { version } as T;
			return null;
		},
	});

	// THE SECOND REPORTED CASE (2026-08-19T11:39, blocking — AFTER the
	// INSTALLATION_COMPLETE fix landed). The cache held chromium_headless_shell-1228
	// COMPLETE, installed for another project; hive-pi's playwright-core pins
	// 1234. playwright does not look for "a headless shell", it looks for one
	// exact revision — so the probe said ✓ and browser_navigate failed on 1234.
	it("is NOT ready when the installed shell is a DIFFERENT revision than playwright pins", async () => {
		const out = await browserProbe(
			deps({ ...installed(["chromium_headless_shell-1228"]), ...pinned("1234") }),
		);
		expect(out.status).toBe("absent");
		// BOTH numbers: "no headless shell" in front of a cache that visibly has
		// one reads as a broken probe rather than a version mismatch.
		expect(out.detail).toContain("1228");
		expect(out.detail).toContain("1234");
	});

	it("is ready when the pinned revision is the one installed", async () => {
		const out = await browserProbe(
			deps({ ...installed(["chromium_headless_shell-1228", "chromium_headless_shell-1234"]), ...pinned("1234") }),
		);
		expect(out.status).toBe("ready");
		// The PINNED one, not the newest — sorting picked 1234 here by accident
		// of ordering; the assertion is that the pin decides.
		expect(out.detail).toBe("chromium_headless_shell-1234");
	});

	it("names the pinned revision even when a NEWER one is installed", async () => {
		const out = await browserProbe(
			deps({ ...installed(["chromium_headless_shell-1234", "chromium_headless_shell-1300"]), ...pinned("1234") }),
		);
		expect(out.status).toBe("ready");
		expect(out.detail).toBe("chromium_headless_shell-1234");
	});

	// The hint is the whole remedy, and `<pinned>` is not a runnable command.
	it("puts the real playwright version in the install command", async () => {
		const out = await browserProbe(
			deps({ ...installed(["chromium_headless_shell-1228"]), ...pinned("1234", "1.62.1") }),
		);
		expect(out.hint).toContain("npx playwright-core@1.62.1 install chromium-headless-shell");
		expect(out.hint).not.toContain("<pinned>");
	});

	// Falls back rather than reporting a capability broken on metadata it could
	// not read — a container without the optional dep, a bundled build.
	it("falls back to any complete shell when playwright-core cannot be resolved", async () => {
		const out = await browserProbe(installed(["chromium_headless_shell-1228"]));
		expect(out.status).toBe("ready");
		expect(out.detail).toBe("chromium_headless_shell-1228");
	});

	it("is ready and names the newest shell", async () => {
		const out = await browserProbe(installed(["chromium_headless_shell-1187", "chromium_headless_shell-1200"]));
		expect(out.status).toBe("ready");
		expect(out.detail).toBe("chromium_headless_shell-1200");
	});

	it("is absent when the cache exists but holds no headless shell", async () => {
		const out = await browserProbe(deps({ exists: () => true, listDir: () => ["firefox-1400"] }));
		expect(out.status).toBe("absent");
		expect(out.detail).toContain("no headless shell");
	});

	it("is absent when nothing is installed at all", async () => {
		const out = await browserProbe(deps());
		expect(out.status).toBe("absent");
	});

	// THE REPORTED CASE (2026-08-19T03:39, blocking). A directory is not an
	// install: an interrupted download leaves `chromium_headless_shell-<v>/`
	// with no binary under it, and the probe answered `ready` on the folder's
	// name alone. The session read `✓ browser`, called browser_navigate, and got
	// "Executable doesn't exist at …/chrome-headless-shell", on a task whose
	// whole purpose was a deployed-DOM verification.
	it("is NOT ready when the shell directory has no INSTALLATION_COMPLETE", async () => {
		const out = await browserProbe(
			deps({
				// The directory exists; the marker inside it does not.
				exists: (p) => p.endsWith("ms-playwright"),
				listDir: () => ["chromium_headless_shell-1234"],
			}),
		);
		expect(out.status).not.toBe("ready");
		// It must not read as "nothing installed" — the directory is plainly
		// there, and the remedy is to RE-run the install, not to run it.
		expect(out.detail).toContain("incomplete");
		expect(out.detail).toContain("chromium_headless_shell-1234");
		expect(out.hint).toContain("interrupted");
	});

	// A half-finished newer version must not mask a working older one: playwright
	// keeps every version it has downloaded, so this is the ordinary state of a
	// machine whose last install was cut short.
	it("ignores an incomplete version when a complete one is present", async () => {
		const out = await browserProbe(
			deps({
				exists: (p) =>
					p.endsWith("ms-playwright") ||
					p === "/home/test/.cache/ms-playwright/chromium_headless_shell-1200/INSTALLATION_COMPLETE",
				listDir: () => ["chromium_headless_shell-1200", "chromium_headless_shell-1234"],
			}),
		);
		expect(out.status).toBe("ready");
		// The COMPLETE one, not the newest directory.
		expect(out.detail).toBe("chromium_headless_shell-1200");
	});
});

describe("harness update (HIV-1974)", () => {
	const RECORD = "/home/test/.local/state/hive-pi-update/last-run";

	function withRecord(line: string) {
		return deps({ exists: (p) => p === RECORD, readText: (p) => (p === RECORD ? line : "") });
	}

	it("is ready when a recent run succeeded", async () => {
		const out = await harnessUpdateProbe(withRecord(`${new Date(NOW - 5 * 60_000).toISOString()} ok activated abc123def`));
		expect(out.status).toBe("ready");
		expect(out.detail).toContain("5m ago");
	});

	it("is degraded when upstream advanced without activation", async () => {
		const active = "/home/test/.local/state/hive-pi-update/activated-revision";
		const available = "/home/test/.local/state/hive-pi-update/available-revision";
		const out = await harnessUpdateProbe(
			deps({
				exists: (p) => p === RECORD || p === active || p === available,
				readText: (p) =>
					p === RECORD
						? `${new Date(NOW - 60_000).toISOString()} ok already at abc123def`
						: p === active
							? "abc123def\n"
							: "fed456abc\n",
			}),
		);
		expect(out.status).toBe("degraded");
		expect(out.detail).toContain("not activated");
	});

	it("is degraded when the last run FAILED, and says where to look", async () => {
		// The measured case: three consecutive failures on a stale index.lock,
		// visible only to `systemctl --user status`, while the harness sat two
		// merges behind for hours.
		const out = await harnessUpdateProbe(withRecord(`${new Date(NOW - 60_000).toISOString()} failed exit at line 42`));
		expect(out.status).toBe("degraded");
		expect(out.detail).toContain("FAILED");
		expect(out.hint).toContain("journalctl");
	});

	it("is degraded when no run has SUCCEEDED for longer than the timer period", async () => {
		// A unit that stopped running at all — masked, disabled, never installed —
		// reports "ok" forever if you only read the last status, so age is the test.
		const out = await harnessUpdateProbe(withRecord(`${new Date(NOW - 3 * 3600_000).toISOString()} ok activated abc`));
		expect(out.status).toBe("degraded");
		expect(out.detail).toContain("3.0h ago");
	});

	it("is unknown where the updater does not run at all — absence is not a fault", async () => {
		// A factory container has no such timer; calling that degraded would cry
		// wolf in every containerised session.
		expect((await harnessUpdateProbe(deps())).status).toBe("unknown");
	});

	it("is unknown on an unreadable record rather than guessing", async () => {
		expect((await harnessUpdateProbe(withRecord("garbage"))).status).toBe("unknown");
	});
});

describe("repo", () => {
	it("reports the branch and the dirty count", async () => {
		const out = await repoProbe(
			deps({
				exec: async (_file, args) =>
					args.includes("--abbrev-ref")
						? { code: 0, stdout: "hiv-1969-readiness-fast-start\n", stderr: "" }
						: { code: 0, stdout: " M a.ts\n?? b.ts\n", stderr: "" },
			}),
		);
		expect(out.status).toBe("ready");
		expect(out.detail).toBe("hiv-1969-readiness-fast-start · 2 changed");
	});

	it("omits the count on a clean tree", async () => {
		const out = await repoProbe(
			deps({
				exec: async (_file, args) =>
					args.includes("--abbrev-ref") ? { code: 0, stdout: "main\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
			}),
		);
		expect(out.detail).toBe("main");
	});

	it("is unknown outside a checkout", async () => {
		const out = await repoProbe(deps());
		expect(out.status).toBe("unknown");
	});
});
