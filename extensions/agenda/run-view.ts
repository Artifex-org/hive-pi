/**
 * Live view of an `orchestrate` run.
 *
 * Without it a run is a frozen screen for minutes: the tool call blocks, the
 * workers are silent by construction (their output goes to the parent, not the
 * terminal), and the user cannot tell a healthy 12-way fan-out from a wedged
 * one. That ambiguity is the whole reason to build this — not decoration.
 *
 * The state fold is PURE and lives here; rendering is a thin function over it.
 * So "does the view say the right thing" is testable without a TUI, which is
 * the same split the rest of this extension uses.
 */

import type { RunEvent } from "./executor.ts";

export interface NodeView {
	nodeId: string;
	workId: string;
	state: "running" | "done" | "failed";
	startedAt: number;
	finishedAt?: number;
	tokens: number;
	reason?: string;
}

export interface RunView {
	startedAt: number;
	finishedAt?: number;
	nodes: NodeView[];
	spentTokens: number;
	halted?: string;
}

export function emptyRunView(now: number): RunView {
	return { startedAt: now, nodes: [], spentTokens: 0 };
}

/**
 * Fold one journal event into the view. Pure; unknown events are ignored rather
 * than throwing, because a view that crashes takes the run's tool call with it.
 */
export function applyRunEvent(view: RunView, event: RunEvent): RunView {
	const nodes = [...view.nodes];
	const indexOf = (workId?: string) => nodes.findIndex((n) => n.workId === workId);

	switch (event.ev) {
		case "run_started":
			return { ...view, startedAt: event.at };

		case "node_started":
			if (!event.workId) return view;
			nodes.push({
				nodeId: event.nodeId ?? "?",
				workId: event.workId,
				state: "running",
				startedAt: event.at,
				tokens: 0,
			});
			return { ...view, nodes };

		case "node_finished": {
			const i = indexOf(event.workId);
			if (i < 0) return view;
			nodes[i] = { ...nodes[i], state: "done", finishedAt: event.at, tokens: event.tokens ?? 0 };
			return { ...view, nodes, spentTokens: view.spentTokens + (event.tokens ?? 0) };
		}

		case "node_failed": {
			const i = indexOf(event.workId);
			if (i < 0) return view;
			nodes[i] = { ...nodes[i], state: "failed", finishedAt: event.at, reason: event.reason };
			return { ...view, nodes };
		}

		case "halted":
			return { ...view, halted: event.reason };

		case "run_finished":
			return { ...view, finishedAt: event.at };

		default:
			return view;
	}
}

function elapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The lines the widget shows. Plain strings so the wording is testable.
 *
 * A node that is running but has produced nothing for a long time is called out
 * explicitly — silence and progress look identical otherwise, and telling them
 * apart is the point of having a view at all.
 */
export function renderRunLines(view: RunView, planName: string, now: number, quietAfterMs = 90_000): string[] {
	const done = view.nodes.filter((n) => n.state === "done").length;
	const failed = view.nodes.filter((n) => n.state === "failed").length;
	const running = view.nodes.filter((n) => n.state === "running");

	const head = [
		`◆ ORCHESTRATE ${planName}`,
		`${done} done · ${failed} failed · ${running.length} running · ${view.spentTokens} tokens · ${elapsed(now - view.startedAt)}`,
	].join("  ");

	const lines = [head];

	if (view.halted) lines.push(`HALTED: ${view.halted}`);

	for (const node of running) {
		const quiet = now - node.startedAt;
		const marker = quiet > quietAfterMs ? ` — no result for ${elapsed(quiet)}` : "";
		lines.push(`  ◌ ${node.nodeId}  ${elapsed(quiet)}${marker}`);
	}

	for (const node of view.nodes.filter((n) => n.state === "failed").slice(0, 5)) {
		lines.push(`  ✗ ${node.nodeId}  ${(node.reason ?? "failed").slice(0, 70)}`);
	}

	if (view.finishedAt) {
		lines.push(`finished in ${elapsed(view.finishedAt - view.startedAt)}`);
	} else if (running.length === 0 && view.nodes.length > 0) {
		// Nothing running, nothing finished the run: the scheduler is between
		// batches. Saying so beats an empty panel that reads as a freeze.
		lines.push("  (scheduling next batch…)");
	}

	return lines;
}
