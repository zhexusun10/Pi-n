#!/usr/bin/env node
// Wrapper to run Node.js with TypeScript source resolver
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// Use enhanced resolver that handles both pi packages and local directory imports
const resolverPath = join(root, 'scripts/ts-resolver-enhanced.ts');
const resolverUrl = pathToFileURL(resolverPath).href;

// Pass through all arguments to node with the resolver imported
const args = ['--import', resolverUrl, ...process.argv.slice(2)];

const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  cwd: process.cwd(),
  shell: false,
});
if (result.error) {
  console.error(`Cannot start Node TypeScript runner: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  process.exit(128 + (constants.signals[result.signal] ?? 1));
}
process.exit(result.status ?? 1);
