/**
 * Which Hive tasks are a PR gate's verdict an agent acts on: `test`, `test-2`,
 * `test-backend`, `lint`, `lint-ts`. Shared by the background watch (its early
 * first-failure notice) and quality_gate (its early foreground handoff), so the
 * two cannot disagree about what a gate task is. A build, an image or a fixer
 * step failing is the final verdict's news.
 */
const GATE_TASK_KEY = /^(?:tests?|lint)(?:$|[-_.:])/;

export function isGateTaskKey(key: string): boolean {
	return GATE_TASK_KEY.test(key);
}
