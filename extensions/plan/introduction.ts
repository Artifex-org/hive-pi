import type { PlanDoc, PlanOp, TextBlock } from "./state.ts";

/** First actual prose, excluding headings, code, lists and quote evidence. */
export function planIntroduction(doc: PlanDoc): { block: TextBlock; text: string; start: number; end: number } | undefined {
	for (const block of doc.blocks) {
		if (block.type !== "text") continue;
		let fenced = false;
		let offset = 0;
		let start: number | undefined;
		let end = 0;
		for (const line of block.markdown.split("\n")) {
			const fence = /^\s*(```|~~~)/.test(line);
			const excluded = fenced || fence || /^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(line) || /^ {4}/.test(line) || !line.trim();
			if (fence) fenced = !fenced;
			if (excluded && start !== undefined) break;
			if (!excluded) { start ??= offset; end = offset + line.length; }
			offset += line.length + 1;
		}
		if (start !== undefined) return { block, start, end, text: block.markdown.slice(start, end).replace(/\s+/g, " ").trim() };
	}
	return undefined;
}

/** Update a real document only; session context alone never creates a plan. */
export function introductionOps(doc: PlanDoc, description: string): PlanOp[] {
	if (doc.phase === "none" || !description.trim()) return [];
	const intro = planIntroduction(doc);
	if (intro?.text === description) return [];
	if (intro) return [{ op: "upsert", id: intro.block.id, block: {
		type: "text", title: intro.block.title,
		markdown: intro.block.markdown.slice(0, intro.start) + description + intro.block.markdown.slice(intro.end),
	} }];
	let id = "session-introduction";
	let suffix = 2;
	while (doc.blocks.some(block => block.id === id)) id = `session-introduction-${suffix++}`;
	return [{ op: "upsert", id, block: { type: "text", markdown: description } }, { op: "move", id }];
}
