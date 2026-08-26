/**
 * Reaching Cursor from inside a sandbox.
 *
 * A launched hive agent runs in its own network namespace with NO DNS. Egress
 * rides an authenticated HTTP proxy injected as HTTPS_PROXY / ALL_PROXY, and the
 * proxy resolves names on the host side.
 *
 * Node's `fetch` can be told to honour those variables (NODE_USE_ENV_PROXY).
 * `node:http2` cannot — it has no proxy support at all — so `http2.connect`
 * tries to resolve the hostname itself, inside a namespace where every lookup
 * fails. MEASURED in a real launch's own sandbox (2026-08-19, launch dbe737f5):
 *
 *   getent hosts api2.cursor.sh   -> (nothing)
 *   node http2.connect(...)       -> EAI_AGAIN
 *
 * which surfaces to the operator as `Cursor stream error: The pending stream has
 * been canceled`, retried three times and then given up on. That message names
 * neither DNS, nor the proxy, nor the host — the agent had a perfectly good
 * hive-provided credential and no way to learn why it could not use it.
 *
 * So when a proxy is configured we build the tunnel ourselves: CONNECT to the
 * proxy, then run TLS (ALPN h2) over that socket and hand the result to
 * http2.connect. With no proxy configured this module does nothing and the
 * direct path is unchanged — which is every non-sandboxed run.
 */

import * as http from "node:http";
import type * as net from "node:net";
import * as tls from "node:tls";

/** The proxy to use, or "" when none is configured. */
export function proxyUrl(): string {
	for (const k of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
		const v = process.env[k];
		if (v && v.trim()) return v.trim();
	}
	return "";
}

/**
 * Open a CONNECT tunnel and negotiate TLS for `target` through it.
 *
 * The proxy's own credentials ride in the URL (srt injects them there), so they
 * are read from the URL rather than a second variable.
 *
 * ALPN is pinned to h2 because that is the only protocol this transport speaks:
 * if the proxy or origin will not do h2, failing here with a TLS/ALPN error is a
 * better answer than an http2 session that mysteriously produces nothing.
 */
export function tunnelSocket(target: URL, proxy: URL): Promise<tls.TLSSocket> {
	const port = target.port || "443";
	const auth = proxy.username
		? "Basic " +
			Buffer.from(
				`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
			).toString("base64")
		: "";
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: proxy.hostname,
			port: proxy.port || 80,
			method: "CONNECT",
			path: `${target.hostname}:${port}`,
			headers: auth ? { "Proxy-Authorization": auth } : {},
		});
		req.once("connect", (res: http.IncomingMessage, socket: net.Socket) => {
			if (res.statusCode !== 200) {
				// A refused CONNECT is usually the allowlist, and saying so beats a
				// bare socket error: the host is the thing the operator has to add.
				socket.destroy();
				reject(
					new Error(
						`proxy refused CONNECT to ${target.hostname} (${res.statusCode}); ` +
							`is the host in the sandbox's allowedDomains?`,
					),
				);
				return;
			}
			const secured = tls.connect(
				{ socket, servername: target.hostname, ALPNProtocols: ["h2"] },
				() => resolve(secured),
			);
			secured.once("error", reject);
		});
		req.once("error", reject);
		req.end();
	});
}
