/** Local bus only. hive-remote forwards snapshots under transcript/status consent. */
export const YSK_STATE_CHANNEL = "hive.you-should-know.state";
export const YSK_CONTROL_CHANNEL = "hive.you-should-know.control";
export const YSK_REMOTE_CHANNEL = "hive.you-should-know.remote";
export type YouShouldKnowAction = "on" | "off" | "dismiss";
export interface YouShouldKnowState {
	version: 1;
	/** Applied command acknowledgment; absence is not delivery confirmation. */
	command_id?: string;
	enabled: boolean;
	phase: "idle" | "scanning" | "waiting" | "failed" | "budget";
	scans: number;
	max_scans: number;
	tokens: number;
	cost: number;
	failure: string;
	notes: { kind: "caveat" | "blocker" | "action" | "decision"; text: string; quote: string }[];
}
export function readYouShouldKnowAction(data: unknown): YouShouldKnowAction | undefined {
	if (!data || typeof data !== "object" || !("action" in data)) return;
	const action = data.action;
	if (action === "on" || action === "off" || action === "dismiss") return action;
}
