// Goal: no message key written in source can be missing from the English catalog, because the translator asserts on an unknown
// key at runtime ("is not an English message") and that would crash the screen that asked for it.
// Method: merge the key lists of every English namespace file, then scan the source files under src/, studio/src/, shared/ and
// electron/ for string literals shaped like a key of a known namespace (`props.loop.order.title`) and require each to exist.
// Literals that are a prefix of real keys (a dynamic key built by concatenation) are accepted; test files and the catalogs are skipped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const CATALOG_DIRECTORY = path.join(ROOT, 'shared/properties/i18n/messages/en');
const SOURCE_DIRECTORIES = ['src', 'studio/src', 'shared', 'electron'] as const;
const FILES_MAX = 20000;

function listSourceFiles(root: string): readonly string[] {
  const found: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const directory = pending.pop() ?? '';
    if (fs.existsSync(directory)) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'messages') {
            pending.push(full);
          }
        } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          found.push(full);
        }
        assert.ok(found.length < FILES_MAX, 'too many source files');
      }
    }
  }
  return found;
}

test('every statically written message key exists in the English catalog', () => {
  const keys = new Set<string>();
  const namespaces = new Set<string>();
  for (const name of fs.readdirSync(CATALOG_DIRECTORY)) {
    if (name.endsWith('.ts') && name !== 'index.ts') {
      namespaces.add(name.slice(0, -3));
      const text = fs.readFileSync(path.join(CATALOG_DIRECTORY, name), 'utf8');
      for (const match of text.matchAll(/^ {2}'([A-Za-z0-9.]+)':/gm)) {
        keys.add(match[1] ?? '');
      }
    }
  }
  assert.ok(keys.size > 100, 'the English catalog was not read');
  const files = SOURCE_DIRECTORIES.flatMap((directory) => listSourceFiles(path.join(ROOT, directory)));
  const keyList = [...keys];
  const missing: string[] = [];
  // A literal passed straight to a translating call, or any literal of three or more segments in a key namespace (key tables).
  const call = /\b(?:translate|translateRich|translateMain|translateRef|messageRef|described|issue|ENGLISH_TRANSLATE)\(\s*'([A-Za-z0-9.]+)'/g;
  const literal = /'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+){2,})'/g;
  for (const file of files) {
    // Comments hold examples of keys, not uses of them.
    const text = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const candidates = [...text.matchAll(call), ...text.matchAll(literal)];
    for (const match of candidates) {
      const key = match[1] ?? '';
      const namespace = key.slice(0, key.indexOf('.'));
      if (namespaces.has(namespace) && !keys.has(key) && !keyList.some((known) => known.startsWith(`${key}.`))) {
        missing.push(`${path.relative(ROOT, file)}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], `message keys missing from the English catalog:\n${missing.join('\n')}`);
});
