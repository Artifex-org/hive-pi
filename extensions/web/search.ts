/**
 * web — Exa search (HIV-1224). One provider, on purpose: Exa was already the
 * `auto` preference in pi-web-access, and 12 alternative backends is where
 * that package's 17k LOC went. Parsing is pure and defensive — the API is
 * third-party data.
 */

export const EXA_SEARCH_URL = "https://api.exa.ai/search";
export const SNIPPET_MAX_CHARS = 1_500;

export interface SearchResultItem {
	title: string;
	url: string;
	publishedDate?: string;
	snippet: string;
}

export function parseExaResponse(payload: unknown, snippetMax = SNIPPET_MAX_CHARS): SearchResultItem[] {
	if (!payload || typeof payload !== "object") return [];
	const results = (payload as { results?: unknown }).results;
	if (!Array.isArray(results)) return [];
	const out: SearchResultItem[] = [];
	for (const entry of results) {
		if (typeof entry !== "object" || entry === null) continue;
		const raw = entry as Record<string, unknown>;
		if (typeof raw.url !== "string") continue;
		const snippet = typeof raw.text === "string" ? raw.text.slice(0, snippetMax).trim() : "";
		out.push({
			title: typeof raw.title === "string" && raw.title ? raw.title : raw.url,
			url: raw.url,
			...(typeof raw.publishedDate === "string" && raw.publishedDate ? { publishedDate: raw.publishedDate } : {}),
			snippet,
		});
	}
	return out;
}

/**
 * The keyless path: Exa's public MCP endpoint. This is how pi-web-access was
 * "Exa zero-config" — no credential exists on this machine, so it is OUR
 * primary too; `EXA_API_KEY` upgrades to the direct API when present.
 * Response: JSON-RPC over JSON or SSE (`data:` lines), result text as
 * `Title:` / `URL:` / `Text:` blocks separated by `---`.
 */
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

export function extractMcpText(body: string): string {
	let parsed: { result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> }; error?: { message?: string } } | null =
		null;
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = JSON.parse(payload);
			if (candidate?.result || candidate?.error) {
				parsed = candidate;
				break;
			}
		} catch {
			/* keep scanning */
		}
	}
	if (!parsed) {
		try {
			const candidate = JSON.parse(body);
			if (candidate?.result || candidate?.error) parsed = candidate;
		} catch {
			/* fall through */
		}
	}
	if (!parsed) throw new Error("Exa MCP returned an unparseable response");
	if (parsed.error) throw new Error(`Exa MCP error: ${parsed.error.message ?? "unknown"}`);
	const text = parsed.result?.content?.find(
		(item) => item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0,
	)?.text;
	if (parsed.result?.isError) throw new Error(text?.trim() || "Exa MCP returned an error");
	if (!text) throw new Error("Exa MCP returned empty content");
	return text;
}

export function parseMcpResults(text: string, snippetMax = SNIPPET_MAX_CHARS): SearchResultItem[] {
	const blocks = text.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
	const out: SearchResultItem[] = [];
	for (const block of blocks) {
		const url = block.match(/^URL: (.+)/m)?.[1]?.trim();
		if (!url) continue;
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() || url;
		let content = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) content = block.slice(textStart + 7);
		content = content.replace(/\n---\s*$/, "").trim();
		const publishedDate = block.match(/^Published Date: (.+)/m)?.[1]?.trim();
		out.push({
			title,
			url,
			...(publishedDate ? { publishedDate } : {}),
			snippet: content.slice(0, snippetMax).trim(),
		});
	}
	return out;
}

export function formatResults(items: readonly SearchResultItem[], query: string): string {
	if (items.length === 0) return `No results for "${query}".`;
	const blocks = items.map((item, index) => {
		const head = `${index + 1}. ${item.title}${item.publishedDate ? ` (${item.publishedDate.slice(0, 10)})` : ""}`;
		const lines = [head, `   ${item.url}`];
		if (item.snippet) lines.push(`   ${item.snippet.replace(/\s+/g, " ")}`);
		return lines.join("\n");
	});
	return blocks.join("\n\n");
}
