import { spawnSync } from "node:child_process";
import { open } from "node:fs/promises";

/** Lock the parent's open file description via an inherited FD. No heartbeat
 * or holder subprocess: pause retains ownership, process death releases it. */
export async function acquireMetadataLock(path: string): Promise<(() => Promise<void>) | null> {
	const file = await open(path, "a", 0o600);
	try {
		const result = spawnSync("flock", ["-n", "-E", "250", "3"], {
			stdio: ["ignore", "ignore", "pipe", file.fd], timeout: 1_000, killSignal: "SIGKILL",
		});
		if (result.error) throw result.error;
		if (result.status === 0) return () => file.close();
		if (result.status !== 250) throw new Error(`Metadata flock failed: ${result.stderr?.toString() || result.signal || result.status}`);
	} catch (error) { await file.close(); throw error; }
	await file.close();
	return null;
}

/** Linux execution-held locks: heartbeat expiry is never proof a check ended. */
export interface ExecutionAdmission {
	directory: string;
	rootLock: string;
	slots: number;
}

// The flock parents retain both locks while the foreground command runs, even
// if its Node owner is stopped or killed. A separate marker distinguishes a
// real command exiting 250 from flock's conflict status: never retry a command.
// FD 3 is private admission signalling, closed BEFORE executing project code.
export const EXECUTION_SCRIPT = String.raw`
trap 'rm -f -- "$2"' EXIT
for ((slot=0; slot<$4; slot++)); do
  flock -n -E 250 -- "$1/slot-$slot.kernel" bash -c '
    : > "$2" || exit 125
    printf "started\n" >&3 || exit 125
    exec 3>&-
    exec bash -c "$1"
  ' -- "$3" "$2"
  status=$?
  if [[ -e "$2" ]]; then exit "$status"; fi
  if ((status != 250)); then exit "$status"; fi
done
exit 250
`;
