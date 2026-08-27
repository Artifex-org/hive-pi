import { describe, expect, it } from "vitest";

import {
	extractJsonBlock,
	parseStructuredResult,
	rejectUnsupportedSchema,
	structuredInstruction,
	structuredRetryTask,
	validateAgainst,
} from "../extensions/harness/structured.ts";

const SCHEMA = {
	type: "object",
	properties: {
		changed_files: { type: "array", items: { type: "string" } },
		claim: { type: "string" },
		notes: { type: "string" },
	},
	required: ["changed_files", "claim"],
};

describe("rejectUnsupportedSchema", () => {
	it("accepts an open schema", () => {
		expect(rejectUnsupportedSchema(SCHEMA)).toBeUndefined();
	});

	it("rejects additionalProperties:false at the root, naming the rule", () => {
		const rejection = rejectUnsupportedSchema({ ...SCHEMA, additionalProperties: false });
		expect(rejection).toContain("(root)");
		expect(rejection).toContain("additionalProperties");
	});

	it("rejects it nested, and reports the path", () => {
		const nested = {
			type: "object",
			properties: { inner: { type: "object", additionalProperties: false } },
		};
		expect(rejectUnsupportedSchema(nested)).toContain("properties.inner");
	});

	it("finds it inside arrays", () => {
		const inArray = { anyOf: [{ type: "object" }, { type: "object", additionalProperties: false }] };
		expect(rejectUnsupportedSchema(inArray)).toContain("anyOf[1]");
	});

	it("does not reject additionalProperties with a schema value", () => {
		expect(rejectUnsupportedSchema({ type: "object", additionalProperties: { type: "string" } })).toBeUndefined();
	});
});

describe("extractJsonBlock", () => {
	it("takes the LAST fenced block, so an explained example does not win", () => {
		const output = [
			"Here is the shape I will return:",
			"```json",
			'{"changed_files": [], "claim": "example"}',
			"```",
			"And the real answer:",
			"```json",
			'{"changed_files": ["a.ts"], "claim": "done"}',
			"```",
		].join("\n");
		const parsed = extractJsonBlock(output);
		expect(parsed.ok).toBe(true);
		expect(parsed.ok && (parsed.value as { claim: string }).claim).toBe("done");
	});

	it("accepts a bare fence without the json tag", () => {
		const parsed = extractJsonBlock('```\n{"a": 1}\n```');
		expect(parsed.ok).toBe(true);
	});

	it("falls back to parsing the whole output when unfenced", () => {
		const parsed = extractJsonBlock('  {"a": 1}  ');
		expect(parsed.ok).toBe(true);
	});

	it("falls back to an EARLIER valid block when the last one is malformed", () => {
		const output = '```json\n{"a": 1}\n```\ntrailing\n```json\n{not json\n```';
		const parsed = extractJsonBlock(output);
		expect(parsed.ok).toBe(true);
		expect(parsed.ok && (parsed.value as { a: number }).a).toBe(1);
	});

	it("reports a missing block distinctly from a malformed one", () => {
		const missing = extractJsonBlock("I could not do it, sorry.");
		expect(missing.ok).toBe(false);
		expect(!missing.ok && missing.error).toContain("No fenced JSON block");

		const malformed = extractJsonBlock("```json\n{oops\n```");
		expect(malformed.ok).toBe(false);
		expect(!malformed.ok && malformed.error).toContain("not valid JSON");
	});
});

describe("validateAgainst", () => {
	it("passes a conforming object", () => {
		const result = validateAgainst(SCHEMA, { changed_files: ["a.ts"], claim: "done" });
		expect(result.ok).toBe(true);
	});

	it("allows extra properties — the whole point of refusing closed schemas", () => {
		const result = validateAgainst(SCHEMA, { changed_files: [], claim: "done", surprise: 1 });
		expect(result.ok).toBe(true);
	});

	it("fails a missing required field with a model-facing message", () => {
		const result = validateAgainst(SCHEMA, { changed_files: [] });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("does not match the required schema");
		expect(result.error).toContain("Re-emit");
	});

	it("fails a wrong type", () => {
		expect(validateAgainst(SCHEMA, { changed_files: "a.ts", claim: "x" }).ok).toBe(false);
	});

	it("points at the offending field rather than collapsing to the root", () => {
		// Regression: typebox errors carry `instancePath`, not `path`. Reading the
		// wrong key renders every error as "(root)" and still looks plausible.
		const result = validateAgainst(SCHEMA, { changed_files: [1], claim: "x" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("/changed_files/0");
	});
});

describe("parseStructuredResult", () => {
	it("extracts and validates in one step", () => {
		const output = 'Did the thing.\n\n```json\n{"changed_files":["a.ts"],"claim":"done"}\n```';
		const result = parseStructuredResult(SCHEMA, output);
		expect(result.ok).toBe(true);
		expect((result.value as { claim: string }).claim).toBe("done");
	});

	it("surfaces the extraction failure when there is no block", () => {
		const result = parseStructuredResult(SCHEMA, "no block here");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("No fenced JSON block");
	});
});

describe("structuredInstruction / structuredRetryTask", () => {
	it("embeds the schema so the worker sees the real contract", () => {
		expect(structuredInstruction(SCHEMA)).toContain('"changed_files"');
	});

	it("carries both the original task and the failure into the retry", () => {
		const retry = structuredRetryTask("Fix the bug in foo.ts", "Your JSON block does not match");
		expect(retry).toContain("Fix the bug in foo.ts");
		expect(retry).toContain("does not match");
	});
});
