/**
 * web — DOM → markdown, in-house.
 *
 * Replaces turndown: its Node entrypoint hard-requires @mixmark-io/domino (a
 * second, full DOM implementation) at import time, and a partial install of
 * that transitive dep crashed every extension load — which on a launch node
 * means every NEW agent launch dies before registering. extract.ts already
 * holds a parsed linkedom DOM, so conversion is a walk we can own outright:
 * no parser, no dependency, and the extension keeps loading even if the
 * install is imperfect.
 *
 * Scope is deliberate: read-only page consumption. We render the structures a
 * model benefits from (headings, lists, links, code, quotes, tables) and fall
 * back to text for the rest. No markdown-escaping of text content — the output
 * is read, not re-rendered.
 */

/** Minimal structural view of a linkedom/DOM node — keeps this module DOM-lib agnostic. */
export interface DomNode {
	nodeType: number;
	nodeName: string;
	textContent: string | null;
	childNodes: ArrayLike<DomNode>;
	getAttribute?(name: string): string | null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "IFRAME", "OBJECT"]);
const BLOCK_CONTAINERS = new Set([
	"DIV",
	"SECTION",
	"ARTICLE",
	"MAIN",
	"BODY",
	"HTML",
	"HEADER",
	"FOOTER",
	"ASIDE",
	"NAV",
	"FIGURE",
	"FIGCAPTION",
	"DETAILS",
	"SUMMARY",
	"FIELDSET",
	"FORM",
]);

function attr(node: DomNode, name: string): string {
	return node.getAttribute?.(name)?.trim() ?? "";
}

function children(node: DomNode): DomNode[] {
	return Array.from(node.childNodes as ArrayLike<DomNode>);
}

/** Inline rendering: collapses whitespace, wraps emphasis/code/links. */
function inline(node: DomNode): string {
	if (node.nodeType === TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
	if (node.nodeType !== ELEMENT_NODE || SKIP.has(node.nodeName)) return "";
	const tag = node.nodeName;
	const body = () => children(node).map(inline).join("");
	switch (tag) {
		case "BR":
			return "\n";
		case "STRONG":
		case "B": {
			const t = body().trim();
			return t ? `**${t}**` : "";
		}
		case "EM":
		case "I": {
			const t = body().trim();
			return t ? `*${t}*` : "";
		}
		case "DEL":
		case "S":
		case "STRIKE": {
			const t = body().trim();
			return t ? `~~${t}~~` : "";
		}
		case "CODE": {
			const t = (node.textContent ?? "").trim();
			return t ? `\`${t}\`` : "";
		}
		case "A": {
			const t = body().trim();
			const href = attr(node, "href");
			if (!t) return "";
			// Fragment/js pseudo-links carry no information a reader can follow.
			if (!href || href.startsWith("#") || href.startsWith("javascript:")) return t;
			return `[${t}](${href})`;
		}
		case "IMG": {
			const src = attr(node, "src");
			const alt = attr(node, "alt");
			return src ? `![${alt}](${src})` : alt;
		}
		default:
			return body();
	}
}

function fence(node: DomNode): string {
	// <pre><code class="language-x"> keeps its language; content stays verbatim.
	const kids = children(node).filter((c) => c.nodeType === ELEMENT_NODE);
	const code = kids.length === 1 && kids[0].nodeName === "CODE" ? kids[0] : node;
	const lang = /(?:^|\s)(?:language|lang)-([\w#+-]+)/.exec(attr(code, "class"))?.[1] ?? "";
	const text = (code.textContent ?? "").replace(/\n$/, "");
	return `\`\`\`${lang}\n${text}\n\`\`\``;
}

function listItems(node: DomNode, ordered: boolean, depth: number): string {
	const indent = "  ".repeat(depth);
	let index = 1;
	const out: string[] = [];
	for (const li of children(node)) {
		if (li.nodeType !== ELEMENT_NODE || li.nodeName !== "LI") continue;
		const marker = ordered ? `${index++}.` : "-";
		const parts: string[] = [];
		const nested: string[] = [];
		for (const child of children(li)) {
			if (child.nodeType === ELEMENT_NODE && (child.nodeName === "UL" || child.nodeName === "OL")) {
				nested.push(listItems(child, child.nodeName === "OL", depth + 1));
			} else {
				parts.push(block(child, depth));
			}
		}
		const text = parts.join(" ").replace(/\s+/g, " ").trim();
		out.push(`${indent}${marker} ${text}`.trimEnd());
		for (const n of nested) if (n) out.push(n);
	}
	return out.join("\n");
}

function table(node: DomNode): string {
	const rows: string[][] = [];
	let sawHeader = false;
	const walkRows = (n: DomNode) => {
		for (const child of children(n)) {
			if (child.nodeType !== ELEMENT_NODE) continue;
			if (child.nodeName === "TR") {
				const cells = children(child)
					.filter((c) => c.nodeType === ELEMENT_NODE && (c.nodeName === "TD" || c.nodeName === "TH"))
					.map((c) => inline(c).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim());
				if (cells.length > 0) {
					if (children(child).some((c) => c.nodeName === "TH") && rows.length === 0) sawHeader = true;
					rows.push(cells);
				}
			} else if (["THEAD", "TBODY", "TFOOT"].includes(child.nodeName)) {
				walkRows(child);
			}
		}
	};
	walkRows(node);
	if (rows.length === 0) return "";
	const width = Math.max(...rows.map((r) => r.length));
	const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
	const out = [line(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`];
	for (const row of rows.slice(1)) out.push(line(row));
	// A headerless table still needs the separator row to parse as a table.
	void sawHeader;
	return out.join("\n");
}

/** Block rendering: returns this node's markdown, blocks separated by blank lines. */
function block(node: DomNode, depth = 0): string {
	if (node.nodeType === TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ").trim();
	if (node.nodeType !== ELEMENT_NODE || SKIP.has(node.nodeName)) return "";
	const tag = node.nodeName;
	const heading = /^H([1-6])$/.exec(tag);
	if (heading) {
		const t = inline(node).replace(/\s+/g, " ").trim();
		return t ? `${"#".repeat(Number(heading[1]))} ${t}` : "";
	}
	switch (tag) {
		case "P":
			return inline(node).replace(/[ \t]+/g, " ").trim();
		case "PRE":
			return fence(node);
		case "UL":
		case "OL":
			return listItems(node, tag === "OL", depth);
		case "BLOCKQUOTE": {
			const body = joinBlocks(children(node).map((c) => block(c, depth)));
			return body
				.split("\n")
				.map((l) => (l ? `> ${l}` : ">"))
				.join("\n");
		}
		case "HR":
			return "---";
		case "TABLE":
			return table(node);
		case "DL": {
			const out: string[] = [];
			for (const child of children(node)) {
				if (child.nodeName === "DT") out.push(`**${inline(child).trim()}**`);
				else if (child.nodeName === "DD") out.push(`: ${inline(child).trim()}`);
			}
			return out.join("\n");
		}
		default:
			if (BLOCK_CONTAINERS.has(tag)) return joinBlocks(children(node).map((c) => block(c, depth)));
			// Unknown/inline-ish element at block position: render as one paragraph.
			return inline(node).replace(/[ \t]+/g, " ").trim();
	}
}

function joinBlocks(parts: string[]): string {
	return parts.filter((p) => p.trim().length > 0).join("\n\n");
}

/** Convert a parsed DOM subtree to markdown. The linkedom `body` element slots in directly. */
export function domToMarkdown(root: DomNode): string {
	return block(root)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
