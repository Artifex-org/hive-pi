/** Session records are historical evidence, never instructions to replay work. */
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { appendOutput, type Job } from "./jobs.ts";

export const JOB_RECORD = "background-job-v1";
const RecordSchema = Type.Object({
	version: Type.Literal(1),
	sessionId: Type.String(),
	executionId: Type.String(),
	job: Type.Object({
		id: Type.String(), what: Type.String(), detail: Type.String(),
		kind: Type.Union([Type.Literal("bash"), Type.Literal("subagent"), Type.Literal("watch")]),
		status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("timeout"), Type.Literal("canceled"), Type.Literal("unconfirmed")]),
		startedAtMs: Type.Number(), endedAtMs: Type.Optional(Type.Number()),
		exitCode: Type.Optional(Type.Number()),
		output: Type.String(), droppedBytes: Type.Number({ minimum: 0 }),
		notified: Type.Boolean(), cwd: Type.Optional(Type.String()), runID: Type.Optional(Type.String()),
	}),
});
export type JobRecord = Static<typeof RecordSchema>;

export function jobRecord(sessionId: string, executionId: string, job: Job): JobRecord {
	return { version: 1, sessionId, executionId, job: { ...job, notified: false } };
}

export function readJobRecord(entry: unknown): JobRecord | undefined {
	if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "custom" ||
		!("customType" in entry) || entry.customType !== JOB_RECORD) return;
	if (!("data" in entry) || !Check(RecordSchema, entry.data)) throw new Error("Invalid background job session record");
	return entry.data;
}

export interface RecoveredJob { job: Job; executionId: string }

/** Fold only the active branch. Forked sessions do not inherit job ownership. */
export function recoverJobs(branch: readonly unknown[], sessionId: string): RecoveredJob[] {
	const records = new Map<string, JobRecord>();
	const notices = new Set<string>();
	for (const entry of branch) {
		const record = readJobRecord(entry);
		if (record?.sessionId === sessionId) records.set(record.job.id, record);
		if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "custom_message" ||
			!("customType" in entry) || entry.customType !== "background" || !("details" in entry)) continue;
		const details = entry.details;
		if (details && typeof details === "object" && "sessionId" in details && details.sessionId === sessionId &&
			"executionId" in details && typeof details.executionId === "string" && "status" in details) {
			notices.add(`${details.executionId}:${details.status}`);
		}
	}
	return [...records.values()].map((record) => {
		// No persisted PID is trusted, and even an apparently finished process may
		// have performed external effects before its result was recorded.
		const interrupted = record.job.status === "running";
		const status = interrupted ? "unconfirmed" : record.job.status as Job["status"];
		let job: Job = { ...record.job, status, notified: notices.has(`${record.executionId}:${status}`) };
		if (interrupted) job = appendOutput(job,
			"\n[Session recovery: execution outcome unknown. The command may have performed external effects. " +
			"It was NOT restarted; verify those effects before retrying.]\n");
		return { job, executionId: record.executionId };
	});
}

/** Owners keep their short ids monotonic even after their extension reloads. */
export function lastSubagentId(branch: readonly unknown[], sessionId: string): number {
	let highest = 0;
	for (const entry of branch) {
		const record = readJobRecord(entry);
		if (record?.sessionId !== sessionId) continue;
		const match = /^sub-(\d+)$/.exec(record.job.id);
		if (match) highest = Math.max(highest, Number(match[1]));
	}
	return highest;
}
