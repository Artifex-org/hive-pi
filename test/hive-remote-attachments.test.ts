import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveAttachment, textLikeAttachment } from "../extensions/hive-remote/attachments.ts";

// The two halves of non-image delivery (HIV-1939): what inlines as text, and
// what lands in the worktree without ever overwriting or escaping it.

describe("textLikeAttachment", () => {
	it("inlines text-shaped types and refuses unknown binary", () => {
		for (const t of ["text/plain", "text/csv", "application/json", "application/xml", "image/svg+xml"]) {
			expect(textLikeAttachment(t), t).toBe(true);
		}
		for (const t of ["application/octet-stream", "application/pdf", "application/zip", "image/png"]) {
			expect(textLikeAttachment(t), t).toBe(false);
		}
	});
});

describe("saveAttachment", () => {
	let dir: string;
	let prevCwd: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hive-att-"));
		prevCwd = process.cwd();
		process.chdir(dir);
	});
	afterEach(() => {
		process.chdir(prevCwd);
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes under .hive-attachments and returns the relative path", () => {
		const rel = saveAttachment("report.pdf", Buffer.from("pdf-bytes"));
		expect(rel).toBe(join(".hive-attachments", "report.pdf"));
		expect(readFileSync(join(dir, rel!), "utf8")).toBe("pdf-bytes");
	});

	it("suffixes on collision instead of overwriting", () => {
		const first = saveAttachment("data.bin", Buffer.from("one"));
		const second = saveAttachment("data.bin", Buffer.from("two"));
		expect(first).toBe(join(".hive-attachments", "data.bin"));
		expect(second).toBe(join(".hive-attachments", "data-1.bin"));
		expect(readFileSync(join(dir, first!), "utf8")).toBe("one");
		expect(readFileSync(join(dir, second!), "utf8")).toBe("two");
	});

	it("never escapes the attachment directory, whatever the name claims", () => {
		const rel = saveAttachment("../../etc/passwd", Buffer.from("x"));
		expect(rel).toBe(join(".hive-attachments", "passwd"));
		const empty = saveAttachment("..", Buffer.from("y"));
		expect(empty).toBe(join(".hive-attachments", "attachment"));
	});
});
