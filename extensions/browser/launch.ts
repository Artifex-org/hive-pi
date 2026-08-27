/**
 * Launch-option derivation for the per-session browser (HIV-1636).
 *
 * Sandboxed (srt) sessions need three deviations from a plain launch, all
 * measured 2026-08-09 inside a launch-shaped sandbox:
 *
 * - srt's egress proxy env (HTTP(S)_PROXY) carries per-launch credentials in
 *   the URL userinfo. Chromium ignores userinfo in proxy configuration
 *   (crbug.com/16709), so external navigation 407s unless the credentials are
 *   handed to Playwright's `proxy` launch option, which answers the auth
 *   challenge itself. With it: 200 on an allowlisted domain,
 *   ERR_TUNNEL_CONNECTION_FAILED on a blocked one — the srt domain allowlist
 *   keeps working through the browser.
 * - Chromium's own sandbox cannot start inside srt (user namespaces are
 *   blocked under bubblewrap) → chromiumSandbox: false; srt is the boundary.
 * - /dev/shm is constrained in the sandbox → --disable-dev-shm-usage.
 *
 * Outside a sandbox none of that applies: the browser keeps its own sandbox
 * and no proxy is injected (Chromium handles credential-less proxy env vars
 * by itself).
 */

export interface ProxyOption {
	server: string;
	username: string;
	password: string;
	bypass: string;
}

export interface BrowserLaunchPlan {
	headless: true;
	chromiumSandbox?: false;
	args?: string[];
	proxy?: ProxyOption;
}

/**
 * Recognise an authenticated proxy in the environment. srt mints a per-launch
 * credential and embeds it as URL userinfo; a credential-less proxy needs no
 * translation.
 */
export function parseAuthenticatedProxy(env: Record<string, string | undefined>): ProxyOption | null {
	const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
	if (!raw) return null;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (!u.username) return null;
	return {
		server: `${u.protocol}//${u.hostname}:${u.port}`,
		username: decodeURIComponent(u.username),
		password: decodeURIComponent(u.password),
		// The primary use case is the agent's own dev server on loopback; that
		// must never detour through the proxy.
		bypass: "localhost,127.0.0.1",
	};
}

export function buildLaunchPlan(env: Record<string, string | undefined>): BrowserLaunchPlan {
	const proxy = parseAuthenticatedProxy(env);
	// HIVE_LAUNCH_ID marks a Hive-launched (sandboxed) session even if the
	// proxy env were ever absent; either signal applies the sandbox flags.
	const sandboxed = proxy !== null || Boolean(env.HIVE_LAUNCH_ID);
	const plan: BrowserLaunchPlan = { headless: true };
	if (sandboxed) {
		plan.chromiumSandbox = false;
		plan.args = ["--disable-dev-shm-usage"];
		if (proxy) plan.proxy = proxy;
	}
	return plan;
}
