// Where an import specifier in a project points: relative paths, the
// project's tsconfig aliases and the usual extension guessing, and the line a
// name is declared on, so the editor opens on it.

import { readSource } from '../lib/mainLimits';
import { toRecord } from '../../shared/core/record';
import { dictionary, list, text } from '../../shared/core/boundary';
import * as path from 'path';
import * as fs from 'fs';
import { readComponentSources, packageSourcePath } from '../lib/componentSources';
import { componentSourceRoot } from '../../shared/properties/componentSources';

// ---------------------------------------------------------------------------
// Source files behind a symbol
// ---------------------------------------------------------------------------

// tsconfig/jsconfig `paths` for the open project, as [prefix, [targets]] with
// the trailing /* stripped. Astro's own config is extended, not read: only the
// project's aliases matter here, and those live in its own file.
export function projectAliases(projectPath: string) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(projectPath, name);
    if (!fs.existsSync(file)) {
      continue;
    }
    try {
      // Config files allow comments and trailing commas; strip both rather
      // than pulling in a JSON5 parser for one field.
      const raw = readSource(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
      const input: unknown = JSON.parse(raw);
      const aliases = toRecord(toRecord(input)?.['compilerOptions'])?.['paths'];
      if (aliases) {
        return parseAliases(input);
      }
    } catch {
      // A malformed config just means no aliases.
    }
  }
  return [];
}

export const SOURCE_EXTENSIONS = ['', '.ts', '.js', '.mjs', '.mts', '.tsx', '.jsx', '.json', '.astro'];

export function firstExisting(base: string) {
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  for (const ext of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = path.join(base, 'index' + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

// The file an import specifier points at: relative paths, project aliases
// (`@/consts.ts`), and the usual extension guessing. Bare package names
// resolve to nothing — node_modules isn't the user's code to edit.
export function resolveImportPath(projectPath: string, fromFile: string, spec: string) {
  const specifier = String(spec || '');
  if (!specifier) {
    return undefined;
  }
  for (const source of readComponentSources(projectPath)) {
    if (specifier.startsWith(source.importPrefix)) {
      const relative = componentSourceRoot(source) + '/' + specifier.slice(source.importPrefix.length);
      packageSourcePath(projectPath, relative);
      return path.resolve(projectPath, relative);
    }
  }
  if (specifier.startsWith('.')) {
    return firstExisting(path.resolve(path.dirname(fromFile), specifier));
  }
  for (const [prefix, targets] of projectAliases(projectPath)) {
    if (!prefix || !specifier.startsWith(prefix)) {
      continue;
    }
    const rest = specifier.slice(prefix.length);
    for (const target of targets) {
      const found = firstExisting(path.resolve(projectPath, target, rest));
      if (found) {
        return found;
      }
    }
  }
  if (specifier.startsWith('/')) {
    return firstExisting(path.join(projectPath, specifier.slice(1)));
  }
  return undefined;
}

// 1-based line of `name`'s top-level declaration, so the editor can open on it.
export function declarationLine(text: string, name: string) {
  if (!name) {
    return 0;
  }
  const re = new RegExp(
    // `[ \t]*`, not `\s*`: with the m flag `\s` eats the newlines before the
    // declaration, and the match would start on a blank line above it.
    `^[ \\t]*(?:export\\s+)?(?:const|let|var|function|class)\\s+` + `${String(name).replace(/[^\w$]/g, '')}\\b`,
    'm',
  );
  const match = re.exec(text);
  if (!match) {
    return 0;
  }
  return text.slice(0, match.index).split('\n').length;
}

// The `paths` of a tsconfig, as [prefix, [targets]] with the trailing `*` gone.
export function parseAliases(input: unknown): readonly (readonly [string, readonly string[]])[] {
  const paths = toRecord(toRecord(toRecord(input)?.['compilerOptions'])?.['paths']);
  if (!paths) {
    return [];
  }
  return Object.entries(dictionary((value) => list(text)(typeof value === 'string' ? [value] : value))(paths)).map(
    ([key, values]) => [key.replace(/\*$/, ''), values.map((value) => value.replace(/\*$/, ''))] as const,
  );
}
