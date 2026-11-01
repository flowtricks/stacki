// A component's prop schema with its defaults resolved: the prop types it
// imports, followed to their own files, and identifier defaults followed to the
// literal they name, so the panel shows the real default.

import { readSource } from '../lib/mainLimits';
import type { SchemaField } from '../parse/astroParserTypes';
import * as path from 'path';
import * as fs from 'fs';
import { parsePropSchema, parseExtendsTag, parseSlots, defaultSlotInline, rootTag } from '../parse/astroParser';
import { capture } from '../lib/mainHelpers';
import { resolveImportPath } from './importPaths';

// The declaration text for every type this file imports, so `type Props =
// SeoProps` can be read when SeoProps lives in types.ts. One level deep and
// only within the project — enough for the shape components actually use,
// without turning this into a type checker.
export function importedTypes(source: string, filePath: string, projectPath: string) {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) {
    return '';
  }
  const out: string[] = [];
  const seen = new Set();
  // `import type { A, B } from '…'`, `import { type A } from '…'`, and the
  // default form — a type-only import is the common way to write this, but a
  // plain `import { X }` of a type is legal too.
  const re = /import\s+(?:type\s+)?(\{[^}]*\}|[\w$]+)\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(capture(fm, 1))) !== null) {
    const names = capture(match, 1)
      .replace(/[{}]/g, '')
      .split(',')
      .map(
        (specifier) =>
          specifier
            .replace(/\btype\b/, '')
            .split(/\s+as\s+/)[0]
            ?.trim() ?? '',
      )
      .filter(Boolean);
    if (!names.length) {
      continue;
    }
    const target = resolveImportPath(projectPath, filePath, capture(match, 2));
    if (!target || seen.has(target) || target.endsWith('.astro')) {
      continue;
    }
    seen.add(target);
    let text;
    try {
      text = readSource(target);
    } catch {
      continue;
    }
    // Only the declarations that were actually imported, so an unrelated type
    // in the same file can't shadow one the component declares itself.
    for (const name of names) {
      const decl = new RegExp(`(?:^|\n)\\s*(?:export\\s+)?(?:type|interface)\\s+${name.replace(/[^\w$]/g, '')}\\b`).exec(text);
      if (!decl) {
        continue;
      }
      const from = decl.index;
      // To the end of the declaration: an interface ends at its closing brace,
      // a type alias at the semicolon that closes it.
      let depth = 0;
      let end = text.length;
      for (let i = from; i < text.length; i++) {
        const character = text.charAt(i);
        if ('{(['.includes(character)) {
          depth++;
        } else if ('})]'.includes(character)) {
          depth--;
          if (depth === 0 && /\{/.test(text.slice(from, i))) {
            end = i + 1;
            break;
          }
        } else if (character === ';' && depth === 0 && from !== i) {
          end = i + 1;
          break;
        }
      }
      out.push(text.slice(from, end));
    }
  }
  return out.join('\n');
}

export function safeSchema(filePath: string, projectPath: string) {
  try {
    const source = readSource(filePath);
    const fields = parsePropSchema(source, importedTypes(source, filePath, projectPath));
    const schema = resolveIdentifierDefaults(fields, source, filePath, projectPath);
    return {
      schema,
      extendsTag: parseExtendsTag(source) ?? undefined,
      slots: parseSlots(source),
      // Where that default slot sits decides whether a fresh instance
      // arrives holding a word or empty — see defaultSlotInline.
      slotText: defaultSlotInline(source),
      // The HTML tag it renders as, so nesting rules apply through a
      // component the same way they do through a plain element.
      renderTag: rootTag(source) ?? undefined,
      // A `...rest` spread on Astro.props means the component forwards
      // arbitrary attributes — the UI offers a free-form Attributes section.
      // Anchored to the end of the destructure rather than scanning forward
      // from its `{`: a rest element is always last, and looking forward
      // tripped over any `}` in front of it (`containerAttrs = {}, ...rest`).
      // The optional `: Type` covers an annotated destructure.
      hasRest: /\.\.\.\s*\w+\s*\}\s*(?::[^=]+)?=\s*Astro\.props/.test(source),
    };
  } catch {
    return {
      schema: [],
      extendsTag: undefined,
      slots: [],
      slotText: false,
      renderTag: undefined,
      hasRest: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Prop-default resolution: a default like `SITE_TITLE` is often an identifier
// imported from another module (or a local const in the frontmatter). Follow
// it to its literal value so the UI shows the real default.
// ---------------------------------------------------------------------------

export function literalValue(raw: string | undefined) {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^(true|false)$/.test(trimmed)) {
    return trimmed === 'true';
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  // Strings, including template literals without interpolation.
  if (/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)$/s.test(trimmed)) {
    return trimmed.slice(1, -1).replace(/\\(['"`\\])/g, '$1');
  }
  return undefined;
}

// Finds `export const NAME = <literal>` (or let/var, optional type note).
export function constLiteralIn(code: string, name: string) {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=\\n]+)?=\\s*` +
      '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`[^`$]*`|-?\\d+(?:\\.\\d+)?|true|false)',
  );
  const match = code.match(re);
  return match ? literalValue(capture(match, 1)) : undefined;
}

// Finds which module a named import binds `name` from: {orig, spec}.
export function findNamedImport(code: string, name: string) {
  const re = /import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    for (const part of capture(match, 1).split(',')) {
      const seg = part.trim().replace(/^type\s+/, '');
      if (!seg) {
        continue;
      }
      const asMatch = seg.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      const orig = asMatch ? capture(asMatch, 1) : seg;
      const local = asMatch ? capture(asMatch, 2) : seg;
      if (local === name) {
        return { orig, spec: capture(match, 2) };
      }
    }
  }
  return undefined;
}

export function resolveModuleFile(spec: string, fromFile: string, projectPath: string) {
  let base;
  if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    base = path.join(projectPath, 'src', spec.slice(2));
  } else if (spec.startsWith('src/')) {
    base = path.join(projectPath, spec);
  } else {
    return undefined;
  }
  const candidates = [base, `${base}.ts`, `${base}.js`, `${base}.mjs`, `${base}.mts`, path.join(base, 'index.ts'), path.join(base, 'index.js')];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export function resolveIdentifierDefaults(schema: readonly SchemaField[], source: string, filePath: string, projectPath: string) {
  return schema.map((field): SchemaField => {
    if (!field.defaultExpr) {
      return field;
    }
    const defaultAsset = defaultAssetIn(source, String(field.default), filePath, projectPath);
    if (defaultAsset !== undefined) {
      return { ...field, defaultAsset };
    }
    const ident = String(field.default).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(ident)) {
      return field;
    }
    // Local const in the component's own frontmatter first.
    let value = constLiteralIn(source, ident);
    if (value === undefined) {
      const imp = findNamedImport(source, ident);
      if (imp) {
        const file = resolveModuleFile(imp.spec, filePath, projectPath);
        if (file) {
          try {
            value = constLiteralIn(readSource(file), imp.orig);
          } catch {
            /* unreadable module — leave the identifier as-is */
          }
        }
      }
    }
    if (value === undefined) {
      return field;
    }
    // Build a resolved field without mutating the parser's original schema.
    const resolved = { ...field, default: value };
    delete resolved.defaultExpr;
    if (resolved.type === 'other') {
      resolved.type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
    }
    return resolved;
  });
}

// Media a default may import; the same set the props panel previews.
const MEDIA_FILE_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|m4v|ogg|mp3|wav)$/i;
const IDENTIFIER_SOURCE = '[A-Za-z_$][\\w$]*';
// One alias step: `const IMAGE = photo.src` names the import `photo`.
const ALIAS_STEPS_MAX = 1;

// The project file an image default imports, as a project-relative rel
// ("src/assets/hero.webp"), so the panel can show its thumbnail. It travels
// beside the expression, never in place of it: the default stays
// `heroImage.src`, which a page may not spell as a path. Follows
// `= heroImage`, `= heroImage.src`, and one local const naming either.
export function defaultAssetIn(source: string, expression: string, filePath: string, projectPath: string): string | undefined {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) {
    return undefined;
  }
  const code = capture(frontmatter, 1);
  let name = importedNameOf(expression);
  for (let step = 0; name !== undefined && step <= ALIAS_STEPS_MAX; step++) {
    const spec = defaultImportSpec(code, name);
    if (spec !== undefined) {
      return assetRelFor(spec, filePath, projectPath);
    }
    const alias = code.match(new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${escapeIdentifier(name)}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`));
    name = alias ? importedNameOf(capture(alias, 1)) : undefined;
  }
  return undefined;
}

// `photo` or `photo.src`, the two ways an expression names an imported image.
function importedNameOf(expression: string): string | undefined {
  const match = expression.trim().match(new RegExp(`^(${IDENTIFIER_SOURCE})(?:\\.src)?$`));
  return match ? capture(match, 1) : undefined;
}

function defaultImportSpec(code: string, name: string): string | undefined {
  const match = code.match(new RegExp(`import\\s+${escapeIdentifier(name)}\\s+from\\s*['"]([^'"]+)['"]`));
  return match ? capture(match, 1) : undefined;
}

function assetRelFor(spec: string, filePath: string, projectPath: string): string | undefined {
  const bare = spec.split('?')[0] ?? '';
  if (!MEDIA_FILE_RE.test(bare)) {
    return undefined;
  }
  const absolute = resolveImportPath(projectPath, filePath, bare);
  if (absolute === undefined) {
    return undefined;
  }
  const rel = path.relative(projectPath, absolute).split(path.sep).join('/');
  return /^(src|public)\//.test(rel) ? rel : undefined;
}

// `$` is legal in an identifier and special in a pattern.
function escapeIdentifier(name: string): string {
  return name.replace(/\$/g, '\\$');
}
