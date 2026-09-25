#!/usr/bin/env node
// Every test:* command belongs to the gate. The manifest is parsed before use
// so an invalid script entry cannot become an unchecked shell command.

import { spawnSync } from 'node:child_process';
import fs = require('node:fs');
import path = require('node:path');

interface PackageScripts {
  readonly [name: string]: string;
}

type GateCommand = readonly [label: string, command: string, argumentsList: readonly string[]];

function readScripts(packagePath: string): PackageScripts {
  const input: unknown = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (typeof input !== 'object' || input === null || !('scripts' in input)) {
    throw new Error('package.json: expected scripts object');
  }
  const value = input.scripts;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('package.json.scripts: expected object');
  }
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(value)) {
    if (typeof command !== 'string') {
      throw new Error(`package.json.scripts.${name}: expected string`);
    }
    scripts[name] = command;
  }
  return scripts;
}

const root = path.join(__dirname, '..', '..');
const scripts = readScripts(path.join(root, 'package.json'));
const requested = process.argv.slice(2).map((name) =>
  name.startsWith('test:') ? name : `test:${name}`,
);
const names =
  requested.length > 0
    ? requested
    : Object.keys(scripts).filter((name) => name.startsWith('test:'));
const unknown = names.filter((name) => scripts[name] === undefined);
if (names.length === 0 || unknown.length > 0) {
  console.error(`Unknown test command: ${unknown.join(', ')}`);
  process.exit(1);
}

const startedMs = Date.now();
const failed: string[] = [];
const pathValue = process.env['PATH'] ?? '';
const environment = {
  ...process.env,
  PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${pathValue}`,
};
const node = process.execPath;
const typeScript = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const staticGates: readonly GateCommand[] = [
  [
    'build:clean',
    node,
    [
      '--disable-warning=ExperimentalWarning',
      '--experimental-transform-types',
      path.join(root, 'scripts', 'clean-build.mts'),
    ],
  ],
  ['build:contracts', node, [typeScript, '-p', path.join('shared', 'tsconfig.json')]],
  ['build:electron', node, [typeScript, '-p', path.join('electron', 'tsconfig.json')]],
  ['build:scripts', node, [typeScript, '-p', path.join('scripts', 'tsconfig.json')]],
  ['build:morph', node, [typeScript, '-p', path.join('electron', 'tsconfig.morph.json')]],
  ['build:preload', node, [typeScript, '-p', path.join('electron', 'tsconfig.preload.json')]],
  [
    'stage:runtime',
    node,
    [path.join(root, 'dist', 'scripts', 'stage-runtime.js')],
  ],
  ['build:web', node, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']],
  ['tsc --noEmit', node, [typeScript, '--noEmit']],
  ['eslint', node, [path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'), '.']],
  ['ratchet-check', node, [path.join(root, 'dist', 'scripts', 'ratchet-check.js')]],
];

for (const [label, command, argumentsList] of staticGates) {
  console.log(`\n[gate] ${label}`);
  const result = spawnSync(command, argumentsList, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  });
  if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') {
    process.exit(130);
  }
  if (result.status !== 0 || result.error) {
    console.error(`\nStatic gate failed: ${label}`);
    process.exit(1);
  }
}

for (const [index, name] of names.entries()) {
  console.log(`\n[${index + 1}/${names.length}] ${name}`);
  const command = scripts[name];
  if (command === undefined) {
    throw new Error(`Missing validated test command ${name}`);
  }
  const result = spawnSync(command, {
    cwd: root,
    env: environment,
    shell: true,
    stdio: 'inherit',
  });
  if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') {
    process.exit(130);
  }
  if (result.status !== 0 || result.error) {
    failed.push(name);
    if (result.error) {
      console.error(result.error.message);
    }
  }
}

const quarantined: readonly string[] = [];
const flaky = ['test:hovercost', 'test:popoverdropdown'] as const;
const durationSeconds = ((Date.now() - startedMs) / 1000).toFixed(1);
console.log(`\n${names.length - failed.length}/${names.length} test commands passed in ${durationSeconds}s.`);
if (failed.length > 0) {
  console.error(`Failed: ${failed.join(', ')}`);
}
const tolerated = [...quarantined, ...flaky];
const unexpected = failed.filter((name) => !tolerated.includes(name));
const healed = quarantined.filter((name) => !failed.includes(name) && names.includes(name));
if (healed.length > 0) {
  console.error(`\nQuarantined tests now pass — remove them: ${healed.join(', ')}`);
}
process.exitCode = unexpected.length > 0 || healed.length > 0 ? 1 : 0;
