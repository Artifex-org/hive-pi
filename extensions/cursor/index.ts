/**
 * cursor — use a Cursor SUBSCRIPTION's models from pi (HIV-2086).
 *
 * Registers a `cursor` provider whose credential is a Cursor subscription
 * session (browser OAuth), not a dashboard API key. That distinction is the
 * whole point: an API key bills at Cursor's API prices, while the session spends
 * the flat-rate subscription — which is what makes routing fleet work through
 * these models worth doing.
 *
 * What arrives with it: Cursor's OWN models — the Composer and Cursor-Grok
 * families — at zero marginal cost, reporting real token usage.
 *
 * The catalogue also offers ~190 third-party passthroughs (claude-*, gpt-*,
 * gemini-*). Those are deliberately NOT registered: Cursor bills them against a
 * separate, much smaller pool at the model's API price, so routing to them
 * would spend metered credit while looking like flat-rate subscription work.
 * See isCursorOwnModel in models.ts — it is a billing boundary, not a taste.
 *
 * ## Tools
 *
 * Cursor's native tools (read/write/ls/grep/shell/delete) ARE bridged: its
 * server-side loop asks the client to run each call, and exec.ts serves those
 * requests from pi's own tool implementations, so limits and guards match a
 * pi-driven turn. A verified turn reads a file, edits it and reports back.
 *
 * pi's EXTENSION tools are not reachable — `factory_finish` in particular — so
 * this is registered for interactive sessions and deliberately NOT on the
 * factory path, where a run without a finish handshake would grade as a
 * protocol failure that says nothing about the model.
 *
 * ## Files
 *
 *   protocol.ts   Connect framing + the error whose CODE lies about its cause
 *   auth.ts       PKCE browser login (60-day session tokens)
 *   transport.ts  the bidirectional Run stream
 *   models.ts     the live catalogue
 *   usage.ts      remaining subscription allowance
 *   provider.ts   pi event mapping
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createChallenge, pollForApproval, type CursorCredentials } from "./auth.ts";
import { fetchModels, toPiModels } from "./models.ts";
import { streamCursor } from "./provider.ts";
import { fetchUsage } from "./usage.ts";

/**
 * Models registered before the live catalogue is known.
 *
 * The catalogue needs a token, and a provider with no models is invisible in
 * `/model` — so a signed-out user would have no way to discover that logging in
 * is what they are missing. These are the stable frontier ids; the real list
 * replaces them after login.
 */
// Cursor's own families only — the same boundary isCursorOwnModel enforces, so
// a seed entry cannot advertise a model the catalogue refresh would then drop.
const SEED_MODEL_IDS = [
	"composer-2.5",
	"composer-2.5-fast",
	"cursor-grok-4.6-high",
	"cursor-grok-4.6-xhigh",
	"cursor-grok-4.5-high",
];

export default function (pi: ExtensionAPI) {
	const register = (models: ReturnType<typeof toPiModels>) => {
		pi.registerProvider("cursor", {
			name: "Cursor (subscription)",
			baseUrl: "https://api2.cursor.sh",
			api: "cursor-agent-run",
			models,
			streamSimple: streamCursor,
			oauth: {
				name: "Cursor (subscription)",
				async login(callbacks): Promise<CursorCredentials> {
					const pkce = createChallenge();
					callbacks.onAuth({ url: pkce.loginUrl });
					callbacks.onProgress?.("Waiting for Cursor login approval in your browser…");
					const creds = await pollForApproval(pkce, callbacks.signal);
					callbacks.onProgress?.("Cursor login complete.");
					return creds;
				},
				// Refresh is deliberately a no-op that returns the credential
				// unchanged. Cursor's documented refresh endpoint
				// (`exchange_user_api_key`) answers 401 for session tokens — it serves
				// dashboard API keys — and the session itself lasts 60 days. A refresh
				// that always failed would turn a working credential into a login
				// loop; pi re-runs the flow when `expires` passes, which is honest
				// until the real endpoint is identified.
				async refreshToken(credentials: CursorCredentials) {
					return credentials;
				},
				getApiKey: (credentials: CursorCredentials) => credentials.access,
			},
		});
	};

	register(
		toPiModels(SEED_MODEL_IDS.map((modelId) => ({ modelId, displayName: modelId }))),
	);

	// `/cursor-usage` — what is left of the subscription this month.
	//
	// Worth a command rather than only a background poll: the allowance is what
	// actually bounds a Cursor run (there is no dollar budget to hit), so
	// "how much is left" is the question an operator asks before a long session.
	pi.registerCommand("cursor-usage", {
		description: "Show remaining Cursor subscription allowance for this billing period",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const token = cursorToken();
			if (!token) {
				ctx.ui.notify("Not signed in to Cursor. Run /login cursor.", "warning");
				return;
			}
			try {
				const usage = await fetchUsage(token);
				const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
				const renews = usage.billingCycleEnd
					? `, renews ${usage.billingCycleEnd.toISOString().slice(0, 10)}`
					: "";
				ctx.ui.notify(
					`Cursor: ${dollars(usage.remainingCents)} of ${dollars(usage.limitCents)} remaining (${usage.remainingPercent}%${renews})`,
					// Below a tenth of the allowance, this stops being information and
					// becomes something to act on before starting a long session.
					usage.remainingPercent <= 10 ? "warning" : "info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Could not read Cursor usage: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// Replace the seed list with the live catalogue once a credential exists.
	// Failure is deliberately quiet: the seed models keep working, so a catalogue
	// outage degrades the model LIST rather than taking the provider down.
	pi.on("session_start", async () => {
		const token = cursorToken();
		if (!token) return;
		try {
			const models = await fetchModels(token);
			if (models.length) register(toPiModels(models));
		} catch {
			// Keep the seed models rather than unregistering a working provider.
		}
	});
}

/**
 * The access token, for the two calls that are NOT model requests.
 *
 * pi injects the resolved credential into `streamSimple` via `options.apiKey`,
 * but the catalogue refresh and the usage command run outside a model request
 * and have no such hook. `CURSOR_ACCESS_TOKEN` is the documented way to hand
 * them one; without it both degrade rather than fail (seed models, and a
 * "sign in" notice), which is why neither throws here.
 */
function cursorToken(): string {
	return process.env.CURSOR_ACCESS_TOKEN?.trim() ?? "";
}
