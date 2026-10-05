/** Local bus only. hive-remote forwards snapshots under transcript/status consent. */
export const YSK_STATE_CHANNEL = "hive.you-should-know.state";
export const YSK_CONTROL_CHANNEL = "hive.you-should-know.control";
export const YSK_REMOTE_CHANNEL = "hive.you-should-know.remote";
export const YSK_FINDINGS_CHANNEL = "hive.you-should-know.findings";
export const YSK_RECORDING_CHANNEL = "hive.you-should-know.recording";
export const YSK_POLICY_CHANNEL = "hive.you-should-know.policy";
export const YSK_POLICY_REQUEST_CHANNEL = "hive.you-should-know.policy-request";
export const YSK_RECEIPTS_CHANNEL = "hive.you-should-know.receipts";
export type YouShouldKnowAction = "on" | "off" | "dismiss" | "record_on" | "record_off";
export interface YouShouldKnowState {
	version: 1;
	/** Applied command acknowledgment; absence is not delivery confirmation. */
	command_id?: string;
	enabled: boolean;
	model: string;
	recording: boolean;
	recording_revision?: number;
	capture_tools: boolean;
	jev: string;
	phase: "idle" | "scanning" | "waiting" | "failed" | "budget";
	scans: number;
	max_scans: number;
	tokens: number;
	cost: number;
	failure: string;
	notes: { id?: string; kind: "caveat" | "blocker" | "action" | "decision"; text: string; quote: string; classification?: "context" | "friction" | "incident" | "defect" | "improvement"; expected?: string; impact?: string }[];
}
export function readYouShouldKnowAction(data: unknown): YouShouldKnowAction | undefined {
	if (!data || typeof data !== "object" || !("action" in data)) return;
	const action = data.action;
	if (action === "on" || action === "off" || action === "dismiss" || action === "record_on" || action === "record_off") return action;
}
