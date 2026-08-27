import { describe, expect, it } from "vitest";

import {
	commandsFor,
	hintForFailedRead,
	looksLikeRef,
	parseRef,
	renderConflict,
} from "../extensions/refs/schemes.ts";

describe("parseRef", () => {
	it("parses each supported scheme", () => {
		expect(parseRef("pr://1428")).toEqual({ kind: "ref", ref: { scheme: "pr", target: "1428" } });
		expect(parseRef("conflict://src/foo.ts")).toEqual({
			kind: "ref",
			ref: { scheme: "conflict", target: "src/foo.ts" },
		});
		expect(parseRef("issue://HIV-1560")).toEqual({ kind: "ref", ref: { scheme: "issue", target: "HIV-1560" } });
	});

	it("is case-insensitive on the scheme and trims", () => {
		expect(parseRef("  PR://12  ")).toEqual({ kind: "ref", ref: { scheme: "pr", target: "12" } });
	});

	it("distinguishes an unknown scheme from a plain path", () => {
		expect(parseRef("ftp://host/x").kind).toBe("unknown-scheme");
		expect(parseRef("src/foo.ts").kind).toBe("not-a-ref");
		// A Windows-ish path or a bare colon must not read as a scheme.
		expect(parseRef("C:/tmp/x").kind).toBe("not-a-ref");
		expect(parseRef("note:something").kind).toBe("not-a-ref");
	});
});

describe("looksLikeRef", () => {
	it("accepts scheme-shaped strings only", () => {
		expect(looksLikeRef("pr://1")).toBe(true);
		expect(looksLikeRef("ftp://x")).toBe(true); // shaped, though unsupported
		expect(looksLikeRef("src/a.ts")).toBe(false);
		expect(looksLikeRef(undefined)).toBe(false);
		expect(looksLikeRef(42)).toBe(false);
	});
});

describe("commandsFor", () => {
	it("builds a gh command for a PR number, tolerating a leading #", () => {
		const resolved = commandsFor({ scheme: "pr", target: "#1428" });
		expect(resolved.kind).toBe("command");
		expect(resolved.kind === "command" && resolved.commands[0]).toMatchObject({ command: "gh" });
		expect(resolved.kind === "command" && resolved.commands[0].args).toContain("1428");
	});

	it("refuses a non-numeric PR target instead of shelling it", () => {
		const resolved = commandsFor({ scheme: "pr", target: "foo; rm -rf /" });
		expect(resolved.kind).toBe("error");
	});

	it("routes a numeric issue to gh", () => {
		const gh = commandsFor({ scheme: "issue", target: "42" });
		expect(gh.kind === "command" && gh.commands[0].command).toBe("gh");
	});

	it("refuses a Linear key and names the MCP tool instead of shelling to a CLI we do not have", () => {
		// Regression: the first version shelled out to a `linear` binary that does
		// not exist on this machine — a documented path dying on ENOENT.
		const linear = commandsFor({ scheme: "issue", target: "hiv-1560" });
		expect(linear.kind).toBe("error");
		expect(linear.kind === "error" && linear.message).toContain("HIV-1560");
		expect(linear.kind === "error" && linear.message).toContain("MCP");
	});

	it("refuses a malformed issue target", () => {
		expect(commandsFor({ scheme: "issue", target: "not a key" }).kind).toBe("error");
	});

	it("asks git for all three conflict stages", () => {
		const resolved = commandsFor({ scheme: "conflict", target: "src/foo.ts" });
		expect(resolved.kind).toBe("command");
		expect(resolved.kind === "command" && resolved.commands.map((c) => c.args[1])).toEqual([
			":1:src/foo.ts",
			":2:src/foo.ts",
			":3:src/foo.ts",
		]);
	});

	// The second-worktree case (three sessions, 2026-08-19..21): the conflicted
	// index belongs to the file's own worktree, not the session's cwd, so an
	// absolute target must carry its own cwd and a `./`-relative pathspec
	// (git's bare `:N:path` form is ROOT-relative and would miss from a subdir).
	it("resolves an absolute conflict target against the file's own directory", () => {
		const resolved = commandsFor({ scheme: "conflict", target: "/repos/wt/internal/store/tenants.go" });
		expect(resolved.kind).toBe("command");
		if (resolved.kind !== "command") return;
		expect(resolved.commands.map((c) => c.args[1])).toEqual([
			":1:./tenants.go",
			":2:./tenants.go",
			":3:./tenants.go",
		]);
		for (const c of resolved.commands) expect(c.cwd).toBe("/repos/wt/internal/store");
	});

	it("refuses an absolute conflict target that is a bare directory", () => {
		const resolved = commandsFor({ scheme: "conflict", target: "/repos/wt/" });
		expect(resolved.kind).toBe("error");
	});

	it("leaves a relative conflict target running in the session's cwd", () => {
		const resolved = commandsFor({ scheme: "conflict", target: "src/foo.ts" });
		expect(resolved.kind === "command" && resolved.commands.every((c) => c.cwd === undefined)).toBe(true);
	});

	it("refuses an empty conflict target and says how to list them", () => {
		const resolved = commandsFor({ scheme: "conflict", target: "" });
		expect(resolved.kind).toBe("error");
		expect(resolved.kind === "error" && resolved.message).toContain("--diff-filter=U");
	});

	it("never puts the target in a shell string — args stay separate", () => {
		const resolved = commandsFor({ scheme: "conflict", target: "a b; rm -rf /" });
		// The whole target is ONE argv entry, so a shell never sees the semicolon.
		expect(resolved.kind === "command" && resolved.commands[0].args).toEqual(["show", ":1:a b; rm -rf /"]);
	});
});

describe("renderConflict", () => {
	it("labels all three stages", () => {
		const rendered = renderConflict("src/foo.ts", [
			{ ok: true, text: "base" },
			{ ok: true, text: "ours" },
			{ ok: true, text: "theirs" },
		]);
		expect(rendered).toContain("base (common ancestor)");
		expect(rendered).toContain("ours (current branch)");
		expect(rendered).toContain("theirs (incoming)");
	});

	it("reports an absent stage as meaningful rather than as an error", () => {
		const rendered = renderConflict("src/foo.ts", [
			{ ok: false, text: "fatal: path does not exist" },
			{ ok: true, text: "ours" },
			{ ok: true, text: "theirs" },
		]);
		expect(rendered).toContain("absent");
		expect(rendered).not.toContain("fatal:");
	});
});

describe("hintForFailedRead", () => {
	it("names read_ref for a supported scheme", () => {
		expect(hintForFailedRead("pr://1428")).toContain("read_ref");
	});

	it("says which scheme was unsupported", () => {
		const hint = hintForFailedRead("ftp://host/x");
		expect(hint).toContain("ftp://");
		expect(hint).toContain("conflict://");
	});
});
