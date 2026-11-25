// An imported asset, seen from a data file.
//
//   const SCREENS = [
//     { label: "Daily devotionals", image: dailyDevotionals },
//   ];
//
// `dailyDevotionals` is a name, and the file above it says what the name is:
//
//   import dailyDevotionals from '@/assets/images/app-daily-devotionals.webp';
//
// Read on its own the name says nothing — a word in a code field, which is
// what the CMS showed for a row that is a picture. Read together with the
// import it IS the picture, and swapping it means binding the name to another
// file, or writing a new name and importing that one.
//
// This file holds that reading and that writing, over the file's own text:
// which names are imports, what a new import should be called, where it goes,
// and which specifier to write it with. Nothing here evaluates anything — an
// import is a line, and a line is something a text editor can be sure of.

// `import name from '…'` — the only form a picker can repoint, since the name
// stands for the file itself. `import { a } from` and `import * as ns from`
// name something inside a module, which is not a file to swap.
// The pattern is assembled from three literal pieces only to fit the line width; each piece is a
// complete regular expression on its own, and the joined source is the original pattern.
const DEFAULT_IMPORT = new RegExp(
  /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s*/.source + /(?:,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*))?/.source + /\s*from\s*(['"])([^'"]+)\2\s*;?[ \t]*$/.source,
  'gm',
);

interface DefaultImport {
  readonly name: string;
  readonly spec: string;
  readonly start: number;
  readonly end: number;
}

/** Every `import name from 'spec'` in the source, in the order written. */
function defaultImports(source: string): DefaultImport[] {
  const out: DefaultImport[] = [];
  const re = new RegExp(DEFAULT_IMPORT.source, 'gm');
  let match;
  while ((match = re.exec(String(source || ''))) !== null) {
    const name = match[1];
    const spec = match[3];
    if (name === undefined || spec === undefined) {
      continue;
    }
    out.push({ name, spec, start: match.index, end: match.index + match[0].length });
  }
  return out;
}

/** The name an import binds, or undefined when nothing imports it. */
function importedAs(source: string, name: string): DefaultImport | undefined {
  return defaultImports(source).find((i) => i.name === name);
}

// Where a new import goes: after the last one, which is where a person adding
// one would put it. A file with no imports yet gets it at the very top —
// before the constant it is for, which is the only ordering that compiles.
function importInsertAt(source: string): number {
  const all = defaultImports(source);
  const anyImport = /^[ \t]*import\b[^\n]*$/gm;
  let end: number | undefined = undefined;
  let match;
  while ((match = anyImport.exec(String(source || ''))) !== null) {
    end = match.index + match[0].length;
  }
  if (all.length) {
    const last = all[all.length - 1];
    if (last !== undefined) {
      end = Math.max(end ?? 0, last.end);
    }
  }
  return end ?? 0;
}

/** The source with `import name from 'spec';` written into it. */
function addImport(source: string, name: string, spec: string): string {
  const text = String(source || '');
  const line = `import ${name} from '${spec}';`;
  const at = importInsertAt(text);
  if (at === 0) {
    return `${line}\n${text.startsWith('\n') ? '' : '\n'}${text}`;
  }
  return `${text.slice(0, at)}\n${line}${text.slice(at)}`;
}

// What to call the import. The file's own name for the image, in the shape a
// JavaScript name has to be — `app-daily-devotionals.webp` is
// `appDailyDevotionals` — and never one the file is already using for
// something else.
function importName(fileRel: string, taken: readonly string[] = []): string {
  const base =
    String(fileRel || '')
      .split('/')
      .pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  const camel = stem
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part : (part[0] ?? '').toUpperCase() + part.slice(1)))
    .join('');
  let candidate = /^[A-Za-z_$]/.test(camel) ? camel : `_${camel}`;
  if (!candidate) {
    candidate = 'asset';
  }
  const used = new Set(taken);
  if (!used.has(candidate)) {
    return candidate;
  }
  let suffix = 2;
  while (used.has(`${candidate}${suffix}`)) {
    suffix += 1;
  }
  return `${candidate}${suffix}`;
}

interface ImportSpecContext {
  readonly imports?: readonly DefaultImport[];
  readonly srcRelative?: string;
  readonly relative: string;
}

// How to write the path. A file that reaches its own src/ through an alias
// says so in every import it already has, and a new one written relative
// beside them would be the odd line out — so the alias is reused when the
// imports show one. (The renderer decides this the same way for a page's
// markup; this is the same rule over a file's text.)
// The `srcRelative` field names the project's `src/` folder, not an abbreviation; the binding
// spells it out.
function importSpecFor({ imports = [], srcRelative: pathInSourceFolder, relative }: ImportSpecContext): string {
  if (pathInSourceFolder) {
    for (const imp of imports) {
      if (imp.spec.startsWith('.')) {
        continue;
      }
      for (const marker of ['/components/', '/layouts/', '/assets/']) {
        const markerIndex = imp.spec.indexOf(marker);
        if (markerIndex > 0) {
          return imp.spec.slice(0, markerIndex + 1) + pathInSourceFolder;
        }
      }
    }
  }
  return relative;
}

import { LIMITS } from '../../shared/core/limits';
import { toRecord } from '../../shared/core/record';

// A value the CMS carries as source — `{ __expr: "dailyDevotionals" }` — with
// the file that name is bound to written beside it, so the field can show the
// picture instead of the word. `resolve` answers what a name imports, as a
// project-relative path, or undefined.
function withAssets(value: unknown, resolve: (name: string) => string | undefined): unknown {
  return withAssetsAtDepth(value, 0, resolve);
}

// The value comes from a project's data file, so its nesting is not ours to trust: past the
// depth any IPC value may have, the rest is returned as it is, without asset paths.
function withAssetsAtDepth(value: unknown, depth: number, resolve: (name: string) => string | undefined): unknown {
  if (depth > LIMITS.ipcDepthMax) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withAssetsAtDepth(item, depth + 1, resolve));
  }
  const record = toRecord(value);
  if (record === undefined) {
    return value;
  }
  const expr = record['__expr'];
  if (typeof expr === 'string') {
    const rel = resolve(expr);
    return rel ? { ...record, __asset: rel } : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    out[key] = withAssetsAtDepth(entry, depth + 1, resolve);
  }
  return out;
}

export { defaultImports, importedAs, importInsertAt, addImport, importName, importSpecFor, withAssets };
export type { DefaultImport, ImportSpecContext };
