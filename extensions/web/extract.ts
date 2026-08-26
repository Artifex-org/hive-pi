/**
 * web — content extraction (HIV-1224). HTML → readable markdown via
 * Readability (article isolation) with a whole-page fallback, PDF via unpdf.
 * Pure over (bytes/strings, caps), so extraction quality is testable on
 * fixtures without a network.
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { extractText, getDocumentProxy } from "unpdf";
import { domToMarkdown, type DomNode } from "./markdown.ts";

export interface Extracted {
	markdown: string;
	title?: string;
	truncated: boolean;
}

/**
 * Truncation teaches narrowing instead of silently cutting: a capped tool
 * response whose reader does not know it is capped reads as "that was
 * everything" — the same success-shaped-nothing failure class as ever.
 */
export function truncateWithHint(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} of ${text.length} chars — re-fetch with a more specific URL/section, or raise max_chars]`,
		truncated: true,
	};
}

export function htmlToMarkdown(html: string, maxChars: number): Extracted {
	const { document } = parseHTML(html);
	let title: string | undefined;
	let contentHtml: string | undefined;
	try {
		// Readability MUTATES the document, and the fallback below reads it —
		// so it gets its own parse rather than sharing one.
		const article = new Readability(parseHTML(html).document as unknown as Document, {
			charThreshold: 250,
			// Keep classes so `language-*` on code blocks survives isolation and
			// the converter can emit language-tagged fences.
			keepClasses: true,
		}).parse();
		if (article?.content) {
			contentHtml = article.content;
			title = article.title || undefined;
		}
	} catch {
		/* fall through to whole-page conversion */
	}
	if (!contentHtml) {
		title = document.querySelector("title")?.textContent?.trim() || undefined;
		contentHtml = document.querySelector("body")?.innerHTML ?? html;
	}
	// Readability yields an HTML *fragment*; wrapping in <body> gives the
	// converter one consistent root for both the article and whole-page paths.
	const content = parseHTML(`<html><body>${contentHtml}</body></html>`).document.body;
	const markdown = domToMarkdown(content as unknown as DomNode).trim();
	const { text, truncated } = truncateWithHint(markdown, maxChars);
	return { markdown: text, ...(title ? { title } : {}), truncated };
}

export async function pdfToMarkdown(data: Uint8Array, maxChars: number): Promise<Extracted> {
	const pdf = await getDocumentProxy(data);
	const { text } = await extractText(pdf, { mergePages: true });
	const { text: body, truncated } = truncateWithHint(text.trim(), maxChars);
	return { markdown: body, truncated };
}

export function plainToMarkdown(text: string, maxChars: number): Extracted {
	const { text: body, truncated } = truncateWithHint(text.trim(), maxChars);
	return { markdown: body, truncated };
}
