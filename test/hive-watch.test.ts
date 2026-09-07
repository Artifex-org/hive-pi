/**
 * The Hive/Linear data layer behind the footer. These cover the places where a
 * wrong answer would look completely plausible on screen:
 *
 *   - pipelineFacts picking the wrong pipeline, or counting superseded runs
 *   - buildOrFilter's nesting, where the wrong shape returns EVERY team issue
 *   - extractIssueKeys turning `fix/utf-8` into a ticket lookup
 *
 * ...and the one where nothing looks wrong on screen at all: the refresh rate.
 * A footer refreshing every 1.5s per session is indistinguishable from a correct
 * one until N sessions have flattened the control plane between them (HIV-3313),
 * so the gap, the coalescing and the backoff are asserted here in request counts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BACKOFF_BASE_MS,
	MIN_REFRESH_GAP_MS,
	NETWORK_BACKOFF_MAX_MS,
	backoffPlan,
	credentialsFromEnv,
	HiveWatcher,
	mapRun,
	matchesProject,
	pickMine,
	pipelineFacts,
	pollDelayMs,
	sameTarget,
} from "../extensions/status-footer/hive.ts";
import {
	buildOrFilter,
	extractIssueKeys,
	type LinearIssue,
	mergeIssues,
	tokenFromEnv,
} from "../extensions/status-footer/linear.ts";
import { parsePullView, repoNameFromRemote, sameWorkspace } from "../extensions/status-footer/workspace.ts";

describe("repoNameFromRemote", () => {
	it("handles both remote spellings and strips .git", () => {
		expect(repoNameFromRemote("git@github.com:Artifex-org/hive-pi.git")).toBe("hive-pi");
		expect(repoNameFromRemote("https://github.com/Artifex-org/hive-pi")).toBe("hive-pi");
		expect(repoNameFromRemote("https://github.com/Artifex-org/hive-pi/")).toBe("hive-pi");
		expect(repoNameFromRemote("")).toBeNull();
	});
});

describe("parsePullView", () => {
	it("reads a pull request and treats a missing one as no PR", () => {
		expect(parsePullView('{"number":2419,"url":"https://x/pull/2419","title":"HIV-1067 fix"}')).toEqual({
			pr: 2419,
			prUrl: "https://x/pull/2419",
			prTitle: "HIV-1067 fix",
		});
		// `gh pr view` fails outside a PR branch, so the caller passes null.
		expect(parsePullView(null)).toEqual({ pr: null, prUrl: null, prTitle: null });
		expect(parsePullView("not json")).toEqual({ pr: null, prUrl: null, prTitle: null });
		expect(parsePullView("{}")).toEqual({ pr: null, prUrl: null, prTitle: null });
	});
});

describe("sameWorkspace", () => {
	const base = { cwd: "/w", repo: "hive", branch: "main", pr: 1, prUrl: null, prTitle: null };
	it("notices a new PR on the same branch", () => {
		expect(sameWorkspace(base, { ...base })).toBe(true);
		expect(sameWorkspace(base, { ...base, pr: 2 })).toBe(false);
		expect(sameWorkspace(base, { ...base, branch: "other" })).toBe(false);
	});
	it("ignores PR metadata that does not change the watch target", () => {
		expect(sameWorkspace(base, { ...base, prTitle: "retitled" })).toBe(true);
	});
});

describe("credentials", () => {
	it("treats blank or missing environment as unconfigured", () => {
		expect(credentialsFromEnv({ HIVE_URL: "https://h", HIVE_TOKEN: "t" })).toEqual({ url: "https://h", token: "t" });
		expect(credentialsFromEnv({ HIVE_URL: "https://h/", HIVE_TOKEN: "t" })?.url).toBe("https://h");
		expect(credentialsFromEnv({ HIVE_URL: "https://h" })).toBeNull();
		expect(credentialsFromEnv({ HIVE_URL: "  ", HIVE_TOKEN: "t" })).toBeNull();
		expect(tokenFromEnv({})).toBeNull();
		expect(tokenFromEnv({ LINEAR_API_TOKEN: "lin" })).toBe("lin");
	});
});

describe("mapRun", () => {
	it("keeps only the summary fields and drops the dag snapshot", () => {
		const run = mapRun({
			id: "r1",
			number: 12,
			state: "running",
			pipeline: "ci",
			branch: "feature",
			pr: 8107,
			is_factory: false,
			tasks_summary: { total: 9, succeeded: 2, failed: 0, running: 2, pending: 5, skipped: 0 },
			tests_summary: { total: 273, passed: 273, failed: 0 },
			created_at: "2026-08-05T14:00:00Z",
			// A real response also carries ~14 KB of dag_snapshot here.
		});
		expect(run).not.toBeNull();
		expect(Object.keys(run as object)).not.toContain("dag_snapshot");
		expect(run?.tasks).toEqual({ total: 9, succeeded: 2, failed: 0, running: 2, pending: 5 });
		expect(run?.tests).toEqual({ total: 273, passed: 273, failed: 0 });
	});

	it("rejects a run without the fields the footer needs", () => {
		expect(mapRun({ number: 1, state: "running" })).toBeNull();
		expect(mapRun({ id: "r", state: "running" })).toBeNull();
	});

	it("survives a run with no task or test summary yet", () => {
		const run = mapRun({ id: "r", number: 1, state: "pending", tasks_summary: null, tests_summary: null });
		expect(run?.tasks).toBeNull();
		expect(run?.tests).toBeNull();
	});
});

describe("pipelineFacts", () => {
	const history = (...states: string[]) => states.map((state) => ({ state }));

	it("prefers the ci pipeline and reads its default branch", () => {
		const facts = pipelineFacts([
			{ pipeline: "e2e", default_branch: "feature", runs: 9000, history: history("failed") },
			{ pipeline: "ci", default_branch: "feature", runs: 10, history: history("succeeded", "failed") },
		]);
		expect(facts.gate).toBe("ci");
		expect(facts.defaultBranch).toBe("feature");
		expect(facts.health).toEqual({ passed: 1, total: 2 });
	});

	it("ignores ad-hoc bookkeeping pipelines, which outrank real ones on run count", () => {
		const facts = pipelineFacts([
			{ pipeline: "__template__", default_branch: "feature", runs: 1204, ad_hoc: true, history: history("succeeded") },
			{ pipeline: "__image__", default_branch: "feature", runs: 845, ad_hoc: true, history: history("succeeded") },
			{ pipeline: "gate", default_branch: "feature", runs: 30, history: history("succeeded") },
		]);
		expect(facts.gate).toBe("gate");
	});

	it("excludes canceled runs from health — a superseded run is not a verdict", () => {
		const facts = pipelineFacts([
			{ pipeline: "ci", default_branch: "main", runs: 5, history: history("succeeded", "canceled", "canceled", "failed") },
		]);
		expect(facts.health).toEqual({ passed: 1, total: 2 });
	});

	it("reports no health rather than 0/0 when nothing has finished", () => {
		expect(pipelineFacts([{ pipeline: "ci", runs: 1, history: history("canceled") }]).health).toBeNull();
		expect(pipelineFacts([]).gate).toBeNull();
	});
});

describe("pickMine", () => {
	const run = (id: string, state: string, isFactory = false, createdAt = "2026-08-05T10:00:00Z") =>
		mapRun({ id, number: 1, state, pipeline: isFactory ? "fix" : "ci", is_factory: isFactory, created_at: createdAt })!;

	it("tracks the run that is still moving", () => {
		expect(pickMine([run("a", "succeeded"), run("b", "running")])?.id).toBe("b");
	});

	it("prefers the gate over the autofix agent working on the same PR", () => {
		expect(pickMine([run("fix", "running", true), run("ci", "running")])?.id).toBe("ci");
	});

	it("falls back to the newest finished run", () => {
		const picked = pickMine([
			run("old", "failed", false, "2026-08-05T09:00:00Z"),
			run("new", "succeeded", false, "2026-08-05T11:00:00Z"),
		]);
		expect(picked?.id).toBe("new");
	});

	it("has nothing to say about a branch with no runs", () => {
		expect(pickMine([])).toBeNull();
	});
});

describe("matchesProject", () => {
	it("only matches the project's own events", () => {
		expect(matchesProject('{"project":"hive","type":"task.running"}', "hive")).toBe(true);
		expect(matchesProject('{"project":"Aurora","type":"task.running"}', "hive")).toBe(false);
		// The cheap substring pre-check must not produce a false positive on its own.
		expect(matchesProject('{"project":"Aurora","branch":"hive-thing"}', "hive")).toBe(false);
		expect(matchesProject("not json but mentions hive", "hive")).toBe(false);
	});
});

describe("extractIssueKeys", () => {
	const teams = new Set(["HIV", "AUR", "BOR"]);

	it("finds keys in lowercase branch names and uppercases them", () => {
		expect(extractIssueKeys(["feature/hiv-1080"], teams)).toEqual(["HIV-1080"]);
	});

	it("does not treat every word-dash-number as a ticket", () => {
		// This is the whole reason the team-key set is fetched.
		expect(extractIssueKeys(["feature/add-2", "fix/utf-8", "release/v1-2"], teams)).toEqual([]);
	});

	it("dedupes across the branch and the PR title, keeping first-seen order", () => {
		expect(extractIssueKeys(["feature/aur-7062-7081-followups", "AUR-7062 and HIV-1080"], teams)).toEqual([
			"AUR-7062",
			"HIV-1080",
		]);
	});

	it("normalises leading zeros so the API filter matches", () => {
		expect(extractIssueKeys(["hiv-0042"], teams)).toEqual(["HIV-42"]);
	});

	it("caps how many keys one branch name can produce", () => {
		const many = Array.from({ length: 20 }, (_, i) => `hiv-${i + 1}`).join(" ");
		expect(extractIssueKeys([many], teams)).toHaveLength(8);
	});

	it("ignores empty inputs", () => {
		expect(extractIssueKeys([null, undefined, ""], teams)).toEqual([]);
	});
});

describe("buildOrFilter", () => {
	it("nests team and number under `and` inside each `or` branch", () => {
		// The flat {team, number} sibling form is ACCEPTED by Linear and then
		// silently ignores the number, returning every issue on the team.
		expect(buildOrFilter(["HIV-1075", "AUR-7055"])).toEqual({
			or: [
				{ and: [{ team: { key: { eq: "HIV" } } }, { number: { eq: 1075 } }] },
				{ and: [{ team: { key: { eq: "AUR" } } }, { number: { eq: 7055 } }] },
			],
		});
	});

	it("returns null rather than an empty filter that would match everything", () => {
		expect(buildOrFilter([])).toBeNull();
		expect(buildOrFilter(["nonsense"])).toBeNull();
	});
});

describe("mergeIssues", () => {
	const issue = (identifier: string, stateType: LinearIssue["stateType"], source: LinearIssue["source"]): LinearIssue => ({
		identifier,
		title: identifier,
		url: "",
		stateName: stateType,
		stateType,
		assignee: null,
		priority: 0,
		source,
	});

	it("prefers the attachment when the same ticket is also parsed from the branch", () => {
		const merged = mergeIssues([issue("HIV-1", "started", "attachment")], [issue("HIV-1", "started", "key")]);
		expect(merged).toHaveLength(1);
		expect(merged[0].source).toBe("attachment");
	});

	it("puts work in progress first and finished work last", () => {
		const merged = mergeIssues(
			[],
			[issue("HIV-3", "completed", "key"), issue("HIV-1", "backlog", "key"), issue("HIV-2", "started", "key")],
		);
		expect(merged.map((i) => i.identifier)).toEqual(["HIV-2", "HIV-1", "HIV-3"]);
	});
});

/**
 * A fake Hive: the endpoints the watcher reads, plus a controllable SSE stream,
 * so a test can fire fleet events the way a busy project does — several a
 * second, all naming the same project — and can hold a request open to put the
 * watcher into the states that only exist mid-refresh.
 */
function fakeHive() {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const encoder = new TextEncoder();
	let failure: { status: number; headers: Record<string, string> } | null = null;
	let crash = false;
	let holding = false;
	let held: Array<() => void> = [];
	let events: ReadableStreamDefaultController<Uint8Array> | null = null;
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	const headersOf = (init?: RequestInit): Record<string, string> =>
		Object.fromEntries(
			Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
		);

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			calls.push({ url, headers: headersOf(init) });
			if (url.includes("/api/v1/events")) {
				// Yields only what a test pushes, so the stream stays open until a test closes it.
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							events = controller;
						},
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/api/v1/projects")) return json({ projects: [{ name: "pyERP" }] });
			if (url.includes("/api/v1/pipelines")) {
				return json({
					pipelines: [{ pipeline: "ci", default_branch: "feature", runs: 12, history: [{ state: "succeeded" }] }],
				});
			}
			if (url.includes("/api/v1/runs")) {
				if (holding) await new Promise<void>((resolve) => held.push(resolve));
				if (crash) throw new TypeError("fetch failed");
				if (failure) return new Response("{}", { status: failure.status, headers: failure.headers });
				return json({ runs: [] });
			}
			throw new Error(`unexpected request: ${url}`);
		}),
	);

	return {
		/** Every refresh reads the active runs exactly once, so this counts refreshes. */
		refreshes: () => calls.filter((call) => call.url.includes("status=running")).length,
		streams: () => calls.filter((call) => call.url.includes("/api/v1/events")),
		fail: (status: number, headers: Record<string, string> = {}) => {
			failure = { status, headers };
		},
		crash: () => {
			crash = true;
		},
		heal: () => {
			failure = null;
			crash = false;
		},
		/** Hold every subsequent run read open, so a refresh can be observed mid-flight. */
		hold: () => {
			holding = true;
		},
		release: () => {
			holding = false;
			for (const resolve of held) resolve();
			held = [];
		},
		event: () => events?.enqueue(encoder.encode('id: 42\ndata: {"project":"pyERP","type":"task.running"}\n\n')),
		endStream: () => {
			events?.close();
			events = null;
		},
	};
}

/** Drain the watcher's promise chains without moving the clock. */
async function settle(): Promise<void> {
	for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(0);
}

describe("HiveWatcher refresh limiting", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	/**
	 * A watcher pointed at pyERP and left quiet: the initial refresh and the one
	 * the stream's connection asks for have both landed, and nothing is armed.
	 * Tests assert against `base` because that settling cost is bookkeeping, not
	 * the behaviour under test.
	 */
	async function watching() {
		const server = fakeHive();
		const seen: Array<{ status: string; project: string | null }> = [];
		const watcher: HiveWatcher = new HiveWatcher(
			() => seen.push({ status: watcher.get().status, project: watcher.get().project }),
			{ url: "https://hive.example", token: "t" },
		);
		watcher.retarget({ repo: "pyERP", branch: "feature", pr: null });
		await settle();
		await vi.advanceTimersByTimeAsync(2 * MIN_REFRESH_GAP_MS);
		return { server, watcher, seen, base: server.refreshes() };
	}

	it("collapses a burst of fleet events into exactly one trailing refresh", async () => {
		const { server, watcher, base } = await watching();

		// The gap since the last refresh has elapsed, so this one goes now.
		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);

		for (let i = 0; i < 25; i += 1) server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);

		// One — the events must still reach the screen — and only one.
		await vi.advanceTimersByTimeAsync(MIN_REFRESH_GAP_MS);
		expect(server.refreshes()).toBe(base + 2);

		await vi.advanceTimersByTimeAsync(10 * MIN_REFRESH_GAP_MS);
		expect(server.refreshes()).toBe(base + 2);
		watcher.stop();
	});

	it("backs off on a 503, waits out its Retry-After, and resets on the next success", async () => {
		const { server, watcher, base } = await watching();
		server.fail(503, { "retry-after": "40" });

		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);
		expect(watcher.get().status).toBe("error");
		expect(watcher.get().error).toBe("http_503");
		expect(watcher.get().retryAt).toBe(Date.now() + 40_000);

		// Events during the backoff are recorded, not sent.
		for (let i = 0; i < 5; i += 1) server.event();
		await vi.advanceTimersByTimeAsync(39_000);
		expect(server.refreshes()).toBe(base + 1);

		server.heal();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(server.refreshes()).toBe(base + 2);
		expect(watcher.get().status).toBe("ok");
		expect(watcher.get().retryAt).toBeNull();

		// Reset: the next event waits the ordinary gap, not a doubled backoff.
		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 2);
		await vi.advanceTimersByTimeAsync(MIN_REFRESH_GAP_MS);
		expect(server.refreshes()).toBe(base + 3);
		watcher.stop();
	});

	// The 503 was only ever half the symptom: an ingress answering for an
	// unpublished backend returns 502 or 504 just as readily.
	it.each([502, 503, 504, 429])("treats %i as push-back", async (status) => {
		const { server, watcher, base } = await watching();
		server.fail(status);

		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);
		expect(watcher.get().retryAt).not.toBeNull();
		watcher.stop();
	});

	it("does not back off from a 404, which waiting cannot fix", async () => {
		const { server, watcher, base } = await watching();
		server.fail(404);

		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);
		expect(watcher.get().status).toBe("error");
		expect(watcher.get().error).toBe("http_404");
		expect(watcher.get().retryAt).toBeNull();
		watcher.stop();
	});

	it("backs off from a request that got no answer at all", async () => {
		const { server, watcher } = await watching();
		server.crash();

		server.event();
		await settle();
		expect(watcher.get().status).toBe("error");
		expect(watcher.get().error).toBe("TypeError");
		expect(watcher.get().retryAt).not.toBeNull();
		watcher.stop();
	});

	// The countdown on screen is a promise, and this is the whole of what keeps
	// it: no event arrives, and the backstop poll is not even started.
	it("arms its own retry, and it fires exactly when the countdown says", async () => {
		const { server, watcher, base } = await watching();
		server.fail(503);

		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);

		const due = watcher.get().retryAt ?? 0;
		expect(due).toBeGreaterThan(Date.now());
		// The rendered wait is the gap here, not the sub-5s backoff underneath it:
		// showing the shorter one would reach zero and then wait again.
		expect(due).toBeGreaterThanOrEqual(Date.now() + BACKOFF_BASE_MS);

		await vi.advanceTimersByTimeAsync(due - Date.now() - 1);
		expect(server.refreshes()).toBe(base + 1);
		await vi.advanceTimersByTimeAsync(1);
		expect(server.refreshes()).toBe(base + 2);
		watcher.stop();
	});

	it("lets a workspace change replace the trailing refresh, not queue behind it", async () => {
		const { server, watcher, base } = await watching();
		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);

		// Arms the trailing refresh, 15s out.
		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);

		watcher.retarget({ repo: "pyERP", branch: "other", pr: null });
		await settle();
		expect(server.refreshes()).toBe(base + 2);
		watcher.stop();
	});

	it("drops an answer a retarget has outdated rather than painting it over the reset", async () => {
		const { server, watcher, seen } = await watching();
		server.hold();
		server.event();
		await settle();

		watcher.retarget({ repo: "other-repo", branch: "x", pr: null });
		seen.length = 0;
		server.release();
		await settle();

		// The held answer was about pyERP; nothing may report it after the move.
		expect(seen.some((snapshot) => snapshot.project === "pyERP")).toBe(false);
		expect(watcher.get().status).toBe("foreign");
		watcher.stop();
	});

	it("does not drop an event that arrived while a refresh was running", async () => {
		const { server, watcher, base } = await watching();
		server.hold();
		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);

		// The gap elapses while that refresh is still open, and another event lands.
		await vi.advanceTimersByTimeAsync(MIN_REFRESH_GAP_MS + 1_000);
		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);

		server.release();
		await settle();
		expect(server.refreshes()).toBe(base + 2);
		watcher.stop();
	});

	it("serves /hive past the gap, joins a running refresh, and adds nothing while backing off", async () => {
		const { server, watcher, base } = await watching();
		server.event();
		await settle();
		expect(server.refreshes()).toBe(base + 1);

		// Inside the gap, but a person asked.
		await watcher.refreshNow();
		expect(server.refreshes()).toBe(base + 2);

		server.hold();
		const first = watcher.refreshNow();
		const second = watcher.refreshNow();
		await settle();
		expect(server.refreshes()).toBe(base + 3);
		server.release();
		await settle();
		await Promise.all([first, second]);

		server.fail(503);
		await watcher.refreshNow();
		const during = server.refreshes();
		await watcher.refreshNow();
		expect(server.refreshes()).toBe(during);
		watcher.stop();
	});

	it("subscribes to this project's events only, and resumes from the last id it saw", async () => {
		const { server, watcher } = await watching();
		const first = server.streams()[0];
		expect(first.url).toContain("project=pyERP");
		expect(first.headers["last-event-id"]).toBeUndefined();

		server.event();
		await settle();
		server.endStream();
		await vi.advanceTimersByTimeAsync(10_000);

		const second = server.streams()[1];
		expect(second).toBeDefined();
		expect(second.url).toContain("project=pyERP");
		expect(second.headers["last-event-id"]).toBe("42");
		watcher.stop();
	});
});

describe("sameTarget", () => {
	const target = { repo: "pyERP", branch: "feature", pr: 1 };

	it("notices every move the footer watches", () => {
		expect(sameTarget(target, { ...target })).toBe(true);
		expect(sameTarget(target, { ...target, branch: "other" })).toBe(false);
		expect(sameTarget(target, { ...target, pr: 2 })).toBe(false);
		expect(sameTarget(target, { ...target, repo: "hive" })).toBe(false);
	});
});

describe("backoffPlan", () => {
	/** The full-jitter draw at its ceiling — the slowest wait a given step can produce. */
	const worst = () => 1;

	it("doubles from 5s and stops at 5 minutes", () => {
		expect(backoffPlan(0, null, undefined, worst)).toEqual({ ceiling: 5_000, delay: 5_000 });
		expect(backoffPlan(5_000, null, undefined, worst).delay).toBe(10_000);
		expect(backoffPlan(160_000, null, undefined, worst).ceiling).toBe(300_000);
		expect(backoffPlan(300_000, null, undefined, worst).ceiling).toBe(300_000);
	});

	// A failure this machine caused says nothing about the server's load, so it
	// must not park the footer behind a five-minute countdown.
	it("caps a client-side failure at a minute", () => {
		expect(backoffPlan(40_000, null, NETWORK_BACKOFF_MAX_MS, worst).ceiling).toBe(60_000);
		expect(backoffPlan(60_000, null, NETWORK_BACKOFF_MAX_MS, worst).ceiling).toBe(60_000);
	});

	it("draws from [0, ceiling], so sessions that failed together do not return together", () => {
		expect(backoffPlan(20_000, null, undefined, () => 0).delay).toBe(0);
		expect(backoffPlan(20_000, null, undefined, () => 0.5).delay).toBe(20_000);
	});

	it("never returns sooner than the server asked, and never later than the ceiling needs", () => {
		expect(backoffPlan(0, 40_000, undefined, () => 0).delay).toBe(40_000);
		expect(backoffPlan(0, 1_000, undefined, worst).delay).toBe(5_000);
	});
});

describe("pollDelayMs", () => {
	it("spreads the backstop poll ±20% so sessions do not re-align into a herd", () => {
		expect(pollDelayMs(() => 0)).toBe(48_000);
		expect(pollDelayMs(() => 1)).toBe(72_000);
		expect(pollDelayMs(() => 0.5)).toBe(60_000);
		for (const draw of [0.13, 0.37, 0.61, 0.94]) {
			const delay = pollDelayMs(() => draw);
			expect(delay).toBeGreaterThanOrEqual(48_000);
			expect(delay).toBeLessThanOrEqual(72_000);
		}
	});
});
