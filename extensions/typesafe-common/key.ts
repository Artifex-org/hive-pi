/**
 * The Jev API keys — one per route. Env first, then pi's auth store.
 *
 * Deliberately a mirror of `compaction/index.ts:readApiKey` rather than a new
 * idea, because the thing it gets right is not obvious: the key that comes back
 * from `auth.json` may be a REFERENCE (`!op read op://…`, `$VAR`) and not a
 * literal, and handing one of those to `fetch` puts someone's 1Password command
 * line into an `Authorization:` header. `apiKeyFromCredential` is the vetting
 * that refuses those; it lives in `hive-common/identity.ts` so that this file
 * and compaction share one copy. See the comment there.
 *
 * NOT A CONSENT SIGNAL. `identity.ts:resolveAuth` states the rule this file
 * obeys: a key found in the environment is a credential SOURCE, never a
 * decision to use it. `config.ts:enabled === true` is the only thing that turns
 * anything on, and a key present with `enabled` absent must stay inert.
 *
 * Blocking I/O — `readStoredCredential` reads a file. Like everything in
 * `hive-common/identity.ts`, it must never be called from a pi event handler:
 * pi awaits handlers serially, so a file read inside one is stalled agent loop.
 * Read it once, at construction, and hold the result.
 */

import { readStoredCredential } from "@earendil-works/pi-coding-agent";

import { apiKeyFromCredential } from "../hive-common/identity.ts";

/** The env var, named once so a test and the docs cannot drift from the code. */
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";

/** pi's credential id for this provider, as `auth.json` keys it. */
export const TYPESAFE_CREDENTIAL = "typesafe";

/**
 * The OpenRouter key for the `openrouter` Jev route: env first, then this
 * credential id in `auth.json` (the Hive registry leases it under this name).
 *
 * NEVER THE PLAIN `openrouter` ENTRY. In `auth.json` an `openrouter` key is a
 * pi PROVIDER credential: it makes every `openrouter/*` chat model routable,
 * and that is how chat turns silently spent on OpenRouter before (HIV-3617).
 * `typesafe-openrouter` is deliberately not a pi provider name, so leasing the
 * Jev fallback key cannot re-open that path, and reading the plain entry here
 * would invite someone to "simplify" the lease back into it.
 */
export const TYPESAFE_OPENROUTER_API_KEY_ENV = "TYPESAFE_OPENROUTER_API_KEY";
export const TYPESAFE_OPENROUTER_CREDENTIAL = "typesafe-openrouter";

/** `readStoredCredential`'s shape, injectable so a test never reads the developer's own auth.json. */
export type CredentialReader = (credentialId: string) => unknown;

export function readApiKey(
	env: Record<string, string | undefined> = process.env,
	readCredential: CredentialReader = readStoredCredential,
): string | null {
	const fromEnv = env[TYPESAFE_API_KEY_ENV];
	if (fromEnv) return fromEnv;
	return apiKeyFromCredential(readCredential(TYPESAFE_CREDENTIAL));
}

/** Same rules as `readApiKey`: a reference (`!op read …`, `$VAR`) is refused, not resolved. */
export function readOpenrouterApiKey(
	env: Record<string, string | undefined> = process.env,
	readCredential: CredentialReader = readStoredCredential,
): string | null {
	const fromEnv = env[TYPESAFE_OPENROUTER_API_KEY_ENV];
	if (fromEnv) return fromEnv;
	return apiKeyFromCredential(readCredential(TYPESAFE_OPENROUTER_CREDENTIAL));
}
