import { describe, expect, it } from "vitest";

import { decodeArgs, PI_MCP_PROVIDER, toolDefinitions, toPiToolCall } from "./mcp.ts";

describe("advertising pi's tools to Cursor", () => {
	const tools = [
		{ name: "factory_finish", description: "End the run", parameters: { type: "object" } },
		{ name: "hive_run", description: "Look up a run", parameters: { type: "object" } },
	];

	it("advertises every pi tool with its schema", () => {
		const defs = toolDefinitions(tools);
		expect(defs.map((d) => d.name)).toEqual(["factory_finish", "hive_run"]);
		expect(defs[0].providerIdentifier).toBe(PI_MCP_PROVIDER);
		// The schema travels as a BARE OBJECT: the field is a protobuf Struct, and
		// the JSON codec renders a Struct as the object itself. MEASURED — encoded
		// as base64 (of JSON text, or of a serialized Struct) the tool is still
		// advertised and still callable, but the model sees no parameters at all
		// and calls it with `{}` forever.
		expect(defs[0].inputSchema).toEqual({ type: "object" });
	});

	// Cursor offers read/write/ls/grep/shell itself, and the bridge serves those
	// locally. Advertising pi's versions too would give the model two routes to
	// one capability with different semantics — one fast and local, one bouncing
	// through pi and ending the turn.
	it("does not re-advertise the tools Cursor already has natively", () => {
		const defs = toolDefinitions([
			{ name: "read" },
			{ name: "write" },
			{ name: "edit" },
			{ name: "ls" },
			{ name: "grep" },
			{ name: "find" },
			{ name: "bash" },
			{ name: "factory_finish" },
		]);
		expect(defs.map((d) => d.name)).toEqual(["factory_finish"]);
	});

	it("survives a tool with no description or schema", () => {
		const [def] = toolDefinitions([{ name: "bare" }]);
		expect(def.description).toBe("");
		// An absent schema becomes an empty object schema rather than undefined:
		// the field is required, and omitting it loses the whole definition.
		expect(def.inputSchema).toEqual({ type: "object", properties: {} });
	});

	it("returns nothing when the session has no tools", () => {
		expect(toolDefinitions(undefined)).toEqual([]);
		expect(toolDefinitions([])).toEqual([]);
	});
});

describe("reading a Cursor MCP call back into a pi tool call", () => {
	// The wire shape, as measured against api2.cursor.sh: `args` values are
	// protobuf Values, which the JSON codec renders as plain JSON.
	it("takes argument values exactly as they arrive", () => {
		expect(decodeArgs({ path: "src/a.ts", count: 3, deep: { a: [1, 2] } })).toEqual({
			path: "src/a.ts",
			count: 3,
			deep: { a: [1, 2] },
		});
	});

	// Two earlier versions corrupted arguments here without erroring: base64
	// decoding turned "42" into a replacement character, and String(value)
	// flattened an object to "[object Object]". Both are asserted against
	// because both reached the tool looking like a plausible argument.
	it("does not base64-decode or stringify a value", () => {
		expect(decodeArgs({ answer: "42", obj: { a: 1 } })).toEqual({
			answer: "42",
			obj: { a: 1 },
		});
	});

	it("returns a copy, so a later mutation cannot reach into the frame", () => {
		const args = { a: 1 };
		const out = decodeArgs(args);
		out.a = 2;
		expect(args.a).toBe(1);
	});

	it("builds a pi tool call, reusing Cursor's call id", () => {
		const call = toPiToolCall({
			toolName: "factory_finish",
			toolCallId: "cc-123",
			args: { kind: "fix" },
		});
		expect(call).toEqual({ id: "cc-123", name: "factory_finish", arguments: { kind: "fix" } });
	});

	it("still produces a stable id when Cursor sends none", () => {
		// pi matches a tool RESULT to its call by id, so an empty one would strand
		// the result.
		expect(toPiToolCall({ name: "factory_finish", args: {} })?.id).toBe("cursor-factory_finish");
	});

	it("returns null for a nameless call rather than inventing one", () => {
		expect(toPiToolCall({ args: {} })).toBeNull();
	});
});
