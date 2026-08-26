/**
 * Cursor subscription auth (HIV-2086).
 *
 * A PKCE browser flow against Cursor's own login page, polled to completion:
 *
 *   1. mint verifier/challenge + a uuid
 *   2. open cursor.com/loginDeepControl?challenge&uuid&mode=login&redirectTarget=cli
 *   3. poll api2.cursor.sh/auth/poll?uuid&verifier until it stops 404ing
 *
 * MEASURED PROPERTIES (probed against a real subscription, 2026-08-18) — these
 * differ from what the public integrations assume, so they are recorded here:
 *
 *   - the access token is an Auth0 SESSION JWT with a **60-day** exp
 *     (iss authentication.cursor.sh, type "session"), not an hourly token;
 *   - the poll returns `accessToken, refreshToken, challenge, authId, uuid`;
 *   - `POST /auth/exchange_user_api_key` — which other integrations call to
 *     refresh — returns 401 "Invalid User API Key" for BOTH tokens. It serves
 *     dashboard API keys, not session tokens. The session-refresh path is
 *     unknown, and a 60-day life makes that tolerable for now.
 *
 * The last point is why `refresh()` is absent rather than wrong: shipping a
 * refresh that 401s would turn a working 60-day credential into a login loop.
 * pi re-runs the flow when the token expires, which is the honest behaviour
 * until the real endpoint is found.
 */

import { createHash, randomUUID } from "node:crypto";

import type { OAuthCredentials } from "@earendil-works/pi-ai";

const LOGIN_URL = "https://cursor.com/loginDeepControl";
const POLL_URL = "https://api2.cursor.sh/auth/poll";

/** Poll pacing: gentle backoff, ~5 minutes of total patience. */
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF = 1.2;
/** Consecutive transport failures tolerated before giving up. */
const POLL_ERROR_BUDGET = 3;

/**
 * Extends pi's OAuthCredentials rather than restating it: pi persists whatever
 * it is handed into auth.json, and its type carries an index signature. A
 * structurally-identical local interface does NOT satisfy that, so declaring one
 * is a type error at the registration site — with a message about index
 * signatures that reads nothing like "use pi's type".
 */
export interface CursorCredentials extends OAuthCredentials {
	access: string;
	refresh: string;
	/** ms since epoch, from the JWT's own `exp`. */
	expires: number;
}

const base64url = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface PkceChallenge {
	verifier: string;
	challenge: string;
	uuid: string;
	loginUrl: string;
}

/** Mint the PKCE pair and the login URL the human must approve. */
export function createChallenge(): PkceChallenge {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	const uuid = randomUUID();
	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});
	return { verifier, challenge, uuid, loginUrl: `${LOGIN_URL}?${params}` };
}

/**
 * Read a JWT's expiry without verifying it.
 *
 * Not a security check — the server validates the token. This exists so the
 * provider knows when to prompt for a fresh login instead of discovering
 * expiry as a mid-turn 401.
 */
export function tokenExpiry(token: string): number {
	try {
		const [, payload] = token.split(".");
		if (!payload) return Date.now() + 3_600_000;
		const claims = JSON.parse(
			Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
		) as { exp?: number };
		// A five-minute skew margin, so a token is never handed out on the
		// assumption it survives the request it is about to start.
		if (typeof claims.exp === "number") return claims.exp * 1000 - 300_000;
	} catch {
		// Fall through: an unreadable token is treated as short-lived rather than
		// trusted, so the failure is a re-login rather than a broken turn.
	}
	return Date.now() + 3_600_000;
}

export function isExpired(creds: CursorCredentials, now = Date.now()): boolean {
	return !creds.access || creds.expires <= now;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Cursor login cancelled"));
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Cursor login cancelled"));
			},
			{ once: true },
		);
	});

/**
 * Poll until the human approves the login in their browser.
 *
 * 404 is the documented "not yet" answer and must not count against the error
 * budget — treating it as a failure would abandon the flow within seconds of
 * showing the user a URL.
 */
export async function pollForApproval(
	pkce: PkceChallenge,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<CursorCredentials> {
	let delay = POLL_BASE_DELAY_MS;
	let consecutiveErrors = 0;

	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		if (signal?.aborted) throw new Error("Cursor login cancelled");
		await sleep(delay, signal);

		try {
			const url = `${POLL_URL}?uuid=${encodeURIComponent(pkce.uuid)}&verifier=${encodeURIComponent(pkce.verifier)}`;
			const res = await fetchImpl(url, { signal });

			if (res.status === 404) {
				consecutiveErrors = 0;
				delay = Math.min(Math.round(delay * POLL_BACKOFF), POLL_MAX_DELAY_MS);
				continue;
			}
			if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`);

			const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
			if (!data.accessToken) throw new Error("poll succeeded but returned no accessToken");

			return {
				access: data.accessToken,
				refresh: data.refreshToken ?? "",
				expires: tokenExpiry(data.accessToken),
			};
		} catch (err) {
			if (signal?.aborted) throw new Error("Cursor login cancelled");
			if (++consecutiveErrors >= POLL_ERROR_BUDGET) {
				throw new Error(
					`Cursor login polling failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
	throw new Error("Cursor login timed out waiting for browser approval");
}
