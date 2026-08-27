export type RemoteTimer = ReturnType<typeof setInterval>;

export interface RemoteLifecycle {
	generation: number;
	flushTimer?: RemoteTimer;
	pollTimer?: RemoteTimer;
	statusTimer?: RemoteTimer;
	quotaTimer?: RemoteTimer;
	/** The heartbeat. Cleared like the rest — a beat surviving a /reload would
	 *  report liveness for an extension instance that no longer exists. */
	activityTimer?: RemoteTimer;
	/** The working-tree reporter's slow fallback beat. */
	worktreeTimer?: RemoteTimer;
	/** Latest browser screenshot publisher; local live media never uses it. */
	surfaceTimer?: RemoteTimer;
	titleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Invalidate async work and stop timers owned by one hive-remote extension
 * instance. Pi replaces an extension instance on /reload, but JavaScript
 * timers outlive that replacement unless the extension explicitly clears them.
 */
export function invalidateRemoteLifecycle(lifecycle: RemoteLifecycle): void {
	lifecycle.generation += 1;
	if (lifecycle.flushTimer) clearInterval(lifecycle.flushTimer);
	if (lifecycle.pollTimer) clearInterval(lifecycle.pollTimer);
	if (lifecycle.statusTimer) clearInterval(lifecycle.statusTimer);
	if (lifecycle.quotaTimer) clearInterval(lifecycle.quotaTimer);
	if (lifecycle.activityTimer) clearInterval(lifecycle.activityTimer);
	if (lifecycle.worktreeTimer) clearInterval(lifecycle.worktreeTimer);
	if (lifecycle.surfaceTimer) clearInterval(lifecycle.surfaceTimer);
	if (lifecycle.titleTimer) clearTimeout(lifecycle.titleTimer);
	lifecycle.flushTimer = undefined;
	lifecycle.pollTimer = undefined;
	lifecycle.statusTimer = undefined;
	lifecycle.quotaTimer = undefined;
	lifecycle.activityTimer = undefined;
	lifecycle.worktreeTimer = undefined;
	lifecycle.surfaceTimer = undefined;
	lifecycle.titleTimer = undefined;
}

export function isCurrentRemoteLifecycle(lifecycle: RemoteLifecycle, generation: number): boolean {
	return lifecycle.generation === generation;
}
