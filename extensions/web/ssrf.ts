/**
 * web — SSRF guard (HIV-1224).
 *
 * `fetch_content` takes model-chosen URLs, and this machine sits on networks
 * a URL must never reach: the home LAN (192.168.x), the k8s NodePorts, the
 * Tailscale range (100.64/10 — CGNAT space), cluster-internal names. The
 * guard is the same idea pi-web-access shipped, kept because it is the one
 * part of that package that was load-bearing security rather than feature.
 *
 * The resolver is injectable so the DNS path is testable; production uses
 * `dns.lookup` (the same resolution fetch will use). A TOCTOU window between
 * check and fetch remains — accepted for a workstation tool; the redirect
 * loop in index.ts re-asserts every hop, which closes the practical bypass
 * (a public URL 302ing to an internal one).
 *
 * "the same resolution fetch will use" is true only when this process is the
 * one resolving. Behind an HTTP proxy it is not, and inside Hive's srt sandbox
 * there is no resolver at all — see `egressGoesThroughAProxy` for the measured
 * detail and for what the guard does instead.
 */

import { lookup } from "node:dns/promises";

export type Resolver = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultResolver: Resolver = async (hostname) => {
	const results = await lookup(hostname, { all: true });
	return results.map((entry) => ({ address: entry.address }));
};

/**
 * Is egress going through an HTTP proxy rather than out of this host directly?
 *
 * This matters because the guard's central assumption — "resolve the name, and
 * `fetch` will use the addresses I just checked" — is false behind a proxy.
 * There the PROXY resolves, host-side, and the address this process would see
 * is not the address the request reaches.
 *
 * Inside Hive's srt sandbox that assumption does not merely weaken, it
 * inverts: the sandbox has NO DNS AT ALL, for every name, allowlisted or not.
 * Measured 2026-08-25 in a live launched profile whose allowlist NAMED
 * github.com:
 *
 *     getent hosts github.com          -> (nothing)
 *     dns.lookup("github.com")         -> EAI_AGAIN
 *     curl https://github.com          -> 200        (via the proxy)
 *     fetch("https://github.com")      -> 200        (NODE_USE_ENV_PROXY=1)
 *
 * So `fetch_content` failed CLOSED on every URL an agent ever gave it — the
 * resolve threw before a request was attempted, and the agent was told
 * "could not resolve github.com" about a host that was reachable and allowed.
 * Every launched agent, for the life of the tool.
 *
 * Gated on the proxy being CONFIGURED, deliberately, rather than on a lookup
 * having failed: "retry without the check when DNS is unhappy" would quietly
 * disable the guard on an ordinary workstation with a flaky resolver, which is
 * precisely when it is load-bearing.
 */
export type ProxyEnv = Record<string, string | undefined>;

export function egressGoesThroughAProxy(env: ProxyEnv = process.env): boolean {
	return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy);
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".local", ".internal", ".localdomain", ".ts.net"];

export function isBlockedHostname(hostname: string): boolean {
	const name = hostname.toLowerCase().replace(/\.$/, "");
	if (BLOCKED_HOSTNAMES.has(name)) return true;
	return BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function parseIpv4(address: string): number[] | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
	return octets.every((octet) => Number.isInteger(octet) && octet <= 255) ? octets : null;
}

function isPrivateIpv4(octets: number[]): boolean {
	const [a, b] = octets;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true; // link-local + cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — the Tailscale range
	if (a === 192 && b === 0) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	return a >= 224; // multicast + reserved
}

export function isPrivateAddress(address: string): boolean {
	const bare = address.toLowerCase().replace(/^\[|\]$/g, "");

	const v4 = parseIpv4(bare);
	if (v4) return isPrivateIpv4(v4);

	if (bare.includes(":")) {
		if (bare === "::" || bare === "::1") return true;
		// v4-mapped (::ffff:10.0.0.1) — judge the embedded v4.
		const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped) {
			const octets = parseIpv4(mapped[1]);
			return octets ? isPrivateIpv4(octets) : true;
		}
		if (bare.startsWith("fc") || bare.startsWith("fd")) return true; // ULA
		if (bare.startsWith("fe8") || bare.startsWith("fe9") || bare.startsWith("fea") || bare.startsWith("feb"))
			return true; // link-local
		return false;
	}

	// Not an IP at all — the caller resolves hostnames separately.
	return false;
}

function looksLikeIpLiteral(hostname: string): boolean {
	return parseIpv4(hostname) !== null || hostname.includes(":") || hostname.startsWith("[");
}

/**
 * Parse and vet a URL for outbound fetching. Throws with a reason a human can
 * act on; returns the parsed URL when it is safe to request.
 */
export async function assertPublicHttpUrl(
	rawUrl: string,
	resolver: Resolver = defaultResolver,
	env: ProxyEnv = process.env,
): Promise<URL> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`not a valid URL: ${rawUrl}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`only http(s) URLs are fetched (got ${url.protocol.replace(":", "")})`);
	}
	const hostname = url.hostname;
	if (isBlockedHostname(hostname)) throw new Error(`refusing internal hostname: ${hostname}`);
	if (looksLikeIpLiteral(hostname)) {
		if (isPrivateAddress(hostname)) throw new Error(`refusing private address: ${hostname}`);
		return url;
	}
	// Behind a proxy the resolve-and-inspect step cannot do its job: this
	// process does not resolve the name, and inside the sandbox it cannot
	// resolve anything at all. Skipping it is not dropping the protection so
	// much as naming where the protection actually lives — the checks ABOVE
	// (internal hostnames, private IP literals) still run on every hop, and
	// which hostnames may be reached at all is enforced by srt's domain
	// allowlist, host-side, where the resolution happens.
	//
	// What is genuinely given up is the public-name-resolving-to-a-private-
	// address case. That was already the guard's weakest claim — the TOCTOU
	// note above concedes it — and behind an allowlist a name has to be
	// permitted before it can be resolved at all.
	if (egressGoesThroughAProxy(env)) return url;

	let resolved: Array<{ address: string }>;
	try {
		resolved = await resolver(hostname);
	} catch {
		throw new Error(`could not resolve ${hostname}`);
	}
	if (resolved.length === 0) throw new Error(`could not resolve ${hostname}`);
	const bad = resolved.find((entry) => isPrivateAddress(entry.address));
	if (bad) throw new Error(`refusing ${hostname} — it resolves to a private address (${bad.address})`);
	return url;
}
