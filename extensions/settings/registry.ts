/**
 * settings — the toggle registry.
 *
 * WHY A CENTRAL REGISTRY RATHER THAN SELF-REGISTRATION. The obvious design is
 * for each extension to announce its own toggle. It is the wrong one here for
 * two reasons. First, a disabled extension does not run, so a self-registering
 * page could only ever list the things that are already on — and the moment you
 * most want a settings page is when you are looking for the switch of something
 * that is off. Second, every extension would have to import a settings module
 * that imports them back, which is the cycle this package has so far avoided.
 *
 * The cost is drift: an extension can rename its config key and this file will
 * not notice. `test/settings.test.ts` closes that by asserting every entry here
 * points at a real `extensions/<dir>` and that the fallbacks match the literal
 * `enabled:` expression in that extension's source. A registry that lies is
 * worse than no registry, so the test is not optional.
 */

/** Display grouping. Order here is the order on the page. */
export const GROUP_ORDER = ["compaction", "editing", "session", "telemetry"] as const;

export type SettingGroup = (typeof GROUP_ORDER)[number];

/**
 * How the owning extension reads its own flag. This is not decoration — it
 * decides what an ABSENT key means, and the two conventions in this package
 * disagree:
 *
 *   opt-out  `enabled: raw.enabled !== false`   absent -> ON
 *   opt-in   `enabled: raw.enabled === true`    absent -> OFF
 *
 * Reading an opt-in flag with opt-out semantics would show telemetry as ON for
 * every user who never enabled it, which is the single most damaging thing a
 * settings page can get wrong.
 */
export type SettingMode = "opt-in" | "opt-out";

export interface SettingSpec {
	/** `configPathFor(config)` — the file the flag lives in. */
	config: string;
	/** Key within that file. */
	key: string;
	/** Extension directory or file stem under `extensions/`, for the drift test. */
	source: string;
	label: string;
	group: SettingGroup;
	mode: SettingMode;
	/** Shown under the row, always. Use for consequences the label cannot carry. */
	warning?: string;
	/** Shown under the row when the setting is ON. */
	hint?: string;
}

/**
 * Deliberately NOT here: `agenda`/`conductor` (owns its own `/conductor
 * on|off`, and its state is a lifecycle rather than a flag) and `plan` (entered
 * per-task, not configured). A settings page that lists things whose real
 * control lives elsewhere teaches people to look in the wrong place.
 */
export const SETTINGS: readonly SettingSpec[] = [
	{
		config: "compaction",
		key: "enabled",
		source: "compaction",
		label: "openai server compaction",
		group: "compaction",
		mode: "opt-in",
		warning: "sends conversation context to OpenAI and sets store:true, so OpenAI retains it server-side",
		// Names the inert case rather than the supported one: on this workstation
		// the default model IS openai-codex, so "enabled and nothing happens" is
		// the expected first experience and the hint has to explain it.
		hint: "needs a direct openai/* model and an API key — inert on openai-codex/*; run /compaction to see why",
	},
	{
		config: "rowtool",
		key: "enabled",
		source: "edit-common",
		label: "row-script edit format",
		group: "editing",
		mode: "opt-in",
		// Opt-in because it REPLACES the built-in `edit` for whoever loads it.
		// Reaching a worker also requires being listed in subagent/worker.ts's
		// WORKER_EXTENSIONS — that list, not this flag, is the scoping mechanism.
		hint: "workers only (subagent WORKER_EXTENSIONS); the orchestrator keeps its native edit",
	},
	{
		config: "filerank",
		key: "enabled",
		source: "filerank",
		label: "filerank result ranking",
		group: "editing",
		mode: "opt-out",
	},
	{
		config: "papercuts",
		key: "enabled",
		source: "papercuts",
		label: "papercut friction log",
		group: "editing",
		mode: "opt-out",
	},
	{
		config: "btw",
		key: "enabled",
		source: "btw",
		label: "/btw side questions",
		group: "session",
		mode: "opt-out",
	},
	{
		config: "narrate",
		key: "enabled",
		source: "narrate",
		label: "narrate reminders",
		group: "session",
		mode: "opt-out",
	},
	{
		config: "term-title",
		key: "enabled",
		source: "term-title",
		label: "terminal tab title",
		group: "session",
		mode: "opt-out",
	},
	{
		config: "skill-scope",
		key: "enabled",
		source: "skillscope",
		label: "per-skill scoping",
		group: "session",
		mode: "opt-out",
		hint: "no effect until skill-scope.config.json names a skill",
	},
	{
		config: "hive-telemetry",
		key: "enabled",
		source: "hive-telemetry",
		label: "hive telemetry",
		group: "telemetry",
		mode: "opt-in",
		warning: "reports session metrics to hive under your API key",
	},
	{
		config: "hive-remote",
		key: "enabled",
		source: "hive-remote",
		label: "hive remote control",
		group: "telemetry",
		mode: "opt-in",
		warning: "streams this session to the hive agents workspace and accepts steering from it",
	},
];

/** Human-facing group headings. Kept apart from the ids so ids stay terse. */
export const GROUP_LABELS: Record<SettingGroup, string> = {
	compaction: "COMPACTION",
	editing: "EDITING",
	session: "SESSION",
	telemetry: "TELEMETRY",
};

/**
 * Resolve a flag out of a config object, honouring the owning extension's own
 * convention. `raw` is whatever `readJSON` returned, including null for a file
 * that does not exist yet — the common case, and the one that must not throw.
 */
export function readSetting(raw: Record<string, unknown> | null, spec: SettingSpec): boolean {
	const value = raw?.[spec.key];
	return spec.mode === "opt-in" ? value === true : value !== false;
}

/**
 * Produce the config object to write back for a new value.
 *
 * Always writes a LITERAL boolean rather than deleting the key to mean the
 * default. Both conventions read a literal correctly, and an explicit `false`
 * survives a later change to the extension's own default — which a deleted key
 * would not. The cost is a config file with a redundant-looking `true` in it;
 * the benefit is that what you set is what you get.
 *
 * Unknown keys are preserved: these files are hand-editable and several carry
 * far more than the flag (hive-remote's capability set, papercuts' path).
 */
export function writeSetting(
	raw: Record<string, unknown> | null,
	spec: SettingSpec,
	value: boolean,
): Record<string, unknown> {
	return { ...(raw ?? {}), [spec.key]: value };
}

export interface SettingRow {
	spec: SettingSpec;
	value: boolean;
}

/** Registry order, filtered to groups that have at least one entry. */
export function groupRows(rows: readonly SettingRow[]): { group: SettingGroup; rows: SettingRow[] }[] {
	return GROUP_ORDER.map((group) => ({ group, rows: rows.filter((row) => row.spec.group === group) })).filter(
		(entry) => entry.rows.length > 0,
	);
}

/**
 * Flat navigation order, matching the visual order produced by `groupRows`.
 * The cursor indexes THIS array, never `SETTINGS` — the two differ whenever a
 * group is empty, and conflating them moves the highlight to the wrong row.
 */
export function navigationOrder(rows: readonly SettingRow[]): SettingRow[] {
	return groupRows(rows).flatMap((entry) => entry.rows);
}
