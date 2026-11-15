// Goal: the pre-push marker is proof only for the exact tree that passed the full gate with this
// exact gate version: equal trees hash equal, a one-byte change (tracked or untracked) hashes
// different, and a missing, corrupt, foreign or older-version marker is a miss, so the hook runs
// the gate. The folder stays bounded.
// Methodology: a scratch git repository in the temp folder (never this checkout); the working
// tree hash is computed, files are edited, and markers are written and read back with
// deliberate defects. The hash uses a throwaway index, so the test also checks the real index is
// untouched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commitTreeHash, gateVersion, MARKER_LIMITS, markerVerdict, parseMarker, workingTreeHash, writeMarker } from '#dist/scripts/gate/gateMarker.js';

function scratchRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'stacki-gate-marker-'));
  // The hook's git variables would point these commands at another repository.
  const environment = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) {
    delete environment[key];
  }
  const git = (...argumentsList: string[]): string => execFileSync('git', argumentsList, { cwd: root, encoding: 'utf8', env: environment }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'a.txt'), 'one\n');
  writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'test: start');
  return root;
}

test('the working tree hash equals the commit tree for a clean tree and changes with any byte', () => {
  const root = scratchRepository();
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const clean = workingTreeHash(root);
    assert.ok(clean !== undefined);
    assert.equal(clean, commitTreeHash(root, head));
    assert.equal(workingTreeHash(root), clean, 'stable for an equal tree');
    writeFileSync(path.join(root, 'a.txt'), 'one!\n');
    const edited = workingTreeHash(root);
    assert.notEqual(edited, clean);
    writeFileSync(path.join(root, 'a.txt'), 'one\n');
    assert.equal(workingTreeHash(root), clean);
    writeFileSync(path.join(root, 'untracked.ts'), 'x');
    assert.notEqual(workingTreeHash(root), clean, 'an untracked file the gate would read changes the hash');
    rmSync(path.join(root, 'untracked.ts'));
    writeFileSync(path.join(root, 'ignored-file'), '');
    rmSync(path.join(root, 'ignored-file'));
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    assert.equal(status, '', 'the real index is untouched');
    assert.equal(commitTreeHash(root, 'not-a-sha'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a marker is valid only for its tree and this gate version; anything else misses', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'stacki-gate-markers-'));
  try {
    const tree = 'd'.repeat(40);
    assert.equal(markerVerdict(folder, tree, gateVersion()).kind, 'miss');
    writeMarker(folder, { treeHash: tree, gateVersion: gateVersion(), finishedAt: '2026-11-15T00:00:00.000Z' });
    assert.equal(markerVerdict(folder, tree, gateVersion()).kind, 'valid');
    assert.equal(markerVerdict(folder, 'e'.repeat(40), gateVersion()).kind, 'miss', 'another tree');
    assert.equal(markerVerdict(folder, tree, `${gateVersion()} next`).kind, 'miss', 'another gate version');
    writeFileSync(path.join(folder, `${tree}.json`), '{ not json');
    assert.equal(markerVerdict(folder, tree, gateVersion()).kind, 'miss', 'corrupt');
    writeFileSync(path.join(folder, `${tree}.json`), JSON.stringify({ treeHash: 'f'.repeat(40), gateVersion: gateVersion(), finishedAt: 'x' }));
    assert.equal(markerVerdict(folder, tree, gateVersion()).kind, 'miss', 'names another tree');
    assert.equal(parseMarker('x'.repeat(MARKER_LIMITS.markerBytesMax + 1)), undefined);
    assert.equal(parseMarker(JSON.stringify({ treeHash: 'short', gateVersion: 'v', finishedAt: 'x' })), undefined);
    assert.match(gateVersion(), /^stacki-gate-marker\/1 node-v\d+\.\d+\.\d+ \w+-\w+$/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the marker folder keeps only the newest markers', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'stacki-gate-markers-'));
  try {
    for (let index = 0; index < MARKER_LIMITS.markersMax + 5; index += 1) {
      writeMarker(folder, { treeHash: index.toString(16).padStart(40, '0'), gateVersion: gateVersion(), finishedAt: 'x' });
    }
    assert.ok(readdirSync(folder).length <= MARKER_LIMITS.markersMax);
    const newest = (MARKER_LIMITS.markersMax + 4).toString(16).padStart(40, '0');
    assert.ok(readFileSync(path.join(folder, `${newest}.json`), 'utf8').includes(newest));
    assert.throws(() => writeMarker(folder, { treeHash: 'bad', gateVersion: 'v', finishedAt: 'x' }), /^Error: writeMarker: a marker names a tree hash$/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
