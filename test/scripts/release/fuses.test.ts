// Goal: the packaged app ships with the Electron fuses it was checked with, and
// without the two that would break it.
// Method: read the fuse settings electron-builder applies (package.json
// build.electronFuses) and the unsigned local build's overrides. The fuses
// themselves were verified on packaged builds; this holds the settings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import { record } from '#dist/shared/core/boundary.js';

test('the packaged app loads only its own checked archive and takes no inspector arguments', () => {
  const build = record(record(JSON.parse(fs.readFileSync('package.json', 'utf8')))['build']);
  assert.deepEqual(build['electronFuses'], {
    // Stacki's own binary is the Node that runs the AI adapters, content configs and app commands.
    runAsNode: true,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // enableNodeOptionsEnvironmentVariable stays unset (on): turning it off also drops NODE_EXTRA_CA_CERTS, from
    // Stacki and everything it starts, so an AI CLI behind a company's TLS proxy could no longer connect.
  });
});

test('the unsigned macOS build makes its ad hoc signature again after the fuses', () => {
  const script = fs.readFileSync('scripts/release/distMacUnsigned.ts', 'utf8');
  assert.match(script, /'-c\.electronFuses\.resetAdHocDarwinSignature=true'/);
});
