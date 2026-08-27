import { describe, expect, it } from "vitest";
import { findSymbol, langOf, listSymbols } from "../extensions/lens/symbols.ts";

// A delimiter scan stands in for a parser here, so the tests that matter are
// the ones where a naive scan is WRONG: braces in strings and comments, nested
// blocks, declarations that never open a block, and uses of a name that are not
// declarations. Getting any of those wrong returns a plausible span, and a
// plausible-but-wrong body is worse than no answer.

const GO = `package main

// Add returns the sum.
//
// The doc comment is the point: it is where the why lives.
func Add(a, b int) int {
	if a > b {
		return a + b
	}
	return a + b
}

type ID string

func (s *Server) Handle(w http.ResponseWriter) {
	s.log("}")  // a brace in a string AND a comment: }
}

const Limit = 10
`;

describe("findSymbol — Go", () => {
	it("returns the body with its doc comment", () => {
		const [s] = findSymbol(GO, "main.go", "Add");
		expect(s.signature).toBe("func Add(a, b int) int {");
		expect(s.text).toContain("// Add returns the sum.");
		expect(s.text).toContain("return a + b");
		expect(s.text.trimEnd().endsWith("}")).toBe(true);
		// Must not run into the next declaration.
		expect(s.text).not.toContain("type ID");
	});

	it("handles a method whose body contains a brace in a string and a comment", () => {
		const [s] = findSymbol(GO, "main.go", "Handle");
		expect(s.signature).toContain("func (s *Server) Handle");
		expect(s.text).toContain('s.log("}")');
		expect(s.text).not.toContain("const Limit");
		// One line of body plus signature and closing brace.
		expect(s.endLine - s.startLine).toBe(2);
	});

	it("handles a declaration that never opens a block", () => {
		const [s] = findSymbol(GO, "main.go", "ID");
		expect(s.text.trim()).toBe("type ID string");
	});

	it("finds a const", () => {
		expect(findSymbol(GO, "main.go", "Limit")[0].text.trim()).toBe("const Limit = 10");
	});
});

const TS = `import { x } from "y";

/** Doc for build. */
export function build(opts: Opts): string {
	const tpl = \`a } b\`;      // a brace inside a template literal
	if (opts) {
		return tpl + "}";
	}
	return "";
}

export const factory = (n: number) => {
	return () => n;
};

export interface Shape {
	area(): number;
}

export class Widget {
	private size = 0;

	render(): string {
		return "{}";
	}
}

// build(1) is a CALL, not a declaration
const later = build(1);
`;

describe("findSymbol — TypeScript", () => {
	it("does not stop at a brace inside a template literal", () => {
		const [s] = findSymbol(TS, "a.ts", "build");
		expect(s.text).toContain("a } b");
		expect(s.text).toContain('return tpl + "}"');
		expect(s.text).not.toContain("export const factory");
	});

	it("finds an arrow-function const", () => {
		const [s] = findSymbol(TS, "a.ts", "factory");
		expect(s.text).toContain("return () => n;");
		expect(s.text).not.toContain("interface Shape");
	});

	it("finds an interface", () => {
		expect(findSymbol(TS, "a.ts", "Shape")[0].text).toContain("area(): number;");
	});

	it("finds a class and stops at its end", () => {
		const [s] = findSymbol(TS, "a.ts", "Widget");
		expect(s.text).toContain("render(): string");
		expect(s.text).not.toContain("const later");
	});

	it("finds a class member", () => {
		const [s] = findSymbol(TS, "a.ts", "render");
		expect(s.text).toContain('return "{}";');
	});

	// The distinction the anchoring exists for. A call site would return a span
	// starting mid-file that looks like a real answer.
	it("never matches a call site as a declaration", () => {
		const found = findSymbol(TS, "a.ts", "build");
		expect(found).toHaveLength(1);
		expect(found[0].signature).toContain("export function build");
	});

	// A name in prose is not a declaration.
	it("ignores a declaration written inside a comment", () => {
		const src = `// export function ghost() {\n//   return 1;\n// }\nexport const real = 1;\n`;
		expect(findSymbol(src, "a.ts", "ghost")).toHaveLength(0);
	});
});

const PY = `import os


class Store:
    """Docstring."""

    def get(self, key):
        # a comment with a colon: and a brace }
        return self.data[key]

    def put(self, key, value):
        self.data[key] = value


@decorator
def standalone(a):
    if a:

        return 1

    return 0


X = 1
`;

describe("findSymbol — Python", () => {
	it("ends a method at the next sibling, not at the first blank line", () => {
		const [s] = findSymbol(PY, "s.py", "get");
		expect(s.text).toContain("return self.data[key]");
		expect(s.text).not.toContain("def put");
	});

	it("keeps blank lines inside a body", () => {
		const [s] = findSymbol(PY, "s.py", "standalone");
		expect(s.text).toContain("return 1");
		expect(s.text).toContain("return 0");
		expect(s.text).not.toContain("X = 1");
	});

	it("includes decorators", () => {
		expect(findSymbol(PY, "s.py", "standalone")[0].text).toContain("@decorator");
	});

	it("finds a class and stops before the next top-level statement", () => {
		const [s] = findSymbol(PY, "s.py", "Store");
		expect(s.text).toContain("def put");
		expect(s.text).not.toContain("@decorator");
	});
});

describe("findSymbol — general", () => {
	// Returning only the first would be a confidently wrong answer whenever a
	// name is both an interface and its implementation.
	it("returns every declaration of a repeated name, contract included", () => {
		const src = `type Runner interface {\n\tRun() error\n}\n\nfunc (a *A) Run() error {\n\treturn nil\n}\n\nfunc (b *B) Run() error {\n\treturn nil\n}\n`;
		const found = findSymbol(src, "r.go", "Run");
		// Three, not two: the interface method is a declaration of Run and is the
		// most useful one of the set — the contract both implementations satisfy.
		expect(found).toHaveLength(3);
		expect(found[0].signature).toBe("Run() error");
		expect(found.map((s) => s.signature)).toEqual(["Run() error", "func (a *A) Run() error {", "func (b *B) Run() error {"]);
	});

	it("is case-sensitive and whole-word", () => {
		const src = `func Build() {}\nfunc BuildAll() {}\nfunc build() {}\n`;
		const found = findSymbol(src, "b.go", "Build");
		expect(found).toHaveLength(1);
		expect(found[0].signature).toBe("func Build() {}");
	});

	it("returns nothing rather than guessing when absent", () => {
		expect(findSymbol("func A() {}\n", "a.go", "Missing")).toEqual([]);
		expect(findSymbol("func A() {}\n", "a.go", "")).toEqual([]);
	});

	// The property is termination and a bounded span, not a particular line: an
	// unclosed block runs to end-of-file, which is the honest answer.
	it("does not hang or throw on an unterminated block", () => {
		const src = "func Broken() {\n\tif x {\n";
		const [s] = findSymbol(src, "b.go", "Broken");
		expect(s.startLine).toBe(1);
		expect(s.endLine).toBe(src.split("\n").length);
		expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
	});

	it("treats a regex-special name as a literal", () => {
		expect(findSymbol("const a = 1\n", "a.ts", "a.*")).toEqual([]);
	});
});

describe("langOf", () => {
	it("routes python by extension and everything else to braces", () => {
		expect(langOf("a.py")).toBe("python");
		expect(langOf("a.pyi")).toBe("python");
		expect(langOf("a.go")).toBe("brace");
		expect(langOf("a.tsx")).toBe("brace");
		expect(langOf("Makefile")).toBe("brace");
	});
});

describe("listSymbols", () => {
	it("outlines top-level declarations and one level of members", () => {
		const found = listSymbols(TS, "a.ts");
		const sigs = found.map((s) => s.signature);
		expect(sigs).toContain("export function build(opts: Opts): string");
		expect(sigs).toContain("export class Widget");
		// Members ARE listed now, at depth 1. Without them list_symbols could not
		// supply the name read_symbol needs on a class — the two tools did not
		// compose on exactly the files where an outline helps most.
		const member = found.find((s) => s.signature.startsWith("render"));
		expect(member).toBeDefined();
		expect(member!.depth).toBe(1);
		expect(found.find((s) => s.signature === "export class Widget")!.depth).toBe(0);
	});

	// One level only: listing every member of every nested scope turns an
	// outline back into the file, which is what it exists to avoid.
	it("does not descend past one level", () => {
		const src = ["class A {", "\tm() {", "\t\tconst inner = () => {};", "\t}", "}"].join("\n");
		expect(listSymbols(src, "a.ts").every((s) => s.depth <= 1)).toBe(true);
	});

	it("reports 1-indexed lines", () => {
		const [first] = listSymbols("\n\nfunc A() {}\n", "a.go");
		expect(first.line).toBe(3);
	});

	it("outlines python, methods included", () => {
		const found = listSymbols(PY, "s.py");
		const sigs = found.map((s) => s.signature);
		expect(sigs).toContain("class Store:");
		// The case that motivated this: `class Store:` used to outline to itself
		// and NOTHING else, so there was no name to hand to read_symbol.
		const method = found.find((s) => s.signature.startsWith("def get"));
		expect(method).toBeDefined();
		expect(method!.depth).toBe(1);
	});
});

// The bug the original "never matches a call site" test could not catch: it
// only covered an UNINDENTED call, which the `^[ \t]+` anchor already excluded.
// Observed live — read_symbol(workstation_loop.go, runWorkstationLane) returned
// the call site at 131-131 as its first "declaration".
it("never matches an INDENTED call site as a declaration", () => {
	const src = [
		"func main() {",
		"\trunWorkstationLane(ctx, p, log)",
		"}",
		"",
		"func runWorkstationLane(ctx context.Context, p Params, log Logger) {",
		"\treturn",
		"}",
	].join("\n");
	const found = findSymbol(src, "workstation_loop.go", "runWorkstationLane");
	expect(found).toHaveLength(1);
	expect(found[0].startLine).toBe(5);
});

it("still finds a real class member", () => {
	const src = ["class Store {", "\tasync get(key: string) {", "\t\treturn 1;", "\t}", "}"].join("\n");
	expect(findSymbol(src, "store.ts", "get")).toHaveLength(1);
});

it("finds a method that opens a body without any modifier", () => {
	const src = ["class Store {", "\tget(key) {", "\t\treturn 1;", "\t}", "}"].join("\n");
	expect(findSymbol(src, "store.js", "get")).toHaveLength(1);
});

it("finds an interface member, which a call statement can never look like", () => {
	const src = ["interface FS {", "\tread(path: string): Promise<string>;", "}"].join("\n");
	expect(findSymbol(src, "fs.ts", "read")).toHaveLength(1);
});

// .hive/main.star is one of the most-read files in this workspace and its
// grammar is Python's, not the brace family's.
it("reads Starlark as Python", () => {
	const src = ["def ci(ctx):", '    return "x"', "", "def other(ctx):", "    pass"].join("\n");
	const found = findSymbol(src, ".hive/main.star", "ci");
	expect(found).toHaveLength(1);
	expect(found[0].startLine).toBe(1);
});
