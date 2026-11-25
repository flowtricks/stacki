// Different npm versions disagree about absent optional native peers. Inspect every platform's
// dependency edges so a warm host installation cannot conceal an incomplete lockfile.
import assert = require('node:assert/strict');
import path = require('node:path');

interface LockEntry {
  readonly location: string;
  readonly dependencies: readonly string[];
  readonly peers: readonly string[];
}

const PACKAGES_MAX = 10000;
const DEPENDENCIES_MAX = 1000;
const PATH_DEPTH_MAX = 64;

/** Missing edges, including foreign-platform optional packages and required peers. */
export function lockfileMissingDependencies(input: unknown): readonly string[] {
  const lockfile = lockRecord(input);
  assert.equal(lockfile['lockfileVersion'], 3, 'Expected npm lockfile version 3');
  const packages = lockRecord(lockfile['packages']);
  const locations = Object.keys(packages);
  assert.ok(locations.length <= PACKAGES_MAX, 'Lockfile package count exceeds limit');
  assert.ok(Object.hasOwn(packages, ''), 'Lockfile must contain its root package');
  const entries = locations.map((location) => parseLockEntry(location, packages[location]));
  const known = new Set(locations);
  const missing: string[] = [];
  for (const entry of entries) {
    for (const name of entry.dependencies) {
      if (!lockfileResolves(known, entry.location, name)) {
        missing.push(`${entry.location || '<root>'} -> ${name}`);
      }
    }
    // A peer belongs beside its consumer, never in that consumer's node_modules.
    const parent = entry.location.slice(0, entry.location.lastIndexOf('node_modules/'));
    for (const name of entry.peers) {
      if (!lockfileResolves(known, parent, name)) {
        missing.push(`${entry.location || '<root>'} -> peer ${name}`);
      }
    }
  }
  assert.ok(missing.length <= PACKAGES_MAX * DEPENDENCIES_MAX * 2);
  return missing;
}

function parseLockEntry(location: string, input: unknown): LockEntry {
  assert.ok(location.length <= 4096, 'Lockfile path exceeds limit');
  assert.ok(location.split('/').length <= PATH_DEPTH_MAX, 'Lockfile path depth exceeds limit');
  const entry = lockRecord(input);
  const dependencies = [
    ...new Set([
      ...lockDependencyNames(entry['dependencies'] ?? {}),
      ...lockDependencyNames(entry['optionalDependencies'] ?? {}),
    ]),
  ];
  const peers = lockDependencyNames(entry['peerDependencies'] ?? {});
  const metadata = lockRecord(entry['peerDependenciesMeta'] ?? {});
  const names = [...dependencies, ...peers];
  assert.ok(names.length <= DEPENDENCIES_MAX, 'Lockfile dependency count exceeds limit');
  for (const name of names) {
    assert.match(name, /^(?:@[^/\\.][^/\\]*\/)?[^/\\.][^/\\]*$/);
    assert.ok(name.length <= 214, 'Lockfile dependency name exceeds limit');
  }
  return {
    location,
    dependencies,
    peers: peers.filter((name) => {
      const optional = lockRecord(metadata[name] ?? {})['optional'];
      if (optional === undefined) {
        return true;
      }
      assert.equal(typeof optional, 'boolean', 'Peer optional metadata must be boolean');
      return optional === false;
    }),
  };
}

function lockRecord(input: unknown): Readonly<Record<string, unknown>> {
  assert.ok(input, 'Expected lockfile object');
  assert.equal(typeof input, 'object', 'Expected lockfile object');
  assert.equal(Array.isArray(input), false, 'Expected lockfile object, not array');
  const entries: [string, unknown][] = Object.entries(input);
  assert.ok(entries.length <= PACKAGES_MAX, 'Lockfile object exceeds limit');
  return Object.fromEntries(entries);
}

function lockDependencyNames(input: unknown): readonly string[] {
  const entries = Object.entries(lockRecord(input));
  assert.ok(entries.length <= DEPENDENCIES_MAX, 'Lockfile dependency count exceeds limit');
  return entries.map(([name, version]) => {
    assert.ok(typeof version === 'string', 'Lockfile dependency version must be text');
    assert.ok(version.length <= 4096, 'Lockfile dependency version exceeds limit');
    return name;
  });
}

function lockfileResolves(known: ReadonlySet<string>, location: string, name: string): boolean {
  // Lockfile paths use POSIX separators even when this check runs on Windows.
  let directory = location;
  for (let depth = 0; depth <= PATH_DEPTH_MAX; depth += 1) {
    if (path.posix.basename(directory) !== 'node_modules') {
      if (known.has(path.posix.join(directory, 'node_modules', name))) {
        return true;
      }
    }
    if (directory === '' || directory === '.') {
      return false;
    }
    const parent = path.posix.dirname(directory);
    assert.notEqual(parent, directory, 'Lockfile dependency lookup must make progress');
    directory = parent;
  }
  throw new Error('Lockfile dependency lookup exceeds depth limit');
}
