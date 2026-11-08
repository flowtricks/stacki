// What a file's imports hold, read from the modules they come from, for the
// binding picker. `import { LINKS, APP_VERSION } from "@/consts.ts"` names
// values the page can bind to, but the frontmatter only says where they come
// from. The picker used to leave them out, so a field already bound to
// `APP_VERSION` showed its binding as a field missing from the entry.
//
// The module is read, never run: a project module's export is followed to its
// declaration, and only a literal written out there (text, a number, an
// object or list literal) counts. A JSON module is parsed as JSON. Anything
// else, a package or a computed value, has no entry here, and the picker
// still lists the import, as "imported", with nothing to preview.
//
// Each host reads the module text its own way (Desktop over IPC, Studio from
// its dev server); readImportedValues is the part both share.

import { assert } from '../../shared/core/assert';
import { NON_DATA_EXT, TOOL_MODULE, scanValue, skipString, type ImportLike } from './dataSource';

export const IMPORTED_VALUE_LIMITS = {
  // Distinct modules read for one file. A page imports a handful of data modules.
  modulesMax: 16,
  // A module longer than this is not read for its values: it is not a constants file.
  moduleCharsMax: 200_000,
  // Names exported in one `export { … }` list that are looked at.
  exportListNamesMax: 256,
} as const;

/**
 * One import's value as its module declares it: the literal source text of
 * the export (`"1.0.12"`, `{ github: "…" }`), or a JSON module's parsed data.
 */
export type ImportedValue = { readonly kind: 'literal'; readonly text: string } | { readonly kind: 'data'; readonly value: unknown };

/** One module to read, and the imports it answers: local name, and the export it names. */
export interface ImportedModuleRequest {
  readonly spec: string;
  readonly bindings: readonly { readonly local: string; readonly exported: string }[];
}

/** A module's text as the host read it, and the file it resolved to. */
export interface ImportedModuleSource {
  readonly file: string;
  readonly text: string;
}

/**
 * The modules a file's imports name that may hold values, each once, with
 * the bindings read from it. Markup, styles, media, Astro's own modules and
 * type-only imports hold no values. Bounded by modulesMax: further modules are
 * not read, and their imports stay unresolved.
 */
export function importedModuleRequests(imports: readonly ImportLike[]): ImportedModuleRequest[] {
  const bySpec = new Map<string, { local: string; exported: string }[]>();
  for (const imp of imports) {
    const spec = imp.path ?? '';
    const local = imp.name ?? '';
    if (spec === '' || local === '' || imp.typeOnly === true) {
      continue;
    }
    if (NON_DATA_EXT.test(spec) || TOOL_MODULE.test(spec)) {
      continue;
    }
    const exported = imp.named === true ? (imp.imported ?? local) : 'default';
    const bindings = bySpec.get(spec);
    if (bindings !== undefined) {
      bindings.push({ local, exported });
    } else if (bySpec.size < IMPORTED_VALUE_LIMITS.modulesMax) {
      bySpec.set(spec, [{ local, exported }]);
    }
  }
  const requests = [...bySpec].map(([spec, bindings]) => ({ spec, bindings }));
  assert(requests.length <= IMPORTED_VALUE_LIMITS.modulesMax, 'importedModuleRequests: module limit holds');
  return requests;
}

/**
 * The values `request`'s bindings hold in `source`, by local name. A binding
 * whose export is not a literal is left out.
 */
export function importedValuesFrom(request: ImportedModuleRequest, source: ImportedModuleSource): Record<string, ImportedValue> {
  const out: Record<string, ImportedValue> = {};
  if (source.text.length > IMPORTED_VALUE_LIMITS.moduleCharsMax) {
    return out;
  }
  const json = /\.json$/i.test(source.file);
  const parsed = json ? parseJSON(source.text) : undefined;
  for (const binding of request.bindings) {
    const value = json ? jsonExport(parsed, binding.exported) : scriptExport(source.text, binding.exported);
    if (value !== undefined) {
      out[binding.local] = value;
    }
  }
  assert(Object.keys(out).length <= request.bindings.length, 'importedValuesFrom: one value per binding at most');
  return out;
}

/**
 * Every value a file's imports hold that the host can read: each module once,
 * read through `readModule` (undefined when it does not resolve to a project
 * file), and a module that fails to read leaves its imports unresolved.
 */
export async function readImportedValues(
  imports: readonly ImportLike[],
  readModule: (spec: string) => Promise<ImportedModuleSource | undefined>,
): Promise<Record<string, ImportedValue>> {
  const requests = importedModuleRequests(imports);
  const answers = await Promise.all(
    requests.map(async (request) => {
      const source = await readModule(request.spec).catch(() => undefined);
      return source === undefined ? {} : importedValuesFrom(request, source);
    }),
  );
  const values: Record<string, ImportedValue> = {};
  for (const answer of answers) {
    for (const [local, value] of Object.entries(answer)) {
      values[local] = value;
    }
  }
  assert(answers.length === requests.length, 'readImportedValues: one answer per module');
  return values;
}

/**
 * The literal `name` is exported as in a script module, or undefined: `export
 * const NAME = …`, `export { local as NAME }` over a top-level declaration,
 * or `export default …`. Only a literal counts; anything else is computed.
 */
export function scriptExport(code: string, name: string): ImportedValue | undefined {
  assert(/^[A-Za-z_$][\w$]*$/.test(name), 'scriptExport: an export name is an identifier');
  if (name === 'default') {
    const head = /(?:^|\n)[ \t]*export\s+default\s+/.exec(code);
    if (head === null) {
      return undefined;
    }
    const start = head.index + head[0].length;
    const text = code.slice(start, scanValue(code, start)).trim();
    const local = /^[A-Za-z_$][\w$]*$/.test(text) ? declarationValue(code, text, { exported: false }) : text;
    return literalOf(local);
  }
  const direct = declarationValue(code, name, { exported: true });
  if (direct !== undefined) {
    return literalOf(direct);
  }
  const local = exportListLocal(code, name);
  return local === undefined ? undefined : literalOf(declarationValue(code, local, { exported: false }));
}

// The value text of a top-level `const|let|var NAME = …`, with an optional
// type annotation, or undefined. `exported` asks for the `export` keyword.
function declarationValue(code: string, name: string, options: { readonly exported: boolean }): string | undefined {
  const escaped = name.replace(/\$/g, '\\$');
  const lead = options.exported ? 'export\\s+' : '(?:export\\s+)?';
  const head = new RegExp(`(?:^|\\n)[ \\t]*${lead}(?:const|let|var)\\s+${escaped}\\s*(?::[^=\\n]*)?=(?!=)\\s*`).exec(code);
  if (head === null) {
    return undefined;
  }
  const start = head.index + head[0].length;
  const end = scanValue(code, start);
  assert(end >= start, 'declarationValue: a value ends after it starts');
  return code.slice(start, end).trim();
}

// The local name `export { local as name }` exports `name` under, or the name
// itself for `export { name }`. Re-exports (`export { x } from '…'`) are
// another module's, and not followed.
function exportListLocal(code: string, name: string): string | undefined {
  const lists = /(?:^|\n)[ \t]*export\s*\{([^}]*)\}(?!\s*from\b)/g;
  for (let match = lists.exec(code); match !== null; match = lists.exec(code)) {
    const entries = (match[1] ?? '').split(',').slice(0, IMPORTED_VALUE_LIMITS.exportListNamesMax);
    for (const entry of entries) {
      const parts = entry.trim().split(/\s+as\s+/);
      const local = parts[0]?.trim();
      const exported = (parts[1] ?? parts[0])?.trim();
      if (exported === name && local !== undefined && local !== '') {
        return local;
      }
    }
  }
  return undefined;
}

// A literal's text, with a trailing `as const` or `satisfies Type` dropped:
// they say what the value is to the compiler, and are not part of it.
function literalOf(text: string | undefined): ImportedValue | undefined {
  if (text === undefined || text === '') {
    return undefined;
  }
  const literal = withoutTypeSuffix(text);
  if (/^[{[]/.test(literal)) {
    return { kind: 'literal', text: literal };
  }
  if (/^(['"`])/.test(literal) && skipString(literal, 0) === literal.length - 1) {
    return /^`/.test(literal) && literal.includes('${') ? undefined : { kind: 'literal', text: literal };
  }
  if (/^-?\d[\d_]*(\.\d+)?(e[+-]?\d+)?$/i.test(literal) || /^(true|false)$/.test(literal)) {
    return { kind: 'literal', text: literal };
  }
  return undefined;
}

function withoutTypeSuffix(text: string): string {
  const trimmed = text.trim();
  const close = literalEnd(trimmed);
  const body = close === undefined ? trimmed : trimmed.slice(0, close + 1);
  const rest = close === undefined ? '' : trimmed.slice(close + 1).trim();
  if (rest !== '' && !/^(as\s+const|satisfies\s[\s\S]*)$/.test(rest)) {
    return trimmed; // `{ … }.field`, `"a" + b`: an expression, which literalOf rejects
  }
  return close === undefined ? trimmed.replace(/\s+as\s+const$/, '') : body;
}

// The index of the bracket or quote that closes the literal opening `text`,
// or undefined when it does not open with one.
function literalEnd(text: string): number | undefined {
  const first = text.charAt(0);
  if (first === '"' || first === "'" || first === '`') {
    return skipString(text, 0);
  }
  if (first !== '{' && first !== '[') {
    return undefined;
  }
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    if (character === '"' || character === "'" || character === '`') {
      index = skipString(text, index);
      continue;
    }
    if ('([{'.includes(character)) {
      depth++;
    } else if (')]}'.includes(character)) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

// JSON is data by definition, so it is parsed rather than read as source.
function parseJSON(text: string): { readonly ok: true; readonly value: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return undefined;
  }
}

// A JSON module's default export is the document; a named one is a top-level key.
function jsonExport(parsed: { readonly value: unknown } | undefined, name: string): ImportedValue | undefined {
  if (parsed === undefined) {
    return undefined;
  }
  if (name === 'default') {
    return { kind: 'data', value: parsed.value };
  }
  const document = parsed.value;
  if (typeof document !== 'object' || document === null || Array.isArray(document) || !Object.prototype.hasOwnProperty.call(document, name)) {
    return undefined;
  }
  const value: unknown = Reflect.get(document, name);
  return { kind: 'data', value };
}
