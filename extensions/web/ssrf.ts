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
	const [a, b, c, d] = octets;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true; // link-local + cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — the Tailscale range
	if (a === 192 && b === 0) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	// Azure's wireserver. A PUBLIC address that every Azure VM routes to its own
	// host agent, so the 169.254.169.254 rule does not cover it and no range
	// rule ever will — it has to be named.
	if (a === 168 && b === 63 && c === 129 && d === 16) return true;
	return a >= 224; // multicast + reserved
}

/**
 * The v4 embedded in a v6 literal, or null.
 *
 * THE BUG THIS EXISTS FOR. The previous check matched only the DOTTED form
 * `::ffff:10.0.0.1` — and `URL` never produces it. WHATWG normalisation
 * compresses every v4-mapped literal to hex:
 *
 *   new URL("http://[::ffff:127.0.0.1]/").hostname  ===  "[::ffff:7f00:1]"
 *
 * So at the only call site that matters the regex could not match, execution
 * fell through to "public", and `http://[::ffff:7f00:1]/` reached loopback.
 * Same for the LAN, for CGNAT, and for 169.254.169.254. The unit tests passed
 * because they called the helper with dotted strings the parser cannot emit —
 * a guard tested against a shape its real input never has.
 *
 * Also handles the two transitional prefixes that carry a v4 destination in
 * their low bits: NAT64 `64:ff9b::/96` and 6to4 `2002::/16`.
 */
function embeddedIpv4(bare: string): number[] | null {
	// Dotted tail, in any of the forms that carry one.
	const dotted = bare.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
	if (dotted) return parseIpv4(dotted[1]);

	const groups = expandIpv6(bare);
	if (!groups) return null;

	const hexToOctets = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

	// v4-mapped ::ffff:0:0/96 and the deprecated v4-compatible ::0:0/96.
	if (groups.slice(0, 5).every((g) => g === 0)) {
		if (groups[5] === 0xffff || groups[5] === 0) return hexToOctets(groups[6], groups[7]);
	}
	// NAT64 well-known prefix 64:ff9b::/96 — the v4 is the last two groups.
	if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
		return hexToOctets(groups[6], groups[7]);
	}
	// 6to4 2002::/16 — the v4 is groups 1-2.
	if (groups[0] === 0x2002) return hexToOctets(groups[1], groups[2]);

	return null;
}

/** Eight 16-bit groups, or null when this is not a parseable v6 literal. */
function expandIpv6(bare: string): number[] | null {
	if (!bare.includes(":")) return null;
	const zone = bare.indexOf("%"); // scoped literal — drop the zone id
	const addr = zone === -1 ? bare : bare.slice(0, zone);
	const halves = addr.split("::");
	if (halves.length > 2) return null;

	const toGroups = (part: string): number[] | null => {
		if (part === "") return [];
		const out: number[] = [];
		for (const piece of part.split(":")) {
			if (piece.includes(".")) {
				const v4 = parseIpv4(piece);
				if (!v4) return null;
				out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
			out.push(Number.parseInt(piece, 16));
		}
		return out;
	};

	const head = toGroups(halves[0]);
	const tail = halves.length === 2 ? toGroups(halves[1]) : [];
	if (head === null || tail === null) return null;
	if (halves.length === 1) return head.length === 8 ? head : null;
	const fill = 8 - head.length - tail.length;
	if (fill < 1) return null;
	return [...head, ...Array(fill).fill(0), ...tail];
}

export function isPrivateAddress(address: string): boolean {
	const bare = address.toLowerCase().replace(/^\[|\]$/g, "");

	const v4 = parseIpv4(bare);
	if (v4) return isPrivateIpv4(v4);

	if (bare.includes(":")) {
		const groups = expandIpv6(bare);
		// Unparseable but colon-bearing: FAIL CLOSED. An address shape we cannot
		// classify is not evidence that it is public.
		if (!groups) return true;
		if (groups.every((g) => g === 0)) return true; // ::
		if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1

		// Any v4 carried inside a v6 literal is judged as that v4 — mapped,
		// compatible, NAT64 or 6to4. This is what the dotted-only check missed.
		const embedded = embeddedIpv4(bare);
		if (embedded) return isPrivateIpv4(embedded);

		if ((groups[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
		if ((groups[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
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
