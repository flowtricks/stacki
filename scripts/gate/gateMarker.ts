// The proof that a tree already passed the full gate, so the pre-push hook need not run the same
// gate on the same tree again.
//
// After a full, unsharded `npm test` passes, runTests writes `.git/stacki-gate/<tree>.json`, where
// <tree> is the git tree hash of the working tree the gate built (tracked files plus untracked
// files git does not ignore, exactly what the gate read). The hash is taken before the gate starts
// and again after it ends, and the marker is written only when both agree: a file edited during
// the run leaves no marker.
//
// The pre-push hook (scripts/policy/pushChecks.mts) asks `node dist/scripts/gate/gateMarker.js
// check <commit>`: the commit's tree must have a marker whose gate version string equals this
// one. Why it is sound: the gate's verdict is a function of the tree (sources, tests, configs,
// lockfiles and the gate's own code are all in it) and the toolchain (the Node version and the
// platform, which the version string holds). Same inputs, same verdict. A different tree, a
// different Node, another platform or a marker format change all miss, and a miss runs the gate.
// A missing, unreadable or malformed marker also runs the gate: it fails closed. Markers live in
// .git/, so they are never pushed and never cross machines.

import childProcess = require('node:child_process');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');

export const MARKER_LIMITS = {
  /** Markers kept; the oldest beyond this are removed when a new one is written. */
  markersMax: 32,
  markerBytesMax: 4_096,
  gitTimeoutMs: 120_000,
} as const satisfies Record<string, number>;

// Raise the number when the marker's meaning changes; every older marker then misses.
const MARKER_FORMAT = 'stacki-gate-marker/1';

/** What a marker must match: the format, the Node version and the platform the gate ran on. */
export function gateVersion(): string {
  return `${MARKER_FORMAT} node-${process.version} ${process.platform}-${process.arch}`;
}

export interface GateMarker {
  readonly treeHash: string;
  readonly gateVersion: string;
  readonly finishedAt: string;
}

const TREE_HASH = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

function git(root: string, argumentsList: readonly string[], environment: NodeJS.ProcessEnv): string | undefined {
  const result = childProcess.spawnSync('git', [...argumentsList], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    timeout: MARKER_LIMITS.gitTimeoutMs,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

/** The folder markers live in, inside the repository's common git directory. */
export function markerFolder(root: string): string | undefined {
  const common = git(root, ['rev-parse', '--git-common-dir'], process.env);
  return common === undefined ? undefined : path.join(path.resolve(root, common), 'stacki-gate');
}

/**
 * The tree hash of the working tree as the gate sees it: a throwaway index built from HEAD plus
 * every tracked and untracked, non-ignored file. The real index is never touched.
 */
export function workingTreeHash(root: string): string | undefined {
  const index = path.join(os.tmpdir(), `stacki-gate-index-${process.pid}-${Date.now()}`);
  const environment = { ...process.env, GIT_INDEX_FILE: index };
  try {
    if (git(root, ['read-tree', 'HEAD'], environment) === undefined) {
      return undefined;
    }
    if (git(root, ['add', '--all', '--', '.'], environment) === undefined) {
      return undefined;
    }
    const tree = git(root, ['write-tree'], environment);
    return tree !== undefined && TREE_HASH.test(tree) ? tree : undefined;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** The tree a commit points at. */
export function commitTreeHash(root: string, commit: string): string | undefined {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit)) {
    return undefined;
  }
  const tree = git(root, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`], process.env);
  return tree !== undefined && TREE_HASH.test(tree) ? tree : undefined;
}

/** Parses a marker file's text; anything unexpected is no marker. */
export function parseMarker(text: string): GateMarker | undefined {
  if (text.length > MARKER_LIMITS.markerBytesMax) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = new Map<string, unknown>(Object.entries(parsed));
  const treeHash = record.get('treeHash');
  const version = record.get('gateVersion');
  const finishedAt = record.get('finishedAt');
  if (typeof treeHash !== 'string' || !TREE_HASH.test(treeHash)) {
    return undefined;
  }
  if (typeof version !== 'string' || typeof finishedAt !== 'string') {
    return undefined;
  }
  return { treeHash, gateVersion: version, finishedAt };
}

export type MarkerVerdict = { readonly kind: 'valid'; readonly marker: GateMarker } | { readonly kind: 'miss'; readonly reason: string };

/** Whether a marker for this tree exists and was written by this exact gate version. */
export function markerVerdict(folder: string, treeHash: string, version: string): MarkerVerdict {
  if (!TREE_HASH.test(treeHash)) {
    return { kind: 'miss', reason: 'no tree hash' };
  }
  let text: string;
  try {
    text = fs.readFileSync(path.join(folder, `${treeHash}.json`), 'utf8');
  } catch {
    return { kind: 'miss', reason: `no marker for tree ${treeHash.slice(0, 12)}` };
  }
  const marker = parseMarker(text);
  if (marker === undefined) {
    return { kind: 'miss', reason: 'the marker is malformed' };
  }
  if (marker.treeHash !== treeHash) {
    return { kind: 'miss', reason: 'the marker names another tree' };
  }
  if (marker.gateVersion !== version) {
    return { kind: 'miss', reason: `the marker is from ${marker.gateVersion}, this gate is ${version}` };
  }
  return { kind: 'valid', marker };
}

/** Writes the marker, then keeps only the newest MARKER_LIMITS.markersMax. */
export function writeMarker(folder: string, marker: GateMarker): void {
  if (!TREE_HASH.test(marker.treeHash)) {
    throw new Error('writeMarker: a marker names a tree hash');
  }
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${marker.treeHash}.json`), `${JSON.stringify(marker)}\n`);
  const markers = fs
    .readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, modifiedMs: fs.statSync(path.join(folder, name)).mtimeMs }))
    .sort((left, right) => right.modifiedMs - left.modifiedMs);
  for (const stale of markers.slice(MARKER_LIMITS.markersMax)) {
    fs.rmSync(path.join(folder, stale.name), { force: true });
  }
  const written = markerVerdict(folder, marker.treeHash, marker.gateVersion);
  if (written.kind !== 'valid') {
    throw new Error(`writeMarker: the marker does not read back (${written.reason})`);
  }
}

/** `check <commit>`: exit 0 when the commit's tree has a valid marker, 1 otherwise. */
function main(argumentsList: readonly string[]): number {
  const [command, commit] = argumentsList;
  if (command !== 'check' || commit === undefined) {
    console.error('usage: gateMarker.js check <commit>');
    return 2;
  }
  const root = process.cwd();
  const folder = markerFolder(root);
  const tree = commitTreeHash(root, commit);
  if (folder === undefined || tree === undefined) {
    console.log(`miss: cannot read the tree of ${commit.slice(0, 12)}`);
    return 1;
  }
  const verdict = markerVerdict(folder, tree, gateVersion());
  if (verdict.kind === 'valid') {
    console.log(`valid: tree ${tree.slice(0, 12)} passed the full gate at ${verdict.marker.finishedAt}`);
    return 0;
  }
  console.log(`miss: ${verdict.reason}`);
  return 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
