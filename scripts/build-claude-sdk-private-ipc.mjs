#!/usr/bin/env node
// Explicit development/release build, never an install hook or runtime fallback.
// Output is NOT an approved profile artifact until independently verified.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (process.platform !== 'linux' || args.length !== 2 || args[0] !== '--output' || !isAbsolute(args[1])) {
  throw new Error('Linux native build requires --output <absolute artifact path>');
}
const require = createRequire(import.meta.url);
const include = require('node-api-headers').include_dir;
if (typeof include !== 'string' || !isAbsolute(include)) {
  throw new Error('Pinned public Node-API headers unavailable');
}
await mkdir(dirname(args[1]), { recursive: true, mode: 0o700 });
const source = fileURLToPath(new URL('../extensions/claude-sdk/native/private-ipc.c', import.meta.url));
const result = spawnSync('cc', [
  '-std=c11', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror',
  '-fvisibility=hidden', '-I', include, source, '-o', args[1],
], { stdio: 'inherit' });
if (result.error || result.status !== 0 || result.signal) {
  throw new Error('SDK native build failed; artifact NOT VERIFIED');
}
