// Adding a collection to a project's Astro content config: a `defineCollection`
// with a glob loader over its own folder under src/content, and a starter
// schema of one title, added to the `collections` export. The config is the
// project's own TypeScript, so it is patched as text, in place: the
// declaration goes just above the export, the name into the export's object,
// and only the imports it lacks are added at the top. A config whose export
// cannot be found is refused rather than guessed at.

import fs from 'node:fs';
import path from 'node:path';

import { assert } from '../../shared/core/assert';
import { CODE_INDENT_UNIT, indentUnitOf, withIndentUnit } from '../../shared/core/indent';
import { err, type Result } from '../../shared/core/result';
import { DescribedError } from '../../shared/properties/describedError';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { createProjectText, writeProjectText } from '../documents/documentWrites';
import { cmsSourcePath } from '../lib/contentPaths';
import { configPathOf } from './contentConfig';

/** Where a project with no content config gets one (Astro 5 and later). */
export const CONTENT_CONFIG_PATH = 'src/content.config.ts';

const COLLECTIONS_EXPORT = /export\s+const\s+collections\s*(?::[^=]+)?=\s*\{/;
// A config is a page of code; past this it is not one Stacki should patch.
const CONFIG_CHARS_MAX = 200_000;

export interface CollectionPatch {
  readonly text: string;
  /** The folder its entries live in, relative to the project. */
  readonly folder: string;
}

/**
 * The config with collection `name` added, or why it cannot be. `source` is
 * the config's text, or undefined when the project has none yet.
 */
export function addCollectionToConfig(source: string | undefined, name: string): Result<CollectionPatch, Described> {
  assert(/^[a-z][A-Za-z0-9]*$/.test(name), 'A collection name is an identifier');
  const folder = `src/content/${kebab(name)}`;
  if (source === undefined) {
    return { ok: true, value: { text: newConfig(name, folder), folder } };
  }
  if (source.length > CONFIG_CHARS_MAX) {
    return err(described('cmsBackend.config.tooLarge'));
  }
  const opening = COLLECTIONS_EXPORT.exec(source);
  if (opening === null) {
    return err(described('cmsBackend.config.noCollections'));
  }
  const open = opening.index + opening[0].length - 1;
  const close = closingBrace(source, open);
  if (close === undefined) {
    return err(described('cmsBackend.config.collectionsNotClosed'));
  }
  const listed = source.slice(open + 1, close);
  if (new RegExp(`(^|[\\s,{])['"]?${name}['"]?\\s*[:,}]|(^|[\\s,])${name}\\s*$`).test(listed)) {
    return err(described('cmsBackend.config.collectionExists', { name }));
  }
  const constant = freeIdentifier(source, name);
  if (constant === undefined) {
    return err(described('cmsBackend.config.nameUsed', { name }));
  }
  const entry = constant === name ? name : `${name}: ${constant}`;
  const patched =
    source.slice(0, opening.index) +
    withIndentUnit(declaration(constant, folder), indentUnitOf(source)) +
    '\n\n' +
    source.slice(opening.index, open + 1) +
    withEntry(listed, entry) +
    source.slice(close);
  const text = withImports(patched);
  assert(text.length > source.length, 'Adding a collection only adds text');
  return { ok: true, value: { text, folder } };
}

/**
 * Adds collection `name` to the project's content config, creating the config
 * when there is none, and makes its folder. Throws, with the reason, when the
 * config cannot be patched.
 */
export function createAstroCollection(projectPath: string, name: string): CollectionPatch {
  const found = configPathOf(projectPath);
  const rel = found?.rel ?? CONTENT_CONFIG_PATH;
  const file = cmsSourcePath(projectPath, rel);
  const before = found === undefined ? undefined : fs.readFileSync(file, 'utf8');
  const patch = addCollectionToConfig(before, name);
  if (!patch.ok) {
    throw new DescribedError(patch.error);
  }
  // The folder first: it makes src/ too, where a project with no config may have none.
  fs.mkdirSync(cmsSourcePath(projectPath, patch.value.folder), { recursive: true });
  if (before === undefined) {
    createProjectText(file, patch.value.text);
  } else {
    writeProjectText(file, patch.value.text, before);
  }
  assert(fs.existsSync(file), 'The content config exists after a collection is added');
  assert(path.isAbsolute(file), 'The config is written by its full path');
  return patch.value;
}

function newConfig(name: string, folder: string): string {
  return [
    "import { defineCollection } from 'astro:content';",
    "import { glob } from 'astro/loaders';",
    "import { z } from 'astro/zod';",
    '',
    declaration(name, folder),
    '',
    `export const collections = { ${name} };`,
    '',
  ].join('\n');
}

function declaration(constant: string, folder: string): string {
  return [
    `const ${constant} = defineCollection({`,
    `\tloader: glob({ base: './${folder}', pattern: '**/*.{md,mdx}' }),`,
    '\tschema: z.object({',
    '\t\ttitle: z.string(),',
    '\t}),',
    '});',
  ].join('\n');
}

// The object's body with one more name: on its own line when the object spans
// lines, after the last name when it is written on one.
function withEntry(listed: string, entry: string): string {
  const body = listed.trimEnd();
  if (body.trim().length === 0) {
    return ` ${entry} `;
  }
  const comma = body.endsWith(',') ? '' : ',';
  if (listed.includes('\n')) {
    const indent = /\n([ \t]*)\S/.exec(listed)?.[1] ?? CODE_INDENT_UNIT;
    return `${body}${comma}\n${indent}${entry},\n`;
  }
  return `${body}${comma} ${entry} `;
}

// The imports a new declaration uses that the config does not have yet.
function withImports(source: string): string {
  const missing = [
    importNamed(source, 'defineCollection') ? '' : "import { defineCollection } from 'astro:content';",
    importNamed(source, 'glob') ? '' : "import { glob } from 'astro/loaders';",
    importNamed(source, 'z') ? '' : "import { z } from 'astro/zod';",
  ].filter((line) => line.length > 0);
  return missing.length === 0 ? source : `${missing.join('\n')}\n${source}`;
}

function importNamed(source: string, name: string): boolean {
  return new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(source);
}

// The name itself, or `<name>Collection` when the config already uses the name.
function freeIdentifier(source: string, name: string): string | undefined {
  for (const candidate of [name, `${name}Collection`]) {
    if (!new RegExp(`\\b${candidate}\\b`).test(source)) {
      return candidate;
    }
  }
  return undefined;
}

// The brace that closes the one at `open`, counting nested braces and skipping strings.
function closingBrace(source: string, open: number): number | undefined {
  assert(source.charAt(open) === '{', 'The scan starts at an opening brace');
  let depth = 0;
  let quote: string | undefined;
  for (let at = open; at < source.length; at += 1) {
    const character = source.charAt(at);
    if (quote !== undefined) {
      if (character === '\\') {
        at += 1;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return at;
      }
    }
  }
  return undefined;
}

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
