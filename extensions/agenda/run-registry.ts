import type { RunSummary } from "./executor.ts";

export type DurableRunStatus = "running" | "done" | "failed" | "canceled";

export interface DurableRunResult {
	text: string;
	details: unknown;
	summary: RunSummary;
}

export interface DurableRunRecord {
	id: string;
	name: string;
	status: DurableRunStatus;
	startedAt: number;
	endedAt?: number;
	result?: DurableRunResult;
	error?: string;
	notified: boolean;
}

interface StoredRun extends DurableRunRecord {
	cancel: () => void;
}

/**
 * Session-local background orchestration runs.
 *
 * The tool call that starts a durable run returns immediately, so its result can
 * no longer carry the eventual summary. This registry is the durable-within-the-
 * session rendezvous: completion is pushed once, while `orchestrate_result`
 * remains a pull path when that notification was compacted or needs full detail.
 */
export class DurableRunRegistry {
	private readonly runs = new Map<string, StoredRun>();

	constructor(private readonly now: () => number = Date.now, private readonly retainCompleted = 20) {}

	start(id: string, name: string, cancel: () => void): DurableRunRecord {
		if (this.runs.has(id)) throw new Error(`orchestration run "${id}" already exists`);
		this.prune();
		const run: StoredRun = {
			id,
			name,
			status: "running",
			startedAt: this.now(),
			notified: false,
			cancel,
		};
		this.runs.set(id, run);
		return this.public(run);
	}

	complete(id: string, result: DurableRunResult): DurableRunRecord | undefined {
		const run = this.runs.get(id);
		if (!run || run.status !== "running") return run ? this.public(run) : undefined;
		run.status = result.summary.halted === "aborted" ? "canceled" : "done";
		run.endedAt = this.now();
		run.result = result;
		return this.public(run);
	}

	fail(id: string, error: unknown): DurableRunRecord | undefined {
		const run = this.runs.get(id);
		if (!run || run.status !== "running") return run ? this.public(run) : undefined;
		run.status = "failed";
		run.endedAt = this.now();
		run.error = String(error);
		return this.public(run);
	}

	markNotified(id: string): void {
		const run = this.runs.get(id);
		if (run) run.notified = true;
	}

	get(id: string): DurableRunRecord | undefined {
		const run = this.runs.get(id);
		return run ? this.public(run) : undefined;
	}

	list(): DurableRunRecord[] {
		return [...this.runs.values()]
			.sort((a, b) => b.startedAt - a.startedAt)
			.map((run) => this.public(run));
	}

	cancelAll(): void {
		for (const run of this.runs.values()) {
			if (run.status !== "running") continue;
			run.cancel();
			run.status = "canceled";
			run.endedAt = this.now();
		}
	}

	private public(run: StoredRun): DurableRunRecord {
		const { cancel: _cancel, ...record } = run;
		return { ...record };
	}

	private prune(): void {
		const completed = [...this.runs.values()]
			.filter((run) => run.status !== "running")
			.sort((a, b) => b.startedAt - a.startedAt);
		for (const run of completed.slice(this.retainCompleted)) this.runs.delete(run.id);
	}
}
