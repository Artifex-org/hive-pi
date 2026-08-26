/**
 * hive-common — HTTP primitives shared by every Hive-facing extension.
 *
 * Timeouts, error redaction and the 4xx/5xx classification live here; RETRIES do
 * not. The caller owns backoff so that a spool drain and a live flush share one
 * policy rather than two that drift apart.
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 8_000;

export interface HiveAuth {
	token: string;
	url: string;
}

export interface RequestResult<T = unknown> {
	ok: boolean;
	status: number | null;
	/** Auth failed: stop for this process rather than retrying on a timer. */
	authFailed: boolean;
	/** Permanently malformed for this server: drop rather than retry forever. */
	permanent: boolean;
	body?: T;
	error?: string;
}

/**
 * redact keeps a network error's shape without its content. A fetch error can
 * embed the full request URL, and a URL can carry a token in a query string —
 * so only the error's name and a short generic message are ever surfaced.
 */
export function redact(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === "AbortError") return "timeout";
		return err.name || "error";
	}
	return "error";
}

/** Longest server explanation kept. Enough for a sentence, never a page. */
const MAX_SERVER_ERROR = 200;

/**
 * serverError extracts Hive's own explanation of a rejection.
 *
 * This is the opposite case to `redact`, and the distinction matters. `redact`
 * exists because a *fetch* error can embed the request URL, and a URL can carry a
 * token — so a thrown error's content is never surfaced. A *response body* from
 * Hive is problem+json that Hive itself wrote to be read: `detail` says exactly
 * which field was refused.
 *
 * Discarding it was expensive. A rejected attach reported nothing but
 * `attached: no`, so diagnosing one meant replaying the request by hand with curl
 * to see a message the client had already received and dropped (HIV-1163).
 *
 * Only the two known string fields are read, and the result is length-bounded, so
 * a proxy's HTML error page or an oversized body cannot become the message.
 */
async function serverError(res: Response): Promise<string | undefined> {
	try {
		const body = (await res.json()) as { detail?: unknown; error?: unknown };
		const detail = typeof body.detail === "string" ? body.detail : "";
		const error = typeof body.error === "string" ? body.error : "";
		const message = detail || error;
		return message ? message.slice(0, MAX_SERVER_ERROR) : undefined;
	} catch {
		// No body, or not JSON. The status alone is what the caller gets.
		return undefined;
	}
}

export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	timer.unref?.();
	try {
		return await fn(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * classify turns an HTTP status into the retry decision.
 *
 * A 4xx other than 401/403/429 is PERMANENT: a payload this server will never
 * accept must be dropped, or one malformed spool file would be retried for the
 * rest of the machine's life.
 */
export function classify(status: number): { authFailed: boolean; permanent: boolean } {
	const authFailed = status === 401 || status === 403;
	return { authFailed, permanent: status >= 400 && status < 500 && !authFailed && status !== 429 };
}

/** request performs one JSON call against the Hive API and never throws. */
export async function request<T = unknown>(
	auth: HiveAuth,
	method: string,
	path: string,
	body?: unknown,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RequestResult<T>> {
	try {
		const res = await withTimeout(timeoutMs, (signal) =>
			fetch(`${auth.url}/api/v1${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${auth.token}`,
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
			}),
		);
		if (!res.ok) {
			const { authFailed, permanent } = classify(res.status);
			return { ok: false, status: res.status, authFailed, permanent, error: await serverError(res) };
		}
		let parsed: T | undefined;
		if (res.status !== 204) {
			try {
				parsed = (await res.json()) as T;
			} catch {
				/* a 2xx with no/!json body is still a success */
			}
		}
		return { ok: true, status: res.status, authFailed: false, permanent: false, body: parsed };
	} catch (err) {
		return { ok: false, status: null, authFailed: false, permanent: false, error: redact(err) };
	}
}

export interface WhoAmI {
	scope: string;
	name?: string;
	tokenName?: string;
	hasUser: boolean;
}

export type ValidateResult = { ok: true; who: WhoAmI } | { ok: false; message: string };

/**
 * validateToken checks a token against GET /api/v1/me. It is the whole of
 * /hive-login's verification: the server answers with the token's own identity,
 * so a typo is caught immediately rather than at the first silent 401 hours
 * later.
 */
export async function validateToken(url: string, token: string): Promise<ValidateResult> {
	try {
		const res = await withTimeout(LOGIN_TIMEOUT_MS, (signal) =>
			fetch(`${url.replace(/\/+$/, "")}/api/v1/me`, {
				headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
				signal,
			}),
		);
		if (res.status === 401 || res.status === 403) {
			return { ok: false, message: "invalid, expired or revoked token" };
		}
		if (!res.ok) return { ok: false, message: `server returned ${res.status}` };

		const body = (await res.json()) as {
			scope?: string;
			id?: string | null;
			name?: string | null;
			token_name?: string | null;
		};
		return {
			ok: true,
			who: {
				scope: body.scope ?? "unknown",
				name: body.name ?? undefined,
				tokenName: body.token_name ?? undefined,
				// A machine token has no owning user, and the agent-session
				// endpoints refuse those — so warn at login rather than let every
				// call fail with a 403 nobody sees.
				hasUser: Boolean(body.id),
			},
		};
	} catch (err) {
		return { ok: false, message: redact(err) };
	}
}
