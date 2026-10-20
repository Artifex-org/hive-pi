import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewArtifactReads } from "./review-artifact.ts";
import { captureDeliveryDiff, reviewDeclaresIncomplete, reviewFingerprint } from "./reviewdiff.ts";
import { captureReleaseDiff, type ReviewTarget } from "./release-review.ts";

/** One private reviewer conversation, never a union of independent approvals. */
export class ReviewContinuation {
	readonly dir = fs.mkdtempSync(join(tmpdir(), "pi-review-session-"));
	readonly id = randomUUID();
	private rounds = 0;
	private covered = 0;
	private conclusion = false;
	private readonly cwd: string;
	private readonly task: string;
	private readonly fingerprint: string;
	private readonly reads: ReviewArtifactReads;
	private readonly reviewTarget?: ReviewTarget;
	constructor(cwd: string, task: string, fingerprint: string, reads: ReviewArtifactReads, reviewTarget?: ReviewTarget) {
		this.cwd = cwd; this.task = task; this.fingerprint = fingerprint; this.reads = reads; this.reviewTarget = reviewTarget;
	}
	configure(args: string[]): void {
		const index = args.indexOf("--no-session");
		if (index !== -1) args.splice(index, 1);
		args.push("--session-dir", this.dir, "--session-id", this.id);
	}
	unchanged(): boolean {
		const diff = this.reviewTarget ? captureReleaseDiff(this.cwd, this.reviewTarget).diff : captureDeliveryDiff(this.cwd, this.task);
		return !!diff && reviewFingerprint(diff) === this.fingerprint;
	}
	private persisted(output: string): boolean {
		// Validate the exact CLI session before using --session-id: the CLI creates
		// a NEW session when the ID is missing. Never silently lose earlier findings.
		try {
			const files = fs.readdirSync(this.dir).filter(name => name.endsWith(`_${this.id}.jsonl`));
			if (files.length !== 1) return false;
			const entries = fs.readFileSync(join(this.dir, files[0]), "utf8").trim().split("\n").map(line => JSON.parse(line));
			const header = entries[0];
			if (header?.type !== "session" || header.id !== this.id || fs.realpathSync(header.cwd) !== fs.realpathSync(this.cwd)) return false;
			const assistants = entries.filter(entry => entry.type === "message" && entry.message?.role === "assistant");
			const last = assistants.at(-1)?.message;
			return last?.content?.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n") === output;
		} catch { return false; }
	}
	next(output: string, success: boolean): { prompt?: string; error?: string } {
		if (!this.unchanged()) return { error: "Delivery review evidence changed during the review." };
		if (!success) return {};
		const complete = this.reads.complete();
		if (complete && !reviewDeclaresIncomplete(output)) return {};
		const covered = this.reads.coveredLines();
		if (this.rounds >= 4 || (complete ? this.conclusion : covered <= this.covered)) return {};
		if (!this.persisted(output)) return { error: "Delivery review incomplete: cannot resume because the matching persisted reviewer transcript is unavailable." };
		this.rounds++;
		this.covered = covered;
		if (complete) this.conclusion = true;
		this.reads.beginRound();
		return { prompt: "Continue this SAME delivery review from your retained conversation. The captured evidence is unchanged. " +
			(complete ? "Every artifact line has been read. Finish the integration review and conclusion." : `Unread artifact line ranges: ${this.reads.missingRanges()}. Use the same artifact path and read all remaining pages.`) +
			" Preserve all prior findings and assess cross-file interactions. Return ONE cumulative final review, not only new findings. " +
			"If you cannot complete the full scope, explicitly report DELIVERY_REVIEW_INCOMPLETE; do not infer approval from coverage." };
	}
	cleanup(): void { fs.rmSync(this.dir, { recursive: true, force: true }); }
}
