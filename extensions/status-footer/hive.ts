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
/** Coalesce a burst of task events into one refetch. */
export const NUDGE_DEBOUNCE_MS = 1_500;
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

/** redact keeps an error's shape without its content — a fetch error can embed a URL, and a URL can carry a token. */
function redact(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
		return err.name || "error";
	}
	return "error";
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
		const res = await fetch(`${this.credentials.url}${pathAndQuery}`, {
			headers: this.headers(),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`http_${res.status}`);
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
	private nudge: ReturnType<typeof setTimeout> | undefined;
	private poll: ReturnType<typeof setInterval> | undefined;
	private inFlight = false;
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
		void this.refresh();
	}

	start(): void {
		if (!this.client || this.poll) return;
		this.poll = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
		this.poll.unref?.();
	}

	stop(): void {
		if (this.poll) clearInterval(this.poll);
		this.poll = undefined;
		if (this.nudge) clearTimeout(this.nudge);
		this.nudge = undefined;
		this.controller?.abort();
		this.controller = null;
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
			() => this.scheduleNudge(),
			(live) => this.patch({ live }),
			controller.signal,
		);
	}

	private scheduleNudge(): void {
		if (this.nudge) return;
		this.nudge = setTimeout(() => {
			this.nudge = undefined;
			void this.refresh();
		}, NUDGE_DEBOUNCE_MS);
		this.nudge.unref?.();
	}

	private patch(patch: Partial<HiveSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		this.onChange();
	}

	async refresh(): Promise<void> {
		if (!this.client || this.inFlight) return;
		this.inFlight = true;
		try {
			await this.refreshOnce(this.client);
		} catch (err) {
			this.patch({ status: "error", error: redact(err) });
		} finally {
			this.inFlight = false;
		}
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
