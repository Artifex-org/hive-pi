import { markRunner } from "./test-temp.ts";

markRunner(process.env.HIVE_PI_TEST_RUN_DIR!);
// Same CLI and arguments as `vitest run`, but temp env was set before this
// process started (including Node's compile cache and Vite's initial imports).
process.argv = [process.execPath, process.argv[1], "run", ...process.argv.slice(2)];
await import(new URL("vitest.mjs", import.meta.resolve("vitest/package.json")).href);
