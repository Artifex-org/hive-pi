/** Explicit retained-review protocol. Human prose is presentation, never identity. */
export const REVIEW_LEDGER_INSTRUCTION =
	'Only the FINAL assistant response of each invocation may contain a protocol frame; never put one in progress or tool-call messages. End that response with one unquoted, unfenced line: REVIEW_LEDGER {"complete":false,"findings":[...]}. Set complete:true only after the full semantic review is complete; reads alone are not completion. ' +
	'For EACH NEW finding include {"id":null,"status":"new","location":"path:line","issue":"full issue","scenario":"full reproduction/interleaving","evidence":"full supporting trace"}. ' +
	'For EVERY previously assigned ID include {"id":"F1","status":"upheld|resolved|withdrawn","location":"path:line","evidence":"supporting trace and explanation"}. ' +
	'Use separate new records for independent bugs even at the same location. Put ALL supporting details in the structured fields; they are retained across compaction. ' +
	'Human recaps may rephrase these records but cannot add, identify or withdraw findings. Use {"complete":true,"findings":[]} only when there are no findings to report or reconcile.';

/** Protocol bytes are not a human conclusion (and must not defeat progress guards). */
export function reviewConclusionText(output: string): string {
	return output.split("\n").filter(line => !line.startsWith("REVIEW_LEDGER ")).join("\n");
}

type Status = "upheld" | "resolved" | "withdrawn";
interface Finding {
	id: string;
	location: string;
	issue: string;
	scenario: string;
	evidence: string;
	disposition?: { status: Status; location: string; evidence: string };
}
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const location = (value: unknown): value is string => nonempty(value) && /^[\s\S]+:[1-9]\d*(?:[–-][1-9]\d*)?$/.test(value);

function unfencedReviewLines(output: string): { text: string; index: number }[] {
	const found: { text: string; index: number }[] = [];
	let fence: { marker: string; length: number } | undefined;
	for (const [index, line] of output.split("\n").entries()) {
		const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (boundary) {
			if (!fence) fence = { marker: boundary[1][0], length: boundary[1].length };
			else if (fence.marker === boundary[1][0] && boundary[1].length >= fence.length && /^[ \t]*$/.test(boundary[2])) fence = undefined;
			continue;
		}
		if (!fence) found.push({ text: line, index });
	}
	return found;
}

/** Only a real protocol line counts, not an example inside Markdown. */
export function reviewLedgerFrames(output: string): string[] {
	return unfencedReviewLines(output).filter(line => line.text.startsWith("REVIEW_LEDGER ")).map(line => line.text.slice("REVIEW_LEDGER ".length));
}

/** Raw rejected bytes eligible for producer feedback, NEVER ledger acceptance. */
export function quotedReviewLedgerFrames(output: string): string[] {
	return unfencedReviewLines(output).filter(line => /^`REVIEW_LEDGER \{.*\}`$/.test(line.text)).map(line => line.text);
}

/** Re-quote only the NEW authoritative line for exact rejected-byte comparison. */
export function requoteReviewLedgerFrame(output: string): string | undefined {
	const frames = unfencedReviewLines(output).filter(line => line.text.startsWith("REVIEW_LEDGER "));
	if (frames.length !== 1) return undefined;
	const lines = output.split("\n");
	lines[frames[0].index] = `\`${frames[0].text}\``;
	return lines.join("\n");
}

export class ReviewLedger {
	private records = new Map<string, Finding>();
	private nextId = 1;
	apply(output: string): { complete: boolean; valid?: boolean; error?: string; feedback?: string } {
		const lines = reviewLedgerFrames(output);
		if (lines.length !== 1) return { complete: false, feedback: "Exactly one real REVIEW_LEDGER protocol line is required; quoted examples and bare ID mentions do not count." };
		let parsed: unknown;
		try { parsed = JSON.parse(lines[0]); }
		catch { return { complete: false, feedback: "REVIEW_LEDGER must contain valid JSON." }; }
		if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { findings?: unknown }).findings) || typeof (parsed as { complete?: unknown }).complete !== "boolean")
			return { complete: false, feedback: "REVIEW_LEDGER requires a complete boolean and a findings array." };
		const { findings: records, complete: semanticComplete } = parsed as { findings: unknown[]; complete: boolean };
		const next = new Map(this.records), seen = new Set<string>();
		let nextId = this.nextId;
		for (const record of records) {
			if (!record || typeof record !== "object") return { complete: false, feedback: "Every finding must be an object." };
			const r = record as Record<string, unknown>;
			if (!location(r.location) || !nonempty(r.evidence)) return { complete: false, feedback: "Each finding/disposition requires a path:line location and supporting evidence." };
			if (r.id === null && r.status === "new" && nonempty(r.issue) && nonempty(r.scenario)) {
				const id = `F${nextId++}`;
				next.set(id, { id, location: r.location, issue: r.issue, scenario: r.scenario, evidence: r.evidence });
			} else if (typeof r.id === "string" && this.records.has(r.id) && typeof r.status === "string" && ["upheld", "resolved", "withdrawn"].includes(r.status)) {
				if (seen.has(r.id)) return { complete: false, feedback: `Duplicate disposition for ${r.id}.` };
				seen.add(r.id);
				// Original supporting fields are immutable. Resolution cannot erase
				// the reproduction the next context needs to evaluate the claim.
				next.set(r.id, { ...this.records.get(r.id)!, disposition: { status: r.status as Status, location: r.location, evidence: r.evidence } });
			} else return { complete: false, feedback: "New findings need id:null, status:new, issue and scenario; dispositions require a known ID and upheld/resolved/withdrawn status." };
		}
		const retained = JSON.stringify([...next.values()]);
		if (Buffer.byteLength(retained) > 64 * 1024) return { complete: false, error: "Retained finding evidence exceeds the 64KiB continuation prompt budget; nothing was discarded." };
		const missing = [...this.records.keys()].filter(id => !seen.has(id));
		// Commit only a fully validated frame. Missing prior dispositions cannot
		// approve a review, but valid new findings must survive the next round.
		this.records = next; this.nextId = nextId;
		return { valid: true, complete: semanticComplete && !missing.length, feedback: missing.length ? `Prior finding dispositions missing: ${missing.join(", ")}.` : semanticComplete ? undefined : "The reviewer reports semantic scope incomplete." };
	}
	retained(): string { return JSON.stringify([...this.records.values()]); }
}
