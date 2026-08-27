/**
 * The diagnosis, driven through pi's REAL edit applier on a REAL file.
 *
 * The unit suite grades `diagnose()` against the measured failure corpus. It
 * cannot tell you the thing that actually decides whether this ships: that the
 * wrapper is on the path pi takes when an edit fails. This house has shipped
 * that exact miss before — a knowledge tool verified by hand, registered into a
 * worker that ran `--no-extensions`, so the feature was a no-op with a green
 * suite behind it (HIV-1560 PR1).
 *
 * So: load `pretty-tools` against fake-pi, take the `edit` tool it registered,
 * and call it. pi's applier reads the file, fails to match, and throws; the
 * assertion is that what comes back quotes the file.
 *
 * It also pins the shape of the failure — a THROW, not an error-shaped success.
 * If a pi release starts returning `{isError: true}` instead, the catch block
 * silently stops firing and every diagnosis disappears with the suite green.
 * That is why the last test asserts on the throw itself.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createFakePi } from "./fake-pi.ts";
import { DIAGNOSIS_MARKER } from "../extensions/pretty-tools.ts";

interface EditTool {
	execute(id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<unknown>;
}

let editTool: EditTool;
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "hive-pi-edit-"));
	const module = (await import("../extensions/pretty-tools.ts")) as { default: (pi: unknown) => void };
	const pi = createFakePi();
	module.default(pi.api);
	const found = pi.tools.find((tool) => tool.name === "edit");
	if (!found) throw new Error("pretty-tools registered no `edit` tool — the wrapper cannot be on the path");
	editTool = found.definition as unknown as EditTool;
});

function file(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content, "utf8");
	return path;
}

async function editFails(path: string, oldText: string, newText = "REPLACED"): Promise<Error> {
	try {
		await editTool.execute("call-1", { path, edits: [{ oldText, newText }] });
	} catch (err) {
		return err as Error;
	}
	throw new Error("the edit unexpectedly SUCCEEDED — this test is not exercising the failure path");
}

describe("edit diagnosis, through pi's real applier", () => {
	it("quotes the near-miss line back on a real not-found failure", async () => {
		const path = file("SKILL.md", "# Linear Issue Manager\n\nbody\n");
		const err = await editFails(path, "# Linear Issue Management\n");

		// pi's own message survives — this augments, never replaces.
		expect(err.message).toContain("Could not find");
		expect(err.message).toContain(DIAGNOSIS_MARKER);
		expect(err.message).toContain("# Linear Issue Manager");
		expect(err.message).toMatch(/lines 1-2 \(\d+% similar\)/);
	});

	it("names the duplicate lines on a real ambiguity failure", async () => {
		const path = file("dup.ts", "function a() {\n\treturn 1;\n}\n\nfunction b() {\n\treturn 1;\n}\n");
		const err = await editFails(path, "\treturn 1;");
		expect(err.message).toContain("occurrences");
		expect(err.message).toContain(DIAGNOSIS_MARKER);
		expect(err.message).toContain("lines 2, 6");
	});

	it("tells the model to re-read when nothing in the file resembles the anchor", async () => {
		const path = file("package.json", '{\n  "name": "hive-pi"\n}\n');
		const err = await editFails(path, 'pi.on("session_start", (_event, ctx) => installFooter(ctx));\n');
		expect(err.message).toContain(DIAGNOSIS_MARKER);
		expect(err.message).toContain("Read the file");
	});

	it("leaves a successful edit completely alone", async () => {
		const path = file("ok.md", "alpha\nbeta\ngamma\n");
		await editTool.execute("call-ok", { path, edits: [{ oldText: "beta", newText: "delta" }] });
		expect(readFileSync(path, "utf8")).toBe("alpha\ndelta\ngamma\n");
	});

	it("does not add a diagnosis to a failure the anchor did not cause", async () => {
		// A missing file fails before any matching happens. The wrapper has
		// nothing to say, and pi's message must come through unchanged.
		const err = await editFails(join(dir, "does-not-exist.md"), "anything");
		expect(err.message).toContain("Could not edit file");
		expect(err.message).not.toContain(DIAGNOSIS_MARKER);
	});

	it("still FAILS — a diagnosis must never turn a failed edit into a success", async () => {
		const path = file("unchanged.md", "# Real Title\n");
		await editFails(path, "# Wrong Title\n");
		expect(readFileSync(path, "utf8")).toBe("# Real Title\n");
	});
});
