/**
 * web — `web_search` + `fetch_content`, in-house (HIV-1224, replacing
 * `pi-web-access`).
 *
 * What the dropped 16k LOC bought us out of: a 112 KB curator page served
 * from a local HTTP server, a Chrome cookie-jar reader (an agent extension
 * reading the browser's cookies is surface we refuse on principle), 12 of 13
 * search providers, video/YouTube extraction and two global shortcuts. What
 * stays is the daily loop: search (Exa) and fetch-as-readable-markdown, with
 * the SSRF guard as real security (ssrf.ts) and truncation that teaches
 * narrowing (extract.ts).
 *
 * No widget, deliberately: the old `web-activity` widget key competed for the
 * band the deck now owns (HIV-1219). If ambient web activity earns a display
 * again it becomes a deck section signal, not a new key.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { htmlToMarkdown, pdfToMarkdown, plainToMarkdown, type Extracted } from "./extract.ts";
import {
	EXA_MCP_URL,
	EXA_SEARCH_URL,
	extractMcpText,
	formatResults,
	parseExaResponse,
	parseMcpResults,
	SNIPPET_MAX_CHARS,
	type SearchResultItem,
} from "./search.ts";
import { assertPublicHttpUrl } from "./ssrf.ts";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 20_000;

function text(body: string, details: unknown) {
	return { content: [{ type: "text" as const, text: body }], details };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description: [
			"Search the web (Exa). Returns titles, URLs, dates and text snippets.",
			"Use fetch_content on a result URL to read a full page.",
		].join(" "),
		promptSnippet: "Search the web",
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			num_results: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 10, description: "Result count, default 5." }),
			),
		}),
		async execute(_id, params, signal) {
			const numResults = params.num_results ?? 5;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
			signal?.addEventListener("abort", () => controller.abort(), { once: true });
			try {
				const apiKey = process.env.EXA_API_KEY;
				let items: SearchResultItem[];
				if (apiKey) {
					// Direct API when a key exists — richer fields, own quota.
					const res = await fetch(EXA_SEARCH_URL, {
						method: "POST",
						headers: { "x-api-key": apiKey, "content-type": "application/json" },
						body: JSON.stringify({
							query: params.query,
							numResults,
							type: "auto",
							contents: { text: { maxCharacters: SNIPPET_MAX_CHARS } },
						}),
						signal: controller.signal,
					});
					if (!res.ok) throw new Error(`Exa search failed: HTTP ${res.status}`);
					items = parseExaResponse(await res.json());
				} else {
					// Keyless: Exa's public MCP endpoint — the "zero-config" path the
					// external package used; no credential exists on this machine.
					const res = await fetch(EXA_MCP_URL, {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							method: "tools/call",
							params: {
								name: "web_search_exa",
								arguments: {
									query: params.query,
									numResults,
									livecrawl: "fallback",
									type: "auto",
									contextMaxCharacters: 3_000,
								},
							},
						}),
						signal: controller.signal,
					});
					if (!res.ok) throw new Error(`Exa MCP search failed: HTTP ${res.status}`);
					items = parseMcpResults(extractMcpText(await res.text())).slice(0, numResults);
				}
				return text(formatResults(items, params.query), { results: items });
			} finally {
				clearTimeout(timer);
			}
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch page",
		description: [
			"Fetch a URL and return readable markdown (article-extracted HTML, PDFs, plain text/JSON).",
			"Truncated responses say so — narrow the request rather than assuming completeness.",
		].join(" "),
		promptSnippet: "Fetch a URL as readable markdown",
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL to fetch." }),
			max_chars: Type.Optional(
				Type.Integer({ minimum: 1_000, maximum: 200_000, description: `Output cap, default ${DEFAULT_MAX_CHARS}.` }),
			),
		}),
		async execute(_id, params, signal) {
			const maxChars = params.max_chars ?? DEFAULT_MAX_CHARS;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
			signal?.addEventListener("abort", () => controller.abort(), { once: true });

			try {
				// Manual redirect loop: EVERY hop is re-vetted, because a public URL
				// 302ing to something internal is the practical SSRF bypass.
				let url = await assertPublicHttpUrl(params.url);
				let response: Response | null = null;
				for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
					const candidate = await fetch(url, {
						redirect: "manual",
						signal: controller.signal,
						headers: { "user-agent": "hive-pi-web/1.0 (+https://github.com/Artifex-org/hive-pi)" },
					});
					if (candidate.status >= 300 && candidate.status < 400) {
						const location = candidate.headers.get("location");
						if (!location) throw new Error(`redirect (HTTP ${candidate.status}) without a Location header`);
						if (hop === MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
						url = await assertPublicHttpUrl(new URL(location, url).toString());
						continue;
					}
					response = candidate;
					break;
				}
				if (!response) throw new Error("no response after redirects");
				if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

				const declaredLength = Number(response.headers.get("content-length") ?? "0");
				if (declaredLength > MAX_BODY_BYTES) {
					throw new Error(`response too large (${Math.round(declaredLength / 1024 / 1024)} MB > 10 MB)`);
				}
				const body = new Uint8Array(await response.arrayBuffer());
				if (body.byteLength > MAX_BODY_BYTES) throw new Error("response too large (>10 MB)");

				const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
				let extracted: Extracted;
				if (contentType.includes("application/pdf") || url.pathname.toLowerCase().endsWith(".pdf")) {
					extracted = await pdfToMarkdown(body, maxChars);
				} else if (contentType.includes("html")) {
					extracted = htmlToMarkdown(new TextDecoder().decode(body), maxChars);
				} else if (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml")) {
					extracted = plainToMarkdown(new TextDecoder().decode(body), maxChars);
				} else {
					throw new Error(`unsupported content-type "${contentType || "unknown"}" — only HTML, PDF, text and JSON are fetched`);
				}

				const header = extracted.title ? `# ${extracted.title}\n\n` : "";
				return text(header + extracted.markdown, {
					url: params.url,
					final_url: url.toString(),
					content_type: contentType,
					truncated: extracted.truncated,
					...(extracted.title ? { title: extracted.title } : {}),
				});
			} finally {
				clearTimeout(timer);
			}
		},
	});
}
