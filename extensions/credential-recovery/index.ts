import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readStoredCredential, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modifyCredential } from "./storage.ts";
import { exchange, identity } from "./client.ts";
import { isQuotaExhaustedText } from "./quota.ts";

export const RECOVERY_CHANNEL = "hive.credential-recovery";

/** Account repair happens inside the existing agent run, before settlement.
 * The agenda driver continues to own normal post-settlement task re-entry. */
export default function credentialRecovery(pi: ExtensionAPI): void {
	let authPath: string | undefined;
	let socket = "";
	let generation = 0;
	let captured: { provider: string; identity: string } | undefined;
	let recovering = false;
	let waiting = false;
	let latestCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const renewalIntervalMs = 10 * 60 * 1000;

	function report(ctx: ExtensionContext, state: "available" | "recovering" | "exhausted" | "error", detail: string): void {
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
		authPath = undefined;
		socket = "";
		const path = join(getAgentDir(), "auth.json");
		if (!existsSync(path)) return;
		const canonical = realpathSync(path);
		const candidate = canonical + ".hive-recovery.sock";
		if (!existsSync(candidate)) return; // a session not leased by Hive
		socket = candidate;
		authPath = path;
		report(ctx, "available", "");
		timer = setInterval(() => { void renew(); }, renewalIntervalMs);
		timer.unref();
	});
	pi.on("session_shutdown", () => { generation++; authPath = undefined; latestCtx = undefined; if (timer) clearInterval(timer); });

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
		if (newest.stopReason === "aborted" || (newest.stopReason === "error" && !failed)) return;
		const provider = ctx.model.provider;
		const start = captured;
		if (!start || start.provider !== provider) return;
		captured = undefined;
		const gen = generation;
		recovering = true;
		if (failed) report(ctx, "recovering", "Account quota exhausted — selecting another assigned account");
		try {
			let exhausted = false;
			await modifyCredential(authPath, provider, async (current) => {
				if (!current) throw new Error("The session credential disappeared during recovery");
				// Another session may have exchanged the shared credential while this
				// model call was in flight. Retry that replacement without blaming it.
				if (failed && identity(current) !== start.identity) return current;
				const result = await exchange(socket, provider, current, failed);
				if (gen !== generation) return current;
				if (result.status === "exhausted") { exhausted = true; return current; }
				return result.credential;
			});
			if (gen !== generation) return;
			if (exhausted) {
				waiting = true;
				report(ctx, "exhausted", "All assigned accounts exhausted — waiting for provider failover or quota recovery");
				return;
			}
			waiting = false;
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
			if (gen === generation) report(ctx, "error", `Account recovery failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally { if (gen === generation) recovering = false; }
	});

	async function renew(): Promise<void> {
		const ctx = latestCtx;
		if (!ctx || !authPath || !ctx.model || recovering || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const gen = generation;
		const provider = ctx.model.provider;
		recovering = true;
		try {
			let exhausted = false;
			await modifyCredential(authPath, ctx.model.provider, async (current) => {
				if (!current) throw new Error("The session credential disappeared during renewal");
				const result = await exchange(socket, provider, current, false);
				if (gen !== generation) return current;
				if (result.status === "exhausted") { exhausted = true; return current; }
				return result.credential;
			});
			if (gen !== generation) return;
			if (exhausted) { report(ctx, "exhausted", "All assigned accounts exhausted — waiting for measured quota recovery"); return; }
			report(ctx, "available", "");
			if (waiting && ctx.isIdle() && !ctx.hasPendingMessages()) {
				waiting = false;
				pi.sendMessage({ customType: "credential-recovery", content: "Account capacity recovered. Continue the interrupted task from the existing transcript and completed tool results.", display: true }, { deliverAs: "followUp", triggerTurn: true });
			}
		} catch (error) {
			if (gen === generation) report(ctx, "error", `Account renewal failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally { if (gen === generation) recovering = false; }
	}

	pi.on("model_select", (_event, ctx) => {
		if (!waiting || recovering || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		waiting = false;
		report(ctx, "available", "");
		pi.sendMessage({ customType: "credential-recovery", content: "The provider was changed after account exhaustion. Continue the interrupted task from the current transcript; preserve completed actions.", display: true }, { deliverAs: "followUp", triggerTurn: true });
	});
}
