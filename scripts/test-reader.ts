/** Test-only Node preload and explicit native-reader admission command. */
import { fileURLToPath } from "node:url";
import { registerReader } from "./test-temp.ts";

if (process.env.HIVE_PI_TEST_RUN_DIR) registerReader(process.env.HIVE_PI_TEST_RUN_DIR);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	registerReader(process.argv[2], Number(process.argv[3]));
}
