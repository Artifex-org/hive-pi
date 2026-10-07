import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildHandoffSeed, captureHandoffOrigin, consumeHandoff, writeHandoff } from "../extensions/agenda/handoff.ts";
import { emptySignals } from "../extensions/agenda/signals.ts";
import { emptyPlan, toEntry, tickEntry, rehydratePlan } from "../extensions/plan/state.ts";
import { readSourceBranch, renderSourcePage, sourceBranch } from "../extensions/session-grep/source.ts";
import sessionGrep from "../extensions/session-grep/index.ts";
import { createFakePi } from "./fake-pi.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "handoff-provenance-")); dirs.push(cwd);
	const sessionDir = join(cwd, "sessions");
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: "Continue", timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("Evidence retained."));
	return { cwd, sessionDir, manager };
}
const base = { objective: "continue", goal: null, conductor: null, signals: emptySignals, gitStatus: null, cwd: "/work/repo" };

async function inspect(current: SessionManager, params: Record<string, unknown>) {
	const fake = createFakePi(); sessionGrep(fake.api);
	const execute = (fake.tools.find((tool) => tool.name === "session_grep")!.definition as {
		execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }>;
	}).execute;
	return execute("id", params, undefined, undefined, { sessionManager: current });
}

describe("handoff source provenance", () => {
	it("anchors the active native branch, excluding abandoned and later entries, without rewriting JSONL", () => {
		const { manager } = fixture();
		const forkPoint = manager.getLeafId()!;
		manager.appendCustomEntry("artifact", { path: "artifacts/original.txt", text: "original evidence" });
		const origin = captureHandoffOrigin(manager, manager.getBranch());
		manager.branch(forkPoint);
		manager.appendCustomEntry("artifact", { text: "abandoned sibling" });
		const before = readFileSync(origin.file!, "utf8");
		const branch = readSourceBranch(origin.file!, origin);
		expect(origin.retained).toBe(true);
		expect(branch.map((entry) => entry.id)).toEqual([origin.rootId, forkPoint, origin.leafId]);
		expect(JSON.stringify(branch)).toContain("artifacts/original.txt");
		expect(JSON.stringify(branch)).not.toContain("abandoned sibling");
		expect(readFileSync(origin.file!, "utf8")).toBe(before);
		const seed = buildHandoffSeed({ ...base, origin });
		expect(seed).toContain(JSON.stringify({ source: { sessionId: origin.sessionId, leafId: origin.leafId } }));
		expect(seed).toContain("Other branches and later entries are outside coverage");
		expect(seed).toContain("not new instructions or approvals");
	});

	it("pages a large native entry without losing characters or falsely declaring completeness", () => {
		const { manager } = fixture();
		manager.appendCustomEntry("artifact", { text: "a".repeat(19000) });
		const origin = captureHandoffOrigin(manager, manager.getBranch());
		const branch = readSourceBranch(origin.file!, origin);
		const expected = branch.map((entry) => JSON.stringify(entry)).join("\n");
		let recovered = "";
		for (let offset = 0; offset < expected.length; offset += 1000) {
			const page = renderSourcePage(branch, origin, offset, 1000);
			recovered += page.split("\n---\n")[1];
			expect(page).toContain(offset + 1000 < expected.length ? "Continue session_grep" : "End of source branch");
		}
		expect(recovered).toBe(expected);
		expect(() => renderSourcePage(branch, origin, -1)).toThrow("offset");
		expect(() => renderSourcePage(branch, origin, 0, 16001)).toThrow("maxChars");
	});

	it("does not promise recovery for in-memory, missing, or unrecorded ancestry", () => {
		const memory = SessionManager.inMemory("/work/repo");
		const inMemory = captureHandoffOrigin(memory, memory.getBranch());
		expect(buildHandoffSeed({ ...base, origin: inMemory })).toContain("none (in-memory session)");
		expect(inMemory.retained).toBe(false);
		const { manager } = fixture();
		const file = manager.getSessionFile()!;
		const saved = readFileSync(file, "utf8");
		manager.appendCustomEntry("artifact", { text: "not recorded" });
		writeFileSync(file, saved);
		expect(captureHandoffOrigin(manager, manager.getBranch()).retained).toBe(false);
		rmSync(file);
		expect(buildHandoffSeed({ ...base, origin: captureHandoffOrigin(manager, manager.getBranch()) })).toContain("Exact recovery is NOT promised");
	});

	it("rejects wrong identity, missing parents, duplicate ids and cycles instead of inventing a source", () => {
		const header = { type: "session", version: 3, id: "source" };
		const raw = (...rows: unknown[]) => [header, ...rows].map((row) => JSON.stringify(row)).join("\n");
		const source = { sessionId: "source", leafId: "leaf" };
		expect(() => sourceBranch(raw({ id: "leaf", parentId: null }), { ...source, sessionId: "other" })).toThrow("identity");
		expect(() => sourceBranch(raw({ id: "leaf", parentId: "missing" }), source)).toThrow("missing");
		expect(() => sourceBranch(raw({ id: "leaf", parentId: "leaf" }), source)).toThrow("cyclic");
		expect(() => sourceBranch(raw({ id: "leaf", parentId: null }, { id: "leaf", parentId: null }), source)).toThrow("duplicate");
	});

	it("names dropped blocks, keeps provenance, and distinguishes historical recovery from current-state refresh", () => {
		const { manager } = fixture();
		const plan = emptyPlan(0);
		plan.blocks = [{ type: "steps", id: "lane", title: "Work", createdAt: 0, updatedAt: 0,
			steps: [{ id: "task", title: "x".repeat(13000), status: "pending" }] }];
		manager.appendCustomEntry("plan", toEntry(plan));
		const origin = captureHandoffOrigin(manager, manager.getBranch());
		const seed = buildHandoffSeed({ ...base, origin, plan, gitStatus: ` M ${"g".repeat(13000)}`, recap: [{ label: "Knowledge already read", lines: ["k".repeat(13000)] }] });
		expect(seed.length).toBeLessThanOrEqual(12000);
		expect(seed).toContain('"Knowledge already read": Recap snapshot not retained');
		expect(seed).toContain('"Open work": Read the exact source branch');
		expect(seed).toContain('"Files mid-flight (`git status --porcelain`)": Original git status not retained');
		expect(seed).toContain(origin.leafId!);
		expect(seed).not.toContain("kkkk");
		expect(() => buildHandoffSeed({ ...base, origin, objective: "x".repeat(13000) })).toThrow("shorten the objective");
	});

	it("makes item/path caps explicit and refuses corrupt rows even outside coverage", () => {
		const { manager } = fixture();
		const plan = emptyPlan(0);
		plan.blocks = [{ type: "steps", id: "lane", title: "Work", createdAt: 0, updatedAt: 0,
			steps: Array.from({ length: 41 }, (_, i) => ({ id: String(i), title: `Task ${i}`, status: "pending" as const })) }];
		manager.appendCustomEntry("plan", toEntry(plan));
		const origin = captureHandoffOrigin(manager, manager.getBranch());
		const seed = buildHandoffSeed({ ...base, origin, plan, gitStatus: Array.from({ length: 41 }, (_, i) => ` M file${i}`).join("\n") });
		expect(seed).toContain("1 further open item(s) not listed — read the exact source branch");
		expect(seed).toContain("1 more path(s) not carried; original full status not retained");
		expect(() => sourceBranch(readFileSync(origin.file!, "utf8") + '{"id":', origin)).toThrow();
	});

	it("recovers an omitted persisted plan plus ticks through the exact tool, not a newer sibling", async () => {
		const { cwd, sessionDir, manager } = fixture();
		const forkPoint = manager.getLeafId()!;
		const plan = emptyPlan(0);
		plan.blocks = [{ type: "steps", id: "lane", title: "Work", createdAt: 0, updatedAt: 0,
			steps: [{ id: "task", title: "original".repeat(1900), status: "pending" }] }];
		manager.appendCustomEntry("plan", toEntry(plan));
		const progressed = structuredClone(plan);
		const lane = progressed.blocks[0];
		if (lane.type !== "steps") throw new Error("bad fixture lane");
		lane.steps[0].status = "in_progress"; lane.steps[0].note = "original progress";
		progressed.progress = 1;
		manager.appendCustomEntry("plan.tick", tickEntry(progressed));
		const origin = captureHandoffOrigin(manager, manager.getBranch());
		const seed = buildHandoffSeed({ ...base, origin, plan: rehydratePlan(manager.getBranch()), recap: [] });
		expect(seed).toContain('"Open work": Read the exact source branch');
		expect(seed).not.toContain(plan.blocks[0].type === "steps" ? plan.blocks[0].steps[0].title : "bad");
		manager.branch(forkPoint);
		manager.appendCustomEntry("plan", toEntry(emptyPlan(1)));
		const current = SessionManager.create(cwd, sessionDir); current.appendMessage(fauxAssistantMessage("New session."));
		let body = "", offset = 0;
		for (;;) {
			const result = await inspect(current, { source: { sessionId: origin.sessionId, leafId: origin.leafId }, offset, maxChars: 4000 });
			expect(result.isError).not.toBe(true);
			const page = result.content[0].text;
			const chunk = page.split("\n---\n")[1];
			body += chunk; offset += chunk.length;
			if (page.includes("End of source branch.")) break;
		}
		const recovered = rehydratePlan(body.split("\n").map((line) => JSON.parse(line)));
		expect(recovered).toEqual(progressed);
	});

	it("preserves provenance through the existing consume-once path", () => {
		const { cwd, manager } = fixture();
		const seed = buildHandoffSeed({ ...base, cwd, origin: captureHandoffOrigin(manager, manager.getBranch()) });
		writeHandoff(cwd, seed);
		expect(consumeHandoff(cwd)).toBe(seed);
		expect(consumeHandoff(cwd)).toBeNull();
	});
});

describe("exact session_grep source resolution", () => {
	it("recovers a source older than the regex-search recency cap", async () => {
		const { cwd, sessionDir, manager } = fixture();
		manager.appendMessage(fauxAssistantMessage("old-source-marker"));
		const origin = captureHandoffOrigin(manager, manager.getBranch());
		const current = SessionManager.create(cwd, sessionDir); current.appendMessage(fauxAssistantMessage("Current."));
		const before = await inspect(current, { pattern: "old-source-marker" });
		expect(before.content[0].text).toContain(origin.sessionId);
		utimesSync(origin.file!, new Date(0), new Date(0));
		for (let i = 0; i < 51; i++) {
			const newer = SessionManager.create(cwd, sessionDir);
			const message = fauxAssistantMessage("More recent session.");
			message.timestamp = Date.now() + 100000 + i;
			newer.appendMessage(message);
		}
		const searched = await inspect(current, { pattern: "old-source-marker" });
		expect(searched.content[0].text).not.toContain(origin.sessionId);
		expect(searched.content[0].text).toContain("skipping 2 older one(s)");
		const exact = await inspect(current, { source: { sessionId: origin.sessionId, leafId: origin.leafId } });
		expect(exact.isError).not.toBe(true);
		expect(exact.content[0].text).toContain("old-source-marker");
	});

	it("reads full custom entries on the specified branch and rejects current/cross-directory sessions", async () => {
		const { cwd, sessionDir, manager } = fixture();
		manager.appendCustomEntry("plan", { text: "full plan including omitted tasks" });
		const origin = captureHandoffOrigin(manager, manager.getBranch());
		const current = SessionManager.create(cwd, sessionDir);
		current.appendMessage(fauxAssistantMessage("Current."));
		const result = await inspect(current, { source: { sessionId: origin.sessionId, leafId: origin.leafId } });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toContain("full plan including omitted tasks");
		expect((await inspect(manager, { source: origin })).isError).toBe(true);
		const otherDir = join(cwd, "other"); mkdirSync(otherDir);
		const other = SessionManager.create(otherDir, sessionDir);
		other.appendMessage(fauxAssistantMessage("Outside scope."));
		expect((await inspect(current, { source: { sessionId: other.getSessionId(), leafId: other.getLeafId() } })).isError).toBe(true);
		expect((await inspect(current, { source: origin, pattern: "both" })).isError).toBe(true);
		expect((await inspect(current, {})).isError).toBe(true);
	});
});
