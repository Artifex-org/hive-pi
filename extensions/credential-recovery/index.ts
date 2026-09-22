import { existsSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { readStoredCredential, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modifyCredential } from "./storage.ts";
import { exchange, identity, type Transport } from "./client.ts";
import { isQuotaExhaustedText } from "./quota.ts";

export const RECOVERY_CHANNEL = "hive.credential-recovery";

/** A unix-socket connect that will keep failing: the sandbox forbids it, or the socket is gone. */
export function isSocketUnreachable(text: string): boolean {
	return /\b(EPERM|EACCES|ENOENT|ECONNREFUSED)\b/.test(text);
}

/** The one-line reason a sandboxed session cannot switch accounts itself. */
export const SANDBOX_UNAVAILABLE = "Account switching unavailable in this sandbox (the recovery socket cannot be reached) — handing the quota failure to Hive's provider failover";

/**
 * Whether the recovery socket accepts a connection from THIS process.
 *
 * `existsSync` cannot answer that: srt's seccomp filter blocks socket(AF_UNIX)
 * outright, so a sandboxed agent sees the file and still gets `connect EPERM`
 * (HIV-3452). A stat said "available", every quota failure then printed
 * "selecting another assigned account" followed by the EPERM, and the session
 * parked instead of failing over.
 */
export function probeSocket(path: string, timeoutMs = 2000): Promise<string | undefined> {
	return new Promise((resolve) => {
		const sock = connect({ path });
		const done = (reason: string | undefined) => { sock.destroy(); resolve(reason); };
		sock.setTimeout(timeoutMs, () => done(undefined)); // slow is not unreachable
		sock.once("connect", () => done(undefined));
		sock.once("error", (error) => done(error.message));
	});
}

/** Account repair happens inside the existing agent run, before settlement.
 * The agenda driver continues to own normal post-settlement task re-entry. */
export default function credentialRecovery(pi: ExtensionAPI): void {
	let authPath: string | undefined;
	let transport: Transport | undefined;
	// Resolves once the socket probe has chosen the transport. Every exchange
	// awaits it, so a quota failure in the first turn cannot race the probe.
	let ready: Promise<void> = Promise.resolve();
	let generation = 0;
	let intention = 0;
	let captured: { provider: string; identity: string } | undefined;
	let recovering = false;
	let waiting = false;
	let retryProvider: string | undefined;
	let latestCtx: ExtensionContext | undefined;
	// Set when the socket is provably unreachable from this process (a sandbox).
	// Every exchange would fail identically, so none is attempted.
	let unreachable = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const renewalIntervalMs = 10 * 60 * 1000;

	function report(ctx: ExtensionContext, state: "available" | "recovering" | "exhausted" | "unavailable" | "error", detail: string): void {
		pi.events.emit(RECOVERY_CHANNEL, { state, detail });
		ctx.ui.setStatus("credential-recovery", detail || undefined);
	}

	pi.on("session_start", (_event, ctx) => {
		generation++;
		if (timer) clearInterval(timer);
		latestCtx = ctx;
		captured = undefined;
		recovering = false;
		waiting = false;
		retryProvider = undefined;
		authPath = undefined;
		transport = undefined;
		ready = Promise.resolve();
		unreachable = false;
		const path = join(getAgentDir(), "auth.json");
		if (!existsSync(path)) return;
		const canonical = realpathSync(path);
		const candidate = canonical + ".hive-recovery.sock";
		const mailbox = canonical + ".hive-recovery.d";
		if (!existsSync(candidate) && !existsSync(mailbox)) return; // a session not leased by Hive
		transport = existsSync(candidate) ? { kind: "socket", path: candidate } : { kind: "mailbox", dir: mailbox };
		authPath = path;
		report(ctx, "available", "");
		timer = setInterval(() => { void renew(); }, renewalIntervalMs);
		timer.unref();
		if (transport.kind !== "socket") return;
		const gen = generation;
		ready = probeSocket(candidate).then((reason) => {
			if (gen !== generation || !reason || !isSocketUnreachable(reason)) return;
			// A sandbox (srt seccomp) or a dead socket. The lease holder also
			// serves the same exchange through files, which the sandbox can
			// write: switch to that when it is there, and only when it is not
			// hand the failure to Hive's failover.
			if (existsSync(mailbox)) transport = { kind: "mailbox", dir: mailbox };
			else markUnreachable(ctx);
		});
	});

	// "unavailable" rather than "error" is the whole fix. hive-remote maps an
	// "error" to provider_failure=other, which the server's quota sweep never
	// selects, so the session parked for good; "unavailable" keeps the failure
	// classed as quota_exhausted and lets Hive switch rung or seed a successor.
	function fallBackToMailbox(): boolean {
		if (transport?.kind !== "socket") return false;
		const mailbox = transport.path.replace(/\.hive-recovery\.sock$/, ".hive-recovery.d");
		if (!existsSync(mailbox)) return false;
		transport = { kind: "mailbox", dir: mailbox };
		// Retry on the new transport now rather than at the next ten-minute
		// renewal; renew() re-sends failed=true for a pending quota failure.
		setTimeout(() => { void renew(); }, 1000).unref();
		return true;
	}

	function markUnreachable(ctx: ExtensionContext): void {
		unreachable = true;
		if (timer) clearInterval(timer);
		timer = undefined;
		report(ctx, "unavailable", SANDBOX_UNAVAILABLE);
	}
	pi.on("session_shutdown", () => { generation++; authPath = undefined; latestCtx = undefined; if (timer) clearInterval(timer); });

	pi.on("input", (event) => {
		if (event.source === "extension") return;
		intention++;
		waiting = false;
		retryProvider = undefined;
	});

	pi.on("turn_start", async (_event, ctx) => {
		captured = undefined;
		latestCtx = ctx;
		if (!authPath || !ctx.model) return;
		const credential = readStoredCredential(ctx.model.provider, authPath);
		if (credential) captured = { provider: ctx.model.provider, identity: identity(credential) };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!authPath || !ctx.model || recovering) return;
		const newest = event.messages.findLast((message) => message.role === "assistant");
		if (!newest || newest.role !== "assistant") return;
		const failed = newest.stopReason === "error" && isQuotaExhaustedText(newest.errorMessage);
		if (newest.stopReason === "aborted" || (newest.stopReason === "error" && !failed)) {
			waiting = false;
			retryProvider = undefined;
			return;
		}
		await ready;
		if (unreachable || !transport) {
			if (failed) report(ctx, "unavailable", SANDBOX_UNAVAILABLE);
			return;
		}
		const via = transport;
		const provider = ctx.model.provider;
		const start = captured;
		if (!start || start.provider !== provider) return;
		captured = undefined;
		const gen = generation;
		const intent = intention;
		recovering = true;
		if (failed) report(ctx, "recovering", "Account quota exhausted — selecting another assigned account");
		try {
			let exhausted: "exhausted" | "unavailable" | undefined;
			await modifyCredential(authPath, provider, async (current) => {
				if (!current) throw new Error("The session credential disappeared during recovery");
				// Another session may have exchanged the shared credential while this
				// model call was in flight. Retry that replacement without blaming it.
				if (failed && identity(current) !== start.identity) return current;
				const result = await exchange(via, provider, current, failed);
				if (gen !== generation) return current;
				if (result.status !== "recovered") { exhausted = result.status; return current; }
				return result.credential;
			});
			if (gen !== generation || intent !== intention || ctx.signal?.aborted) { waiting = false; retryProvider = undefined; return; }
			if (exhausted) {
				retryProvider = undefined;
				waiting = failed;
				report(ctx, exhausted, exhausted === "unavailable"
					? "Account switching unavailable for this provider — using configured provider alternatives"
					: failed ? "All assigned accounts exhausted — waiting for provider failover or quota recovery" : "No account has capacity for the next request");
				return;
			}
			waiting = false;
			retryProvider = undefined;
			report(ctx, "available", "");
			if (!failed) return;
			if (ctx.mode === "json" || ctx.mode === "rpc") {
				process.stdout.write(JSON.stringify({ type: "credential_recovery", state: "continuing" }) + "\n");
			}
			if (ctx.hasPendingMessages()) return;
			// Queue a continuation of the existing transcript. Never replay the
			// original user request or any already completed tool invocation.
			pi.sendMessage({ customType: "credential-recovery", content: "The exhausted account was replaced. Continue the interrupted task from the current transcript and completed tool results; do not repeat completed actions.", display: true }, { deliverAs: "followUp", triggerTurn: true });
		} catch (error) {
			if (gen === generation && intent === intention && !ctx.signal?.aborted) {
				const text = error instanceof Error ? error.message : String(error);
				if (isSocketUnreachable(text) && !fallBackToMailbox()) {
					markUnreachable(ctx);
				} else {
					if (failed) { waiting = true; retryProvider = provider; }
					report(ctx, "error", `Account recovery failed: ${text}`);
				}
			}
		} finally { if (gen === generation) recovering = false; }
	});

	async function renew(): Promise<void> {
		const ctx = latestCtx;
		if (!ctx || !authPath || !ctx.model || recovering || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		await ready;
		if (unreachable || !transport) return;
		const via = transport;
		const gen = generation;
		const intent = intention;
		const provider = ctx.model.provider;
		recovering = true;
		try {
			let exhausted: "exhausted" | "unavailable" | undefined;
			await modifyCredential(authPath, ctx.model.provider, async (current) => {
				if (!current) throw new Error("The session credential disappeared during renewal");
				const result = await exchange(via, provider, current, retryProvider === provider);
				if (gen !== generation) return current;
				if (result.status !== "recovered") { exhausted = result.status; return current; }
				return result.credential;
			});
			if (gen !== generation || intent !== intention || ctx.signal?.aborted) { waiting = false; retryProvider = undefined; return; }
			if (exhausted) { retryProvider = undefined; report(ctx, exhausted, exhausted === "unavailable" ? "Account switching unavailable for this provider" : "All assigned accounts exhausted — waiting for measured quota recovery"); return; }
			retryProvider = undefined;
			report(ctx, "available", "");
			if (waiting && ctx.isIdle() && !ctx.hasPendingMessages()) {
				waiting = false;
				pi.sendMessage({ customType: "credential-recovery", content: "Account capacity recovered. Continue the interrupted task from the existing transcript and completed tool results.", display: true }, { deliverAs: "followUp", triggerTurn: true });
			}
		} catch (error) {
			if (gen === generation) {
				const text = error instanceof Error ? error.message : String(error);
				// The socket is not reachable from here and will not become so:
				// a sandboxed launch (srt) refuses unix-socket connects with
				// EPERM, and a lease that ended removes the file. Renewing every
				// ten minutes against that produced one "Account renewal failed:
				// connect EPERM …hive-recovery.sock" line per interval on every
				// sandboxed agent (2026-09-11). Say it once, then stop the timer;
				// an exchange on a real exhaustion still tries, and still reports.
				if (isSocketUnreachable(text) && !fallBackToMailbox()) {
					markUnreachable(ctx);
				} else {
					report(ctx, "error", `Account renewal failed: ${text}`);
				}
			}
		} finally { if (gen === generation) recovering = false; }
	}

	pi.on("model_select", (_event, ctx) => {
		retryProvider = undefined;
		if (!waiting || recovering || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		waiting = false;
		report(ctx, "available", "");
		pi.sendMessage({ customType: "credential-recovery", content: "The provider was changed after account exhaustion. Continue the interrupted task from the current transcript; preserve completed actions.", display: true }, { deliverAs: "followUp", triggerTurn: true });
	});
}
