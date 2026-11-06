// Goal: a push cannot pass on compilation alone or run stale tests.
// Method: execute the real push wrapper against temporary compiler and gate
// programs, checking order, failure propagation, and isolation from hook environment variables.
// The ref cases feed lines in git's pre-push format, so a change to which field is read fails here.
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { POLICY_LIMITS } from '../../../scripts/policy/limits.mts';
import { readPushedRefs, runPushChecks } from '../../../scripts/policy/pushChecks.mts';

const OBJECT = 'a'.repeat(40);
const OBJECT_ZERO = '0'.repeat(40);
const TRACE_GATE = 'compile\nfull gate\n';
const TRACE_PREFLIGHT = 'compile\nfull gate\nlinux preflight\n';

function pushFixture(options: { readonly compilerStatus: number; readonly gateStatus: number; readonly preflightStatus?: number }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'stacki-push-checks-'));
  const compiler = path.join(root, 'node_modules/typescript/bin');
  const gate = path.join(root, 'dist/scripts/gate');
  const release = path.join(root, 'dist/scripts/release');
  mkdirSync(compiler, { recursive: true });
  mkdirSync(gate, { recursive: true });
  mkdirSync(release, { recursive: true });
  writeFileSync(
    path.join(compiler, 'tsc'),
    `require('node:fs').appendFileSync('trace', 'compile\\n');
process.exit(${options.compilerStatus});`,
  );
  writeFileSync(
    path.join(gate, 'runTests.js'),
    `const assert = require('node:assert/strict');
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
assert.equal(process.env.GIT_COMMON_DIR, undefined);
assert.equal(process.env.GIT_DIR, undefined);
assert.equal(process.env.GIT_WORK_TREE, undefined);
assert.equal(process.env.GIT_INDEX_FILE, undefined);
assert.deepEqual(process.argv.slice(2), []);
require('node:fs').appendFileSync('trace', 'full gate\\n');
process.exit(${options.gateStatus});`,
  );
  writeFileSync(
    path.join(release, 'linuxPreflight.js'),
    `const assert = require('node:assert/strict');
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
assert.deepEqual(process.argv.slice(2), []);
require('node:fs').appendFileSync('trace', 'linux preflight\\n');
process.exit(${options.preflightStatus ?? 0});`,
  );
  return root;
}

function pushTrace(pushedRefs: string): string {
  const root = pushFixture({ compilerStatus: 0, gateStatus: 0 });
  try {
    assert.equal(runPushChecks(root, pushedRefs), 0);
    return readFileSync(path.join(root, 'trace'), 'utf8');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readFromFile(content: string): string | undefined {
  const root = mkdtempSync(path.join(tmpdir(), 'stacki-pushed-refs-'));
  const file = path.join(root, 'refs');
  writeFileSync(file, content);
  const descriptor = openSync(file, 'r');
  try {
    return readPushedRefs(descriptor);
  } finally {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  }
}

test('push isolates the full gate from Electron mode and worktree hook variables', () => {
  const root = pushFixture({ compilerStatus: 0, gateStatus: 0 });
  const keys = ['ELECTRON_RUN_AS_NODE', 'GIT_COMMON_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
  const inherited = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) {
    process.env[key] = 'inherited-hook-value';
  }
  try {
    assert.equal(runPushChecks(root, ''), 0);
    assert.equal(readFileSync(path.join(root, 'trace'), 'utf8'), 'compile\nfull gate\n');
    for (const key of keys) {
      assert.equal(process.env[key], 'inherited-hook-value');
    }
  } finally {
    for (const [key, value] of inherited) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed compile blocks the gate instead of running stale output', () => {
  const root = pushFixture({ compilerStatus: 2, gateStatus: 0 });
  try {
    assert.equal(runPushChecks(root, ''), 1);
    assert.equal(readFileSync(path.join(root, 'trace'), 'utf8'), 'compile\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed regression suite blocks the push', () => {
  const root = pushFixture({ compilerStatus: 0, gateStatus: 1 });
  try {
    assert.equal(runPushChecks(root, ''), 1);
    assert.equal(readFileSync(path.join(root, 'trace'), 'utf8'), 'compile\nfull gate\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a release tag runs the Linux preflight after the gate', () => {
  assert.equal(pushTrace(`refs/tags/v1.0.15 ${OBJECT} refs/tags/v1.0.15 ${OBJECT_ZERO}\n`), TRACE_PREFLIGHT);
});

test('the remote ref decides, whatever the local ref is called', () => {
  assert.equal(pushTrace(`HEAD ${OBJECT} refs/tags/v1.0.15 ${OBJECT_ZERO}\n`), TRACE_PREFLIGHT);
  assert.equal(pushTrace(`HEAD^{/a fix} ${OBJECT} refs/tags/v1.0.15 ${OBJECT_ZERO}\n`), TRACE_PREFLIGHT);
  assert.equal(pushTrace(`refs/tags/v1.0.15 ${OBJECT} refs/heads/v1 ${OBJECT_ZERO}\n`), TRACE_GATE);
});

test('a release tag among other refs still runs the preflight', () => {
  const branch = `refs/heads/main ${OBJECT} refs/heads/main ${OBJECT}`;
  const tag = `refs/tags/v1.0.15 ${OBJECT} refs/tags/v1.0.15 ${OBJECT_ZERO}`;
  assert.equal(pushTrace(`${branch}\n${tag}\n`), TRACE_PREFLIGHT);
  assert.equal(pushTrace(`${tag}\n${branch}\n`), TRACE_PREFLIGHT);
});

test('a branch push runs the gate alone', () => {
  assert.equal(pushTrace(`refs/heads/main ${OBJECT} refs/heads/main ${OBJECT}\n`), TRACE_GATE);
});

test('deleting a release tag runs the gate alone', () => {
  assert.equal(pushTrace(`(delete) ${OBJECT_ZERO} refs/tags/v1.0.15 ${OBJECT}\n`), TRACE_GATE);
});

test('a tag that is not a version runs the gate alone', () => {
  assert.equal(pushTrace(`refs/tags/docs-1 ${OBJECT} refs/tags/docs-1 ${OBJECT_ZERO}\n`), TRACE_GATE);
  assert.equal(pushTrace(`refs/tags/vnext ${OBJECT} refs/tags/vnext ${OBJECT_ZERO}\n`), TRACE_GATE);
});

test('a failed preflight blocks the tag', () => {
  const root = pushFixture({ compilerStatus: 0, gateStatus: 0, preflightStatus: 1 });
  try {
    assert.equal(runPushChecks(root, `refs/tags/v1.0.15 ${OBJECT} refs/tags/v1.0.15 ${OBJECT_ZERO}\n`), 1);
    assert.equal(readFileSync(path.join(root, 'trace'), 'utf8'), TRACE_PREFLIGHT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed gate never reaches the preflight', () => {
  const root = pushFixture({ compilerStatus: 0, gateStatus: 1 });
  try {
    assert.equal(runPushChecks(root, `refs/tags/v1.0.15 ${OBJECT} refs/tags/v1.0.15 ${OBJECT_ZERO}\n`), 1);
    assert.equal(readFileSync(path.join(root, 'trace'), 'utf8'), TRACE_GATE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reading refs returns everything up to the bound and nothing past it', () => {
  assert.equal(readFromFile(''), '');
  assert.equal(readFromFile('refs/heads/main a refs/heads/main b\n'), 'refs/heads/main a refs/heads/main b\n');
  assert.equal(readFromFile('x'.repeat(POLICY_LIMITS.hookPayloadBytesMax))?.length, POLICY_LIMITS.hookPayloadBytesMax);
  assert.equal(readFromFile('x'.repeat(POLICY_LIMITS.hookPayloadBytesMax + 1)), undefined);
});
