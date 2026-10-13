import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The directory a test may create files in under ~/.hive/scratch.
 *
 * A launched sandbox can write only its own scratch child (the cwd lies inside
 * ~/.hive/scratch/<child>), never the shared parent; an ordinary checkout
 * uses the parent directly.
 */
export function writableScratchRoot(cwd: string = process.cwd(), home: string = os.homedir()): string {
	const scratch = path.join(home, ".hive", "scratch");
	const first = path.relative(scratch, cwd).split(path.sep)[0];
	return first && first !== ".." ? path.join(scratch, first) : scratch;
}

/** Create a private temp directory (mode 0700) in the writable scratch root. */
export function mkScratchDir(prefix: string): string {
	const writable = writableScratchRoot();
	fs.mkdirSync(writable, { recursive: true, mode: 0o700 });
	const dir = fs.mkdtempSync(path.join(writable, prefix));
	fs.chmodSync(dir, 0o700);
	return dir;
}
