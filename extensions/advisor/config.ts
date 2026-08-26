/**
 * advisor — configuration.
 *
 * Env-driven like agenda's evaluator knobs: the advisor's whole point is to be
 * zero-setup on a machine that already has Hive auth, so there is no config
 * file. Everything here has a working default; PI_ADVISOR_MODEL exists for the
 * machine that wants a specific reviewer regardless of what the Hive mode
 * catalog says.
 */

export interface AdvisorConfig {
	/** Explicit `provider/id` override. Wins over the Hive mode catalog. */
	modelOverride: string | undefined;
	/** Hard wall for one consultation. The advisor reads a whole session and
	 *  thinks hard; this is generous by design, but it must end. */
	timeoutMs: number;
	/** Transcript budget in characters (~4 chars/token — 400k chars fits any
	 *  current high-class context with room for the answer). */
	maxChars: number;
	disabled: boolean;
}

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_CHARS = 400_000;

export function loadAdvisorConfig(env: NodeJS.ProcessEnv = process.env): AdvisorConfig {
	return {
		modelOverride: nonEmpty(env.PI_ADVISOR_MODEL),
		timeoutMs: positiveInt(env.PI_ADVISOR_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
		maxChars: positiveInt(env.PI_ADVISOR_MAX_CHARS) ?? DEFAULT_MAX_CHARS,
		disabled: env.PI_ADVISOR_DISABLED === "1",
	};
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}
