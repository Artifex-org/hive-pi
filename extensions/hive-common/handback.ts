/**
 * Has the agent handed the turn back? — pure, derived from the session branch
 * alone, so every extension that is about to wake the agent computes the SAME
 * answer without sharing state (each extension is its own module instance).
 *
 * MEASURED, 2026-10-05, over the last five days of local transcripts (2,195
 * sessions on disk): after an assistant turn that ended in plain text, the next
 * thing to happen was NOT the human on 1,672 occasions —
 *
 *     background         739   job completion notices
 *     team-message       676   teammate messages
 *     agenda             154   goal / conductor / drift re-entry
 *     plan-autocontinue   87   "continue with the next pending step"
 *     orchestrate         16   orchestration completion
 *
 * — and only a trailing `?` stopped any of them, and only the agenda driver and
 * plan auto-continue checked even that. The failures this left are the ones an
 * operator sees as "it should have stopped and it kept going":
 *
 *   - "Ich warte auf deine Freigabe …" re-driven by the goal judge seven times
 *     in one session, the model writing back "the automatic continuation does
 *     not override Joan's explicit instruction to wait".
 *   - "Standing by — blocked on controller decisions" nudged by plan
 *     auto-continue until its spin guard ran out.
 *   - A plan presented for approval, a pending `request_host` grant, a question
 *     asked in prose: each followed by a background or team wake that the
 *     model treated as licence to carry on.
 *
 * Three answers, not two:
 *
 *   - `human`   — the turn ended waiting on a person: a plan awaiting approval,
 *                 a grant still pending, a `plan_ask` nobody answered, a turn
 *                 the human aborted, a trailing question, or an explicit request
 *                 for a decision / an explicit "I am waiting".
 *   - `machine` — the turn ended waiting on its OWN asynchronous work (a CI
 *                 watcher, a background job). Its completion should wake it;
 *                 a "keep going" nudge should not, because there is nothing to
 *                 do until the result lands.
 *   - `none`    — a plain stop. This includes the low-tier "Wave done." summary
 *                 with plan steps still pending, which plan auto-continue exists
 *                 to re-drive, so the phrase lists below are request-shaped and
 *                 never match a report.
 *
 * A user-role message after the last assistant turn is the human answering —
 * that is `none`, whatever the turn said. Custom messages (automatic wakes,
 * held notices) are not: they never clear a hand-back.
 */

/** Why the turn is held. Enum-like on purpose: these travel on the bus and into status lines. */
export type HandbackReason =
	| "plan-approval"
	| "grant"
	| "question"
	| "decision-request"
	| "waiting"
	| "aborted"
	| "own-work";

export type Handback =
	| { kind: "none" }
	| { kind: "human"; reason: Exclude<HandbackReason, "own-work">; structured: boolean }
	| { kind: "machine"; reason: "own-work" };

export const NO_HANDBACK: Handback = { kind: "none" };

/**
 * A hand-back strong enough to hold even the agent's OWN job completions: a
 * gate a person must open (plan, grant, an abort), or a question / decision put
 * to them in so many words. A bare "standing by" is not: an agent that says it
 * is standing by while its CI watcher runs must still hear the verdict.
 */
export function isFirmHandback(handback: Handback): boolean {
	return handback.kind === "human" && (handback.structured || handback.reason !== "waiting");
}

/**
 * The hand-back reduced to what a re-entry policy keys on:
 *   - `firm`    — a person must act (isFirmHandback)
 *   - `waiting` — the agent said it is waiting, without asking anything
 *   - `machine` — waiting on its own job
 *   - `none`    — a plain stop
 */
export type HandbackClass = "firm" | "waiting" | "machine" | "none";

export function handbackClass(handback: Handback): HandbackClass {
	if (handback.kind === "none") return "none";
	if (handback.kind === "machine") return "machine";
	return isFirmHandback(handback) ? "firm" : "waiting";
}

/**
 * Strip fenced code blocks and inline code before reading prose.
 *
 * Without this, a turn ending in a shell snippet (`grep -q "x" && echo "?"`) or
 * a regex reads as a question. Unterminated fences run to end-of-text, which is
 * the conservative reading: the trailing content is code, so it cannot ask.
 */
export function stripCode(text: string): string {
	const withoutFences = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
	return withoutFences.replace(/`[^`\n]*`/g, " ");
}

/**
 * Does this assistant text end by asking something?
 *
 * Trailing whitespace and closing delimiters are ignored, so "Should I? )" and
 * "Ready?\n\n" both count. A question mark earlier does not — only the final
 * sentence decides, because an explanation that quotes a question and then
 * states a conclusion is not itself a question.
 */
export function endsWithQuestion(text: string): boolean {
	const trimmed = stripCode(text).replace(/[\s)\]}"'*_>]+$/u, "");
	return trimmed.endsWith("?");
}

/**
 * Phrasings that ask a person to decide or answer. Request-shaped, not
 * topic-shaped: "confirm" alone matches "I can confirm the tests pass", which
 * is a report; "please confirm" cannot be anything but a request. The first
 * block is `agenda/ask.ts`'s fleet-validated set (4 of 7,864 endings, all
 * genuine); the rest extend it to the hand-backs measured above, German
 * included because half the evidence was German.
 */
export const DECISION_PHRASES: readonly RegExp[] = [
	/\blet me know\b/i,
	/\byour call\b/i,
	/\bshall i\b/i,
	/\bdo you want\b/i,
	/\bwould you like\b/i,
	/\bwhich (?:one )?(?:would you|should i|do you)\b/i,
	/\bbefore i proceed\b/i,
	/\bplease (?:confirm|advise|choose|decide|pick|specify)\b/i,
	/\bawaiting your\b/i,
	/\bsay the word\b/i,
];

const HUMAN_PHRASES: readonly RegExp[] = [
	...DECISION_PHRASES,
	/\bplease (?:approve|grant|review|reply|answer)\b/i,
	/\bwant me to\b/i,
	/\bup to you\b/i,
	/\b(?:once|when|if|after) you(?:'ve| have)? (?:confirm|approve|decide|grant|reply|answer|choose|pick|sign off|give the go-ahead)\b/i,
	/\b(?:waiting|wait) (?:for|on) (?:your\b|you\b|the (?:user|operator|controller|human)\b|joan\b|(?:an? |the )?(?:approval|confirmation|decision|answer|reply|go-ahead|sign-?off|grant)\b|(?:controller|operator)\b)/i,
	/\bawait(?:s|ing)? (?:you\b|the (?:user|operator|controller)\b|(?:an? |the )?(?:approval|confirmation|decision|answer|go-ahead|grant)\b|(?:controller|operator)\b)/i,
	/\bneeds? (?:your|an? (?:human|operator)|operator|human) (?:approval|decision|input|go-ahead|confirmation|answer|sign-?off)\b/i,
	/\bpending (?:your |human |operator )?(?:approval|sign-?off|decision)\b/i,
	/\bblocked on (?:your\b|you\b|the (?:user|operator|controller)\b|(?:an? |the )?(?:decision|approval|grant)\b|(?:controller|operator)\b|joan\b)/i,
	/\/plan approve\b/i,
	/\b(?:requires?|needs?|awaits?|awaiting) (?:\w+ ){0,2}(?:authori[sz]ation|approval|sign-?off)\b/i,
	/\bauthori[sz]ation (?:is )?(?:needed|required)\b/i,
	/\bauthori[sz]ed [\w -]{1,40} is (?:needed|required)\b/i,
	// German: "ich warte auf deine Freigabe", "soll ich …", "sobald du …".
	/\b(?:auf|ohne|nach|bis zu)\s+(?:[\p{L}-]+\s+){0,3}(?:freigabe|entscheidung|zustimmung|bestätigung|rückmeldung)\b/iu,
	/\b(?:soll ich|möchtest du|willst du|sobald du|sag(?:e|t)? (?:mir )?bescheid|gib mir bescheid)\b/i,
	/\bbitte (?:bestätige|entscheide|wähle|prüfe|gib (?:mir )?(?:frei|bescheid))\b/i,
	/\bich warte\b/i,
];

/**
 * Words that say "I am stopping and waiting" without naming on whom. Alone they
 * are a hand-back to the human; next to a statement that the agent is watching
 * its own job they are the `machine` shape ("Final harvest awaits run #1769 —
 * standing by.").
 */
const WAIT_WORDS: readonly RegExp[] = [
	/\bstanding by\b/i,
	/(?:^|[.!:—–-]\s*)holding\b/im,
	/\bon hold\b/i,
	/\b(?:i'?ll|i will|i'm going to) (?:wait|stop here|hold)\b/i,
	/(?:^|[.!—–-]\s*)stopping(?: here| now)?\s*\.?\s*$/im,
	/\bnothing (?:executable|actionable) (?:remains|left)\b/i,
	/\bno executable step(?:s)? remains?\b/i,
	/\bwork (?:is|remains) (?:stopped|paused)\b/i,
	/\bi will not (?:retry|continue|proceed)\b/i,
];

/** The agent is waiting on work it started itself, and will be told when it lands. */
const OWN_WORK: readonly RegExp[] = [
	/\b(?:i'?m|i am|still) watching\b/i,
	/\bwatch(?:er)? (?:is )?(?:active|attached|running|armed|in flight)\b/i,
	/\bthe watcher will\b/i,
	/\b(?:waiting|wait) (?:for|on) (?:run|ci\b|the (?:run|ci|build|checks?|verdict|watcher|job|pipeline|gate|signing)\b|#\d|image build)/i,
	/\bawait(?:s|ing)? (?:run\b|ci\b|the (?:run|ci|build|checks?|verdict|watcher|job|pipeline)\b|#\d)/i,
	/\bwill (?:report|resume|continue|inspect|harvest|push|deliver)\b[^.\n]*\b(?:when|once|after|the moment)\b/i,
	/\b(?:standing by|holding|waiting) (?:on|for) (?:run\b|ci\b|`?bg-\d|#\d|the (?:ci )?(?:verdict|run|build|checks?|watch(?:er)?)\b)/i,
	/\bholding the watch\b/i,
	/\bblocked on ci\b/i,
	/`?bg-\d+`? (?:still )?(?:watches|tracks|is (?:running|watching))\b/i,
];

/** The last two paragraphs, code removed: where a hand-back lives when there is one. */
export function handbackTail(text: string): string {
	const paragraphs = stripCode(text)
		.trim()
		.split(/\n\s*\n/)
		.filter((p) => p.trim().length > 0);
	const tail = paragraphs.slice(-2).join("\n\n");
	return tail.length > 700 ? tail.slice(-700) : tail;
}

/** Classify an assistant turn's text alone. Exported for the fixtures. */
export function classifyText(text: string | undefined): Handback {
	if (!text?.trim()) return NO_HANDBACK;
	if (endsWithQuestion(text)) return { kind: "human", reason: "question", structured: false };
	const tail = handbackTail(text);
	if (HUMAN_PHRASES.some((re) => re.test(tail))) return { kind: "human", reason: "decision-request", structured: false };
	if (OWN_WORK.some((re) => re.test(tail))) return { kind: "machine", reason: "own-work" };
	if (WAIT_WORDS.some((re) => re.test(tail))) return { kind: "human", reason: "waiting", structured: false };
	return NO_HANDBACK;
}

interface MessageLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
	toolName?: string;
	toolCallId?: string;
}

interface ToolCallLike {
	id: string;
	name: string;
	arguments: unknown;
}

function messageOf(entry: unknown): MessageLike | undefined {
	const message = (entry as { message?: unknown } | null)?.message;
	return message && typeof message === "object" ? (message as MessageLike) : undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => {
			const p = part as { type?: string; text?: unknown };
			return p?.type === "text" && typeof p.text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

function toolCallsOf(content: unknown): ToolCallLike[] {
	if (!Array.isArray(content)) return [];
	const calls: ToolCallLike[] = [];
	for (const part of content) {
		const p = part as { type?: string; id?: unknown; name?: unknown; arguments?: unknown };
		if (p?.type === "toolCall" && typeof p.id === "string" && typeof p.name === "string") {
			calls.push({ id: p.id, name: p.name, arguments: p.arguments });
		}
	}
	return calls;
}

/**
 * The Hive tool a call reaches, whether it was called natively
 * (`mcp__hive__request_host`) or through the `mcp` meta-tool that low-tier pi
 * agents use (`mcp {tool: "hive_request_host"}`).
 */
function hiveToolOf(call: ToolCallLike | undefined, fallbackName: string | undefined): string {
	const args = call?.arguments as { tool?: unknown; name?: unknown } | undefined;
	const viaMeta = typeof args?.tool === "string" ? args.tool : typeof args?.name === "string" ? args.name : "";
	return `${call?.name ?? fallbackName ?? ""} ${viaMeta}`;
}

// Only the requests a PERSON decides. `request_resource` / `request_environment`
// also answer "pending", but that is provisioning, which finishes on its own.
const GRANT_TOOL = /\b(?:mcp__hive__|hive_)?(?:request_(?:host|credential|network)|get_(?:host|credential|network)_request)\b/;
const GRANT_PENDING = /"(?:verdict|state|status|decision)"\s*:\s*"(?:pending|requested|awaiting[\w-]*)"/i;
const GRANT_DECIDED = /"(?:verdict|state|status|decision)"\s*:\s*"(?:approved?|granted|deny|denied|rejected|expired|revoked|canceled|cancelled|failed)"/i;

/**
 * Structured hand-backs inside the final run: the tool results say a person
 * must act, whatever the model wrote afterwards.
 */
function structuredHandback(run: readonly unknown[]): Handback | undefined {
	const calls = new Map<string, ToolCallLike>();
	let plan: Handback | undefined;
	let grant: Handback | undefined;
	let planAsk: Handback | undefined;
	for (const entry of run) {
		const message = messageOf(entry);
		if (!message) continue;
		if (message.role === "assistant") {
			for (const call of toolCallsOf(message.content)) calls.set(call.id, call);
			continue;
		}
		if (message.role !== "toolResult") continue;
		const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
		const name = message.toolName ?? call?.name;
		const text = textOf(message.content);
		if (name === "plan_ready") {
			// The latest presentation decides: approved, declined and lanes-only
			// answers all read differently from the parked/unattended header.
			plan = text.startsWith("Plan is ready and awaiting approval") && !/\n\nApproved\./.test(text)
				? { kind: "human", reason: "plan-approval", structured: true }
				: undefined;
			continue;
		}
		if (name === "plan_ask") {
			planAsk = text.startsWith("The user answered:") ? undefined : { kind: "human", reason: "question", structured: true };
			continue;
		}
		if (GRANT_TOOL.test(hiveToolOf(call, name))) {
			if (GRANT_PENDING.test(text)) grant = { kind: "human", reason: "grant", structured: true };
			else if (GRANT_DECIDED.test(text)) grant = undefined;
		}
	}
	return plan ?? grant ?? planAsk;
}

/**
 * Classify the session's current hand-back state from its branch.
 *
 * The "final run" is everything after the previous plain-text stop (or the
 * previous user message) up to the last assistant message — the tool calls the
 * agent made on the way to the turn it ended on.
 */
export function classifyHandback(branch: readonly unknown[]): Handback {
	let last = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const role = messageOf(branch[i])?.role;
		if (role === "user") return NO_HANDBACK; // the human spoke after the agent did
		if (role === "assistant") {
			last = i;
			break;
		}
	}
	if (last < 0) return NO_HANDBACK;
	const final = messageOf(branch[last]) as MessageLike;
	// The human pressed stop. Waking now would overrule them.
	if (final.stopReason === "aborted") return { kind: "human", reason: "aborted", structured: true };
	// A turn that did not run, or one still mid-tool, is not a hand-back.
	if (final.stopReason === "error" || final.stopReason === "toolUse" || final.stopReason === "length") return NO_HANDBACK;

	let start = 0;
	for (let i = last - 1; i >= 0; i--) {
		const message = messageOf(branch[i]);
		if (message?.role === "user" || (message?.role === "assistant" && message.stopReason === "stop")) {
			start = i + 1;
			break;
		}
	}
	return structuredHandback(branch.slice(start, last)) ?? classifyText(textOf(final.content));
}
