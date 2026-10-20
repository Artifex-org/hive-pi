/**
 * Sanitized `output.diagnostics` for every Claude SDK turn that ends in error
 * (docs/claude-sdk-compatibility.md §Failure diagnostics). Diagnostics explain a
 * failure to Hive's diagnose_agent_session; they never authorize a retry, and
 * `errorMessage` stays the generic user-facing text.
 */
import type { AssistantMessageDiagnostic, JsonObject } from "@earendil-works/pi-ai";
import { boundedDetail, sanitizeDiagnosticText, SdkAssistantFailure, SdkProtocolError, SdkResultFailure } from "./events.ts";
import { BridgeError } from "./tool-bridge.ts";
import type { ProcessEvidence } from "./runtime.ts";

/** Characters of sanitized CLI stderr a diagnostic carries (the end of the tail). */
export const STDERR_DIAGNOSTIC_CHARS = 500;

/** A refusal or failure raised by this provider itself; its message is fixed provider text. */
export class SdkProviderError extends Error {}

/** The abort reason the lease-expiry timer gives a running query. */
export class SdkLeaseExpired extends Error {
	constructor() { super("Claude SDK lease expired during inference"); }
}

/** Why a handed-off (parked) query was disposed before Pi supplied its results. */
export type ParkedEndReason = "parked_expired" | "aborted" | "replaced";

/**
 * How this request reached the SDK. `tool_results` is a tool-result request
 * refused before its parked query was looked up. `rebuilt_after_<reason>` is a tool-result
 * request whose parked query this runtime had already disposed; `rebuilt` is one
 * whose parked query it never held (process loss, runtime replacement).
 */
export type Continuation = "fresh_prompt" | "tool_results" | "parked" | "rebuilt_options_changed" | "rebuilt" | `rebuilt_after_${ParkedEndReason}`;

export interface FailureContext {
	/** `post_start` once an SDK query was opened or a parked one claimed. */
	phase: "pre_start" | "post_start";
	continuation: Continuation;
	/** The disposed parked query a `rebuilt_after_*` request continues. */
	parkedEnd?: { parkedMs: number; endedMsAgo: number };
	aborted: boolean;
	leaseExpired: boolean;
	cleanupFailed: boolean;
	evidence?: ProcessEvidence;
	secrets: readonly string[];
	retried?: boolean;
}

export type FailureKind = "aborted" | "lease_expired" | "result_error" | "bridge_correlation" | "stream_protocol" | "stream_ended"
	| "provider_refusal" | "cli_exit" | "thrown_error";

/**
 * Error text from outside this provider (the SDK, its transport, Node) is copied
 * only when it has one of these known shapes, and only the matched part: a
 * sanitizer cannot recognize every secret in arbitrary text.
 */
const KNOWN_FOREIGN_MESSAGES: readonly RegExp[] = [
	/^Claude Code process (?:exited with code -?\d+|terminated by signal SIG[A-Z0-9]{1,8})/,
	/^Query closed before response received/,
	/^(?:Operation|Connection) aborted(?: by user)?/,
	/^ProcessTransport is not ready for writing/,
	/^Claude Code executable not found/,
	/^This operation was aborted/,
	/^The operation was aborted/,
	/^Aborted$/,
];

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const SAFE_SIGNAL = /^SIG[A-Z0-9]{1,8}$/;

function kindOf(error: unknown, context: FailureContext): FailureKind {
	if (context.aborted) return "aborted";
	if (context.leaseExpired || error instanceof SdkLeaseExpired) return "lease_expired";
	if (error instanceof SdkResultFailure) return "result_error";
	if (error instanceof BridgeError) return "bridge_correlation";
	const kind = error instanceof SdkProtocolError ? error.kind : error instanceof SdkProviderError ? "provider_refusal" : "thrown_error";
	// A CLI that died on its own surfaces as a thrown SDK error or an ended stream.
	const exit = context.evidence?.exit;
	return exit && !exit.requested && (kind === "stream_ended" || kind === "thrown_error") ? "cli_exit" : kind;
}

function message(error: unknown, kind: FailureKind, context: FailureContext): string {
	const exit = context.evidence?.exit;
	if (kind === "cli_exit" && exit) {
		return exit.signal ? `Claude CLI terminated by signal ${SAFE_SIGNAL.test(exit.signal) ? exit.signal : "unknown"}` : `Claude CLI exited with code ${exit.code}`;
	}
	if (error instanceof SdkResultFailure) {
		const cause = error.errors ?? error.apiError;
		return boundedDetail(`Claude SDK result ${error.subtype}${cause ? `: ${cause}` : ""}`);
	}
	if (!(error instanceof Error)) return `Non-Error thrown value (${typeof error})`;
	const line = String(error.message).split("\n", 1)[0];
	const own = error instanceof SdkProtocolError || error instanceof SdkProviderError || error instanceof BridgeError || error instanceof SdkLeaseExpired;
	const text = own ? line : KNOWN_FOREIGN_MESSAGES.map(shape => shape.exec(line)?.[0]).find(Boolean);
	return text ? boundedDetail(sanitizeDiagnosticText(text, context.secrets)) : "(unrecognized error text withheld)";
}

/** Context every diagnostic carries; process evidence only when there is some. */
function contextDetails(context: FailureContext): JsonObject {
	const details: JsonObject = { retrySafe: false, phase: context.phase, continuation: context.continuation };
	if (context.parkedEnd) details.parkedEnd = { ...context.parkedEnd };
	if (context.retried) details.retriedOnce = "failed before any content or tool call; the query was opened again";
	if (context.cleanupFailed) details.cleanupFailed = true;
	const exit = context.evidence?.exit;
	if (exit) details.cliExit = { code: exit.code, signal: exit.signal && SAFE_SIGNAL.test(exit.signal) ? exit.signal : exit.signal ? "unknown" : null, requested: exit.requested };
	const stderr = sanitizeDiagnosticText(context.evidence?.stderr ?? "", context.secrets);
	if (stderr) details.stderrTail = stderr.length > STDERR_DIAGNOSTIC_CHARS ? `…${stderr.slice(-(STDERR_DIAGNOSTIC_CHARS - 1))}` : stderr;
	return details;
}

/**
 * The sanitized diagnostic for a failed turn. A structured SDK assistant error
 * keeps its `claude_sdk_assistant_failure` shape; every other failure is a
 * `claude_sdk_failure` with a stable `kind`. Raw SDK text, request ids and
 * credentials are never copied.
 */
export function failureDiagnostic(error: unknown, context: FailureContext, timestamp: number): AssistantMessageDiagnostic {
	if (error instanceof SdkAssistantFailure) {
		return { type: "claude_sdk_assistant_failure", timestamp,
			error: { message: error.detail ?? "Claude SDK assistant failure", code: error.code }, details: contextDetails(context) };
	}
	const kind = kindOf(error, context);
	const details: JsonObject = { kind, ...contextDetails(context) };
	if (error instanceof SdkProtocolError && error.frame) details.frame = { ...error.frame };
	if (error instanceof SdkResultFailure) {
		details.result = { subtype: error.subtype, isError: error.isError,
			...(error.stopReason ? { stopReason: error.stopReason } : {}), ...(error.numTurns !== undefined ? { numTurns: error.numTurns } : {}),
			...(error.startupFailure ? { startupFailure: error.startupFailure } : {}), ...(error.errors ? { errors: error.errors } : {}),
			...(error.apiError ? { apiError: error.apiError } : {}) };
	}
	// A subclass that does not set `name` still reports "Error"; its class name is more telling.
	const named = error instanceof Error ? (error.name === "Error" ? error.constructor.name : error.name) : "";
	const name = SAFE_NAME.test(named) ? named : "Error";
	return { type: "claude_sdk_failure", timestamp, error: { name, message: message(error, kind, context), code: kind }, details };
}
