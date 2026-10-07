import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import planExtension from "../extensions/plan/index.ts";
import sessionIdentity, { SESSION_IDENTITY_ENTRY } from "../extensions/hive-remote/sessionIdentity.ts";
import { SESSION_IDENTITY_CHANNEL, SESSION_IDENTITY_INITIAL_CHANNEL } from "../extensions/hive-remote/sessionIdentityBus.ts";
import { planIntroduction, introductionOps } from "../extensions/plan/introduction.ts";
import { applyOps, emptyPlan, toEntry, PLAN_ENTRY_TYPE, rehydratePlan, type PlanDoc } from "../extensions/plan/state.ts";
import { createFakePi, type FakePi } from "./fake-pi.ts";

type Execute = (id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<unknown>;
const ctx = { mode: "tui", cwd: "/tmp/fake-repo", hasUI: true, isIdle: () => true } as unknown as ExtensionContext;
function tool(fake: FakePi, name: string, params: Record<string, unknown>) {
  const recorded = fake.tools.find(t => t.name === name);
  if (!recorded) throw new Error(`Missing actual registered tool: ${name}`);
  return (recorded.definition.execute as Execute)("intro-test", params, undefined, undefined, ctx);
}
const identity = (fake: FakePi) => fake.entries.filter(e => e.customType === SESSION_IDENTITY_ENTRY).at(-1)?.data as { description: string; title: string; revision: number; titlePinned?: boolean };
const savedPlan = (fake: FakePi) => rehydratePlan(fake.entries) as PlanDoc;

describe("canonical plan introduction", () => {
  it("extracts actual prose, not headings, fenced code, bullets, quotes, or subsequent paragraphs", () => {
    const doc = { ...emptyPlan(1), phase: "drafting", blocks: [{ id: "intro", type: "text", markdown: "# Plan\n```sh\nrm -rf wrong\n```\n- evidence\n> quoted material\n    code\n\nThe real goal\nand approach.\n\nSecond paragraph." }] } as PlanDoc;
    expect(planIntroduction(doc)?.text).toBe("The real goal and approach.");
    const next = applyOps(doc, introductionOps(doc, "Revised goal and approach."), 2).doc;
    expect(planIntroduction(next)?.text).toBe("Revised goal and approach.");
    expect(next.blocks[0]).toMatchObject({ markdown: expect.stringContaining("```sh\nrm -rf wrong\n```") });
    expect(next.blocks[0]).toMatchObject({ markdown: expect.stringContaining("Second paragraph.") });
    expect(introductionOps(next, "Revised goal and approach.")).toEqual([]);
  });
  it("does not create a plan, and never overwrites a reserved-ID code block", () => {
    expect(introductionOps(emptyPlan(1), "Context only.")).toEqual([]);
    const doc = { ...emptyPlan(1), phase: "drafting", blocks: [{ id: "session-introduction", type: "text", markdown: "```sh\necho keep\n```" }] } as PlanDoc;
    const next = applyOps(doc, introductionOps(doc, "Goal and approach."), 2).doc;
    expect(next.blocks.map(b => b.id)).toEqual(["session-introduction-2", "session-introduction"]);
    expect(next.blocks[1]).toEqual(doc.blocks[0]);
  });
  it("registers the kickoff tool and synchronizes the actual plan_write persistence path without a feedback loop", async () => {
    const fake = createFakePi();
    sessionIdentity(fake.api); planExtension(fake.api);
    await fake.emit({ type: "session_start", reason: "new" });
    await tool(fake, "session_context", { goal: "Verify context", approach: "Exercise actual plan writes" });
    expect(fake.entries.some(e => e.customType === PLAN_ENTRY_TYPE)).toBe(false);
    const context = identity(fake).description;
    await tool(fake, "plan_write", { ops: [{ op: "header", title: "Context", phase: "drafting" }, { op: "lane", kind: "execute", items: [{ id: "check", title: "Verify" }] }] });
    expect(planIntroduction(savedPlan(fake))?.text).toBe(context);
    const intro = planIntroduction(savedPlan(fake))!.block.id;
    await tool(fake, "plan_write", { ops: [{ op: "upsert", id: intro, block: { type: "text", markdown: "# Goal\n\nA freshly authored plan introduction.\n\nMore evidence." } }] });
    expect(identity(fake).description).toBe("A freshly authored plan introduction.");
    expect(planIntroduction(savedPlan(fake))?.text).toBe(identity(fake).description);
    const before = identity(fake).revision;
    await tool(fake, "session_context", { goal: "Refined task", approach: "Use the existing plan" });
    expect(planIntroduction(savedPlan(fake))?.text).toBe(identity(fake).description);
    expect(identity(fake).revision).toBe(before + 1);
    expect(savedPlan(fake).blocks.find(b => b.id === intro)).toMatchObject({ markdown: expect.stringContaining("More evidence.") });
    await tool(fake, "session_context", { goal: "Refined task", approach: "Use the existing plan" });
    expect(identity(fake).revision).toBe(before + 1);
  });
  it("pins a manual name, but agent and server canonical updates are not manual renames", async () => {
    const fake = createFakePi(); sessionIdentity(fake.api);
    await fake.emit({ type: "session_start", reason: "new" });
    fake.api.events.emit(SESSION_IDENTITY_INITIAL_CHANNEL, { title: "Starting task", prompt: "Inspect the starting task" });
    fake.api.setSessionName("Starting task"); await fake.emit({ type: "session_info_changed" });
    expect(identity(fake).titlePinned).not.toBe(true);
    fake.api.setSessionName("Operator name"); await fake.emit({ type: "session_info_changed" });
    expect(identity(fake)).toMatchObject({ title: "Operator name", titlePinned: true });
    fake.api.events.emit(SESSION_IDENTITY_CHANNEL, { source: "pivot", title: "New objective", description: "Goal: a changed task. Approach: verify.", reason: "Operator changed scope" });
    expect(fake.sessionName).toBe("Operator name");
    expect(identity(fake).title).toBe("Operator name");
    expect(fake.busEvents.filter(e => e.name === SESSION_IDENTITY_CHANNEL).at(-1)?.payload).toMatchObject({ title: "New objective", source: "pivot" });
    fake.api.events.emit(SESSION_IDENTITY_CHANNEL, { canonical: { title: "Server objective", description: "Canonical context.", provisional: false, revision: 9, titlePinned: false } });
    fake.api.setSessionName("Server objective"); await fake.emit({ type: "session_info_changed" });
    expect(identity(fake).titlePinned).toBe(false);
  });
  it("honors a /name gesture before the first kickoff context exists", async () => {
    const fake = createFakePi(); sessionIdentity(fake.api);
    await fake.emit({ type: "session_start", reason: "new" });
    fake.api.setSessionName("Early manual title"); await fake.emit({ type: "session_info_changed" });
    fake.api.events.emit(SESSION_IDENTITY_INITIAL_CHANNEL, { title: "Automatically selected title", prompt: "Opening task" });
    expect(identity(fake)).toMatchObject({ title: "Early manual title", titlePinned: true });
  });
  it("does not republish stale plan/context prose on resume", async () => {
    const fake = createFakePi(); sessionIdentity(fake.api); planExtension(fake.api);
    const doc = applyOps(emptyPlan(1), [{ op: "header", phase: "drafting" }, { op: "upsert", id: "intro", block: { type: "text", markdown: "Old plan introduction." } }], 2).doc;
    await fake.emit({ type: "session_start", reason: "resume" }, { branch: [
      { type: "custom", customType: SESSION_IDENTITY_ENTRY, data: { title: "Task", description: "Canonical current context.", revision: 7, provisional: false } },
      { type: "custom", customType: PLAN_ENTRY_TYPE, data: toEntry(doc) },
    ] });
    expect(fake.busEvents.filter(e => e.name === SESSION_IDENTITY_CHANNEL)).toEqual([]);
    expect(fake.entries.filter(e => e.customType === SESSION_IDENTITY_ENTRY)).toEqual([]);
  });
});
