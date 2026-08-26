import http from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { proxyUrl, tunnelSocket } from "./proxy.ts";

const proxyEnvKeys = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
const inheritedProxyEnv = new Map(proxyEnvKeys.map((key) => [key, process.env[key]]));

function clearProxyEnv(): void {
	for (const key of proxyEnvKeys) delete process.env[key];
}

beforeEach(clearProxyEnv);
afterEach(clearProxyEnv);
afterAll(() => {
	for (const [key, value] of inheritedProxyEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("finding the sandbox proxy", () => {
	it("is empty when nothing is configured, so the direct path is unchanged", () => {
		expect(proxyUrl()).toBe("");
	});

	// HTTPS_PROXY wins: srt sets both, and ALL_PROXY is the broader fallback.
	it("prefers HTTPS_PROXY over ALL_PROXY", () => {
		process.env.ALL_PROXY = "http://all:1";
		expect(proxyUrl()).toBe("http://all:1");
		process.env.HTTPS_PROXY = "http://https:2";
		expect(proxyUrl()).toBe("http://https:2");
	});
});

/** A proxy that answers every CONNECT with `status`, recording what it was asked. */
function fakeProxy(status: number): Promise<{ port: number; seen: string[]; close: () => void }> {
	const seen: string[] = [];
	const server = http.createServer();
	server.on("connect", (req, socket) => {
		seen.push(`${req.url} auth=${req.headers["proxy-authorization"] ?? "none"}`);
		socket.end(`HTTP/1.1 ${status} nope\r\n\r\n`);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () =>
			resolve({
				port: (server.address() as { port: number }).port,
				seen,
				close: () => server.close(),
			}),
		);
	});
}

describe("tunnelling to Cursor through the proxy", () => {
	// The operator-facing half. A refused CONNECT is almost always the sandbox
	// allowlist, and the raw socket error says nothing about which host to add —
	// which is how a launch with a perfectly good credential reported only
	// "the pending stream has been canceled".
	it("names the allowlist when the proxy refuses", async () => {
		const proxy = await fakeProxy(403);
		try {
			await expect(
				tunnelSocket(new URL("https://api2.cursor.sh"), new URL(`http://127.0.0.1:${proxy.port}`)),
			).rejects.toThrow(/allowedDomains/);
		} finally {
			proxy.close();
		}
	});

	// The CONNECT target must be host:port — a proxy cannot resolve a full URL,
	// and the sandbox has no DNS for the client to fall back on.
	it("asks for host:port and forwards the proxy credentials", async () => {
		const proxy = await fakeProxy(403);
		try {
			await tunnelSocket(
				new URL("https://api2.cursor.sh"),
				new URL(`http://user:pass@127.0.0.1:${proxy.port}`),
			).catch(() => {});
			expect(proxy.seen[0]).toContain("api2.cursor.sh:443");
			// srt injects credentials in the URL; they must reach the proxy or
			// every CONNECT is refused for the wrong reason.
			expect(proxy.seen[0]).toContain("auth=Basic ");
		} finally {
			proxy.close();
		}
	});
});
