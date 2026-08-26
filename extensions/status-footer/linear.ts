/**
 * status-footer — Linear client.
 *
 * Answers "which tickets is this PR about?" two ways, in order of authority:
 *
 *   1. `attachmentsForURL(prUrl)` — what the GitHub↔Linear integration actually
 *      linked. This is the literal meaning of "a PR with tickets attached".
 *   2. `TEAM-123` keys parsed out of the branch name and the PR title, filtered
 *      against the workspace's real team keys. This covers the window before the
 *      integration attaches anything, and the case where there is no PR yet —
 *      which is most of the time you are actually writing the code.
 *
 * Lookups use `issues(filter:{or:[…]})` rather than a batch of aliased
 * `issue(id:)` calls, because ONE unknown identifier in an aliased batch nulls
 * `data` for the whole response: a stale key in a branch name would silently
 * blank every valid ticket.
 */

const API_URL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 6_000;
const TEAM_KEYS_TTL_MS = 60 * 60_000;
export const REFRESH_INTERVAL_MS = 3 * 60_000;
const MAX_KEYS = 8;

export type LinearStateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

export interface LinearIssue {
	identifier: string;
	title: string;
	url: string;
	stateName: string;
	stateType: LinearStateType;
	assignee: string | null;
	priority: number;
	/** How we found it — an attachment is authoritative, a parsed key is a guess. */
	source: "attachment" | "key";
}

export interface LinearSnapshot {
	/** off: no LINEAR_API_TOKEN. unresolved: not looked up yet. */
	status: "off" | "unresolved" | "ok" | "error";
	issues: LinearIssue[];
	error: string | null;
}

export const OFFLINE_LINEAR: LinearSnapshot = { status: "off", issues: [], error: null };

export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
	const token = (env.LINEAR_API_TOKEN ?? env.LINEAR_API_KEY ?? "").trim();
	return token || null;
}

/**
 * extractIssueKeys pulls TEAM-123 candidates out of free text and keeps only the
 * ones whose prefix is a REAL team key. Branch names are lowercase by
 * convention (`feature/hiv-1080`), so matching is case-insensitive and the
 * result is normalised to Linear's uppercase form.
 *
 * The team filter is what makes this safe: without it `feature/add-2` and
 * `fix/utf-8` parse as ticket references.
 */
export function extractIssueKeys(texts: Array<string | null | undefined>, teamKeys: ReadonlySet<string>): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	for (const text of texts) {
		if (!text) continue;
		for (const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,6})\b/g)) {
			const key = `${match[1].toUpperCase()}-${Number(match[2])}`;
			if (!teamKeys.has(match[1].toUpperCase()) || seen.has(key)) continue;
			seen.add(key);
			found.push(key);
			if (found.length >= MAX_KEYS) return found;
		}
	}
	return found;
}

/**
 * buildOrFilter turns TEAM-123 keys into the `or`-of-`and` shape the Linear API
 * needs. The nesting is not cosmetic: `{team, number}` as sibling keys of one
 * filter object is accepted and then silently ignores the number, returning
 * every issue on the team.
 */
export interface LinearIssueFilter {
	or: Array<{ and: Array<Record<string, unknown>> }>;
}

export function buildOrFilter(keys: string[]): LinearIssueFilter | null {
	const clauses: LinearIssueFilter["or"] = [];
	for (const key of keys) {
		const [team, number] = key.split("-");
		const parsed = Number(number);
		if (!team || !Number.isFinite(parsed)) continue;
		clauses.push({ and: [{ team: { key: { eq: team } } }, { number: { eq: parsed } }] });
	}
	return clauses.length > 0 ? { or: clauses } : null;
}

interface RawIssue {
	identifier?: string;
	title?: string;
	url?: string;
	priority?: number;
	state?: { name?: string; type?: string } | null;
	assignee?: { displayName?: string } | null;
}

export function mapIssue(raw: RawIssue | null | undefined, source: LinearIssue["source"]): LinearIssue | null {
	if (!raw?.identifier) return null;
	return {
		identifier: raw.identifier,
		title: raw.title ?? "",
		url: raw.url ?? "",
		stateName: raw.state?.name ?? "?",
		stateType: (raw.state?.type ?? "backlog") as LinearStateType,
		assignee: raw.assignee?.displayName ?? null,
		priority: typeof raw.priority === "number" ? raw.priority : 0,
		source,
	};
}

const ISSUE_FIELDS = "identifier title url priority state { name type } assignee { displayName }";

function redact(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
		return err.name || "error";
	}
	return "error";
}

export class LinearClient {
	constructor(private readonly token: string) {}

	/**
	 * The shared transport. Public because `extensions/tasks/linear.ts` owns its
	 * own queries but must not own a second credential path: one place reads the
	 * token, one place sets the timeout, one place redacts errors — which is the
	 * whole answer to "what can leave this machine".
	 *
	 * Callers own their query strings. This class stays stateless apart from the
	 * token, which is what makes it safe for another extension to import: pi
	 * builds a fresh jiti per extension entry, so `tasks` gets its own instance
	 * of this module, and a module with no mutable state cannot fork.
	 */
	async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
		const res = await fetch(API_URL, {
			method: "POST",
			headers: { Authorization: this.token, "Content-Type": "application/json" },
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`http_${res.status}`);
		const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
		if (!body.data) throw new Error("graphql");
		return body.data;
	}

	async teamKeys(): Promise<Set<string>> {
		const data = await this.graphql<{ teams?: { nodes?: Array<{ key?: string }> } }>(
			"query { teams(first: 100) { nodes { key } } }",
		);
		return new Set((data.teams?.nodes ?? []).map((t) => t.key).filter((k): k is string => Boolean(k)));
	}

	/** Issues the forge integration actually attached to this pull request. */
	async issuesForUrl(url: string): Promise<LinearIssue[]> {
		const data = await this.graphql<{ attachmentsForURL?: { nodes?: Array<{ issue?: RawIssue | null }> } }>(
			`query($url: String!) { attachmentsForURL(url: $url) { nodes { issue { ${ISSUE_FIELDS} } } } }`,
			{ url },
		);
		return (data.attachmentsForURL?.nodes ?? [])
			.map((node) => mapIssue(node.issue, "attachment"))
			.filter((issue): issue is LinearIssue => issue !== null);
	}

	async issuesByKey(keys: string[]): Promise<LinearIssue[]> {
		const filter = buildOrFilter(keys);
		if (!filter) return [];
		const data = await this.graphql<{ issues?: { nodes?: RawIssue[] } }>(
			`query($filter: IssueFilter) { issues(filter: $filter, first: ${MAX_KEYS}) { nodes { ${ISSUE_FIELDS} } } }`,
			{ filter },
		);
		return (data.issues?.nodes ?? [])
			.map((node) => mapIssue(node, "key"))
			.filter((issue): issue is LinearIssue => issue !== null);
	}
}

/**
 * mergeIssues keeps attachments ahead of parsed keys, deduplicates by
 * identifier, and orders the rest by how much they are likely to matter right
 * now: work in progress first, finished work last.
 */
export function mergeIssues(attached: LinearIssue[], guessed: LinearIssue[]): LinearIssue[] {
	const byId = new Map<string, LinearIssue>();
	for (const issue of [...attached, ...guessed]) {
		if (!byId.has(issue.identifier)) byId.set(issue.identifier, issue);
	}
	const weight: Record<LinearStateType, number> = {
		started: 0,
		triage: 1,
		unstarted: 2,
		backlog: 3,
		completed: 4,
		canceled: 5,
	};
	return [...byId.values()].sort(
		(a, b) =>
			(a.source === "attachment" ? 0 : 1) - (b.source === "attachment" ? 0 : 1) ||
			(weight[a.stateType] ?? 9) - (weight[b.stateType] ?? 9) ||
			a.identifier.localeCompare(b.identifier),
	);
}

export interface LinearTarget {
	branch: string | null;
	prUrl: string | null;
	prTitle: string | null;
}

/**
 * LinearWatcher owns all Linear state for one session. Like HiveWatcher it keeps
 * everything in the instance, never at module scope.
 */
export class LinearWatcher {
	private snapshot: LinearSnapshot = { ...OFFLINE_LINEAR };
	private target: LinearTarget = { branch: null, prUrl: null, prTitle: null };
	private readonly client: LinearClient | null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private teams: { keys: Set<string>; at: number } | null = null;
	private inFlight = false;

	constructor(
		private readonly onChange: () => void,
		token: string | null = tokenFromEnv(),
	) {
		this.client = token ? new LinearClient(token) : null;
		if (this.client) this.snapshot = { ...OFFLINE_LINEAR, status: "unresolved" };
	}

	get(): LinearSnapshot {
		return this.snapshot;
	}

	get configured(): boolean {
		return this.client !== null;
	}

	retarget(target: LinearTarget): void {
		this.target = target;
		void this.refresh();
	}

	start(): void {
		if (!this.client || this.timer) return;
		this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	async refresh(): Promise<void> {
		if (!this.client || this.inFlight) return;
		this.inFlight = true;
		try {
			const now = Date.now();
			if (!this.teams || now - this.teams.at > TEAM_KEYS_TTL_MS) {
				this.teams = { keys: await this.client.teamKeys(), at: now };
			}
			const keys = extractIssueKeys([this.target.branch, this.target.prTitle], this.teams.keys);
			const [attached, guessed] = await Promise.all([
				this.target.prUrl ? this.client.issuesForUrl(this.target.prUrl) : Promise.resolve<LinearIssue[]>([]),
				keys.length > 0 ? this.client.issuesByKey(keys) : Promise.resolve<LinearIssue[]>([]),
			]);
			this.snapshot = { status: "ok", issues: mergeIssues(attached, guessed), error: null };
		} catch (err) {
			this.snapshot = { ...this.snapshot, status: "error", error: redact(err) };
		} finally {
			this.inFlight = false;
			this.onChange();
		}
	}
}
