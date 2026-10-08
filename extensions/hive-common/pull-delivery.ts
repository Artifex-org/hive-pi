/** A created PR, not an arbitrary link printed by a status/view command. */
export function createdPullURL(command: string, output: string): string | null {
	if (!/\bgh\s+pr\s+create\b/.test(command)) return null;
	return output.match(/https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*\/?/)?.[0] ?? null;
}
