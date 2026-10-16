export type PilotPolicyFailure =
	| "not_armed"
	| "unexpected_query"
	| "unexpected_result"
	| "account_excluded"
	| "account_changed"
	| "closed";

export class PilotPolicyError extends Error {
	constructor(readonly category: PilotPolicyFailure) {
		super(`claude_sdk_pilot_${category}`);
		this.name = "PilotPolicyError";
	}
}

type Phase = "unarmed" | "first_allowed" | "first_spent" | "recall_allowed" | "spent" | "closed";
type AccountIdentity = Readonly<{ credential: string; slot: string }>;

/**
 * Nonrefundable allowances for exactly two native queries. The caller must put
 * each returned allowance into SDK maxTurns BEFORE constructing that query.
 * This arithmetic alone does not establish the native CLI's retry semantics.
 * Keep this object outside runtime instances so resets cannot refund a query.
 */
export class PilotQueryBudget {
	readonly maxOutputTokens = 512;
	private phase: Phase = "unarmed";
	private account: AccountIdentity | undefined;
	private requestActive = false;
	private exclusions = new Set<string>();
	private readonly allowances: number[] = [];
	private readonly observations: number[] = [];

	/** Read at each lease request; never expose the mutable policy set. */
	get excludedAccounts(): readonly string[] {
		return [...this.exclusions];
	}

	get reservedTurns(): number {
		return this.allowances.reduce((sum, turns) => sum + turns, 0);
	}

	get observedTurns(): number {
		return this.observations.reduce((sum, turns) => sum + turns, 0);
	}

	assertRequestAllowed(): void {
		// Availability/auth probes before command dispatch must refuse without
		// spending or arming the one-use pilot. No lease is acquired.
		if (this.phase === "unarmed") throw new PilotPolicyError("not_armed");
		if (this.phase === "closed") this.fail("closed");
		if (this.phase === "spent") this.fail("unexpected_query");
	}

	/** Validate a real Pi request before any lease, including parked continuations. */
	beginRequest(continuation: boolean): void {
		this.assertRequestAllowed();
		if (this.requestActive || this.phase === "first_spent" && !continuation ||
			this.phase !== "first_spent" && continuation) this.fail("unexpected_query");
		this.requestActive = true;
	}

	endRequest(): void {
		this.requestActive = false;
	}

	arm(excludedAccounts: readonly string[]): void {
		if (this.phase !== "unarmed") this.fail("closed");
		this.exclusions = new Set(excludedAccounts);
		if (this.account) this.checkAccount(this.account);
		this.phase = "first_allowed";
	}

	checkAccount(identity: AccountIdentity): void {
		if (this.phase === "closed") this.fail("closed");
		if (!identity.credential || !identity.slot) this.fail("account_changed");
		if (this.exclusions.has(identity.credential) || this.exclusions.has(identity.slot)) {
			this.fail("account_excluded");
		}
		if (this.account &&
			(this.account.credential !== identity.credential || this.account.slot !== identity.slot)) {
			this.fail("account_changed");
		}
		this.account = { credential: identity.credential, slot: identity.slot };
	}

	reserveQuery(): 2 | 1 {
		if (this.phase === "unarmed") this.fail("not_armed");
		if (this.phase === "first_allowed") {
			this.phase = "first_spent";
			this.allowances.push(2);
			return 2;
		}
		if (this.phase === "recall_allowed") {
			this.phase = "spent";
			this.allowances.push(1);
			return 1;
		}
		this.fail(this.phase === "closed" ? "closed" : "unexpected_query");
	}

	observeResult(turns: number, success: boolean): void {
		const limit = this.allowances[this.observations.length];
		if (this.phase === "closed") this.fail("closed");
		if (!success || limit === undefined || !Number.isSafeInteger(turns) || turns < 1 || turns > limit) {
			this.fail("unexpected_result");
		}
		this.observations.push(turns);
	}

	/** Call only after verified Pi results and successful explicit runtime close. */
	allowRecall(): void {
		if (this.phase !== "first_spent" || this.observations.length !== 1) {
			this.fail("unexpected_query");
		}
		this.phase = "recall_allowed";
	}

	close(): void {
		this.phase = "closed";
	}

	private fail(category: PilotPolicyFailure): never {
		this.close();
		throw new PilotPolicyError(category);
	}
}
