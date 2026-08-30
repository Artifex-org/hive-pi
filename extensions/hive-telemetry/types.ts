/**
 * hive-telemetry — shared types.
 *
 * `HiveMetricEvent` is the PUBLIC contract other extensions emit on the
 * `pi.events` bus. It is deliberately metric-only and carries no free text:
 * anything on that bus can be emitted by any loaded extension, so a channel
 * that accepted prose would be an exfiltration path straight past the
 * payload allowlist.
 */

export const HIVE_METRIC_CHANNEL = "hive.metric";

export interface NestedUsageMetric {
	provider: string;
	model: string;
	authMode: "api_key" | "subscription" | "unknown";
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	cost: number;
}

export interface HiveGateMetricEvent {
	kind: "gate";
	/** <=64 chars, sanitized to [a-z0-9_.-] by the consumer. */
	name: string;
	outcome: "pass" | "fail" | "timeout" | "skip";
	/** Duration in milliseconds. */
	value?: number;
}

export type HiveMetricEvent = HiveGateMetricEvent | { kind: "nested_usage"; models: NestedUsageMetric[] };

export type ErrorClass =
	| "rate_limit"
	| "overloaded"
	| "context_length"
	| "auth"
	| "timeout"
	| "network"
	| "aborted"
	| "unknown";

/**
 * Why a TOOL call failed, as opposed to why a provider call did (ErrorClass).
 *
 * Deliberately a separate vocabulary: a tool failing because a guard refused
 * the write and a provider failing because it was rate-limited share no
 * remedy, and folding them into one enum would make both unactionable. The
 * strings match hive's `internal/store/agent_tool_error_kinds.go`; anything it
 * does not recognise is folded to `other` server-side rather than rejected, so
 * a drift here degrades the data instead of dropping it.
 */
export type ToolErrorKind =
	| "guard_blocked"
	| "not_found"
	| "nonzero_exit"
	| "bad_args"
	| "no_match"
	| "timeout"
	| "permission"
	| "unreachable"
	| "interrupted"
	| "other";

export interface ResolvedConfig {
	enabled: boolean;
	url: string;
	flushIntervalMs: number;
	eventThreshold: number;
	spoolEveryFlush: boolean;
	projectOverride: string | null;
}

export interface ResolvedAuth {
	token: string;
	url: string;
	/** Where the token came from, for `/hive-telemetry` to report. Never the token. */
	source: string;
}

export interface ProjectIdentity {
	/** Normalized "owner/repo". Never a filesystem path. */
	repo: string;
	/** Stable pseudonymous bucket for a non-repo directory: `local-<12 hex>`. */
	projectHint: string;
}

/** The exact JSON POSTed to hive. Nothing outside this shape leaves the machine. */
export interface AgentUsagePayload {
	client_run_id: string;
	client_session_id: string;
	parent_session_id: string;
	seq: number;
	agent: "pi";
	agent_version: string;
	source: "workstation" | "eval" | "ci" | "cloud";
	/** The Hive launch that spawned this process (HIVE_LAUNCH_ID), when one did. */
	launch_id?: string;
	repo: string;
	status: "active" | "ended";
	outcome: string;
	/** False for a run nobody is sitting at — a sub-agent call (HIV-1176). */
	interactive: boolean;
	started_at: string;
	ended_at?: string;
	duration_ms: number;
	turns: number;
	tool_calls: number;
	tool_errors: number;
	compactions: number;
	compaction_overflows: number;
	/** Omitted when no compaction reported a size. */
	compaction_tokens_before?: number;
	models: PayloadModel[];
	tools: PayloadTool[];
	gates: PayloadGate[];
}

export interface PayloadModel {
	model: string;
	provider: string;
	auth_mode: "api_key" | "subscription" | "unknown";
	turns: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	/**
	 * A SUBSET of output_tokens, omitted entirely when the provider exposes no
	 * reasoning breakdown. Omitted must stay omitted: the server persists it as
	 * NULL ("not measured"), which is not the same as 0 ("measured, and zero").
	 */
	reasoning_tokens?: number;
	cost_usd: number;
}

export interface PayloadTool {
	tool_name: string;
	calls: number;
	errors: number;
	/**
	 * Counts per ToolErrorKind, keyed by the vocabulary hive accepts. Optional
	 * and OMITTED (not `{}`) when this tool never errored — the server column is
	 * nullable and NULL means NOT REPORTED, which its report keeps distinct from
	 * "reported, and there were none".
	 *
	 * `Record<string, number>` rather than `Record<ToolErrorKind, number>`
	 * because this is the wire shape: hive normalises unknown keys to `other`
	 * instead of rejecting the payload, so a vocabulary drift degrades the data
	 * rather than 4xx-ing a whole session's telemetry into the bin.
	 */
	error_kinds?: Record<string, number>;
}

export interface PayloadGate {
	gate_name: string;
	passed: number;
	failed: number;
	timed_out: number;
	skipped: number;
	duration_ms: number;
}
