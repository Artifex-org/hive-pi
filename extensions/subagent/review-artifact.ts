/** Verify the complete captured artifact reached the reviewer through read results.
 * A successful answer (or an attempted read) alone does not prove coverage. */
import { resolve, join } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

function artifactReadPath(input: string, cwd: string): string | null {
	// Match read's locator syntax without a runtime dependency on the SDK
	// (the Claude adapter imports this module under plain Node).
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
		const drive = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
		if (drive) path = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
	}
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || process.platform === "win32" && path.startsWith("~\\")) path = join(homedir(), path.slice(2));
	try { path = resolve(cwd, path.startsWith("file://") ? fileURLToPath(path) : path); }
	catch { return null; }
	try { return realpathSync(path); }
	catch { return path; } // unit fixtures or an unsuccessful read of an absent path
}

/** read cannot page within an oversized line. Encode only those patches as
 * lossless JSON string chunks; each encoded row stays below its byte cap. */
export function reviewArtifactText(text: string): { text: string; chunked: boolean } {
	if (text.split("\n").every(line => Buffer.byteLength(line) <= 32 * 1024)) return { text, chunked: false };
	// JSON escapes need at most six bytes per UTF-16 code unit. Leave ample
	// room for array indentation and delimiters, even for split surrogates.
	const size = 4096;
	const chunks = [];
	for (let offset = 0; offset < text.length; offset += size) chunks.push(text.slice(offset, offset + size));
	return { text: JSON.stringify(chunks, null, 2), chunked: true };
}

export class ReviewArtifactReads {
	private readonly lines: string[];
	private readonly covered: Uint8Array;
	private readonly pending = new Map<string, { start: number; limit?: number }>();
	private readonly path: string;
	private readonly cwd: string;
	constructor(path: string, text: string, cwd: string) {
		this.path = artifactReadPath(path, cwd) ?? path;
		this.cwd = cwd;
		this.lines = text.split("\n");
		this.covered = new Uint8Array(this.lines.length);
	}
	observe(event: Record<string, unknown>): void {
		if (typeof event.toolCallId !== "string" || event.toolName !== "read") return;
		if (event.type === "tool_execution_start") {
			const args = event.args as { path?: unknown; offset?: unknown; limit?: unknown } | undefined;
			if (typeof args?.path !== "string" || artifactReadPath(args.path, this.cwd) !== this.path) return;
			const offset = args.offset ?? 1, limit = args.limit;
			if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1) return;
			if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) return;
			this.pending.set(event.toolCallId, { start: offset - 1, limit: limit as number | undefined });
			return;
		}
		if (event.type !== "tool_execution_end") return;
		const page = this.pending.get(event.toolCallId);
		this.pending.delete(event.toolCallId);
		if (!page || event.isError) return;
		const result = event.result as { content?: { type: string; text?: string }[]; details?: { truncation?: { outputLines?: number; firstLineExceedsLimit?: boolean } } } | undefined;
		const truncation = result?.details?.truncation;
		if (truncation?.firstLineExceedsLimit) return;
		const count = truncation?.outputLines ?? Math.min(page.limit ?? this.lines.length, this.lines.length - page.start);
		if (!Number.isInteger(count) || count <= 0 || page.start + count > this.lines.length) return;
		const expected = this.lines.slice(page.start, page.start + count).join("\n");
		const output = result?.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
		// Compare actual returned bytes, not just a claimed line count. The read
		// tool can append pagination notices after these exact source lines.
		if (output === undefined || !(output === expected || output.startsWith(expected + "\n\n["))) return;
		this.covered.fill(1, page.start, page.start + count);
	}
	beginRound(): void { this.pending.clear(); }
	coveredLines(): number { return this.covered.reduce((sum, value) => sum + value, 0); }
	missingRanges(): string {
		const ranges: string[] = [];
		for (let i = 0; i < this.covered.length; i++) {
			if (this.covered[i]) continue;
			const start = i + 1;
			while (i + 1 < this.covered.length && !this.covered[i + 1]) i++;
			ranges.push(`${start}-${i + 1}`);
			if (ranges.length === 32) { ranges.push("(further gaps omitted; complete all pages)"); break; }
		}
		return ranges.join(", ");
	}
	complete(): boolean { return this.covered.every(value => value === 1); }
}
