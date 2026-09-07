/**
 * status-footer — Hive client.
 *
 * Answers three questions about the repo in the cwd, live:
 *   1. what is my branch/PR's run doing right now?
 *   2. what else is this project running?
 *   3. is the project healthy — is trunk green, what is the recent pass rate?
 *
 * Liveness comes from the server's event feed, subscribed NARROWED to this
 * project (`/api/v1/events?project=…`) and resumed with `Last-Event-ID`: an
 * event nudges a refetch. The periodic poll is only a backstop for a dropped
 * stream, which is why its interval is long.
 *
 * Refreshes are RATE LIMITED, and that is load-bearing rather than tidiness. One
 * watcher per session, a fleet feed that fires several times a second on a busy
 * project, and no floor between refetches turned every session into a refresh
 * every ~1.5-2s: 112,300 identical `GET /runs?project=…&status=running` in 14
 * hours, enough to flap the control plane's readiness (HIV-3313). So every
 * trigger goes through `requestRefresh`, a burst inside one gap collapses into a
 * single trailing refresh, and a server (or the ingress in front of it) that
 * answers 429/502/503/504 gets exponential backoff with full jitter instead of
 * the same load it just refused.
 *
 * Every response is mapped to a narrow type at the boundary. That is deliberate:
 * a run object carries its whole `dag_snapshot` (~14 KB), and holding a few of
 * those in a footer that redraws on a timer is exactly the kind of retained
 * garbage nobody ever finds.
 *
 * The GET path is hive-common's `request`, shared with every other Hive-facing
 * extension: timeouts, the 4xx/5xx classification, `Retry-After` and error
 * redaction are decided in one place. Only the SSE stream is local, because
 * `request` is a JSON call and this is a long-lived byte stream.
 */

import { type HiveAuth, type RequestResult, parseRetryAfterMs, redact, request } from "../hive-common/http.ts";

const PROJECTS_TTL_MS = 15 * 60_000;
const PIPELINES_TTL_MS = 5 * 60_000;
const TRUNK_TTL_MS = 3 * 60_000;
const REQUEST_TIMEOUT_MS = 6_000;
/** Backstop only — SSE is the primary trigger. */
export const POLL_INTERVAL_MS = 60_000;
/**
 * Spread of the backstop poll, ±20%. Sessions start together — a fleet restart,
 * a reconnect after an outage — and a fixed interval keeps them aligned forever
 * after, so N sessions hit the same second of every minute. The jitter is drawn
 * again on every tick, so a herd disperses rather than merely shifting.
 */
export const POLL_JITTER_RATIO = 0.2;
/**
 * No two refreshes closer together than this, whoever asks.
 *
 * The footer shows fleet and branch state to a human reading a status bar: a
 * 15s-old answer is indistinguishable from a fresh one at that glance, and the
 * SSE `live` patch still lands instantly. What the gap costs is nothing anybody
 * can see; what it buys is a hard ceiling of four reads a minute per session.
 */
export const MIN_REFRESH_GAP_MS = 15_000;
/** First wait after the server pushes back; doubles per consecutive failure. */
export const BACKOFF_BASE_MS = 5_000;
/** Ceiling for that doubling — a server in trouble is still checked every 5 minutes. */
export const BACKOFF_MAX_MS = 5 * 60_000;
/**
 * Ceiling for a failure this machine caused — DNS, a refused connection, a
 * sleeping laptop's network. That is no evidence about the server's load, so it
 * does not earn the five-minute curve: otherwise a laptop that slept for ten
 * minutes wakes up showing "retry 4m" beside a perfectly healthy stream.
 */
export const NETWORK_BACKOFF_MAX_MS = 60_000;
/** Floor for a stream reconnect, so a server refusing instantly cannot become a tight loop. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const ACTIVE_LIMIT = 20;

export type RunState = "pending" | "evaluating" | "running" | "succeeded" | "failed" | "canceled" | "error";

const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "canceled", "error"]);
export const isTerminal = (state: string): boolean => TERMINAL.has(state);

export interface HiveTaskCounts {
	total: number;
	succeeded: number;
	failed: number;
	running: number;
	pending: number;
}

export interface HiveRun {
	id: string;
	number: number;
	state: RunState;
	pipeline: string;
	branch: string;
	pr: number | null;
	isFactory: boolean;
	tasks: HiveTaskCounts | null;
	tests: { total: number; passed: number; failed: number } | null;
	createdAt: string;
}

export interface HiveSnapshot {
	/** off: no credentials. unresolved: not looked up yet. foreign: repo is not a Hive project. */
	status: "off" | "unresolved" | "foreign" | "ok" | "error";
	project: string | null;
	defaultBranch: string | null;
	/** The newest run for the current PR, or for the current branch when there is no PR. */
	mine: HiveRun | null;
	/** Everything the project currently has in flight, mine included. */
	active: HiveRun[];
	/** The newest FINISHED run on the default branch — the "is trunk red" answer. */
	trunk: HiveRun | null;
	trunkActive: boolean;
	health: { passed: number; total: number } | null;
	/** True while the SSE stream is connected. */
	live: boolean;
	error: string | null;
	/** When the next attempt is due while backing off from a server that pushed back; null otherwise. */
	retryAt: number | null;
}

export const OFFLINE_HIVE: HiveSnapshot = {
	status: "off",
	project: null,
	defaultBranch: null,
	mine: null,
	active: [],
	trunk: null,
	trunkActive: false,
	health: null,
	live: false,
	error: null,
	retryAt: null,
};

/** The same `{url, token}` pair every other Hive-facing extension passes to hive-common. */
export type HiveCredentials = HiveAuth;

/**
 * credentialsFromEnv reads HIVE_URL/HIVE_TOKEN — the same pair `hive doctor`
 * checks. Absent credentials are not an error: the segment simply does not
 * render, so a machine without Hive access sees the footer it had before.
 */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): HiveCredentials | null {
	const url = (env.HIVE_URL ?? "").trim().replace(/\/+$/, "");
	const token = (env.HIVE_TOKEN ?? "").trim();
	if (!url || !token) return null;
	return { url, token };
}

interface RawRun {
	id?: string;
	number?: number;
	state?: string;
	pipeline?: string;
	branch?: string;
	pr?: number | null;
	is_factory?: boolean;
	tasks_summary?: Record<string, number> | null;
	tests_summary?: { total?: number; passed?: number; failed?: number } | null;
	created_at?: string;
}

const count = (summary: Record<string, number> | null | undefined, key: string): number =>
	typeof summary?.[key] === "number" ? summary[key] : 0;

export function mapRun(raw: RawRun): HiveRun | null {
	if (!raw?.id || typeof raw.number !== "number" || !raw.state) return null;
	const summary = raw.tasks_summary ?? null;
	return {
		id: raw.id,
		number: raw.number,
		state: raw.state as RunState,
		pipeline: raw.pipeline ?? "?",
		branch: raw.branch ?? "",
		pr: typeof raw.pr === "number" ? raw.pr : null,
		isFactory: raw.is_factory === true,
		tasks: summary
			? {
					total: count(summary, "total"),
					succeeded: count(summary, "succeeded"),
					failed: count(summary, "failed"),
					running: count(summary, "running"),
					pending: count(summary, "pending"),
				}
			: null,
		tests:
			raw.tests_summary && typeof raw.tests_summary.total === "number"
				? {
						total: raw.tests_summary.total,
						passed: raw.tests_summary.passed ?? 0,
						failed: raw.tests_summary.failed ?? 0,
					}
				: null,
		createdAt: raw.created_at ?? "",
	};
}

interface RawPipeline {
	pipeline?: string;
	default_branch?: string;
	runs?: number;
	ad_hoc?: boolean;
	history?: Array<{ state?: string }>;
}

export interface PipelineFacts {
	defaultBranch: string | null;
	/** The pipeline the project's health is judged by — its PR/trunk gate. */
	gate: string | null;
	health: { passed: number; total: number } | null;
}

/**
 * pipelineFacts picks the gate pipeline and reads its recent history.
 *
 * "ci" by convention, falling back to the busiest non-ad-hoc pipeline so a
 * project that names its gate differently still gets a health number rather than
 * a blank. `__template__`/`__image__` are ad-hoc bookkeeping pipelines and would
 * otherwise win on run count by a wide margin.
 *
 * Canceled runs are excluded from the denominator: a run canceled because a
 * newer commit superseded it is not evidence about the project's health, and on
 * a busy repo they outnumber the real results.
 */
export function pipelineFacts(raw: RawPipeline[]): PipelineFacts {
	const usable = raw.filter((p) => p.pipeline && p.ad_hoc !== true);
	const gate =
		usable.find((p) => p.pipeline === "ci") ??
		usable.slice().sort((a, b) => (b.runs ?? 0) - (a.runs ?? 0))[0] ??
		null;
	if (!gate) return { defaultBranch: null, gate: null, health: null };

	const history = gate.history ?? [];
	const judged = history.filter((h) => h.state === "succeeded" || h.state === "failed" || h.state === "error");
	return {
		defaultBranch: gate.default_branch ?? null,
		gate: gate.pipeline ?? null,
		health: judged.length > 0 ? { passed: judged.filter((h) => h.state === "succeeded").length, total: judged.length } : null,
	};
}

/**
 * HiveRequestError carries hive-common's whole `RequestResult` through the
 * throw.
 *
 * `refreshOnce` reads four endpoints, two of them inside one `Promise.all`;
 * threading a result object out of every call site would mean a branch per call
 * and a hand-rolled "which one failed" aggregation. So the client throws, and
 * the single catch in the watcher receives the classified result — numeric
 * status, redacted message, the server's `Retry-After` — instead of a string it
 * would have to parse back into a decision.
 */
export class HiveRequestError extends Error {
	constructor(readonly result: RequestResult) {
		super(describeFailure(result));
		this.name = "HiveRequestError";
	}
}

/**
 * describeFailure is what a status-bar row can hold. A status is short, stable
 * and carries nothing secret, so it is shown as-is; Hive's own problem+json
 * `detail` can be a whole sentence and would push every other segment off the
 * row. A thrown fetch error never reaches here unredacted — hive-common keeps
 * only its name, because the URL it embeds can carry a token.
 */
export function describeFailure(result: RequestResult): string {
	return result.status === null ? (result.error ?? "error") : `http_${result.status}`;
}

/**
 * BACKPRESSURE_STATUS is the server, or the ingress in front of it, saying "not
 * now". 502 and 504 belong here as squarely as 503: in the readiness flap this
 * whole change answers, Traefik replied for an unpublished backend, and which
 * status a client saw came down to which side gave up first.
 */
const BACKPRESSURE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** A request that got no answer at all is push-back too: the server may simply be gone. */
function isBackpressure(result: RequestResult): boolean {
	return result.status === null || BACKPRESSURE_STATUS.has(result.status);
}

/** How far a failure of this kind may escalate — see NETWORK_BACKOFF_MAX_MS. */
function maxCeilingFor(result: RequestResult): number {
	return result.status === null ? NETWORK_BACKOFF_MAX_MS : BACKOFF_MAX_MS;
}

/**
 * backoffPlan computes the wait after a failure, and the ceiling to double from
 * next time.
 *
 * Full jitter — a uniform draw from [0, ceiling] rather than the ceiling itself —
 * because every session hammering that endpoint failed in the same second: a
 * deterministic backoff sends them all back in one wave, which is the load that
 * caused the failure. The draw may land near zero, which is safe because
 * MIN_REFRESH_GAP_MS still applies on top of it. `Retry-After` wins whenever it
 * asks for longer; the server knows more than this heuristic does.
 */
export function backoffPlan(
	previousCeilingMs: number,
	retryAfterMs: number | null,
	maxCeilingMs: number = BACKOFF_MAX_MS,
	random: () => number = Math.random,
): { ceiling: number; delay: number } {
	const ceiling = Math.min(previousCeilingMs === 0 ? BACKOFF_BASE_MS : previousCeilingMs * 2, maxCeilingMs);
	return { ceiling, delay: Math.max(retryAfterMs ?? 0, ceiling * random()) };
}

/** pollDelayMs is the backstop interval with its jitter applied. */
export function pollDelayMs(random: () => number = Math.random): number {
	return Math.round(POLL_INTERVAL_MS * (1 + (random() * 2 - 1) * POLL_JITTER_RATIO));
}

export class HiveClient {
	constructor(private readonly credentials: HiveCredentials) {}

	get baseUrl(): string {
		return this.credentials.url;
	}

	private headers(accept = "application/json"): Record<string, string> {
		return { Authorization: `Bearer ${this.credentials.token}`, Accept: accept };
	}

	/**
	 * get reads one endpoint through hive-common's `request` and throws
	 * HiveRequestError on anything that is not a usable answer, so the watcher
	 * has one place to classify a failure.
	 */
	private async get<T>(pathAndQuery: string): Promise<T> {
		const result = await request<T>(this.credentials, "GET", pathAndQuery, undefined, REQUEST_TIMEOUT_MS);
		if (!result.ok) throw new HiveRequestError(result);
		if (result.body === undefined) {
			// `request` counts a 2xx whose body did not parse as a success with no
			// body — right for a write nobody reads the response of, wrong here:
			// each of these endpoints IS its body. A body that died between the
			// headers and the last byte (a reset, or the timeout landing mid-read)
			// would otherwise be reported to the user as "nothing running", and to
			// the limiter as a success worth refreshing again in 15s.
			throw new HiveRequestError({
				ok: false,
				status: null,
				authFailed: false,
				permanent: false,
				retryAfterMs: null,
				error: "truncated",
			});
		}
		return result.body;
	}

	async listProjects(): Promise<string[]> {
		const body = await this.get<{ projects?: Array<{ name?: string }> }>("/projects");
		return (body.projects ?? []).map((p) => p.name).filter((n): n is string => Boolean(n));
	}

	async pipelines(project: string): Promise<PipelineFacts> {
		const body = await this.get<{ pipelines?: RawPipeline[] }>(`/pipelines?project=${encodeURIComponent(project)}`);
		return pipelineFacts(body.pipelines ?? []);
	}

	async runs(query: Record<string, string | number>): Promise<HiveRun[]> {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) search.set(key, String(value));
		const body = await this.get<{ runs?: RawRun[] }>(`/runs?${search.toString()}`);
		return (body.runs ?? []).map(mapRun).filter((r): r is HiveRun => r !== null);
	}

	/**
	 * streamEvents follows the server's event feed, NARROWED to this project
	 * (`?project=`, exact match, HIV-812). The feed is fleet-wide by default: on
	 * a busy instance that is every other project's task transitions, decoded and
	 * discarded by every session that has one open. The client-side
	 * `matchesProject` check stays anyway, so a server that ignores the parameter
	 * degrades to the old behaviour instead of a storm of foreign nudges.
	 *
	 * `Last-Event-ID` resumes where the previous connection stopped — the ids are
	 * a monotonic sequence — so the run that finished during a reconnect is
	 * delivered rather than missed.
	 *
	 * Reconnects until the signal aborts, with the same manners as the refresh
	 * path: jittered, and honouring `Retry-After`. A control plane that just
	 * dropped every stream it was serving is not helped by all of them coming
	 * back in the same second.
	 */
	async streamEvents(project: string, onEvent: () => void, onLive: (live: boolean) => void, signal: AbortSignal): Promise<void> {
		const url = `${this.credentials.url}/api/v1/events?project=${encodeURIComponent(project)}`;
		let ceiling = 0;
		let lastEventId: string | null = null;
		while (!signal.aborted) {
			let retryAfterMs: number | null = null;
			try {
				const headers = this.headers("text/event-stream");
				if (lastEventId !== null) headers["Last-Event-ID"] = lastEventId;
				const res = await fetch(url, { headers, signal });
				if (!res.ok || !res.body) {
					retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
					throw new Error(`http_${res.status}`);
				}

				onLive(true);
				ceiling = 0;
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				while (!signal.aborted) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					// Keep the trailing partial line for the next chunk.
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						// The cursor advances on the frame's id, not on whether we
						// acted on it: resuming from an id we skipped would replay it.
						if (line.startsWith("id:")) {
							lastEventId = line.slice(3).trim();
							continue;
						}
						if (!line.startsWith("data:")) continue;
						if (matchesProject(line.slice(5), project)) onEvent();
					}
					// A pathological server could stream without newlines; do not grow forever.
					if (buffer.length > 64_000) buffer = "";
				}
			} catch {
				// Any stream failure is a reconnect, not a report: the poll backstop
				// keeps the footer correct meanwhile.
			}
			onLive(false);
			if (signal.aborted) return;
			const plan = backoffPlan(ceiling, retryAfterMs, RECONNECT_MAX_MS);
			ceiling = plan.ceiling;
			await sleep(Math.max(plan.delay, RECONNECT_MIN_MS), signal);
		}
	}
}

/**
 * matchesProject checks an SSE data line without parsing it when it obviously
 * cannot match. The feed is global and busy, so most lines are for other
 * projects and a substring test saves a JSON.parse per event.
 */
export function matchesProject(data: string, project: string): boolean {
	if (!data.includes(project)) return false;
	try {
		return (JSON.parse(data) as { project?: string }).project === project;
	} catch {
		return false;
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}

export interface HiveTarget {
	repo: string | null;
	branch: string | null;
	pr: number | null;
}

/** Two targets name the same watch. Used to drop an answer a retarget has outdated. */
export function sameTarget(a: HiveTarget, b: HiveTarget): boolean {
	return a.repo === b.repo && a.branch === b.branch && a.pr === b.pr;
}

/**
 * HiveWatcher owns all Hive state for one session. It holds no module-level
 * state on purpose: pi builds a fresh jiti instance per extension with
 * moduleCache disabled, so a module singleton is not shared with anything —
 * every watcher instance must be self-contained.
 */
export class HiveWatcher {
	private snapshot: HiveSnapshot = { ...OFFLINE_HIVE };
	private target: HiveTarget = { repo: null, branch: null, pr: null };
	private readonly client: HiveClient | null;
	private controller: AbortController | null = null;
	/** The single trailing refresh a burst of triggers collapses into. */
	private pending: ReturnType<typeof setTimeout> | undefined;
	private poll: ReturnType<typeof setTimeout> | undefined;
	private inFlight = false;
	/** The running refresh, so a caller that needs its answer joins it instead of starting a second. */
	private current: Promise<void> | null = null;
	/** A trigger that arrived while a refresh was running, and whether it had earned the gap skip. */
	private queued: { skipGap: boolean } | null = null;
	private lastRefreshAt = 0;
	/**
	 * The ONE piece of backoff state. `snapshot.retryAt` is a projection of it,
	 * written only by `patch`, so what the countdown promises and what the timer
	 * does cannot drift apart.
	 */
	private backoff: { until: number; ceiling: number } | null = null;
	private projects: { names: string[]; at: number } | null = null;
	private facts: { value: PipelineFacts; at: number } | null = null;
	private trunkAt = 0;

	constructor(
		private readonly onChange: () => void,
		credentials: HiveCredentials | null = credentialsFromEnv(),
	) {
		this.client = credentials ? new HiveClient(credentials) : null;
		if (this.client) this.snapshot = { ...OFFLINE_HIVE, status: "unresolved" };
	}

	get(): HiveSnapshot {
		return this.snapshot;
	}

	get configured(): boolean {
		return this.client !== null;
	}

	get runUrlBase(): string | null {
		return this.client?.baseUrl ?? null;
	}

	/** Point the watcher at a workspace. Resets cached project facts when the repo changes. */
	retarget(target: HiveTarget): void {
		const repoChanged = target.repo !== this.target.repo;
		this.target = target;
		if (repoChanged) {
			this.facts = null;
			this.trunkAt = 0;
			this.snapshot = { ...OFFLINE_HIVE, status: this.client ? "unresolved" : "off", retryAt: this.retryAt };
			this.restartStream();
		}
		// A workspace change is a user action and what is on screen is now about the
		// wrong branch, so it skips the gap — but not a server that is pushing back.
		this.requestRefresh({ skipGap: true });
	}

	start(): void {
		if (!this.client || this.poll) return;
		this.schedulePoll();
	}

	stop(): void {
		if (this.poll) clearTimeout(this.poll);
		this.poll = undefined;
		if (this.pending) clearTimeout(this.pending);
		this.pending = undefined;
		this.queued = null;
		this.controller?.abort();
		this.controller = null;
	}

	/** The backstop re-arms itself with a fresh draw each tick — see POLL_JITTER_RATIO. */
	private schedulePoll(): void {
		this.poll = setTimeout(() => {
			this.schedulePoll();
			this.requestRefresh();
		}, pollDelayMs());
		this.poll.unref?.();
	}

	private restartStream(): void {
		this.controller?.abort();
		this.controller = null;
		const project = this.snapshot.project;
		if (!this.client || !project) return;
		const controller = new AbortController();
		this.controller = controller;
		void this.client.streamEvents(
			project,
			() => this.requestRefresh(),
			(live) => {
				this.patch({ live });
				// A (re)connection means some window went unwatched. `Last-Event-ID`
				// replays what the server still holds; a refresh covers the rest.
				// Through the normal gap — this is a correction, not an emergency.
				if (live) this.requestRefresh();
			},
			controller.signal,
		);
	}

	/**
	 * requestRefresh is the only way a refresh is ASKED for; `refresh` is the only
	 * way one happens. Every trigger — an SSE event, the backstop poll, a
	 * retarget — comes through here, so the rate limit holds however loud the
	 * trigger is.
	 *
	 * Any number of triggers inside one gap collapse into exactly ONE trailing
	 * refresh at the end of it. Not zero: the event that arrived still has to
	 * reach the screen, and dropping it is how a footer ends up 60s stale on a
	 * finished run. Not one per event: that is the load this exists to remove.
	 * While the server is pushing back the same trailing timer simply lands later,
	 * which is what "nudges are recorded but issue no request" means here.
	 */
	private requestRefresh(options: { skipGap?: boolean } = {}): void {
		if (!this.client) return;
		const skipGap = options.skipGap === true;
		if (this.inFlight) {
			// The running refresh may have read the server before this trigger
			// existed. Remember the skip too: a retarget queued behind a refresh is
			// still a user action when its turn comes.
			this.queued = { skipGap: (this.queued?.skipGap ?? false) || skipGap };
			return;
		}
		if (this.pending) {
			// A burst coalesces into the trailing refresh already armed — unless
			// this trigger may skip the gap, which then REPLACES that timer rather
			// than waiting behind it.
			if (!skipGap) return;
			clearTimeout(this.pending);
			this.pending = undefined;
		}
		const gapUntil = skipGap ? 0 : this.lastRefreshAt + MIN_REFRESH_GAP_MS;
		const wait = Math.max(gapUntil, this.backoff?.until ?? 0) - Date.now();
		if (wait <= 0) {
			void this.refresh();
			return;
		}
		this.pending = setTimeout(() => {
			this.pending = undefined;
			void this.refresh();
		}, wait);
		this.pending.unref?.();
	}

	/** The snapshot's view of `backoff` — the only way retryAt is ever written. */
	private get retryAt(): number | null {
		return this.backoff?.until ?? null;
	}

	private patch(patch: Partial<Omit<HiveSnapshot, "retryAt">>): void {
		this.snapshot = { ...this.snapshot, ...patch, retryAt: this.retryAt };
		this.onChange();
	}

	/**
	 * refreshNow is the person-asking path (`/hive`). It skips the gap — a
	 * 15s-old answer is not what somebody just asked for — but not a server that
	 * is pushing back: the overlay renders the countdown instead of adding to the
	 * load that caused it. It never starts a second refresh beside a running one;
	 * it joins that one, so the overlay opens on the answer rather than on
	 * whatever was there before.
	 */
	async refreshNow(): Promise<void> {
		if (!this.client) return;
		if (this.inFlight) {
			await this.current;
			return;
		}
		// The retry is already armed and its countdown is on screen; asking again
		// here would double the ceiling on the next failure for a keypress.
		if (this.backoff !== null) return;
		await this.refresh();
	}

	private refresh(): Promise<void> {
		if (!this.client) return Promise.resolve();
		if (this.inFlight) return this.current ?? Promise.resolve();
		// A trailing refresh armed for later is answered by this one; leaving it
		// to fire would put a second read inside the gap this one just started.
		if (this.pending) {
			clearTimeout(this.pending);
			this.pending = undefined;
		}
		this.inFlight = true;
		const promise = this.runRefresh(this.client);
		// runRefresh can in principle settle synchronously; only keep a handle
		// while there is actually something to join.
		this.current = this.inFlight ? promise : null;
		return promise;
	}

	private async runRefresh(client: HiveClient): Promise<void> {
		// Measured from the START of the request, so the gap bounds the request
		// rate rather than the idle time between requests.
		this.lastRefreshAt = Date.now();
		try {
			await this.refreshOnce(client);
			this.clearBackoff();
		} catch (err) {
			this.noteFailure(err);
		} finally {
			this.inFlight = false;
			this.current = null;
			const queued = this.queued;
			this.queued = null;
			// Re-ask when something arrived mid-refresh, and ALWAYS while backing
			// off: a countdown on screen is a promise that an attempt happens when
			// it reaches zero, and this is the only place that arms it.
			if (queued !== null || this.backoff !== null) this.requestRefresh({ skipGap: queued?.skipGap ?? false });
		}
	}

	private clearBackoff(): void {
		if (this.backoff === null) return;
		this.backoff = null;
		// patch derives retryAt from `backoff`, so clearing it is the whole update.
		this.patch({});
	}

	/**
	 * noteFailure decides whether this failure means "slow down", and says so on
	 * screen either way. A footer that silently stops updating is indistinguishable
	 * from a project that has gone quiet, so the wait is rendered rather than
	 * swallowed.
	 */
	private noteFailure(err: unknown): void {
		if (!(err instanceof HiveRequestError)) {
			// Not a request failure at all — a fault in this file. Waiting longer
			// will not make it come out differently, so it is reported, not paced.
			this.backoff = null;
			this.patch({ status: "error", error: redact(err) });
			return;
		}
		if (!isBackpressure(err.result)) {
			// A 404 or a 401 is not a busy server: backing off would only make a
			// wrong target, or a dead token, take longer to become visible.
			this.backoff = null;
			this.patch({ status: "error", error: describeFailure(err.result) });
			return;
		}
		const { ceiling, delay } = backoffPlan(
			this.backoff?.ceiling ?? 0,
			err.result.retryAfterMs,
			maxCeilingFor(err.result),
		);
		this.backoff = { until: Date.now() + delay, ceiling };
		this.patch({ status: "error", error: describeFailure(err.result) });
	}

	private async resolveProject(client: HiveClient, repo: string): Promise<string | null> {
		const now = Date.now();
		if (!this.projects || now - this.projects.at > PROJECTS_TTL_MS) {
			this.projects = { names: await client.listProjects(), at: now };
		}
		// Hive project names match repository names, but not always their casing.
		const lowered = repo.toLowerCase();
		return this.projects.names.find((name) => name.toLowerCase() === lowered) ?? null;
	}

	/**
	 * stale is the guard on every result read across an await: a retarget since
	 * this refresh started means the answer is about the wrong branch, and
	 * patching it would paint the old project's runs over the reset `retarget`
	 * just did — a flash of somebody else's CI state that the next refresh then
	 * silently corrects.
	 */
	private stale(target: HiveTarget): boolean {
		return !sameTarget(target, this.target);
	}

	private async refreshOnce(client: HiveClient): Promise<void> {
		const target = this.target;
		const { repo, branch, pr } = target;
		if (!repo) {
			this.patch({ status: "unresolved", project: null, mine: null, active: [], trunk: null });
			return;
		}

		const project = await this.resolveProject(client, repo);
		if (this.stale(target)) return;
		if (!project) {
			this.patch({ status: "foreign", project: null, mine: null, active: [], trunk: null, error: null });
			return;
		}
		const isNewProject = project !== this.snapshot.project;

		const now = Date.now();
		if (!this.facts || now - this.facts.at > PIPELINES_TTL_MS) {
			const fetched = await client.pipelines(project);
			// Not just the patch: caching the old project's pipelines would
			// outlive this refresh and answer for the new one.
			if (this.stale(target)) return;
			this.facts = { value: fetched, at: now };
		}
		const facts = this.facts.value;

		// Mine: the PR's runs when there is a PR, the branch's otherwise. A PR
		// number is the better key — a factory branch can be rewritten under the
		// same PR, and a branch name alone matches across forks.
		const mineQuery: Record<string, string | number> | null = pr
			? { project, pr, limit: 5 }
			: branch
				? { project, branch, limit: 5 }
				: null;
		const [active, mineRuns] = await Promise.all([
			client.runs({ project, status: "running", limit: ACTIVE_LIMIT }),
			mineQuery ? client.runs(mineQuery) : Promise.resolve<HiveRun[]>([]),
		]);
		if (this.stale(target)) return;

		let trunk = this.snapshot.trunk;
		let trunkActive = this.snapshot.trunkActive;
		const trunkStale = now - this.trunkAt > TRUNK_TTL_MS;
		if (facts.defaultBranch && facts.gate && (trunkStale || isNewProject)) {
			const recent = await client.runs({ project, branch: facts.defaultBranch, pipeline: facts.gate, limit: 5 });
			if (this.stale(target)) return;
			// The newest FINISHED run is the honest "is trunk red" answer; a run
			// still in flight has not said anything yet.
			trunk = recent.find((r) => isTerminal(r.state) && r.state !== "canceled") ?? null;
			trunkActive = recent.some((r) => !isTerminal(r.state));
			this.trunkAt = now;
		}

		this.patch({
			status: "ok",
			project,
			defaultBranch: facts.defaultBranch,
			mine: pickMine(mineRuns),
			active,
			trunk,
			trunkActive,
			health: facts.health,
			error: null,
		});
		if (isNewProject) this.restartStream();
	}
}

/**
 * pickMine prefers a run that is still going — that is the one whose progress
 * the footer should track — and otherwise reports the newest finished one.
 * Factory (autofix) runs lose to real CI runs at equal liveness: the question
 * "did my PR pass" is about the gate, not about the fixer working on it.
 */
export function pickMine(runs: HiveRun[]): HiveRun | null {
	if (runs.length === 0) return null;
	const rank = (r: HiveRun): number => (isTerminal(r.state) ? 0 : 2) + (r.isFactory ? 0 : 1);
	return runs.slice().sort((a, b) => rank(b) - rank(a) || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
