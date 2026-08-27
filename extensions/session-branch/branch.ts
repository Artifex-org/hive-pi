/**
 * The ACTIVE BRANCH of the session tree — and noticing when it moves.
 *
 * A pi session is not a log, it is a TREE. Every entry carries `id` and
 * `parentId`, the live position is a leaf pointer, `/tree` moves that pointer to
 * another leaf inside the SAME file, and `/fork` and `/clone` start new files.
 * `sessionManager.getEntries()` returns every entry the file has ever held —
 * all branches, abandoned ones included, in append order.
 * `sessionManager.getBranch()` walks leaf→root and reverses, so it returns the
 * root→leaf path of the branch that is actually live (`session-manager.js:943`).
 *
 * Our state documents rehydrated from `getEntries()`, and every one of them
 * scans backwards for the NEWEST snapshot. On a tree that is the wrong rule
 * twice over:
 *
 *   (a) the newest snapshot in the file need not belong to the live branch. An
 *       operator who plans on one branch, abandons it, and moves back to a
 *       sibling gets the abandoned plan restored on the branch they returned to
 *       — the snapshot is newer, so "newest wins" picks it.
 *   (b) an in-session `/tree` move emits NO event and no `session_start`, so
 *       nothing re-derived at all. The deck, the plan and the workflow kept
 *       describing the branch the operator had just left, for the rest of the
 *       session.
 *
 * oh-my-pi resolves this explicitly the other way: its `buildSessionContext()`
 * walks the new root→leaf path, and its branch-scoped state (todo, advisor,
 * checkpoint) RESETS on a switch. We adopt the same rule, and the reset is the
 * deliberate part — a successful branch read that contains no snapshot means
 * this branch never wrote one, and carrying the other branch's document over is
 * precisely the bug in (a).
 *
 * WHY THE `getEntries()` FALLBACK EXISTS, and what it costs. If a pin ever ships
 * a session manager without `getBranch`, `branchEntries` returns the whole entry
 * list rather than throwing. That is a deliberate degradation, not a fix: the
 * fallback restores exactly the behaviour this module was written to remove. It
 * is here because a wrong-but-present list keeps a handler running, and a throw
 * inside an awaited handler IS the agent loop stopping. If the fallback ever
 * fires in practice, the bug is back and silent — worth a probe, not a shrug.
 *
 * WHY `before_agent_start` AND NOT A TIMER. The re-derivation trigger has to be
 * a moment, and the only moment that matters is the one where the state the
 * model sees is assembled: the start of a turn. A polling timer was rejected
 * outright — the deck's 1s tick only runs while a live section is showing
 * elapsed time, so an idle session being navigated with `/tree` never ticks at
 * all, which is exactly the session this bug shows up in.
 *
 * THE FINGERPRINT MOVES ON NEARLY EVERY TURN, and that is accepted rather than
 * optimised away. The previous turn's entries are appended before the next
 * `before_agent_start`, so the leaf has changed and `poll()` walks and
 * re-derives. The cost is one `getBranch()` plus a backwards scan that stops at
 * the first valid snapshot — bounded by recency, not by session length — and a
 * same-branch re-derive restores precisely what memory already holds. Comparing
 * documents to suppress that would add a deep-equality walk to save a shallow
 * one.
 *
 * TWO UPSTREAM GAPS, both worth filing rather than working around:
 *
 *   1. pi emits no event when the leaf pointer moves. `/tree` changes what the
 *      model will see on the next turn and nothing is told. The fingerprint
 *      check here is a poll disguised as a turn hook; a `leaf_moved` event would
 *      make it a subscription.
 *   2. `before_agent_start` does not fire for INJECTED turns (agenda's driver
 *      continuations, `agent-session.js:884` sits on the user-prompt path only).
 *      So a `/tree` move immediately followed by an injected continuation still
 *      runs that turn against the branch the operator left. The next human turn
 *      corrects it.
 *
 * Pure by construction: no fs, no process, no pi imports. Everything takes the
 * entries or a minimal ctx-shaped interface, so the decisions are testable with
 * fixtures instead of a live session tree.
 */

/** The slice of `ctx.sessionManager` this module touches. All optional — a fake, a worker's stub and an older pin each have a different subset. */
export interface BranchSessionManager {
	getBranch?: () => readonly unknown[];
	getEntries?: () => readonly unknown[];
	getLeafId?: () => string | null;
}

export interface BranchCtxLike {
	readonly sessionManager?: BranchSessionManager;
}

/**
 * The root→leaf path of the ACTIVE branch, which is what "the session state"
 * means on a tree.
 *
 * Deliberately NOT wrapped in a try/catch: reading `ctx.sessionManager` throws
 * once the session has been replaced, and swallowing that here would turn a
 * stale ctx into "this branch has no state", i.e. into a silent wipe. Every
 * caller is already inside the try it needs — `poll()` below, and the
 * `session_start` handlers that had one before this module existed.
 */
export function branchEntries(ctx: BranchCtxLike | null | undefined): readonly unknown[] {
	const manager = ctx?.sessionManager;
	if (!manager) return [];
	if (typeof manager.getBranch === "function") return manager.getBranch();
	// The documented degradation — see the header. Wrong-but-present beats a
	// throw inside an awaited handler.
	if (typeof manager.getEntries === "function") return manager.getEntries();
	return [];
}

/**
 * A cheap identity for "which branch, and how far along it are we".
 *
 * Length alone cannot see a move to a sibling of equal depth, and the leaf's id
 * alone cannot see a move to an ancestor of the current leaf — pairing them
 * catches both, at the cost of reading two fields.
 *
 * The id-less fallback is for fixtures and for entries a pin adds without one:
 * it degrades to length plus the last entry's shape, which CAN collide (two
 * sibling branches of the same depth ending in the same kind of entry read as
 * the same branch). Real pi entries always carry `id` (`SessionEntryBase`), so
 * the collision is a test-fixture concern, not a session one.
 */
export function branchFingerprint(entries: readonly unknown[]): string {
	const last = entries[entries.length - 1] as
		| { id?: unknown; customType?: unknown; message?: { role?: unknown } }
		| undefined;
	if (last === undefined) return "0:";
	if (typeof last.id === "string" && last.id.length > 0) return `${entries.length}:${last.id}`;
	const shape =
		typeof last.customType === "string"
			? last.customType
			: typeof last.message?.role === "string"
				? last.message.role
				: "?";
	return `${entries.length}:~${shape}`;
}

export interface BranchWatch {
	/**
	 * The active branch's entries when it has MOVED since the last derivation,
	 * `null` when it has not — and `null`, never `[]`, when the branch could not
	 * be read at all. The caller re-derives from what it gets back and leaves its
	 * state alone on `null`.
	 */
	poll(ctx: BranchCtxLike | null | undefined): readonly unknown[] | null;
	/** Record that state was just derived from this ctx's branch, without re-deriving. For the `session_start` path, which reads the branch itself. */
	mark(ctx: BranchCtxLike | null | undefined): void;
	/** The stamp last derived from. Exposed for tests; nothing in the harness reads it. */
	stamp(): string | null;
}

/**
 * The re-derive trigger: a closure holding the stamp of the branch the caller's
 * state was last built from.
 *
 * A closure rather than a module-level map because pi builds a fresh jiti per
 * extension with `moduleCache:false` — module state is not shared between
 * extensions and would silently diverge — and because two extensions watching
 * the same session must not share one another's derivation history.
 *
 * `poll()` swallows a read failure and returns `null`: a ctx that has gone stale
 * between pi emitting the event and this handler running means "cannot tell",
 * and the honest response to "cannot tell" is to leave the current document
 * alone. Only a SUCCESSFUL read that carries no snapshot clears state, which is
 * the reset-on-switch semantics from the header.
 */
export function createBranchWatch(): BranchWatch {
	let derivedFrom: string | null = null;

	/**
	 * `getLeafId()` is the cheap half: the leaf pointer is exactly the identity
	 * we want and reading it walks nothing. It returns `string | null`, and a
	 * null leaf (an empty session) falls through to the path fingerprint so the
	 * two sources never mix — the prefixes keep a leaf id from ever comparing
	 * equal to a fingerprint.
	 */
	const stampOf = (ctx: BranchCtxLike | null | undefined): string | null => {
		const manager = ctx?.sessionManager;
		if (!manager) return null;
		const leaf = typeof manager.getLeafId === "function" ? manager.getLeafId() : null;
		if (typeof leaf === "string" && leaf.length > 0) return `leaf:${leaf}`;
		return `path:${branchFingerprint(branchEntries(ctx))}`;
	};

	return {
		poll(ctx) {
			try {
				const stamp = stampOf(ctx);
				if (stamp === null || stamp === derivedFrom) return null;
				const entries = branchEntries(ctx);
				derivedFrom = stamp;
				return entries;
			} catch {
				return null;
			}
		},
		mark(ctx) {
			try {
				derivedFrom = stampOf(ctx);
			} catch {
				// Unknown, so the next poll re-derives rather than assuming the
				// branch is still the one we just read.
				derivedFrom = null;
			}
		},
		stamp: () => derivedFrom,
	};
}
