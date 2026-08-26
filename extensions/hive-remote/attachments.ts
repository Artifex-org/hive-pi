// Non-image attachment delivery (HIV-1939): classification and worktree
// placement for files the operator attached to a steer.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Text-like content the model can simply read inline. application/octet-stream
// is deliberately absent: DetectContentType on the server answers it for
// anything it does not recognize, and dumping unknown binary as UTF-8 into the
// context is exactly the failure the worktree path exists to avoid.
export function textLikeAttachment(mediaType: string): boolean {
	if (mediaType.startsWith("text/")) return true;
	switch (mediaType) {
		case "application/json":
		case "application/xml":
		case "application/x-yaml":
		case "application/yaml":
		case "application/toml":
		case "application/x-sh":
		case "image/svg+xml":
			return true;
		default:
			return false;
	}
}

// saveAttachment writes bytes under <cwd>/.hive-attachments and returns the
// RELATIVE path (what the steer text names), or null on any failure — the
// caller folds that into the message rather than dropping the steer.
export function saveAttachment(name: string, bytes: Buffer): string | null {
	try {
		const dir = join(process.cwd(), ".hive-attachments");
		mkdirSync(dir, { recursive: true });
		// The server sanitized the name to one path element; basename plus a
		// control-character strip again here as the local belt to that braces.
		let safe = Array.from(basename(name))
			.filter((c) => {
				const code = c.codePointAt(0) ?? 0;
				return code >= 0x20 && code !== 0x7f && c !== "/" && c !== "\\";
			})
			.join("")
			.trim();
		if (!safe || safe === "." || safe === "..") safe = "attachment";
		let target = join(dir, safe);
		// Collision → suffix, never overwrite: two steers may attach two
		// different files under one name.
		for (let n = 1; existsSync(target) && n < 100; n++) {
			const dot = safe.lastIndexOf(".");
			const stem = dot > 0 ? safe.slice(0, dot) : safe;
			const ext = dot > 0 ? safe.slice(dot) : "";
			target = join(dir, `${stem}-${n}${ext}`);
		}
		writeFileSync(target, bytes);
		return join(".hive-attachments", basename(target));
	} catch {
		return null;
	}
}
