/**
 * Linear-backed task lists.
 *
 * The direction of sync is the whole design. A harness that mirrors Linear
 * continuously has every session racing every other session's writes, and a
 * crashed run leaves a ticket transitioned to a state nobody chose. So:
 *
 *   IN   on demand only — `/tasks linear <KEY>` reads once. No watcher.
 *   OUT  on explicit action only — `/tasks linear push`, behind a confirmation.
 *
 * The session list is the WORKING COPY and is allowed to diverge. Divergence
 * that surprises someone is a sync bug; divergence a human chose is the point.
 *
 * The transport is `status-footer`'s `LinearClient` rather than a second one:
 * one place reads `LINEAR_API_TOKEN`, one place sets the timeout, one place
 * redacts errors. That import is safe across extensions specifically because
 * that module holds no mutable state at module scope — pi builds a fresh jiti
 * per extension entry, so a stateful module would silently fork.
 */

import { buildOrFilter, LinearClient, type LinearStateType } from "../status-footer/linear.ts";
import { type TaskItem, type TaskListState, type TaskStatus, type TaskWrite } from "./state.ts";

/** Linear descriptions are unbounded; a task list is a glance surface. */
const MAX_DESCRIPTION = 400;
const MAX_CHILDREN = 100;

export interface LinearTaskSource {
	identifier: string;
	title: string;
	description?: string;
	stateType: LinearStateType;
	stateName: string;
	url: string;
}

interface RawNode {
	identifier?: string;
	title?: string;
	description?: string;
	url?: string;
	state?: { name?: string; type?: string } | null;
	children?: { nodes?: RawNode[] } | null;
}

const NODE_FIELDS = "identifier title description url state { name type }";

const ISSUE_TREE_QUERY = `query($filter: IssueFilter) {
  issues(filter: $filter, first: 1) {
    nodes {
      ${NODE_FIELDS}
      children(first: ${MAX_CHILDREN}) { nodes { ${NODE_FIELDS} } }
    }
  }
}`;

function truncate(text: string | undefined): string | undefined {
	const trimmed = (text ?? "").trim();
	if (!trimmed) return undefined;
	return trimmed.length > MAX_DESCRIPTION ? `${trimmed.slice(0, MAX_DESCRIPTION - 1)}…` : trimmed;
}

export function mapNode(raw: RawNode | null | undefined): LinearTaskSource | null {
	if (!raw?.identifier) return null;
	return {
		identifier: raw.identifier,
		title: (raw.title ?? "").trim() || raw.identifier,
		description: truncate(raw.description),
		stateType: (raw.state?.type ?? "backlog") as LinearStateType,
		stateName: raw.state?.name ?? "?",
		url: raw.url ?? "",
	};
}

/**
 * Parent first, then children in Linear's order.
 *
 * The parent is included deliberately: hydrating only the sub-issues loses the
 * thing they are sub-issues OF, and a list of six unrelated-looking titles is
 * worse than five plus their heading.
 */
export function flattenTree(raw: RawNode | null | undefined): LinearTaskSource[] {
	const parent = mapNode(raw);
	if (!parent) return [];
	const children = (raw?.children?.nodes ?? [])
		.map(mapNode)
		.filter((node): node is LinearTaskSource => node !== null);
	return [parent, ...children];
}

export async function fetchIssueTree(client: LinearClient, key: string): Promise<LinearTaskSource[]> {
	const filter = buildOrFilter([key.toUpperCase()]);
	if (!filter) throw new Error("bad_key");
	const data = await client.graphql<{ issues?: { nodes?: RawNode[] } }>(ISSUE_TREE_QUERY, { filter });
	const node = data.issues?.nodes?.[0];
	if (!node) return [];
	return flattenTree(node);
}

/**
 * Linear state → task status.
 *
 * `canceled` maps to nothing: a canceled issue is not work, and importing it as
 * a pending task manufactures a to-do the human already decided against.
 * `triage` is likewise excluded — it has not been accepted as work yet.
 */
export function statusFor(stateType: LinearStateType): TaskStatus | null {
	switch (stateType) {
		case "completed":
			return "completed";
		case "started":
			return "in_progress";
		case "backlog":
		case "unstarted":
			return "pending";
		default:
			return null; // triage, canceled
	}
}

export interface HydrateResult {
	writes: TaskWrite[];
	/** Issues skipped, with why. Reported, never silent. */
	skipped: { key: string; reason: string }[];
	/** Linked tasks whose Linear state no longer matches local state. */
	drifted: { key: string; local: TaskStatus; linear: string }[];
	/** Linked tasks whose issue was absent from this read. */
	orphaned: string[];
}

/**
 * Plan the writes for a hydrate. Pure — the fold is what gets tested, the fetch
 * is not.
 *
 * Re-running is a re-READ, not a reset:
 *
 *   - text (subject, description) refreshes from Linear, which owns it
 *   - **status does NOT** — clobbering a task the human just marked in_progress
 *     with Linear's stale `backlog` is precisely the surprise that makes people
 *     stop trusting a sync. Mismatches are reported as `drifted` instead
 *   - a linked task whose issue is absent is reported, never deleted; the issue
 *     may simply be outside this parent's tree
 */
export function planHydrate(state: TaskListState, sources: readonly LinearTaskSource[]): HydrateResult {
	const byKey = new Map<string, TaskItem>();
	for (const task of state.tasks) if (task.linearKey) byKey.set(task.linearKey, task);

	const writes: TaskWrite[] = [];
	const skipped: HydrateResult["skipped"] = [];
	const drifted: HydrateResult["drifted"] = [];
	const seen = new Set<string>();

	for (const source of sources) {
		const status = statusFor(source.stateType);
		if (status === null) {
			skipped.push({ key: source.identifier, reason: source.stateType });
			continue;
		}
		seen.add(source.identifier);
		const existing = byKey.get(source.identifier);

		if (!existing) {
			writes.push({
				subject: source.title,
				description: source.description,
				status,
				linearKey: source.identifier,
			});
			continue;
		}

		if (existing.status !== status) {
			drifted.push({ key: source.identifier, local: existing.status, linear: source.stateName });
		}
		// Text only. Status is deliberately absent from this write.
		writes.push({ id: existing.id, subject: source.title, description: source.description });
	}

	const orphaned = [...byKey.keys()].filter((key) => !seen.has(key));
	return { writes, skipped, drifted, orphaned };
}

export function describeHydrate(result: HydrateResult): string[] {
	const lines: string[] = [];
	for (const entry of result.skipped) lines.push(`  skipped ${entry.key} (${entry.reason} in Linear)`);
	for (const entry of result.drifted) {
		lines.push(`  drift: ${entry.key} is "${entry.linear}" in Linear but ${entry.local} here — local status kept`);
	}
	for (const key of result.orphaned) lines.push(`  ${key} is linked here but absent from this read — left in place`);
	return lines;
}

// --- write-back -------------------------------------------------------------

const COMMENT_MUTATION = `mutation($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;

const RESOLVE_QUERY = `query($filter: IssueFilter) {
  issues(filter: $filter, first: ${MAX_CHILDREN}) { nodes { id identifier } }
}`;

/** Tasks that carry a Linear key, in list order. */
export function linkedTasks(state: TaskListState): TaskItem[] {
	return state.tasks.filter((task): task is TaskItem & { linearKey: string } => Boolean(task.linearKey));
}

/**
 * The comment body.
 *
 * One comment covering the whole list, not one per task: a push that fires six
 * notifications for six checkboxes trains everyone to mute the project.
 */
export function pushBody(tasks: readonly TaskItem[], key: string): string {
	const mine = tasks.filter((task) => task.linearKey === key);
	const lines = ["Task status from the pi harness:", ""];
	for (const task of mine) {
		const glyph = task.status === "completed" ? "x" : " ";
		lines.push(`- [${glyph}] ${task.subject}${task.status === "in_progress" ? " _(in progress)_" : ""}`);
	}
	return lines.join("\n");
}

export async function resolveIds(client: LinearClient, keys: readonly string[]): Promise<Map<string, string>> {
	const filter = buildOrFilter([...keys]);
	const out = new Map<string, string>();
	if (!filter) return out;
	const data = await client.graphql<{ issues?: { nodes?: Array<{ id?: string; identifier?: string }> } }>(
		RESOLVE_QUERY,
		{ filter },
	);
	for (const node of data.issues?.nodes ?? []) {
		if (node.id && node.identifier) out.set(node.identifier, node.id);
	}
	return out;
}

export async function postComment(client: LinearClient, issueId: string, body: string): Promise<boolean> {
	const data = await client.graphql<{ commentCreate?: { success?: boolean } }>(COMMENT_MUTATION, { issueId, body });
	return data.commentCreate?.success === true;
}
