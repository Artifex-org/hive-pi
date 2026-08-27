/**
 * The loop item and its schedule — pure folds, no timers, no I/O.
 *
 * Two modes, and the difference between them is who is responsible for keeping
 * the loop alive:
 *
 *  - **fixed**: the schedule re-arms ITSELF from `intervalMs`. The model is
 *    never responsible for a cron loop's liveness — a turn that ends in a
 *    summary rather than a tool call would otherwise silently end it.
 *  - **self-paced**: the model re-arms by calling `agenda_wake`. Liveness is
 *    opt-in and silence terminates, with exactly one keepalive as a grace
 *    period for a turn that simply forgot.
 *
 * Everything about when the next fire happens is decided here so it can be
 * tested without waiting for wall-clock time.
 */

export type LoopMode = "fixed" | "self-paced";

export type LoopState = "active" | "expired" | "stopped" | "exhausted" | "dry";

const TERMINAL: ReadonlySet<LoopState> = new Set<LoopState>(["expired", "stopped", "exhausted", "dry"]);

export function isTerminal(state: LoopState): boolean {
	return TERMINAL.has(state);
}

/** Claude Code's scheduled-wakeup bounds. Below a minute is a busy-wait, not a loop. */
export const MIN_DELAY_MS = 60_000;
export const MAX_DELAY_MS = 3_600_000;
/** A loop that has not been touched in a week is abandoned, not running. */
export const MAX_LIFETIME_MS = 7 * 24 * 3_600_000;
export const DEFAULT_MAX_FIRES = 50;
/** One grace wake for a self-paced turn that neither re-armed nor stopped. */
export const KEEPALIVE_MS = 20 * 60_000;
/** Consecutive "nothing changed" iterations before we advise stopping. */
export const MAX_NOOP_STREAK = 3;

export interface LoopItem {
	schemaVersion: 1;
	kind: "loop";
	id: string;
	mode: LoopMode;
	state: LoopState;
	/** Verbatim text re-injected each iteration. */
	prompt: string;
	/** Fixed mode only. */
	intervalMs?: number;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	/** Wall-clock time of the next fire, or null when nothing is scheduled. */
	nextAt: number | null;
	/** Set when the pending wake is the one-shot keepalive. */
	keepaliveArmed: boolean;
	fires: number;
	maxFires: number;
	noopStreak: number;
	tokenBudget?: number;
	tokens: number;
	/** Last reason the model gave for its chosen delay, shown to the user. */
	lastReason?: string;
}

export const LOOP_ENTRY_TYPE = "agenda";

export function createLoop(
	id: string,
	mode: LoopMode,
	prompt: string,
	now: number,
	options: { intervalMs?: number; maxFires?: number; tokenBudget?: number } = {},
): LoopItem {
	return {
		schemaVersion: 1,
		kind: "loop",
		id,
		mode,
		state: "active",
		prompt,
		intervalMs: options.intervalMs,
		createdAt: now,
		updatedAt: now,
		expiresAt: now + MAX_LIFETIME_MS,
		// Fixed loops start counting immediately. A self-paced loop has no
		// schedule until its first turn asks for one — its first iteration is the
		// injection that `/loop` performs directly.
		nextAt: mode === "fixed" ? now + (options.intervalMs ?? MIN_DELAY_MS) : null,
		keepaliveArmed: false,
		fires: 0,
		maxFires: options.maxFires ?? DEFAULT_MAX_FIRES,
		noopStreak: 0,
		tokenBudget: options.tokenBudget,
		tokens: 0,
	};
}

export function clampDelay(ms: number): { ms: number; clamped: boolean } {
	if (ms < MIN_DELAY_MS) return { ms: MIN_DELAY_MS, clamped: true };
	if (ms > MAX_DELAY_MS) return { ms: MAX_DELAY_MS, clamped: true };
	return { ms, clamped: false };
}

/** Is a fire owed right now? */
export function isDue(loop: LoopItem, now: number): boolean {
	if (loop.state !== "active") return false;
	if (loop.nextAt === null) return false;
	return now >= loop.nextAt;
}

/** Terminal state this loop should move to, or null if it may keep running. */
export function expiryCheck(loop: LoopItem, now: number): LoopState | null {
	if (now >= loop.expiresAt) return "expired";
	if (loop.fires >= loop.maxFires) return "exhausted";
	if (loop.tokenBudget !== undefined && loop.tokens >= loop.tokenBudget) return "exhausted";
	return null;
}

/**
 * Charge a fire and schedule whatever comes next.
 *
 * Fixed mode re-arms from `intervalMs`, ALWAYS relative to `now` rather than to
 * the missed `nextAt`. That is what makes overdue fires coalesce: a loop that
 * was owed six fires during one long turn produces one, then schedules from
 * here, instead of firing six times in a row to catch up.
 *
 * Self-paced mode arms the single keepalive and waits for `agenda_wake`.
 */
export function recordFire(loop: LoopItem, now: number): LoopItem {
	const fires = loop.fires + 1;
	const base: LoopItem = { ...loop, fires, updatedAt: now };

	const terminal = expiryCheck(base, now);
	if (terminal) return { ...base, state: terminal, nextAt: null, keepaliveArmed: false };

	if (loop.mode === "fixed") {
		return { ...base, nextAt: now + (loop.intervalMs ?? MIN_DELAY_MS), keepaliveArmed: false };
	}

	return { ...base, nextAt: now + KEEPALIVE_MS, keepaliveArmed: true };
}

/**
 * Fold an `agenda_wake` call from the model.
 *
 * Clearing `keepaliveArmed` is the point: a turn that re-armed is alive, so its
 * grace period is spent and a fresh one is granted next time.
 */
export function applyWake(
	loop: LoopItem,
	request: { delaySeconds?: number; reason?: string; stop?: boolean; noop?: boolean },
	now: number,
): { loop: LoopItem; clamped: boolean; advisedStop: boolean } {
	if (request.stop) {
		return {
			loop: { ...loop, state: "stopped", nextAt: null, keepaliveArmed: false, updatedAt: now },
			clamped: false,
			advisedStop: false,
		};
	}

	const noopStreak = request.noop ? loop.noopStreak + 1 : 0;
	const advisedStop = noopStreak >= MAX_NOOP_STREAK;

	const requested = (request.delaySeconds ?? MIN_DELAY_MS / 1000) * 1000;
	const { ms, clamped } = clampDelay(requested);

	const next: LoopItem = {
		...loop,
		noopStreak,
		nextAt: now + ms,
		keepaliveArmed: false,
		updatedAt: now,
		lastReason: request.reason ?? loop.lastReason,
	};

	const terminal = expiryCheck(next, now);
	return {
		loop: terminal ? { ...next, state: terminal, nextAt: null } : next,
		clamped,
		advisedStop,
	};
}

/**
 * The keepalive fired and the model still did not re-arm. The loop ends.
 *
 * "dry" rather than "stopped": the user did not stop it, it ran out of things
 * to say. `/loop` reports the difference, because a loop that quietly went
 * quiet and one the user cancelled are not the same event.
 */
export function applyKeepaliveLapse(loop: LoopItem, now: number): LoopItem {
	return { ...loop, state: "dry", nextAt: null, keepaliveArmed: false, updatedAt: now };
}

export function addTokens(loop: LoopItem, tokens: number, now: number): LoopItem {
	const next = { ...loop, tokens: loop.tokens + tokens, updatedAt: now };
	const terminal = expiryCheck(next, now);
	return terminal ? { ...next, state: terminal, nextAt: null } : next;
}

export function stopLoop(loop: LoopItem, now: number): LoopItem {
	return { ...loop, state: "stopped", nextAt: null, keepaliveArmed: false, updatedAt: now };
}

/** Recover the newest loop from persisted session entries. */
export function rehydrateLoop(entries: readonly unknown[]): LoopItem | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { customType?: string; data?: unknown } | undefined;
		if (!entry || entry.customType !== LOOP_ENTRY_TYPE) continue;
		const item = validateLoop(entry.data);
		if (item) return item;
	}
	return null;
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function validateLoop(data: unknown): LoopItem | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (record.kind !== "loop") return null;
	if (record.schemaVersion !== 1) return null;
	if (typeof record.id !== "string" || !record.id) return null;
	if (typeof record.prompt !== "string" || !record.prompt) return null;
	if (record.mode !== "fixed" && record.mode !== "self-paced") return null;

	const states: LoopState[] = ["active", "expired", "stopped", "exhausted", "dry"];
	if (typeof record.state !== "string" || !states.includes(record.state as LoopState)) return null;

	const createdAt = positiveInt(record.createdAt, 0);
	return {
		schemaVersion: 1,
		kind: "loop",
		id: record.id,
		mode: record.mode,
		state: record.state as LoopState,
		prompt: record.prompt,
		intervalMs: typeof record.intervalMs === "number" ? record.intervalMs : undefined,
		createdAt,
		updatedAt: positiveInt(record.updatedAt, createdAt),
		// A missing or corrupt expiry becomes "already expired", never "never
		// expires" — this bound is the last thing standing between an abandoned
		// loop and an unbounded one.
		expiresAt: positiveInt(record.expiresAt, 0),
		nextAt: typeof record.nextAt === "number" ? record.nextAt : null,
		keepaliveArmed: record.keepaliveArmed === true,
		fires: positiveInt(record.fires, 0),
		maxFires: Math.max(1, positiveInt(record.maxFires, DEFAULT_MAX_FIRES)),
		noopStreak: positiveInt(record.noopStreak, 0),
		tokenBudget: typeof record.tokenBudget === "number" ? record.tokenBudget : undefined,
		tokens: positiveInt(record.tokens, 0),
		lastReason: typeof record.lastReason === "string" ? record.lastReason : undefined,
	};
}
