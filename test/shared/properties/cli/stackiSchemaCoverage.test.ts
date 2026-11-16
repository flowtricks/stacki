// Goal: every key a `.stacki` parser reads, and every `.stacki` path the app writes, is reachable through the Stacki CLI
// (the generic `config` layer by way of the key registry, or a domain command), or is listed as not settable with a reason.
// Adding a setting to the app without CLI coverage must break this suite. That is the "everything that can be set" guarantee.
// Method: (1) the registry has one entry per project metadata kind and each entry's empty document passes the app's own
// parser and the registry's own check; (2) the source of each parser the entry names is scanned for the keys it reads
// (`value['key']`, `.get('key')`, `for (const key of ['a', 'b'])`) and each must be a registry key or a documented exception;
// (3) every `.stacki/...` path literal in the app's source (Desktop, Studio, shared, scaffolder) is a registry file or sits under an
// unsettable entry; (4) a registry key naming a command names a command that exists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { METADATA_FILES } from '#dist/shared/properties/projectMetadata.js';
import { STACKI_FILES, STACKI_UNSETTABLE, refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';
import { COMMANDS } from '#dist/shared/properties/cli/stackiCommands.js';

const TEST_LIMITS = { depthMax: 12 } as const;

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && !!value && !Array.isArray(value), 'expected an object');
  return Object.fromEntries(Object.entries(value ?? {}));
}

// Collects every key and every command named anywhere under a schema, variants and list items included.
function keysOf(type: unknown, into: Set<string>, commands: Set<string>, depth: number): void {
  assert.ok(depth <= TEST_LIMITS.depthMax, 'a registry nests at most 12 levels');
  const node = asRecord(type);
  const groups: unknown[] = [];
  if (node['fields'] !== undefined) {
    groups.push(node['fields']);
  }
  for (const variant of Object.values(asRecord(node['variants'] ?? {}))) {
    groups.push(variant);
  }
  if (typeof node['tag'] === 'string') {
    into.add(node['tag']);
  }
  for (const group of groups) {
    for (const [key, entry] of Object.entries(asRecord(group))) {
      const field = asRecord(entry);
      into.add(key);
      const named = field['commands'];
      for (const command of Array.isArray(named) ? named : []) {
        commands.add(String(command));
      }
      keysOf(field['type'], into, commands, depth + 1);
    }
  }
  for (const inner of [node['item'], node['kind'] === 'map' ? node['value'] : undefined]) {
    if (inner !== undefined) {
      keysOf(inner, into, commands, depth + 1);
    }
  }
}

function readKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const match of source.matchAll(/\[\s*'([A-Za-z_][\w-]*)'\s*\]/g)) {
    keys.add(match[1] ?? '');
  }
  for (const match of source.matchAll(/\.(?:get|has)\(\s*'([A-Za-z_][\w-]*)'\s*\)/g)) {
    keys.add(match[1] ?? '');
  }
  for (const match of source.matchAll(/for \(const \w+ of \[([^\]]+)\]\)/g)) {
    for (const word of (match[1] ?? '').matchAll(/'([A-Za-z_][\w-]*)'/g)) {
      keys.add(word[1] ?? '');
    }
  }
  return keys;
}

test('each project metadata kind has exactly one registry entry at its own path', () => {
  const kinds = Object.keys(METADATA_FILES).sort();
  const covered = STACKI_FILES.flatMap((file) => (file.metadataKind === undefined ? [] : [file.metadataKind])).sort();
  assert.deepEqual(covered, kinds);
  for (const file of STACKI_FILES) {
    if (file.metadataKind !== undefined) {
      assert.equal(file.file, asRecord(METADATA_FILES)[file.metadataKind], `${file.id} path`);
    }
    assert.ok(file.file.startsWith('.stacki/'), `${file.id} lives under .stacki`);
  }
  assert.equal(new Set(STACKI_FILES.map((file) => file.id)).size, STACKI_FILES.length, 'ids are unique');
  assert.equal(new Set(STACKI_FILES.map((file) => file.file)).size, STACKI_FILES.length, 'paths are unique');
});

test('each file registry describes a document the app accepts, and its own check agrees', () => {
  for (const file of STACKI_FILES) {
    assert.ok(Object.keys(file.fields).length > 0, `${file.id} lists keys`);
    assert.equal(refusalOfSource(file, serializeDocument(file, { ...file.empty })), undefined, `${file.id}: the empty document passes the app's parser`);
    assert.equal(checkValue({ kind: 'object', fields: file.fields }, file.empty, file.id), undefined, `${file.id}: the empty document passes the registry`);
    const keys = new Set<string>();
    const commands = new Set<string>();
    keysOf({ kind: 'object', fields: file.fields }, keys, commands, 0);
    for (const [key, entry] of Object.entries(file.fields)) {
      assert.ok(entry.description.length > 0, `${file.id}.${key} says what it is`);
    }
    const known = new Set(COMMANDS.map((spec) => spec.words.join(' ')));
    for (const command of [...commands, ...file.commands]) {
      assert.ok(known.has(command) || file.appId !== undefined, `${file.id} names the command "${command}", which is not in the command table`);
    }
  }
});

test('every key a parser reads is a registry key or a documented exception', () => {
  const missing: string[] = [];
  for (const file of STACKI_FILES) {
    const known = new Set<string>();
    keysOf({ kind: 'object', fields: file.fields }, known, new Set<string>(), 0);
    for (const source of file.parserSources) {
      assert.ok(fs.existsSync(source), `${file.id}: parser source ${source} exists`);
      for (const key of readKeys(fs.readFileSync(source, 'utf8'))) {
        if (!known.has(key) && file.parserKeyExceptions?.[key] === undefined) {
          missing.push(`${file.id}: ${source} reads "${key}"`);
        }
      }
    }
    for (const [key, reason] of Object.entries(file.parserKeyExceptions ?? {})) {
      assert.ok(reason.length > 10, `${file.id}: the exception for ${key} says why`);
    }
  }
  assert.deepEqual(missing, [], 'add these keys to the registry (shared/properties/cli/files/) or list them as exceptions with a reason');
});

test('every .stacki path the app names is a registry file or listed as not settable', () => {
  const roots = ['electron', 'shared', 'src', 'studio/src', 'studio/scripts', 'packages', 'scripts/createStacki'];
  const skipped = new Set(['i18n', 'node_modules', 'generated', 'vendor']);
  const found = new Map<string, string>();
  const walk = (directory: string, depth: number): void => {
    assert.ok(depth < TEST_LIMITS.depthMax, 'the source tree is shallower than 12 levels');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !skipped.has(entry.name) && entry.name !== 'cli') {
        walk(path.join(directory, entry.name), depth + 1);
      } else if (entry.isFile() && /\.(ts|tsx|mts)$/.test(entry.name)) {
        const text = fs.readFileSync(path.join(directory, entry.name), 'utf8');
        for (const match of text.matchAll(/'(\.stacki\/[A-Za-z0-9._-]+\/?)[^']*'/g)) {
          found.set(match[1] ?? '', path.join(directory, entry.name));
        }
      }
    }
  };
  for (const root of roots) {
    if (fs.existsSync(root)) {
      walk(root, 0);
    }
  }
  const settable = new Set(STACKI_FILES.map((file) => file.file));
  const unlisted = [...found].filter(
    ([name]) => !settable.has(name) && !STACKI_UNSETTABLE.some((entry) => name.startsWith(entry.path) || entry.path.startsWith(name)),
  );
  assert.deepEqual(
    unlisted.map(([name, where]) => `${name} (${where})`),
    [],
    'add the path to a registry file, or to STACKI_UNSETTABLE with the reason it is not settable',
  );
  for (const entry of STACKI_UNSETTABLE) {
    assert.ok(entry.reason.length > 20, `${entry.path} says why it is not settable`);
  }
});
