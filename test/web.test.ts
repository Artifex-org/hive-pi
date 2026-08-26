import { describe, expect, it } from "vitest";
import { htmlToMarkdown, plainToMarkdown, truncateWithHint } from "../extensions/web/extract.ts";
import { extractMcpText, formatResults, parseExaResponse, parseMcpResults } from "../extensions/web/search.ts";
import {
	assertPublicHttpUrl,
	egressGoesThroughAProxy,
	isBlockedHostname,
	isPrivateAddress,
	type Resolver,
} from "../extensions/web/ssrf.ts";

describe("ssrf guard", () => {
	it("classifies private IPv4 space including CGNAT (the Tailscale range)", () => {
		for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "100.100.1.1", "0.0.0.0", "224.0.0.1"]) {
			expect(isPrivateAddress(address), address).toBe(true);
		}
		for (const address of ["8.8.8.8", "104.18.32.7", "172.15.0.1", "100.63.0.1"]) {
			expect(isPrivateAddress(address), address).toBe(false);
		}
	});

	it("classifies IPv6 loopback, ULA, link-local and v4-mapped forms", () => {
		for (const address of ["::1", "::", "fd12::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) {
			expect(isPrivateAddress(address), address).toBe(true);
		}
		expect(isPrivateAddress("2606:4700::6812:2007")).toBe(false);
		expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
	});

	it("blocks internal hostnames by name, including the tailnet domain", () => {
		for (const hostname of ["localhost", "foo.local", "gadget.tail0123.ts.net", "metadata.google.internal", "db.internal"]) {
			expect(isBlockedHostname(hostname), hostname).toBe(true);
		}
		expect(isBlockedHostname("example.com")).toBe(false);
	});

	it("rejects non-http protocols, private literals, and hostnames resolving private", async () => {
		await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(/only http/);
		await expect(assertPublicHttpUrl("http://192.168.0.10:30111/")).rejects.toThrow(/private address/);
		await expect(
			assertPublicHttpUrl("https://evil.example.com/", async () => [{ address: "10.0.0.5" }], {}),
		).rejects.toThrow(/resolves to a private address/);
		const ok = await assertPublicHttpUrl(
			"https://example.com/page",
			async () => [{ address: "93.184.215.14" }],
			{},
		);
		expect(ok.hostname).toBe("example.com");
	});

	it("recognises a configured egress proxy from any of the usual variables", () => {
		expect(egressGoesThroughAProxy({})).toBe(false);
		for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
			expect(egressGoesThroughAProxy({ [key]: "http://user:pw@localhost:3128" }), key).toBe(true);
		}
	});

	// THE REGRESSION THIS EXISTS FOR. Inside Hive's srt sandbox every lookup
	// fails, allowlisted or not, so the guard rejected every URL an agent gave
	// it -- "could not resolve github.com" about a host that was reachable and
	// on the allowlist. The resolver here throws the way the sandbox's does.
	it("does not fail closed on DNS when egress goes through a proxy", async () => {
		const deadResolver = async () => {
			throw new Error("getaddrinfo EAI_AGAIN");
		};
		const proxied = { HTTPS_PROXY: "http://user:pw@localhost:3128" };

		const ok = await assertPublicHttpUrl("https://github.com/Artifex-org/hive", deadResolver, proxied);
		expect(ok.hostname).toBe("github.com");

		// Un-proxied behaviour is untouched: a dead resolver still fails closed.
		await expect(assertPublicHttpUrl("https://github.com/", deadResolver, {})).rejects.toThrow(/could not resolve/);
	});

	// Skipping the resolve step must not skip the checks that do not need it.
	// These are what still stands between a launched agent and the LAN.
	it("keeps the name and literal checks under a proxy", async () => {
		const proxied = { HTTPS_PROXY: "http://user:pw@localhost:3128" };
		const unused: Resolver = async () => {
			throw new Error("resolver must not be consulted under a proxy");
		};
		await expect(assertPublicHttpUrl("http://192.168.0.10:30500/v2/", unused, proxied)).rejects.toThrow(/private address/);
		await expect(assertPublicHttpUrl("https://hive.example-tailnet.ts.net/", unused, proxied)).rejects.toThrow(/internal hostname/);
		await expect(assertPublicHttpUrl("http://localhost:8000/", unused, proxied)).rejects.toThrow(/internal hostname/);
		await expect(assertPublicHttpUrl("file:///etc/passwd", unused, proxied)).rejects.toThrow(/only http/);
	});
});

describe("extraction", () => {
	const PAGE = `<!doctype html><html><head><title>Deck Notes</title></head><body>
		<nav><a href="/">Home</a><a href="/about">About</a><a href="/pricing">Pricing</a><a href="/blog">Blog</a><a href="/contact">Contact</a></nav>
		<article><h1>The Widget Essay</h1>${"<p>A pinned widget should say something worth a row of the terminal, and nothing otherwise. This sentence pads the article far enough past the readability threshold that extraction has a real body to isolate from the surrounding chrome.</p>".repeat(6)}</article>
		<footer>© 2026 Nobody · <a href="/imprint">Imprint</a></footer>
		<script>alert("never")</script></body></html>`;

	it("isolates the article and drops nav, footer and scripts", () => {
		const extracted = htmlToMarkdown(PAGE, 50_000);
		expect(extracted.markdown).toContain("The Widget Essay");
		expect(extracted.markdown).toContain("worth a row of the terminal");
		expect(extracted.markdown).not.toContain("Pricing");
		expect(extracted.markdown).not.toContain("Imprint");
		expect(extracted.markdown).not.toContain("alert(");
		expect(extracted.title).toBe("Deck Notes");
	});

	it("renders structure: headings, emphasis, links, lists, code, quotes, tables", () => {
		const html = `<html><head><title>t</title></head><body>
			<h2>Section</h2>
			<p>Plain <strong>bold</strong> and <em>italic</em> and <code>inline()</code> and <a href="https://x.example/a">a link</a>.</p>
			<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
			<ol><li>first</li><li>second</li></ol>
			<pre><code class="language-go">func main() {}</code></pre>
			<blockquote><p>quoted line</p></blockquote>
			<table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>
			<hr>
		</body></html>`;
		const { markdown } = htmlToMarkdown(html, 50_000);
		expect(markdown).toContain("## Section");
		expect(markdown).toContain("**bold**");
		expect(markdown).toContain("*italic*");
		expect(markdown).toContain("`inline()`");
		expect(markdown).toContain("[a link](https://x.example/a)");
		expect(markdown).toContain("- one");
		expect(markdown).toContain("  - nested");
		expect(markdown).toContain("1. first");
		expect(markdown).toContain("2. second");
		expect(markdown).toContain("```go\nfunc main() {}\n```");
		expect(markdown).toContain("> quoted line");
		expect(markdown).toContain("| K | V |");
		expect(markdown).toContain("| a | 1 |");
		expect(markdown).toContain("---");
	});

	it("keeps fragment links as text and images as markdown", () => {
		const { markdown } = htmlToMarkdown(
			`<html><body><p><a href="#top">Top</a> <img src="/d.png" alt="diagram"> <a href="https://y.example">Y</a></p></body></html>`,
			1_000,
		);
		expect(markdown).toContain("Top");
		expect(markdown).not.toContain("(#top)");
		expect(markdown).toContain("![diagram](/d.png)");
		expect(markdown).toContain("[Y](https://y.example)");
	});

	it("falls back to whole-page conversion when there is no article", () => {
		const extracted = htmlToMarkdown("<html><head><title>t</title></head><body><p>tiny</p><script>x()</script></body></html>", 1_000);
		expect(extracted.markdown).toContain("tiny");
		expect(extracted.markdown).not.toContain("x()");
	});

	it("truncation states the cut and teaches narrowing", () => {
		const { text, truncated } = truncateWithHint("a".repeat(5_000), 1_000);
		expect(truncated).toBe(true);
		expect(text).toContain("truncated at 1000 of 5000 chars");
		expect(plainToMarkdown("short", 1_000).truncated).toBe(false);
	});
});

describe("exa parsing", () => {
	it("drops malformed entries and formats the survivors", () => {
		const items = parseExaResponse({
			results: [
				{ title: "Good", url: "https://a.example", publishedDate: "2026-08-01T00:00:00Z", text: "  snippet body  " },
				{ title: "No url" },
				"garbage",
				{ url: "https://b.example", text: 42 },
			],
		});
		expect(items).toHaveLength(2);
		expect(items[0].snippet).toBe("snippet body");
		expect(items[1].title).toBe("https://b.example");

		const formatted = formatResults(items, "q");
		expect(formatted).toContain("1. Good (2026-08-01)");
		expect(formatted).toContain("https://a.example");
	});

	it("reports an empty result set honestly", () => {
		expect(parseExaResponse({})).toEqual([]);
		expect(formatResults([], "deck widgets")).toContain('No results for "deck widgets"');
	});
});

describe("exa keyless MCP path", () => {
	it("unwraps SSE-framed JSON-RPC and plain JSON alike", () => {
		const rpc = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: A\nURL: https://a.example\nText: body" }] } };
		expect(extractMcpText(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`)).toContain("Title: A");
		expect(extractMcpText(JSON.stringify(rpc))).toContain("Title: A");
		expect(() => extractMcpText("data: {}\n")).toThrow(/unparseable|empty/);
		expect(() =>
			extractMcpText(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "rate limited" } })),
		).toThrow(/rate limited/);
	});

	it("parses Title/URL/Text blocks and drops blocks without a URL", () => {
		const items = parseMcpResults(
			[
				"Title: First\nURL: https://a.example\nPublished Date: 2026-08-01\nText: alpha body\n---",
				"Title: No url here\nText: orphan\n---",
				"Title: Second\nURL: https://b.example\nText: beta body",
			].join("\n"),
		);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ title: "First", url: "https://a.example", publishedDate: "2026-08-01", snippet: "alpha body" });
		expect(items[1].snippet).toBe("beta body");
	});
});
