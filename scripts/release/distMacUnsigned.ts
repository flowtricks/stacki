// Packages a local, unsigned macOS build. Release builds sign and notarize
// (package.json build.mac), which needs the maintainer's certificates; this
// overrides exactly those three settings. A script rather than an npm one-liner
// because the overrides do not fit in 100 columns.
//
// It adds one more: flipping the app's fuses (package.json build.electronFuses)
// changes the binary, and with no signing step after it an Apple silicon Mac
// refuses to start the result unless its ad hoc signature, which names no
// identity and uses no certificate, is made again.

import childProcess = require('node:child_process');
import path = require('node:path');
import { repositoryRoot } from '../lib/repoRoot';

const UNSIGNED_OVERRIDES = [
  '-c.mac.forceCodeSigning=false',
  '-c.mac.notarize=false',
  '-c.mac.identity=null',
  '-c.electronFuses.resetAdHocDarwinSignature=true',
] as const;

const root = repositoryRoot();
const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const result = childProcess.spawnSync(process.execPath, [builder, '--mac', ...UNSIGNED_OVERRIDES], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error !== undefined) {
  console.error(`electron-builder could not start: ${result.error.message}`);
}
process.exitCode = result.status ?? 1;
