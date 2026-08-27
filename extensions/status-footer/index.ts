/**
 * status-footer — the bottom bar, and the Hive/Linear watchers behind it.
 *
 * Four rows in a normal terminal:
 *   1. context gauge            · session tokens, cost, turns
 *   2. model and thinking level · provider quota
 *   3. project, cwd, PR (with its run's verdict), branch
 *   4. Hive: my run, trunk, in-flight, health · Linear: the PR's tickets
 *
 * Row 4 is omitted entirely outside a Hive project with no tickets, so it costs
 * nothing where it would say nothing. One row in compact/focus mode.
 *
 * WHY THIS IS ONE EXTENSION: pi builds a fresh jiti instance per extension with
 * `moduleCache: false`, so two extensions importing the same module get two
 * separate instances of it — a shared store between a "hive" extension and a
 * "footer" extension would silently never update. The watchers therefore live in
 * this factory's closure alongside the footer that renders them, and nothing in
 * this directory keeps state at module scope.
 *
 * All I/O is on timers and never awaited from an event handler: pi runs handlers
 * serially, so a blocking `gh pr view` inside one is a stalled agent loop.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type HiveRun, HiveWatcher } from "./hive.ts";
import { LinearWatcher } from "./linear.ts";
import {
	type ThemeLike,
	fitRow,
	formatCost,
	formatTokens,
	integrationRow,
	issueGlyph,
	runGlyph,
	workspaceRow,
} from "./render.ts";
import { EMPTY_WORKSPACE, type Workspace, projectLabel, resolveWorkspace, sameWorkspace } from "./workspace.ts";

const REDRAW_INTERVAL_MS = 2_500;
/** Re-resolve the workspace on a timer so a PR opened mid-session shows up. */
const WORKSPACE_INTERVAL_MS = 120_000;
const GAUGE_WIDTH = 10;

function formatContext(ctx: ExtensionContext, theme: ThemeLike, compact = false): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!usage || usage.percent === null || !contextWindow) return theme.fg("muted", "ctx ?");

	const percent = Math.max(0, Math.min(100, usage.percent));
	const filled = Math.round((percent / 100) * GAUGE_WIDTH);
	const gauge = `${"█".repeat(filled)}${"░".repeat(GAUGE_WIDTH - filled)}`;
	const color = percent >= 80 ? "error" : percent >= 60 ? "warning" : "success";
	if (compact) return `${theme.fg("muted", "ctx ")}${theme.fg(color, `${Math.round(percent)}%`)}`;
	const tokens = usage.tokens === null ? "?" : formatTokens(usage.tokens);
	return `${theme.fg("muted", "ctx ")}${theme.fg(color, gauge)} ${theme.fg(color, `${Math.round(percent)}%`)} ${theme.fg("dim", `${tokens}/${formatTokens(contextWindow)}`)}`;
}

function formatSession(ctx: ExtensionContext, theme: ThemeLike): string {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let turns = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = (entry.message as AssistantMessage).usage;
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cost += usage.cost.total;
		turns += 1;
	}
	const parts = [
		`↑${formatTokens(input)}`,
		`↓${formatTokens(output)}`,
		`R${formatTokens(cacheRead)}`,
		formatCost(cost),
		`${turns}t`,
	];
	return theme.fg("dim", parts.join(" · "));
}

/** runLine is one row of the /hive overlay: state, progress, tests, and where to look. */
function runLine(run: HiveRun, theme: ThemeLike, baseUrl: string | null): string {
	const { glyph, color } = runGlyph(run.state);
	const parts = [
		theme.fg(color, glyph),
		theme.fg("accent", `${run.pipeline}#${run.number}`),
		theme.fg("muted", run.state),
	];
	if (run.tasks && run.tasks.total > 0) {
		const failed = run.tasks.failed > 0 ? `, ${run.tasks.failed} failed` : "";
		parts.push(theme.fg("dim", `${run.tasks.succeeded}/${run.tasks.total} tasks${failed}`));
	}
	if (run.tests) parts.push(theme.fg("dim", `${run.tests.passed}/${run.tests.total} tests`));
	if (run.branch) parts.push(theme.fg("dim", run.branch));
	if (baseUrl) parts.push(theme.fg("dim", `${baseUrl}/runs/${run.id}`));
	return parts.join(" ");
}

async function showOverlay(ctx: ExtensionContext, title: string, body: (theme: ThemeLike) => string[]): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(body({ fg: (_color, text) => text }).join("\n"), "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => ({
			render(width: number): string[] {
				const contentWidth = Math.max(1, width - 4);
				return [
					theme.fg("accent", title),
					...body(theme).map((line) => truncateToWidth(line, contentWidth)),
					theme.fg("dim", "Esc or Enter to close"),
				];
			},
			invalidate() {},
			handleInput(data: string): void {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done();
				tui.requestRender();
			},
		}),
		{
			overlay: true,
			overlayOptions: { width: "80%", minWidth: 56, maxHeight: "70%", anchor: "center", margin: 2 },
		},
	);
}

export default function statusFooter(pi: ExtensionAPI) {
	let tui: { requestRender(): void } | undefined;
	let redrawTimer: ReturnType<typeof setInterval> | undefined;
	let workspaceTimer: ReturnType<typeof setInterval> | undefined;
	let workspace: Workspace = EMPTY_WORKSPACE;
	let project = "";

	const requestRender = () => tui?.requestRender();
	const hive = new HiveWatcher(requestRender);
	const linear = new LinearWatcher(requestRender);

	/**
	 * refreshWorkspace re-resolves the cwd and only retargets the watchers when
	 * something they care about moved. Without that guard the 2-minute tick would
	 * restart the SSE stream and refetch everything for no reason.
	 */
	const refreshWorkspace = async (cwd: string): Promise<void> => {
		const next = await resolveWorkspace(cwd);
		if (sameWorkspace(next, workspace) && project) return;
		workspace = next;
		project = projectLabel(cwd, next.repo, null);
		hive.retarget({ repo: next.repo, branch: next.branch, pr: next.pr });
		linear.retarget({ branch: next.branch, prUrl: next.prUrl, prTitle: next.prTitle });
		requestRender();
	};

	const stopTimers = () => {
		if (redrawTimer) clearInterval(redrawTimer);
		if (workspaceTimer) clearInterval(workspaceTimer);
		redrawTimer = undefined;
		workspaceTimer = undefined;
	};

	const installFooter = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		stopTimers();
		project = projectLabel(ctx.cwd, workspace.repo, null);
		// Fire-and-forget: this handler must not await network or `gh`.
		void refreshWorkspace(ctx.cwd);
		hive.start();
		linear.start();

		ctx.ui.setFooter((footerTui, theme, footerData) => {
			tui = footerTui;
			const unsubscribe = footerData.onBranchChange(() => void refreshWorkspace(ctx.cwd));
			redrawTimer = setInterval(() => footerTui.requestRender(), REDRAW_INTERVAL_MS);
			redrawTimer.unref?.();
			workspaceTimer = setInterval(() => void refreshWorkspace(ctx.cwd), WORKSPACE_INTERVAL_MS);
			workspaceTimer.unref?.();

			return {
				dispose: () => {
					unsubscribe();
					stopTimers();
					if (tui === footerTui) tui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const statuses = footerData.getExtensionStatuses();
					const quota = statuses.get("usage");
					const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
					const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
					const branch = footerData.getGitBranch();
					const compact = width < 80 || statuses.has("pi-focus");
					const context = formatContext(ctx, theme, compact);
					const modelText = theme.fg("muted", compact ? model : `${model} · ${thinking}`);
					if (compact) return [fitRow(context, modelText, width)];

					const rows = [
						fitRow(context, formatSession(ctx, theme), width),
						fitRow(modelText, quota ? theme.fg("accent", quota) : theme.fg("muted", "quota ?"), width),
						truncateToWidth(
							workspaceRow({ ...workspace, cwd: ctx.cwd }, project, branch, hive.get().mine, theme),
							width,
							"",
						),
					];
					const integrations = integrationRow(hive.get(), linear.get(), theme, width);
					if (integrations) rows.push(integrations);
					return rows;
				},
			};
		});
		requestRender();
	};

	pi.registerCommand("hive", {
		description: "Hive: this project's runs, trunk state and recent health",
		handler: async (_args, ctx) => {
			await hive.refresh();
			const snapshot = hive.get();
			await showOverlay(ctx, "Hive", (theme) => {
				if (!hive.configured) return [theme.fg("dim", "HIVE_URL / HIVE_TOKEN are not set in this environment.")];
				if (snapshot.status === "foreign") {
					return [theme.fg("dim", `${workspace.repo ?? "this repo"} is not a registered Hive project.`)];
				}
				if (snapshot.status === "error") return [theme.fg("error", `Hive is unreachable: ${snapshot.error}`)];
				if (snapshot.status !== "ok") return [theme.fg("dim", "Resolving…")];

				const lines = [
					`${theme.fg("muted", "project")} ${theme.fg("accent", snapshot.project ?? "?")}   ${theme.fg("muted", "trunk")} ${snapshot.defaultBranch ?? "?"}   ${theme.fg("muted", "live")} ${snapshot.live ? theme.fg("success", "streaming") : theme.fg("dim", "polling")}`,
				];
				if (snapshot.health) {
					lines.push(
						`${theme.fg("muted", "health")} ${snapshot.health.passed}/${snapshot.health.total} recent gate runs passed`,
					);
				}
				if (snapshot.trunk) lines.push("", theme.fg("muted", "Trunk"), `  ${runLine(snapshot.trunk, theme, hive.runUrlBase)}`);
				if (snapshot.mine) lines.push("", theme.fg("muted", "This branch"), `  ${runLine(snapshot.mine, theme, hive.runUrlBase)}`);

				const others = snapshot.active.filter((run) => run.id !== snapshot.mine?.id);
				if (others.length > 0) {
					lines.push("", theme.fg("muted", `In flight (${others.length})`));
					for (const run of others.slice(0, 10)) lines.push(`  ${runLine(run, theme, hive.runUrlBase)}`);
				}
				if (!snapshot.mine && others.length === 0) lines.push("", theme.fg("dim", "Nothing running."));
				return lines;
			});
		},
	});

	pi.registerCommand("linear", {
		description: "Linear: tickets attached to this PR or named by the branch",
		handler: async (_args, ctx) => {
			await linear.refresh();
			const snapshot = linear.get();
			await showOverlay(ctx, "Linear", (theme) => {
				if (!linear.configured) return [theme.fg("dim", "LINEAR_API_TOKEN is not set in this environment.")];
				if (snapshot.status === "error") return [theme.fg("error", `Linear is unreachable: ${snapshot.error}`)];
				if (snapshot.issues.length === 0) {
					return [
						theme.fg("dim", "No tickets attached to this PR, and no ticket key in the branch name or PR title."),
					];
				}
				const lines: string[] = [];
				for (const issue of snapshot.issues) {
					const { glyph, color } = issueGlyph(issue.stateType);
					const via = issue.source === "attachment" ? "attached" : "from branch/title";
					lines.push(
						`${theme.fg(color, glyph)} ${theme.fg("accent", issue.identifier)} ${issue.title}`,
						`    ${theme.fg("muted", issue.stateName)}${issue.assignee ? theme.fg("dim", ` · ${issue.assignee}`) : ""}${theme.fg("dim", ` · ${via}`)}`,
						`    ${theme.fg("dim", issue.url)}`,
						"",
					);
				}
				return lines;
			});
		},
	});

	pi.on("session_start", (_event, ctx) => installFooter(ctx));
	pi.on("message_end", () => requestRender());
	pi.on("model_select", () => requestRender());
	pi.on("session_tree", () => requestRender());
	pi.on("session_compact", () => requestRender());
	pi.on("session_shutdown", () => {
		stopTimers();
		hive.stop();
		linear.stop();
		tui = undefined;
	});
}
