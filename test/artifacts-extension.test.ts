/**
 * The artifacts extension's behaviour against the fake pi.
 *
 * Two things are being defended here and they pull in opposite directions.
 * One: the store must be reachable — the tools have to exist before any
 * lifecycle event, resolve a directory even when pi will not name a session
 * file, and hand back exactly the bytes that were spilled. Two: it must stay
 * silent — an extension whose whole purpose is to keep large text OUT of
 * context would be self-defeating the moment it injected anything.
 *
 * `test/fake-pi.ts` deliberately does not implement
 * `sessionManager.getSessionFile()`, which is faithful to an unpersisted
 * session and is why every test in this file exercises the tmpdir fallback.
 * The session-file branch is pinned in `artifacts-store.test.ts` against the
 * pure `resolveArtifactDir`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createFakePi, type FakePi } from "./fake-pi.ts";
import artifactsExtension, {
	ARTIFACT_DIR_ENV,
	ARTIFACT_DIR_OWNER_ENV,
	formatAge,
	renderList,
} from "../extensions/artifacts/index.ts";
import {
	PREVIEW_BYTES,
	artifactDirFor,
	listArtifacts,
	readArtifact,
	spill,
	writeArtifact,
} from "../extensions/artifacts/store.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const scratched: string[] = [];
let savedEnv: string | undefined;
let savedOwnerEnv: string | undefined;

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hive-pi-artifacts-ext-"));
	scratched.push(dir);
	return dir;
}

/** Load the extension with a controlled inherited env, as a child pi would. */
function load(inherited?: string): FakePi {
	if (inherited === undefined) delete process.env[ARTIFACT_DIR_ENV];
	else process.env[ARTIFACT_DIR_ENV] = inherited;
	const pi = createFakePi();
	artifactsExtension(pi.api);
	return pi;
}

async function call(pi: FakePi, name: string, params: Record<string, unknown> = {}): Promise<ToolResult> {
	const tool = pi.tools.find((entry) => entry.name === name);
	if (!tool) throw new Error(`${name} was never registered`);
	const execute = tool.definition.execute as (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<ToolResult>;
	// The tools only touch ctx to locate the store, which session_start has
	// already pinned in these tests; a bare object is enough and keeps the test
	// honest about how little they need.
	return execute("call-1", params, undefined, undefined, {} as ExtensionContext);
}

beforeEach(() => {
	savedEnv = process.env[ARTIFACT_DIR_ENV];
	savedOwnerEnv = process.env[ARTIFACT_DIR_OWNER_ENV];
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env[ARTIFACT_DIR_ENV];
	else process.env[ARTIFACT_DIR_ENV] = savedEnv;
	if (savedOwnerEnv === undefined) delete process.env[ARTIFACT_DIR_OWNER_ENV];
	else process.env[ARTIFACT_DIR_OWNER_ENV] = savedOwnerEnv;
	while (scratched.length > 0) {
		const dir = scratched.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("it never spends the budget it exists to protect", () => {
	// The doctrine of the whole feature: an artifact exists so large text does
	// NOT enter context unasked. An extension that announced its own artifacts
	// would be paying exactly the cost it was built to avoid, so both entry
	// points must be pulls.
	it("injects nothing — no before_agent_start, no message, no entry", async () => {
		const pi = load(scratch());
		await pi.emit({ type: "session_start" });
		await call(pi, "artifact_list");

		expect(pi.handlers.has("before_agent_start")).toBe(false);
		expect(pi.messages).toEqual([]);
		expect(pi.userMessages).toEqual([]);
		expect(pi.entries).toEqual([]);
	});

	// Subscribing to any of these switches on a pi transform path for every LLM
	// call in the process, whether or not this extension does anything.
	it("subscribes to none of the forbidden per-call events", () => {
		const pi = load(scratch());
		for (const forbidden of ["context", "before_provider_request", "before_provider_headers"]) {
			expect(pi.handlers.has(forbidden), forbidden).toBe(false);
		}
	});
});

describe("registration", () => {
	// Registration must not sit behind session_start: the tools have to exist
	// before the first turn, and an extension that registers only from a
	// handler is invisible to the capability conformance sweep, which loads
	// every extension and emits nothing.
	it("registers both tools in the factory, before any lifecycle event", () => {
		const pi = load(scratch());
		expect(pi.tools.map((tool) => tool.name).sort()).toEqual(["artifact_list", "artifact_read"]);
	});

	// An empty capability is rejected by test/tool-capability.test.ts; a wrong
	// one is worse, because it reads as review. Both tools genuinely only read,
	// so the honest declaration is why they are exempt from path guarding.
	it("declares an honest, non-empty capability on each tool", () => {
		const pi = load(scratch());
		for (const tool of pi.tools) {
			const capability = tool.definition.capability as { writesExemptBecause?: string; writes?: unknown };
			expect(typeof capability?.writesExemptBecause, tool.name).toBe("string");
			expect(capability.writes, tool.name).toBeUndefined();
		}
	});
});

describe("where the store ends up", () => {
	// The export IS the child-adoption mechanism. Without it a delegated pi
	// spills into its own directory and the parent never sees the bytes.
	it("exports PI_ARTIFACT_DIR at session_start, naming a directory that exists", async () => {
		delete process.env[ARTIFACT_DIR_ENV];
		const pi = load();
		await pi.emit({ type: "session_start" });

		const exported = process.env[ARTIFACT_DIR_ENV];
		expect(exported).toBeDefined();
		expect(exported).toContain("pi-artifacts-");
		expect(existsSync(exported!)).toBe(true);
		scratched.push(exported!);
	});

	// A child must JOIN its parent's store rather than start its own. This is
	// the case the env var exists for, and the only one where the extension
	// deliberately ignores its own session.
	it("adopts an inherited PI_ARTIFACT_DIR rather than minting its own", async () => {
		const parentStore = scratch();
		const pi = load(parentStore);
		await pi.emit({ type: "session_start" });
		expect(process.env[ARTIFACT_DIR_ENV]).toBe(parentStore);
	});

	// The distinction the OWNER marker exists to make, and the bug it fixes:
	// pi rebuilds extensions on every session replacement, so the factory runs
	// again in the SAME process and reads back what the previous session
	// exported. Without ownership, session two adopts session one's store and
	// silently appends to it — the artifact-store shape of HIV-1966.
	it("does NOT adopt a directory this process exported for an earlier session", async () => {
		delete process.env[ARTIFACT_DIR_ENV];
		delete process.env[ARTIFACT_DIR_OWNER_ENV];

		const first = load();
		await first.emit({ type: "session_start" });
		const firstStore = process.env[ARTIFACT_DIR_ENV]!;
		scratched.push(firstStore);
		expect(process.env[ARTIFACT_DIR_OWNER_ENV]).toBe(String(process.pid));

		// A second session in the same process: same env, fresh factory.
		const second = load();
		await second.emit({ type: "session_start" });
		const secondStore = process.env[ARTIFACT_DIR_ENV]!;
		scratched.push(secondStore);

		expect(secondStore).not.toBe(firstStore);
	});

	it("still adopts a directory a PARENT process exported", async () => {
		// The inverse control: an owner marker naming a different pid is a real
		// parent, and joining its store is the whole point of the variable.
		const parentStore = scratch();
		process.env[ARTIFACT_DIR_ENV] = parentStore;
		process.env[ARTIFACT_DIR_OWNER_ENV] = String(process.pid + 1);
		const pi = load(parentStore);
		await pi.emit({ type: "session_start" });
		expect(process.env[ARTIFACT_DIR_ENV]).toBe(parentStore);
	});

	// A fork inherits the REFS (pi copies custom entries into it), so it has to
	// inherit the BYTES. Without this the forked session renders `artifact://7`
	// from its own history and then cannot read it — a transcript that lies to
	// the session holding it. `adoptDir` was written and tested for this and had
	// no caller at all until the seam audit found it.
	it("adopts the parent's artifacts when the session is a FORK", async () => {
		const parentSession = join(mkdtempSync(join(tmpdir(), "pi-fork-parent-")), "1700000000_abc.jsonl");
		const parentStore = artifactDirFor(parentSession);
		mkdirSync(parentStore, { recursive: true });
		writeArtifact(parentStore, 7, "bash", "the parent's bytes");
		scratched.push(parentStore);

		delete process.env[ARTIFACT_DIR_ENV];
		delete process.env[ARTIFACT_DIR_OWNER_ENV];
		const pi = load();
		await pi.emit({ type: "session_start", reason: "fork", previousSessionFile: parentSession });

		const forkStore = process.env[ARTIFACT_DIR_ENV]!;
		scratched.push(forkStore);
		expect(forkStore).not.toBe(parentStore);
		// The ref the fork inherited in its transcript now resolves in the fork.
		expect(readArtifact(forkStore, "artifact://7")).toContain("the parent's bytes");
	});

	it("does not adopt on an ordinary start — only a fork inherits refs", async () => {
		// The inverse control. Copying someone else's store into every new session
		// would be the cross-session bleed the OWNER marker exists to prevent.
		const parentSession = join(mkdtempSync(join(tmpdir(), "pi-fork-parent-")), "1700000000_def.jsonl");
		const parentStore = artifactDirFor(parentSession);
		mkdirSync(parentStore, { recursive: true });
		writeArtifact(parentStore, 3, "bash", "not yours");
		scratched.push(parentStore);

		delete process.env[ARTIFACT_DIR_ENV];
		delete process.env[ARTIFACT_DIR_OWNER_ENV];
		const pi = load();
		await pi.emit({ type: "session_start", reason: "startup", previousSessionFile: parentSession });

		const store = process.env[ARTIFACT_DIR_ENV]!;
		scratched.push(store);
		expect(readArtifact(store, "artifact://3")).toBeNull();
	});

	// fake-pi's sessionManager has no getSessionFile, which is exactly what an
	// unpersisted session looks like. A bare call would TypeError inside a
	// handler that pi awaits, i.e. in the agent loop.
	it("survives a sessionManager that cannot name a session file", async () => {
		const pi = load(scratch());
		await expect(pi.emit({ type: "session_start" })).resolves.toBeDefined();
	});

	// A tool called before session_start (or in a session where it never fired)
	// must still work rather than throw — resolution is lazy for this reason.
	it("resolves the store lazily, so a tool called before session_start still answers", async () => {
		const store = scratch();
		const pi = load(store);
		const result = await call(pi, "artifact_list");
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("No artifacts");
	});
});

describe("artifact_read", () => {
	it("returns exactly the bytes that were spilled", async () => {
		const store = scratch();
		const body = `${"x".repeat(3_000)}THE-ERROR`;
		const { ref } = spill(body, { dir: store, kind: "build", previewBytes: PREVIEW_BYTES });

		const pi = load(store);
		await pi.emit({ type: "session_start" });
		const result = await call(pi, "artifact_read", { ref });

		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toBe(body);
	});

	// A model that saw `artifact://7` scroll past will type `7`. Refusing that
	// costs a turn and teaches nothing.
	it("accepts a bare id as readily as the full reference", async () => {
		const store = scratch();
		writeArtifact(store, 4, "note", "the finding");
		const pi = load(store);
		expect((await call(pi, "artifact_read", { ref: "4" })).content[0].text).toBe("the finding");
	});

	// The failure has to name the remedy. "Not found" with the ids listed is
	// one step from recovery; a bare error is a dead end.
	it("errors usefully on an id this session does not have", async () => {
		const store = scratch();
		writeArtifact(store, 2, "note", "something");
		const pi = load(store);
		const result = await call(pi, "artifact_read", { ref: "artifact://99" });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("artifact://2");
	});

	// The capability declaration says this tool addresses artifacts by id and
	// nothing else. A path must fail as a malformed REFERENCE, never be tried.
	it("refuses a path-shaped reference instead of reading a file", async () => {
		const pi = load(scratch());
		const result = await call(pi, "artifact_read", { ref: "../../etc/passwd" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not an artifact reference");
	});

	it("pages with head and tail, and shows both ends when given both", async () => {
		const store = scratch();
		writeArtifact(store, 1, "log", "one\ntwo\nthree\nfour\nfive");
		const pi = load(store);

		expect((await call(pi, "artifact_read", { ref: "1", head: 2 })).content[0].text).toBe("one\ntwo");
		expect((await call(pi, "artifact_read", { ref: "1", tail: 2 })).content[0].text).toBe("four\nfive");
		expect((await call(pi, "artifact_read", { ref: "1", head: 1, tail: 1 })).content[0].text).toBe(
			"one\n[…]\nfive",
		);
	});

	// The byte cap still applies after a line selection: "the last 5 lines" of a
	// minified bundle is one enormous line, and the cap is what keeps this
	// tool's cost predictable rather than a function of the artifact's newlines.
	it("caps the answer by BYTES even when the caller asked for lines", async () => {
		const store = scratch();
		writeArtifact(store, 1, "bundle", "a".repeat(200_000));
		const pi = load(store);
		const result = await call(pi, "artifact_read", { ref: "1", tail: 1 });
		expect(result.content[0].text.length).toBeLessThan(100_000);
		expect(result.content[0].text).toContain("dropped from the head");
	});
});

describe("artifact_list", () => {
	it("indexes what the session spilled without reading any of it", async () => {
		const store = scratch();
		spill("a".repeat(4_000), { dir: store, kind: "build", previewBytes: 100 });
		spill("b".repeat(9_000), { dir: store, kind: "test-output", previewBytes: 100 });

		const pi = load(store);
		const listed = (await call(pi, "artifact_list")).content[0].text;

		expect(listed).toContain("artifact://1");
		expect(listed).toContain("build");
		expect(listed).toContain("artifact://2");
		expect(listed).toContain("test-output");
		// The index must not smuggle the bodies back in — that would cost the
		// whole budget the store was built to save.
		expect(listed).not.toContain("aaaa");
		expect(listed).not.toContain("bbbb");
	});

	// The empty case is not an error and should say what will fill it,
	// otherwise a model reads "0 artifacts" as a broken store.
	it("explains itself when the store is empty", () => {
		expect(renderList([], Date.now())).toContain("No artifacts");
	});

	it("reports size and age per row", () => {
		const now = 1_000_000;
		const rendered = renderList(
			[{ id: 3, kind: "build", bytes: 4_096, modifiedAtMs: now - 90_000, file: "/x/3.build.log" }],
			now,
		);
		expect(rendered).toContain("artifact://3");
		expect(rendered).toContain("4096 bytes");
		expect(rendered).toContain("1m ago");
	});
});

describe("age formatting", () => {
	// An artifact's usefulness decays by the hour, so the unit has to change
	// with the scale — "5400s ago" is a number nobody reads as 90 minutes.
	it("changes unit with the scale", () => {
		expect(formatAge(5_000)).toBe("5s ago");
		expect(formatAge(90_000)).toBe("1m ago");
		expect(formatAge(3 * 3_600_000)).toBe("3h ago");
		expect(formatAge(72 * 3_600_000)).toBe("3d ago");
	});

	// Clock skew between a copied artifact's mtime and this process is real
	// after an adoptDir; a negative age must not render as "-1s ago".
	it("does not produce a negative age", () => {
		expect(formatAge(-5_000)).toBe("just now");
	});
});

describe("the store the tools read is the store the spiller wrote", () => {
	// The seam other streams depend on: a producer calls `spill` with the
	// directory from PI_ARTIFACT_DIR, and `artifact_read` finds it. If these
	// two ever disagreed about the directory the feature would be silently
	// half-broken — refs handed out, nothing readable.
	it("round-trips a spill through the exported directory", async () => {
		delete process.env[ARTIFACT_DIR_ENV];
		const pi = load();
		await pi.emit({ type: "session_start" });
		const exported = process.env[ARTIFACT_DIR_ENV]!;
		scratched.push(exported);

		const { ref } = spill("m".repeat(6_000), { dir: exported, kind: "finding", previewBytes: 100 });
		expect(listArtifacts(exported)).toHaveLength(1);
		expect((await call(pi, "artifact_read", { ref: ref! })).content[0].text).toBe("m".repeat(6_000));
	});
});
