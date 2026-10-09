/** Bounded textual caller inventory, not a language-server reference index. */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { findSymbol, listSymbols } from "../lens/symbols.ts";

export const CALLER_SYMBOL_CAP = 16;
export const CALLER_SITE_CAP = 80;
export const CALLER_FILE_CAP = 20;
export const CALLER_SOURCE_BYTES = 128 * 1024;
export const CALLER_GREP_BYTES = 32 * 1024;
export const CALLER_SEARCH_MS = 2_000;
export const CALLER_DECLARATION_CAP = 64;
export const CALLER_SPAN_LOOKUP_CAP = 32;

export interface CallerSite { symbol: string; path: string; line: number; }
export interface CallerInventory { sites: CallerSite[]; notes: string[]; }
export type CallerGrep = (symbol: string, repo: string, timeoutMs: number) => { text: string; incomplete?: string };

/** Declarations only: Go functions/methods, JS/TS exports, public Rust/Python functions. */
function functionName(line: string): string | undefined {
	return /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[(\[]/.exec(line)?.[1]
		?? /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([\w$]+)\s*[(<]/.exec(line)?.[1]
		?? /^\s*export\s+(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:<[^;]{1,256}>\s*)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*(?::[^=]*)?=>)/.exec(line)?.[1]
		?? /^\s*(?:pub(?:\([^)]*\))?\s+(?:async\s+)?fn|(?:async\s+)?def)\s+([A-Za-z]\w*)\s*[(<]/.exec(line)?.[1]
		?? /^\s*(?:(?:public|private|protected|static|async|abstract|override|readonly)\s+)*(?!(?:if|for|while|switch|catch|constructor)\b)([\w$]+)\s*(?:<[^;]{1,256}>\s*)?\([^)]*\)\s*(?::[^;{]+)?\s*\{/.exec(line)?.[1];
}

/** New-line positions of changed hunks, plus declarations removed by the diff. */
export function changedFunctionNames(patch: string, readSource: (path: string, revision?: "HEAD" | ":") => string | null, deadline = Date.now() + CALLER_SEARCH_MS): { names: string[]; notes: string[] } {
	const ranges = new Map<string, { start: number; end: number }[]>();
	const names = new Set<string>();
	const notes: string[] = [];
	let path = "";
	let revision: "HEAD" | ":" | undefined;
	let spanLookups = 0;
	const patchLines = patch.split("\n");
	for (const [index, line] of patchLines.entries()) {
		if (line.startsWith("Committed (")) { revision = "HEAD"; continue; }
		if (line === "Staged vs HEAD:") { revision = ":"; continue; }
		if (line === "Unstaged vs index:") { revision = undefined; continue; }
		if (line.startsWith("+++ b/")) path = line.slice(6);
		else if (line === "+++ /dev/null") path = "";
		else if (line.startsWith("@@")) {
			const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
			if (!match) continue;
			const headerName = functionName(match[3]);
			if (headerName) names.add(headerName);
			if (path) {
				const start = Number(match[1]);
				const key = `${revision ?? ""}\0${path}`;
				const list = ranges.get(key) ?? [];
				list.push({ start, end: start + Math.max(1, Number(match[2] ?? 1)) - 1 });
				ranges.set(key, list);
			}
		} else if (/^[+-](?![+-])/.test(line)) {
			const name = functionName(line.slice(1)) ?? (/^[+-]\s*export\s+(?:const|let)\b/.test(line)
				? functionName(patchLines.slice(index, index + 8).filter((row) => row[0] === line[0] || row[0] === " ").map((row) => row.slice(1)).join("\n")) : undefined);
			if (name) names.add(name);
		}
	}
	if (ranges.size > CALLER_FILE_CAP) notes.push(`Changed-source scan capped at ${CALLER_FILE_CAP} files.`);
	for (const [key, hunks] of [...ranges].slice(0, CALLER_FILE_CAP)) {
		const [version, file] = key.split("\0");
		const sourceRevision = version === "HEAD" || version === ":" ? version : undefined;
		if (Date.now() >= deadline) { notes.push("Source discovery stopped at its shared time budget."); break; }
		const source = readSource(file, sourceRevision);
		if (source === null) { notes.push(`Could not scan ${file} (missing or over ${CALLER_SOURCE_BYTES} bytes).`); continue; }
		if (Date.now() >= deadline) { notes.push("Source discovery stopped at its shared time budget."); break; }
		const sourceLines = source.split("\n");
		const outline = listSymbols(source, file, CALLER_DECLARATION_CAP + 1);
		if (outline.length > CALLER_DECLARATION_CAP) notes.push(`Source outline for ${file} capped at ${CALLER_DECLARATION_CAP} declarations.`);
		for (const declaration of outline.slice(0, CALLER_DECLARATION_CAP)) {
			if (Date.now() >= deadline || spanLookups >= CALLER_SPAN_LOOKUP_CAP) { notes.push("Source discovery stopped at its time/span-lookup budget."); break; }
			const name = functionName(sourceLines.slice(declaration.line - 1, declaration.line + 7).join("\n"));
			if (!name) continue;
			spanLookups++;
			const spans = findSymbol(source, file, name, CALLER_DECLARATION_CAP + 1);
			if (spans.length > CALLER_DECLARATION_CAP) notes.push(`Source spans for ${name} capped at ${CALLER_DECLARATION_CAP} declarations.`);
			if (spans.slice(0, CALLER_DECLARATION_CAP).some((span) => hunks.some((h) => h.start <= span.endLine && h.end >= span.startLine))) names.add(name);
			if (names.size > CALLER_SYMBOL_CAP) break;
		}
		if (names.size > CALLER_SYMBOL_CAP || spanLookups >= CALLER_SPAN_LOOKUP_CAP) break;
	}
	if (spanLookups >= CALLER_SPAN_LOOKUP_CAP) notes.push(`Source span lookups capped at ${CALLER_SPAN_LOOKUP_CAP}.`);
	if (names.size > CALLER_SYMBOL_CAP) notes.push(`Changed-symbol scan capped at ${CALLER_SYMBOL_CAP} functions.`);
	return { names: [...names].slice(0, CALLER_SYMBOL_CAP), notes };
}

const grepCallers: CallerGrep = (symbol, repo, timeoutMs) => {
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	try {
		return { text: execFileSync("git", ["--no-optional-locks", "grep", "--no-color", "-n", "-I", "-E", "-m", "8", "--", `(^|[^[:alnum:]_$])${escaped}[[:space:]]*(<[^;()]{1,128}>|\\[[^;()]{1,128}\\]|::<[^;()]{1,128}>)?[[:space:]]*\\(`, "*.go", "*.ts", "*.tsx", "*.js", "*.jsx", "*.py", "*.rs"], {
			cwd: repo, encoding: "utf8", timeout: timeoutMs, maxBuffer: CALLER_GREP_BYTES, stdio: ["ignore", "pipe", "ignore"],
		}) };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string | Buffer };
		if (failure.status === 1) return { text: "" }; // git grep's documented no-match result
		return { text: String(failure.stdout ?? "").slice(0, CALLER_GREP_BYTES), incomplete: `Caller grep for ${symbol} failed or exceeded its time/output bound.` };
	}
};

export function discoverCallers(repo: string, patch: string, changedPaths: readonly string[], grep: CallerGrep = grepCallers, readSource = (file: string, revision?: "HEAD" | ":"): string | null => {
	try {
		if (revision) return execFileSync("git", ["--no-optional-locks", "show", revision === ":" ? `:${file}` : `HEAD:${file}`], {
			cwd: repo, encoding: "utf8", timeout: 300, maxBuffer: CALLER_SOURCE_BYTES, stdio: ["ignore", "pipe", "ignore"],
		});
		const absolute = resolve(repo, file);
		if (!absolute.startsWith(`${resolve(repo)}/`) || statSync(absolute).size > CALLER_SOURCE_BYTES) return null;
		return readFileSync(absolute, "utf8");
	} catch { return null; } // explicitly reported by changedFunctionNames
}): CallerInventory {
	const deadline = Date.now() + CALLER_SEARCH_MS;
	const { names, notes } = changedFunctionNames(patch, readSource, deadline);
	const sites: CallerSite[] = [];
	const seen = new Set<string>();
	for (const symbol of names) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) { notes.push(`Caller search stopped at its ${CALLER_SEARCH_MS}ms budget.`); break; }
		const result = grep(symbol, repo, Math.min(300, remaining));
		if (result.incomplete) notes.push(result.incomplete);
		for (const line of result.text.slice(0, CALLER_GREP_BYTES).split("\n")) {
			const match = /^(.+?):(\d+):(.*)$/.exec(line);
			if (!match || changedPaths.includes(match[1]) || functionName(match[3]) === symbol) continue;
			const key = `${symbol}:${match[1]}:${match[2]}`;
			if (seen.has(key)) continue;
			seen.add(key);
			sites.push({ symbol, path: match[1], line: Number(match[2]) });
			if (sites.length === CALLER_SITE_CAP) { notes.push(`Caller inventory capped at ${CALLER_SITE_CAP} sites; grep also caps each file at 8 matches per symbol.`); return { sites, notes }; }
		}
	}
	return { sites, notes };
}
