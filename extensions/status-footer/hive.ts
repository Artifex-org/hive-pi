/**
 * status-footer — Hive client.
 *
 * Answers three questions about the repo in the cwd, live:
 *   1. what is my branch/PR's run doing right now?
 *   2. what else is this project running?
 *   3. is the project healthy — is trunk green, what is the recent pass rate?
 *
 * Liveness comes from the server's SSE feed (`/api/v1/events`): an event for our
 * project nudges a refetch. The periodic poll is only a backstop for a dropped
 * stream, which is why its interval is long.
 *
 * Refreshes are RATE LIMITED, and that is load-bearing rather than tidiness. One
 * watcher per session, a fleet feed that fires several times a second on a busy
 * project, and no floor between refetches turned every session into a refresh
 * every ~1.5-2s: 112,300 identical `GET /runs?project=…&status=running` in 14
 * hours, enough to flap the control plane's readiness (HIV-3313). So every
 * trigger goes through `requestRefresh`, a burst inside one gap collapses into a
 * single trailing refresh, and a server answering 429/503 gets exponential
 * backoff instead of the same load it just refused.
 *
 * Every response is mapped to a narrow type at the boundary. That is deliberate:
 * a run object carries its whole `dag_snapshot` (~14 KB), and holding a few of
 * those in a footer that redraws on a timer is exactly the kind of retained
 * garbage nobody ever finds.
 */

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
/** Longest `Retry-After` honoured, so a misconfigured proxy cannot park the footer for a day. */
export const RETRY_AFTER_MAX_MS = 15 * 60_000;
const RECONNECT_BASE_MS = 2_000;
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

export interface HiveCredentials {
	url: string;
	token: string;
}

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
 * HiveHttpError is a status Hive answered with, kept as a value rather than
 * folded into a message. The refresh limiter decides on 429/503 and on
 * `Retry-After`, and re-deriving those from a formatted string is exactly how
 * that decision comes apart the next time the message is reworded.
 */
export class HiveHttpError extends Error {
	constructor(
		readonly status: number,
		readonly retryAfterMs: number | null,
	) {
		super(`http_${status}`);
		this.name = "HiveHttpError";
	}
}

/** HiveNetworkError is a request that got no answer at all — DNS, TCP, TLS, or the timeout. */
export class HiveNetworkError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "HiveNetworkError";
	}
}

/** redact keeps an error's shape without its content — a fetch error can embed a URL, and a URL can carry a token. */
function redact(err: unknown): string {
	// A status is Hive's own answer and carries nothing secret, so it is the one
	// detail worth showing: "unreachable (http_503)" is actionable, "Error" is not.
	if (err instanceof HiveHttpError) return `http_${err.status}`;
	if (err instanceof HiveNetworkError) return err.reason;
	if (err instanceof Error) {
		if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
		return err.name || "error";
	}
	return "error";
}

/**
 * parseRetryAfterMs reads the delta-seconds form of `Retry-After`. The HTTP-date
 * form is not read: honouring it would mean trusting this machine's clock against
 * the server's, and Hive sends seconds.
 */
export function parseRetryAfterMs(header: string | null): number | null {
	if (!header) return null;
	const seconds = Number(header.trim());
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return Math.min(seconds * 1_000, RETRY_AFTER_MAX_MS);
}

/**
 * backoffPlan computes the wait after a server pushed back, and the ceiling to
 * double from next time.
 *
 * Full jitter — a uniform draw from [0, ceiling] rather than the ceiling itself —
 * because every session hammering the same endpoint failed in the same moment: a
 * deterministic backoff sends them all back in one wave, which is the load that
 * caused the failure. The draw may land near zero, which is safe because
 * MIN_REFRESH_GAP_MS still applies on top of it. `Retry-After` wins whenever it
 * asks for longer; the server knows more than this heuristic does.
 */
export function backoffPlan(
	previousCeilingMs: number,
	retryAfterMs: number | null,
	random: () => number = Math.random,
): { ceiling: number; delay: number } {
	const ceiling = Math.min(previousCeilingMs === 0 ? BACKOFF_BASE_MS : previousCeilingMs * 2, BACKOFF_MAX_MS);
	return { ceiling, delay: Math.max(retryAfterMs ?? 0, ceiling * random()) };
}

/** pollDelayMs is the backstop interval with its jitter applied. */
export function pollDelayMs(random: () => number = Math.random): number {
	return Math.round(POLL_INTERVAL_MS * (1 + (random() * 2 - 1) * POLL_JITTER_RATIO));
}

/**
 * isBackpressure: the server said "slow down" (429/503), or never answered at
 * all. Anything else — a 404, a 401, a malformed body — is a fault that waiting
 * cannot fix, so it is reported and retried on the ordinary gap.
 */
function isBackpressure(err: unknown): boolean {
	if (err instanceof HiveHttpError) return err.status === 429 || err.status === 503;
	return err instanceof HiveNetworkError;
}

export class HiveClient {
	constructor(private readonly credentials: HiveCredentials) {}

	get baseUrl(): string {
		return this.credentials.url;
	}

	private headers(accept = "application/json"): Record<string, string> {
		return { Authorization: `Bearer ${this.credentials.token}`, Accept: accept };
	}

	private async get<T>(pathAndQuery: string): Promise<T> {
		let res: Response;
		try {
			res = await fetch(`${this.credentials.url}${pathAndQuery}`, {
				headers: this.headers(),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (err) {
			throw new HiveNetworkError(redact(err));
		}
		if (!res.ok) throw new HiveHttpError(res.status, parseRetryAfterMs(res.headers.get("retry-after")));
		return (await res.json()) as T;
	}

	async listProjects(): Promise<string[]> {
		const body = await this.get<{ projects?: Array<{ name?: string }> }>("/api/v1/projects");
		return (body.projects ?? []).map((p) => p.name).filter((n): n is string => Boolean(n));
	}

	async pipelines(project: string): Promise<PipelineFacts> {
		const body = await this.get<{ pipelines?: RawPipeline[] }>(`/api/v1/pipelines?project=${encodeURIComponent(project)}`);
		return pipelineFacts(body.pipelines ?? []);
	}

	async runs(query: Record<string, string | number>): Promise<HiveRun[]> {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) search.set(key, String(value));
		const body = await this.get<{ runs?: RawRun[] }>(`/api/v1/runs?${search.toString()}`);
		return (body.runs ?? []).map(mapRun).filter((r): r is HiveRun => r !== null);
	}

	/**
	 * streamEvents follows the server's global SSE feed and calls back for every
	 * event naming `project`. It reconnects with exponential backoff forever
	 * until the signal aborts; `onLive` reports connectedness so the footer can
	 * show whether it is live or coasting on the poll backstop.
	 */
	async streamEvents(project: string, onEvent: () => void, onLive: (live: boolean) => void, signal: AbortSignal): Promise<void> {
		let backoff = RECONNECT_BASE_MS;
		while (!signal.aborted) {
			try {
				const res = await fetch(`${this.credentials.url}/api/v1/events`, {
					headers: this.headers("text/event-stream"),
					signal,
				});
				if (!res.ok || !res.body) throw new Error(`http_${res.status}`);

				onLive(true);
				backoff = RECONNECT_BASE_MS;
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
			await sleep(backoff, signal);
			backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
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
	/** A trigger that arrived while a refresh was already running; re-asked when it finishes. */
	private queued = false;
	private lastRefreshAt = 0;
	private backoffUntil = 0;
	private backoffCeiling = 0;
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
			this.snapshot = { ...OFFLINE_HIVE, status: this.client ? "unresolved" : "off" };
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
		this.queued = false;
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
			(live) => this.patch({ live }),
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
		if (!this.client || this.pending) return;
		if (this.inFlight) {
			// The running refresh may have read the server before this event existed.
			this.queued = true;
			return;
		}
		const gapUntil = options.skipGap ? 0 : this.lastRefreshAt + MIN_REFRESH_GAP_MS;
		const wait = Math.max(gapUntil, this.backoffUntil) - Date.now();
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

	private patch(patch: Partial<HiveSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.onChange();
	}

	/**
	 * refresh reads Hive NOW. Everything on a timer goes through `requestRefresh`
	 * instead; this stays public for the one caller that is a person asking —
	 * `/hive` — for whom a 15s-old answer is not what was asked for.
	 */
	async refresh(): Promise<void> {
		if (!this.client || this.inFlight) return;
		this.inFlight = true;
		// Measured from the START of the request, so the gap bounds the request
		// rate rather than the idle time between requests.
		this.lastRefreshAt = Date.now();
		try {
			await this.refreshOnce(this.client);
			this.clearBackoff();
		} catch (err) {
			this.noteFailure(err);
		} finally {
			this.inFlight = false;
			if (this.queued) {
				this.queued = false;
				this.requestRefresh();
			}
		}
	}

	private clearBackoff(): void {
		this.backoffCeiling = 0;
		this.backoffUntil = 0;
		if (this.snapshot.retryAt !== null) this.patch({ retryAt: null });
	}

	/**
	 * noteFailure decides whether this failure means "slow down", and says so on
	 * screen either way. A footer that silently stops updating is indistinguishable
	 * from a project that has gone quiet, so the wait is rendered rather than
	 * swallowed.
	 */
	private noteFailure(err: unknown): void {
		if (!isBackpressure(err)) {
			this.patch({ status: "error", error: redact(err), retryAt: null });
			return;
		}
		const { ceiling, delay } = backoffPlan(
			this.backoffCeiling,
			err instanceof HiveHttpError ? err.retryAfterMs : null,
		);
		this.backoffCeiling = ceiling;
		this.backoffUntil = Date.now() + delay;
		this.patch({ status: "error", error: redact(err), retryAt: this.backoffUntil });
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

	private async refreshOnce(client: HiveClient): Promise<void> {
		const { repo, branch, pr } = this.target;
		if (!repo) {
			this.patch({ status: "unresolved", project: null, mine: null, active: [], trunk: null });
			return;
		}

		const project = await this.resolveProject(client, repo);
		if (!project) {
			this.patch({ status: "foreign", project: null, mine: null, active: [], trunk: null, error: null });
			return;
		}
		const isNewProject = project !== this.snapshot.project;

		const now = Date.now();
		if (!this.facts || now - this.facts.at > PIPELINES_TTL_MS) {
			this.facts = { value: await client.pipelines(project), at: now };
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

		let trunk = this.snapshot.trunk;
		let trunkActive = this.snapshot.trunkActive;
		const trunkStale = now - this.trunkAt > TRUNK_TTL_MS;
		if (facts.defaultBranch && facts.gate && (trunkStale || isNewProject)) {
			const recent = await client.runs({ project, branch: facts.defaultBranch, pipeline: facts.gate, limit: 5 });
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
