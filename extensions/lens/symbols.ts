/**
 * lens — locating a symbol's source without reading the whole file.
 *
 * PURE, and deliberately dependency-free. The obvious implementation is a real
 * parser (pi-lens uses ast-grep's native binding), and the obvious cost is a
 * native module in a package the Hive factory image also installs. For the one
 * question actually being asked — "where does `foo` start and end" — a
 * delimiter scan that knows about strings and comments is enough, and it is
 * enough for every language we work in rather than only the ones a grammar was
 * downloaded for.
 *
 * What this deliberately does NOT do: resolve references, rank identifiers,
 * follow imports, or understand types. Those want a real index, and when we
 * need one the answer is an LSP or `ast-grep`, not a bigger regex.
 */

export type Lang = "brace" | "python";

/** Language family by extension. Unknown extensions read as brace-delimited,
 *  which is right for the C-family majority and degrades to "found nothing"
 *  rather than to a wrong answer. */
export function langOf(file: string): Lang {
	// `.star` is Starlark — Python's grammar with a different extension. Hive's
	// pipelines live in `.hive/main.star` and `.hive/lib/*.star`, some of the
	// most-read files in this workspace, and without this `def ci(ctx)` in them
	// is unfindable: they fall to the brace family, whose patterns need a
	// `func`/`class`/`function` keyword that Starlark does not have.
	return /\.(py|pyi|star|bzl|bazel)$/i.test(file) ? "python" : "brace";
}

export interface SymbolSpan {
	name: string;
	/** 1-indexed, inclusive. */
	startLine: number;
	endLine: number;
	/** The declaration line, trimmed — enough to tell two matches apart. */
	signature: string;
	text: string;
}

/**
 * Declaration patterns, by family.
 *
 * Anchored at a line start (allowing indentation and export/modifier keywords)
 * so a CALL to `foo(` never matches a declaration of `foo`. That distinction is
 * the whole point: matching uses would return the wrong span and the reader
 * would not know.
 */
function declPatterns(name: string, lang: Lang): RegExp[] {
	const n = escape(name);
	if (lang === "python") {
		return [new RegExp(`^[ \\t]*(?:async[ \\t]+)?def[ \\t]+${n}\\b`), new RegExp(`^[ \\t]*class[ \\t]+${n}\\b`)];
	}
	return [
		// Go: func Name / func (r T) Name / type Name / var|const Name
		new RegExp(`^[ \\t]*func[ \\t]+(?:\\([^)]*\\)[ \\t]*)?${n}\\b`),
		new RegExp(`^[ \\t]*type[ \\t]+${n}\\b`),
		// TS/JS: export? (async)? function Name / class Name / interface|type|enum Name
		new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:default[ \\t]+)?(?:async[ \\t]+)?function\\*?[ \\t]+${n}\\b`),
		new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:default[ \\t]+)?(?:abstract[ \\t]+)?class[ \\t]+${n}\\b`),
		new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:interface|type|enum)[ \\t]+${n}\\b`),
		// const Name = ... (arrow functions, factories) and Go's var/const
		new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+${n}\\b`),
		// Class members and object methods — but NOT call sites.
		//
		// The old single pattern here made the modifier group optional, which left
		// `^[ \t]+NAME[ \t]*[(<]` — that is, ANY indented `name(`, and an indented
		// call statement is exactly that. Observed live: read_symbol(
		// workstation_loop.go, runWorkstationLane) returned two "declarations",
		// the first being the call site at 131-131. The existing regression test
		// only covered an UNINDENTED call, which the `[ \t]+` anchor already
		// excluded, so it certified nothing.
		//
		// A declaration is now told from a statement by its shape, three ways:
		// a modifier keyword, or a line that opens a body, or a typed signature
		// with no body. A bare `name(args)` matches none of them.
		new RegExp(`^[ \\t]+(?:(?:public|private|protected|static|readonly|async|get|set)[ \\t]+)+${n}[ \\t]*[(<]`),
		// `  run() {`, `  run<T>(x: T) {`
		new RegExp(`^[ \\t]+${n}[ \\t]*[(<].*\\{[ \\t]*$`),
		// `  read(path: string): Promise<string>;` — a TS interface member. The
		// `):` return annotation is what a call statement never has.
		new RegExp(`^[ \\t]+${n}[ \\t]*[(<].*\\)[ \\t]*:.*;[ \\t]*$`),
		// `  Run() error` — a Go interface member. Told from a call statement by
		// the RETURN TYPE after the closing paren: `foo(a, b)` has nothing there.
		// A bodiless `Run()` with no return type is genuinely indistinguishable
		// from a call and is deliberately not matched — a miss the not-found path
		// explains is better than a call site presented as a declaration.
		new RegExp(`^[ \\t]+${n}[ \\t]*\\([^)]*\\)[ \\t]+[\\w\\[\\]*.,() ]+[ \\t]*$`),
	];
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * findSymbol returns every declaration of `name`, in file order.
 *
 * ALL of them, not the first. A name is frequently both an interface and its
 * implementation, or a method on two types, and silently picking one would be a
 * confidently wrong answer — the failure mode this tool exists to avoid.
 */
export function findSymbol(source: string, file: string, name: string): SymbolSpan[] {
	if (!name.trim()) return [];
	const lang = langOf(file);
	const patterns = declPatterns(name, lang);
	const lines = source.split("\n");
	const out: SymbolSpan[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!patterns.some((p) => p.test(line))) continue;
		// A declaration inside a comment or string is not a declaration.
		if (inCommentOrString(lines, i)) continue;
		const endLine = lang === "python" ? pythonEnd(lines, i) : braceEnd(lines, i);
		const startLine = withDoc(lines, i, lang);
		out.push({
			name,
			startLine: startLine + 1,
			endLine: endLine + 1,
			signature: line.trim(),
			text: lines.slice(startLine, endLine + 1).join("\n"),
		});
	}
	return out;
}

/** listSymbols is the cheap outline: top-level declarations plus one level of
 *  members, no bodies. */
export function listSymbols(
	source: string,
	file: string,
): { line: number; signature: string; depth: number }[] {
	const lang = langOf(file);
	const lines = source.split("\n");
	const decl =
		lang === "python"
			? /^(?:async[ \t]+)?(?:def|class)[ \t]+\w/
			: /^(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(?:func|function\*?|class|interface|type|enum|const|let|var)[ \t]+/;
	/**
	 * Members, one level in.
	 *
	 * Listing these is what makes the two tools COMPOSE. Without it a Python
	 * `class Store:` outlined to itself and nothing else, so `list_symbols` could
	 * not supply the name `read_symbol` needs on a Python or TS class — the two
	 * tools were unusable together on exactly the files where an outline helps
	 * most, which is the structural reason the pair saw 3 calls ever.
	 *
	 * The brace-family pattern uses the same discriminators as declPatterns —
	 * a modifier keyword, a line that opens a body, a TS return annotation, or a
	 * Go return type — so an indented CALL is not mistaken for a member.
	 */
	const member =
		lang === "python"
			? /^[ \t]+(?:async[ \t]+)?(?:def|class)[ \t]+\w/
			: new RegExp(
					"^[ \\t]+(?:" +
						// modifier-led member
						"(?:public|private|protected|static|readonly|async|get|set)[ \\t]+\\w" +
						// opens a body
						"|\\w[\\w$]*[ \\t]*[(<].*\\{[ \\t]*$" +
						// TS signature with a return annotation
						"|\\w[\\w$]*[ \\t]*[(<].*\\)[ \\t]*:.*;[ \\t]*$" +
						// Go interface member: return type after the paren
						"|\\w[\\w$]*[ \\t]*\\([^)]*\\)[ \\t]+[\\w\\[\\]*.,() ]+[ \\t]*$" +
						")",
				);
	const out: { line: number; signature: string; depth: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const top = decl.test(lines[i]);
		// One level only. Listing every member of every nested scope turns an
		// outline back into the file, which is the thing it exists to avoid.
		const nested = !top && member.test(lines[i]);
		if (!top && !nested) continue;
		if (inCommentOrString(lines, i)) continue;
		out.push({
			line: i + 1,
			signature: lines[i].trim().replace(/[ \t]*\{[ \t]*$/, ""),
			depth: top ? 0 : 1,
		});
	}
	return out;
}

/**
 * braceEnd finds the line closing the block opened on or after `start`.
 *
 * Scans character by character, skipping string literals, template literals,
 * character literals and comments — because a `}` inside `"}"` or after `//`
 * is the single most likely way a brace counter silently returns the wrong
 * span, and a wrong span is worse than no answer.
 *
 * A declaration with no brace before its statement ends (a Go `type X int`, a
 * TS `type X = Y`, an interface method) ends at that statement.
 */
function braceEnd(lines: string[], start: number): number {
	let depth = 0;
	let seenOpen = false;
	let inBlockComment = false;

	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		let inString: string | null = null;

		for (let c = 0; c < line.length; c++) {
			const ch = line[c];
			const next = line[c + 1];

			if (inBlockComment) {
				if (ch === "*" && next === "/") {
					inBlockComment = false;
					c++;
				}
				continue;
			}
			if (inString) {
				if (ch === "\\") c++;
				else if (ch === inString) inString = null;
				continue;
			}
			if (ch === "/" && next === "/") break; // line comment: rest is text
			if (ch === "#" && !seenOpen && depth === 0) break; // shell-ish comment
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				c++;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				inString = ch;
				continue;
			}
			if (ch === "{") {
				depth++;
				seenOpen = true;
				continue;
			}
			if (ch === "}") {
				depth--;
				if (seenOpen && depth === 0) return i;
				continue;
			}
			// A statement that ended before any block opened is the whole symbol:
			// `type ID string`, `type X = Y;`, `const n = 1;`
			if (ch === ";" && !seenOpen && depth === 0) return i;
		}
		// Unbraced single-line declaration (Go has no semicolons).
		if (!seenOpen && !inBlockComment && !/[=(,{[]\s*$/.test(line) && i >= start) {
			if (!/^\s*(?:\/\/|#)/.test(line)) return i;
		}
	}
	return lines.length - 1;
}

/**
 * pythonEnd ends the block at the first non-blank line indented no further than
 * the declaration. Blank lines and comment-only lines never end a block — they
 * appear inside functions constantly, and treating one as the end would
 * truncate at the first paragraph break.
 */
function pythonEnd(lines: string[], start: number): number {
	const indent = indentOf(lines[start]);
	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		if (indentOf(line) <= indent) return end;
		end = i;
	}
	return lines.length - 1;
}

function indentOf(line: string): number {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0].replace(/\t/g, "    ").length : 0;
}

/**
 * withDoc extends the span backwards over the symbol's documentation.
 *
 * The doc comment is usually the most valuable part of the answer — it is where
 * the WHY lives, and reading a function without it is how a caller reimplements
 * a rule that was already written down. Decorators and Go build-ish comments
 * come along for the same reason.
 */
function withDoc(lines: string[], declLine: number, lang: Lang): number {
	let start = declLine;
	for (let i = declLine - 1; i >= 0; i--) {
		const line = lines[i].trim();
		const isDoc =
			lang === "python"
				? line.startsWith("#") || line.startsWith("@")
				: line.startsWith("//") || line.startsWith("*") || line.startsWith("/*") || line.startsWith("@");
		if (!isDoc) break;
		start = i;
	}
	return start;
}

/**
 * inCommentOrString reports whether line `i` starts inside a block comment or a
 * template literal opened earlier in the file.
 *
 * Cheap and conservative: it rescans from the top counting unterminated `/*`
 * and backticks. A false positive costs one missed match; a false negative
 * costs a "declaration" that is really prose, which reads as a real answer.
 */
function inCommentOrString(lines: string[], i: number): boolean {
	if (/^\s*(?:\/\/|\/\*|\*|#)/.test(lines[i])) return true;
	let inBlock = false;
	let ticks = 0;
	for (let k = 0; k < i; k++) {
		const line = lines[k];
		for (let c = 0; c < line.length; c++) {
			const ch = line[c];
			const next = line[c + 1];
			if (inBlock) {
				if (ch === "*" && next === "/") {
					inBlock = false;
					c++;
				}
				continue;
			}
			if (ch === "/" && next === "/") break;
			if (ch === "/" && next === "*") {
				inBlock = true;
				c++;
				continue;
			}
			if (ch === "`") ticks++;
		}
	}
	return inBlock || ticks % 2 === 1;
}
