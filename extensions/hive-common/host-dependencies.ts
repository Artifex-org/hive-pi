import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

/** Reuse launch-pinned direct dependencies; an invalid supplied pin never falls back. */
export function hostRequire(): NodeJS.Require {
	return createRequire(process.env.HIVE_PI_BIN ? realpathSync(process.env.HIVE_PI_BIN) : import.meta.url);
}
