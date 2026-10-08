/** The measurement must distinguish successful scripts from successful nested calls. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { python3Available } from "./require-tools.ts";

const SCRIPT = new URL("../workstation/.pi/agent/scripts/measure-tool-failures.py", import.meta.url).pathname;
const SINCE = "2026-10-01T00:00:00Z";
const UNTIL = "2026-10-02T00:00:00Z";

function result(id: string, toolName: string, timestamp: string, text: string, extra = {}) {
	return { type: "message", timestamp, message: {
		role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], ...extra,
	} };
}

function report(entries: unknown[], excluded: unknown[] = []) {
	const root = mkdtempSync(join(tmpdir(), "tool-failure-measure-"));
	try {
		writeFileSync(join(root, "included.jsonl"), entries.map(e => typeof e === "string" ? e : JSON.stringify(e)).join("\n"));
		writeFileSync(join(root, "excluded.jsonl"), excluded.map(e => JSON.stringify(e)).join("\n"));
		return JSON.parse(execFileSync("python3", [SCRIPT, "--sessions-root", root,
			"--since", SINCE, "--until", UNTIL, "--exclude-session", "excluded"], { encoding: "utf8" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe.runIf(python3Available())("tool failure measurement", () => {
	it("counts caught nested errors separately and never emits raw result text or arguments", () => {
		const measured = report([
			{ type: "model_change", provider: "test", modelId: "model-a" },
			result("c1", "codemode", SINCE, "Script completed\nSECRET-SENTINEL", { nestedCalls: {
				complete: false, calls: [
					{ name: "bash", status: "ok" },
					{ name: "bash", status: "error", arguments: { command: "SECRET-SENTINEL" }, error: "Command timed out after 20 seconds" },
					{ name: "read", status: "unfinished" },
				],
			} }),
			result("c2", "codemode", SINCE, "Script failed\nScript error:\nTypeError: tools.tool_search does not exist."),
			result("c3", "bash", SINCE, "Command exited with code 1", { isError: true }),
		]);
		expect(measured.outer_by_model_day).toEqual([
			{ model: "test/model-a", day: "2026-10-01", tool: "bash", results: 1, errors: 1 },
			{ model: "test/model-a", day: "2026-10-01", tool: "codemode", results: 2, errors: 1 },
		]);
		expect(measured.nested_by_tool_status).toEqual([
			{ tool: "bash", status: "error", calls: 1 },
			{ tool: "bash", status: "ok", calls: 1 },
			{ tool: "read", status: "unfinished", calls: 1 },
		]);
		expect(measured.coverage).toMatchObject({ incomplete_nested_records: 1,
			completed_scripts_with_nested_errors: 1, nested_errors_in_completed_scripts: 1, model_only_discovery_errors: 1 });
		expect(measured.discovery_error_sessions).toBe(1);
		expect(measured.timeout_signatures).toEqual({ nested_bash: 1 });
		expect(JSON.stringify(measured)).not.toContain("SECRET-SENTINEL");
	});

	it("freezes timestamp boundaries, de-duplicates results, excludes the analysis and records malformed entries", () => {
		const included = result("b", "bash", SINCE, "ok");
		const measured = report([
			{ type: "model_change", provider: "test", modelId: "model-before-window" },
			result("old", "bash", "2026-09-30T23:59:59Z", "ok"),
			included, included,
			{ type: "model_change", provider: "test", modelId: "model-after-change" },
			result("c", "codemode", "2026-10-01T23:59:59Z", "Script completed"),
			result("new", "bash", UNTIL, "ok"),
			"not json", null,
		], [result("exclude", "bash", SINCE, "ignored", { isError: true })]);
		expect(measured.sessions).toBe(1);
		expect(measured.coverage).toMatchObject({ duplicate_results: 1, parse_errors: 2 });
		expect(measured.outer_by_model_day).toEqual([
			{ model: "test/model-after-change", day: "2026-10-01", tool: "codemode", results: 1, errors: 0 },
			{ model: "test/model-before-window", day: "2026-10-01", tool: "bash", results: 1, errors: 0 },
		]);
	});
});
