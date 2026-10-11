/** Chart sources already coalesce snapshots; never discard their trailing update. */
export function toolUpdateThrottled(tool: string, now: number, last: number): boolean {
	return tool !== "render_chart" && now - last < 1000;
}
