import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { describeMissingFile, isNotFound } from "../extensions/lens/locate.ts";

// A missing FILE used to throw a bare ENOENT out of read_symbol/list_symbols,
// so the agent learned only that its guess was wrong — never what was actually
// there. Three papercuts in two days, every one an INFERRED path:
//
//   internal/retention/reaper.go   → the package is retention.go
//   internal/mcp/mcp_test.go       → the helpers are in agentops_test.go
//   .../machine_parameter_catalog/validation.py
//
// Each cost a grep round-trip to learn something the directory listing already
// knew. The assertions below are about what the answer CONTAINS, because that
// is the whole value: a message that does not name the neighbour is the ENOENT
// again in more words.

let root: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "lens-locate-"));
	await mkdir(join(root, "internal", "retention"), { recursive: true });
	await writeFile(join(root, "internal", "retention", "retention.go"), "package retention\n");
	await writeFile(join(root, "internal", "retention", "sweep.go"), "package retention\n");
	await writeFile(join(root, "internal", "retention", "notes.md"), "#\n");
	await mkdir(join(root, "empty"), { recursive: true });
});

describe("isNotFound", () => {
	it("recognises the two errors that mean nothing is at that path", () => {
		expect(isNotFound({ code: "ENOENT" })).toBe(true);
		// A path segment that is a FILE, not a directory, fails as ENOTDIR — the
		// same situation from the caller's side, and it must not throw instead.
		expect(isNotFound({ code: "ENOTDIR" })).toBe(true);
	});

	it("does not swallow errors that mean something else", () => {
		// EACCES is a real problem worth surfacing as itself; treating it as
		// "not found" would tell the agent to go looking for a file that is
		// right there.
		expect(isNotFound({ code: "EACCES" })).toBe(false);
		expect(isNotFound(new Error("boom"))).toBe(false);
		expect(isNotFound(null)).toBe(false);
	});
});

describe("describeMissingFile — the directory exists", () => {
	// The reported case, reproduced: a real package, a guessed filename.
	it("names the file that is actually there", async () => {
		const out = await describeMissingFile(join(root, "internal", "retention", "reaper.go"));
		expect(out).toContain("does not exist");
		expect(out).toContain("retention.go");
		expect(out).toContain("sweep.go");
	});

	// Ranking is the difference between an answer and a list. A same-extension
	// sibling must come before an unrelated file.
	it("puts same-extension neighbours before the rest", async () => {
		const out = await describeMissingFile(join(root, "internal", "retention", "reaper.go"));
		expect(out.indexOf("retention.go")).toBeLessThan(out.indexOf("notes.md"));
	});

	// A stem match is the strongest signal there is — the caller had the name
	// right and the extension wrong.
	it("leads with a file of the same stem", async () => {
		await writeFile(join(root, "internal", "retention", "sweep.ts"), "export {};\n");
		const out = await describeMissingFile(join(root, "internal", "retention", "sweep.py"));
		expect(out.indexOf("sweep.ts")).toBeLessThan(out.indexOf("retention.go"));
	});

	it("says so plainly when the directory is empty", async () => {
		const out = await describeMissingFile(join(root, "empty", "anything.go"));
		expect(out).toContain("empty");
		// …and does not then offer a list it does not have.
		expect(out).not.toContain("these are in it");
	});
});

describe("describeMissingFile — the directory does not exist either", () => {
	// A different situation wanting a different next move: listing the
	// neighbours of a directory that is not there would answer a question
	// nobody asked. Say where the path stopped being real.
	it("names the segment where the path diverges, not the filename", async () => {
		const out = await describeMissingFile(
			join(root, "internal", "machine_parameter_catalog", "validation.py"),
		);
		expect(out).toContain("stops being real at");
		expect(out).toContain("machine_parameter_catalog");
		// The last REAL directory's contents are the useful part.
		expect(out).toContain("retention");
	});

	it("still answers when nothing above it can be listed", async () => {
		const out = await describeMissingFile(join(root, "a", "b", "c", "d.go"));
		expect(out).toContain("does not exist");
		expect(out).toContain("stops being real at");
		expect(out).toContain("a");
	});
});

describe("describeMissingFile is bounded and total", () => {
	// A diagnostic that walks a tree can cost more than the failure it explains.
	it("caps the list and says how many it did not show", async () => {
		const big = join(root, "big");
		await mkdir(big, { recursive: true });
		for (let i = 0; i < 40; i++) await writeFile(join(big, `f${i}.go`), "package big\n");
		const out = await describeMissingFile(join(big, "nope.go"));
		expect(out).toMatch(/and \d+ more/);
		// 12 shown + the "… and N more" line, never 40 names.
		expect(out.split("\n").filter((l) => l.startsWith("  ")).length).toBeLessThanOrEqual(13);
	});

	// It runs on a failure path. Throwing there would replace a bad message
	// with no message at all.
	it("never throws, whatever it is handed", async () => {
		await expect(describeMissingFile("")).resolves.toBeTypeOf("string");
		await expect(describeMissingFile("/proc/1/mem/nope")).resolves.toBeTypeOf("string");
		await expect(describeMissingFile(join(root, "\0bad"))).resolves.toBeTypeOf("string");
	});
});

// The WIRING. Everything above tests the helper; none of it proves read_symbol
// stopped throwing. The defect was in the tool, not in the message, and a
// helper that returns a lovely sentence nobody calls is the same ENOENT.
describe("read_symbol / list_symbols answer instead of throwing", () => {
	type Tool = {
		name: string;
		execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
	};

	async function tools(): Promise<Map<string, Tool>> {
		const map = new Map<string, Tool>();
		const fakePi = { registerTool: (t: Tool) => map.set(t.name, t) };
		const mod = await import("../extensions/lens/index.ts");
		(mod.default as unknown as (pi: typeof fakePi) => void)(fakePi);
		return map;
	}

	it("read_symbol names the neighbour rather than raising ENOENT", async () => {
		const missing = join(root, "internal", "retention", "reaper.go");
		const out = await (await tools()).get("read_symbol")!.execute("t1", {
			file: missing,
			symbol: "Reap",
		});
		const body = out.content.map((c) => c.text).join("\n");
		expect(body).toContain("does not exist");
		expect(body).toContain("retention.go");
		// Not the in-file miss message: the file is what was wrong, and saying
		// "no declaration found in <file>" about a file that is not there is
		// the wrong answer confidently given.
		expect(body).not.toContain("No declaration of");
	});

	it("list_symbols does the same", async () => {
		const out = await (await tools()).get("list_symbols")!.execute("t2", {
			file: join(root, "internal", "retention", "reaper.go"),
		});
		const body = out.content.map((c) => c.text).join("\n");
		expect(body).toContain("retention.go");
	});

	// The narrow guard earning its place: a file that EXISTS still reports a
	// missing symbol the old way. Widening the catch to every error would have
	// turned real read failures into "does not exist".
	it("leaves the existing-file paths alone", async () => {
		const real = join(root, "internal", "retention", "retention.go");
		const out = await (await tools()).get("read_symbol")!.execute("t3", {
			file: real,
			symbol: "NotThere",
		});
		const body = out.content.map((c) => c.text).join("\n");
		expect(body).toContain("No declaration of");
		expect(body).not.toContain("does not exist");
	});
});
