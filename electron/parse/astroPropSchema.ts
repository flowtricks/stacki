// A component's prop schema: the fields of its Props type with their types,
// defaults, docs and unions, as the props panel shows them.

import { LIMITS } from '../../shared/core/limits';
import type { DefaultRule, PropUnion, SchemaField } from './astroParserTypes';
import { required } from './astroAttrs';
import { skipStringOrComment, findMatchingBrace } from './astroScan';
import { splitTypeTop, explodeMembers, statedDefault, MEMBER_NAME_SOURCE, memberName, resolveConstTypeQueries } from './astroPropTypes';

const MEMBER_DOCUMENTATION_RE = new RegExp(String.raw`^(?:readonly\s+)?${MEMBER_NAME_SOURCE}\??\s*:\s*([^;\n]+?)[;,]?\s*$`);
import {
  parsePropSchemaExpandAlias,
  parsePropSchemaMemberEntries,
  parsePropSchemaRawTypes,
  parsePropSchemaFields,
  parsePropSchemaDestructure,
  parsePropSchemaSplitFallback,
  parsePropSchemaFallbacks,
  parsePropSchemaDirectAccess,
  propsDestructure,
} from './astroPropFields';

// `prelude` carries type declarations this file imports from elsewhere. A
// component is free to write `type Props = SeoProps` with SeoProps in
// types.ts, and without the declaration text there is nothing to read — the
// panel would show a component with no props at all. The caller (which has
// file access; this doesn't) resolves and reads them.
export function parsePropSchema(source: string, prelude = ''): SchemaField[] {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  // Type queries over `as const` lists are read as the unions they stand for.
  const frontmatter = resolveConstTypeQueries((prelude ? prelude + '\n' : '') + (fm ? fm[1] : ''));
  const aliases = parsePropSchemaAliases(frontmatter);

  // Which type describes the props. `Astro.props as X` names it outright;
  // otherwise it's Props. Both are consulted when both exist — a component can
  // export a strict discriminated `Props` and destructure through a widened
  // alias, and between them they hold the whole picture.
  const asType = frontmatter.match(/Astro\.props\s+as\s+([A-Za-z_$][\w$]*)/) ?? undefined;
  const propsDecl =
    frontmatter.match(
      new RegExp(
        '(?:export\\s+)?(?:interface|type)\\s+Props\\b\\s*(?:' +
          'extends\\s+([^{=]+))?(?:=)?\\s*([\\s\\S]*?)(?=\\n(?:e' +
          'xport\\s+)?(?:type|interface|const|let|function|\\' +
          '/\\/|\\/\\*)|\\n---|$)',
        '',
      ),
    ) ?? undefined;
  // `const { a }: { a: string } = Astro.props` declares the props in the
  // annotation; it is the Props type when there is no other.
  const annotation = propsDecl === undefined && asType === undefined ? propsDestructure(frontmatter)?.annotation : undefined;
  const declaration = propsDecl
    ? { heritage: propsDecl[1], body: propsDecl[2] }
    : annotation === undefined
      ? undefined
      : { heritage: undefined, body: annotation };
  const blocks = parsePropSchemaBlocks(aliases, declaration, asType);
  const unions = parsePropSchemaUnions(aliases, propsDecl, asType);
  const sharedDocumentation = parsePropSchemaSharedDocumentation(unions);
  const { rawTypes, noted } = parsePropSchemaRawTypes(aliases, blocks);
  const schema = parsePropSchemaFields(aliases, rawTypes, noted, sharedDocumentation, unions);
  parsePropSchemaDestructure(frontmatter, schema);
  // A component with no Props type at all may still read `Astro.props.label`.
  if (declaration === undefined && asType === undefined) {
    parsePropSchemaDirectAccess(source, schema);
  }
  const splitFallback = parsePropSchemaSplitFallback(unions);
  parsePropSchemaFallbacks(frontmatter, schema, splitFallback);
  return [...schema.values()];
}

// Props types are written by hand: a chain of aliases a dozen deep, each naming the next, is
// already past anything a component declares, and deeper chains are left unexpanded.
const PROP_SCHEMA_LIMITS = { memberAliasDepthMax: 12 } as const;

function parsePropSchemaMemberBlocks(aliases: ReadonlyMap<string, string>, expr: string | undefined, seen = new Set<string>(), out: string[] = []): string[] {
  // `seen` gains one alias per expansion, so its size bounds how deep the expansion has gone.
  const depth = seen.size;
  if (!expr || depth > PROP_SCHEMA_LIMITS.memberAliasDepthMax) {
    return out;
  }
  let i = 0;
  while (i < expr.length) {
    if (expr.charAt(i) === '{') {
      const close = findMatchingBrace(expr, i);
      if (close === -1) {
        break;
      }
      out.push(expr.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i));
    if (id) {
      if (aliases.has(id[0]) && !seen.has(id[0])) {
        seen.add(id[0]);
        parsePropSchemaMemberBlocks(aliases, aliases.get(id[0]), seen, out);
      }
      i += id[0].length;
      continue;
    }
    i++;
  }
  return out;
}

function parsePropSchemaCollectUnions(aliases: ReadonlyMap<string, string>, unionTables: string[][], expr: string | undefined, seen = new Set<string>()): void {
  // `seen` gains one alias per expansion, so its size bounds how deep the expansion has gone.
  const depth = seen.size;
  if (!expr || depth >= LIMITS.treeDepthMax) {
    return;
  }
  for (const part of splitTypeTop(expr, '&')) {
    // The declaration's own semicolon rides along on the last part.
    const inner = part.replace(/;\s*$/, '').replace(/^\(([\s\S]*)\)$/, '$1');
    const arms = splitTypeTop(inner, '|');
    if (arms.length >= 2) {
      // An arm is an object literal, a named alias, or an intersection of
      // them — resolve each to the members it contributes.
      const branches = arms.map((arm) => parsePropSchemaMemberBlocks(aliases, arm, new Set(), []));
      if (branches.every((branch) => branch.length)) {
        unionTables.push(branches.map((blocks) => blocks.join('\n')));
        continue;
      }
    }
    const id = inner.match(/^[A-Za-z_$][\w$]*$/);
    if (id && aliases.has(id[0]) && !seen.has(id[0])) {
      seen.add(id[0]);
      parsePropSchemaCollectUnions(aliases, unionTables, aliases.get(id[0]), seen);
    }
  }
}

function parsePropSchemaMemberDocs(block: string) {
  const out = new Map<string, string>();
  let documentation: string[] = [];
  let inBlock = false;
  for (const raw of explodeMembers(block).split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('*/');
      documentation.push((end === -1 ? line : line.slice(0, end)).replace(/^\*+\s?/, ''));
      if (end !== -1) {
        inBlock = false;
      }
      continue;
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/');
      documentation.push((end === -1 ? line.slice(2) : line.slice(2, end)).replace(/^\*+\s?/, ''));
      inBlock = end === -1;
      continue;
    }
    if (line.startsWith('//')) {
      documentation.push(line.slice(2).trim());
      continue;
    }
    if (!line) {
      documentation = [];
      continue;
    }
    const match = line.match(MEMBER_DOCUMENTATION_RE);
    if (match) {
      const text = documentation.join(' ').replace(/\s+/g, ' ').trim();
      if (text) {
        out.set(memberName(required(match[1], 'Member name capture')), text);
      }
      documentation = [];
    }
  }
  return out;
}

function parsePropSchemaAliases(frontmatter: string): Map<string, string> {
  // Collect local type aliases (type HeadingTag = "h1" | "h2" | ...) so props
  // referencing them resolve to their union options.
  //
  // The declaration ends at the semicolon that closes it, which has to be
  // found by scanning: stopping at the first `;` truncates any alias whose
  // body is an object, because every member ends in one — `type Base = { a:
  // string; b: number }` would come back as `{ a: string`.
  const aliases = new Map<string, string>();
  const declRe = /(?:^|\n)\s*(?:export\s+)?(type|interface)\s+([A-Za-z_$][\w$]*)\s*/g;
  let dm;
  while ((dm = declRe.exec(frontmatter)) !== null) {
    const after = declRe.lastIndex;
    let body;
    if (dm[1] === 'interface') {
      // `interface X extends Y { … }` — the braces are the body.
      const open = frontmatter.indexOf('{', after);
      if (open === -1) {
        continue;
      }
      const close = findMatchingBrace(frontmatter, open);
      if (close === -1) {
        continue;
      }
      const heritage = frontmatter.slice(after, open).replace(/^\s*extends\s+/, '');
      body = `${heritage} ${frontmatter.slice(open, close + 1)}`;
    } else {
      const eq = frontmatter.indexOf('=', after);
      if (eq === -1) {
        continue;
      }
      let i = eq + 1;
      let depth = 0;
      for (; i < frontmatter.length; i++) {
        const skipped = skipStringOrComment(frontmatter, i);
        if (skipped !== i) {
          i = skipped - 1;
          continue;
        }
        const character = frontmatter.charAt(i);
        if ('([{'.includes(character)) {
          depth++;
        } else if (')]}'.includes(character)) {
          depth--;
        } else if (character === ';' && depth === 0) {
          break;
        }
      }
      body = frontmatter.slice(eq + 1, i);
    }
    aliases.set(required(dm[2], 'Type alias name capture'), body.trim());
  }
  return aliases;
}

// The declaration of the props: what `interface Props extends …` extends, and its body.
interface PropsDeclaration {
  readonly heritage: string | undefined;
  readonly body: string | undefined;
}

function parsePropSchemaBlocks(
  aliases: ReadonlyMap<string, string>,
  declaration: PropsDeclaration | undefined,
  asType: RegExpMatchArray | undefined,
): string[] {
  const blocks: string[] = [];
  if (declaration) {
    // `interface Props extends HTMLAttributes<"button">` — the extended type
    // is part of the shape too.
    if (declaration.heritage) {
      parsePropSchemaMemberBlocks(aliases, declaration.heritage, new Set(), blocks);
    }
    parsePropSchemaMemberBlocks(aliases, declaration.body, new Set(), blocks);
  }
  if (asType && aliases.has(required(asType[1], 'Asserted props type capture'))) {
    parsePropSchemaMemberBlocks(aliases, aliases.get(required(asType[1], 'Asserted props type capture')), new Set(), blocks);
  }
  return blocks;
}

// What one union branch's own doc comments say each prop falls back to. A label
// that reads Play in the play branch and Close in the close one has no
// single answer for the field, but it has one per branch — and the
// branch is decided by props the panel already knows.
function parsePropSchemaBranchDocs(documentationMap: ReadonlyMap<string, string>): {
  defaults: Record<string, string | number>;
  rules: Record<string, DefaultRule>;
  docs: Record<string, string>;
} {
  const defaults: Record<string, string | number> = {};
  const rules: Record<string, DefaultRule> = {};
  const docs: Record<string, string> = {};
  for (const [name, documentation] of documentationMap) {
    docs[name] = documentation;
    const said = statedDefault(documentation);
    if (said.value !== undefined) {
      defaults[name] = said.value;
    }
    if (said.when) {
      rules[name] = said.when;
    }
  }
  return { defaults, rules, docs };
}

function parsePropSchemaUnions(
  aliases: ReadonlyMap<string, string>,
  propsDecl: RegExpMatchArray | undefined,
  asType: RegExpMatchArray | undefined,
): PropUnion[] {
  const unionTables: string[][] = [];
  parsePropSchemaCollectUnions(aliases, unionTables, propsDecl && propsDecl[2]);
  parsePropSchemaCollectUnions(aliases, unionTables, asType && aliases.get(required(asType[1], 'Asserted props type capture')));
  const unions: PropUnion[] = [];

  for (const branchBlocks of unionTables) {
    const maps = branchBlocks.map(parsePropSchemaMemberEntries);
    const documentationMaps = branchBlocks.map(parsePropSchemaMemberDocs);
    const names = new Set(maps.flatMap((map) => [...map.keys()]));
    const branches = maps.map((map, at) => {
      const forbids = [];
      const pins: Record<string, string[]> = {};
      const { defaults, rules, docs } = parsePropSchemaBranchDocs(required(documentationMaps[at], 'Union branch documentation exists'));
      for (const name of names) {
        const entry = map.get(name);
        if (!entry) {
          continue;
        }
        // A branch PINS a prop when it fixes it to a known set of values —
        // one (`variant: "autofit"`) or several (`variant: "autofit" |
        // "autofill"`), which is still a discriminant, just a wider one.
        // Anything with a non-literal member (string, number, an alias like
        // GridColumns) fixes nothing and pins nothing. Split first: a naive
        // literal test on the whole type reads `"a" | "b"` as one string,
        // because it does start and end with a quote.
        if (entry === 'never') {
          forbids.push(name);
          continue;
        }
        const parts = splitTypeTop(entry, '|')
          .flatMap((x) => parsePropSchemaExpandAlias(aliases, x.trim()))
          .map((x) => x.trim())
          .filter((x) => x && x !== 'undefined' && x !== 'null');
        const isLiteral = (x: string) => /^(['"`]).*\1$/.test(x) || /^(true|false|-?\d+(\.\d+)?)$/.test(x);
        if (parts.length && parts.every(isLiteral)) {
          pins[name] = parts.map((x) => (/^['"`]/.test(x) ? x.slice(1, -1) : x));
        }
      }
      return { forbids, pins, defaults, rules, docs };
    });
    // In a union told apart by a literal field (`kind: 'link'` here, `kind:
    // 'button'` there) a member one branch leaves out is not part of that
    // branch: TypeScript rejects `disabled` beside `kind="link"`. It is
    // forbidden there just as `disabled?: never` would say.
    if (discriminated(branches.map((branch) => branch.pins))) {
      for (const [at, branch] of branches.entries()) {
        const map = required(maps[at], 'Union branch members exist');
        for (const name of names) {
          if (!map.has(name) && !branch.forbids.includes(name)) {
            branch.forbids.push(name);
          }
        }
      }
    }
    // A union that forbids nothing and pins nothing tells the panel nothing.
    if (
      branches.some(
        (branch) => branch.forbids.length || Object.keys(branch.pins).length || Object.keys(branch.defaults).length || Object.keys(branch.rules).length,
      )
    ) {
      unions.push({ names: [...names], branches });
    }
  }
  return unions;
}

// Whether one field tells the branches apart: pinned in every one of them
// (two or more), to values no two of them share.
function discriminated(pins: readonly Readonly<Record<string, readonly string[]>>[]): boolean {
  const names = new Set(pins.flatMap((branch) => Object.keys(branch)));
  for (const name of names) {
    const pinned = pins.map((branch) => branch[name]).filter((values) => values !== undefined);
    const values = pinned.flat();
    if (pinned.length >= 2 && pinned.length === pins.length && new Set(values).size === values.length) {
      return true;
    }
  }
  return false;
}

function parsePropSchemaSharedDocumentation(unions: readonly PropUnion[]): Map<string, string> {
  // A prop written in several branches has a doc in each, and they differ
  // exactly where the branches do — the play control's label falls back to
  // Play, the close one's to Close. The schema keeps the first it meets, so
  // the tip beside a close button's label read "Defaults to Play".
  //
  // What every branch says is what is true of the prop itself, so the tip
  // shows their common opening and stops at the last sentence they share.
  // Where they part is the fallback, which the field already answers with a
  // placeholder for the branch in force.
  const sharedDocumentation = new Map<string, string>();
  {
    const perName = new Map<string, Set<string>>();
    for (const union of unions) {
      for (const branch of union.branches) {
        for (const [name, documentation] of Object.entries(branch.docs || {})) {
          if (!perName.has(name)) {
            perName.set(name, new Set());
          }
          required(perName.get(name), 'Documentation set was initialized').add(documentation);
        }
      }
    }
    for (const [name, docs] of perName) {
      if (docs.size < 2) {
        continue;
      }
      const all = [...docs];
      const first = required(all[0], 'Shared documentation has an entry');
      let i = 0;
      while (i < first.length && all.every((other) => other[i] === first[i])) {
        i++;
      }
      const cut = first.slice(0, i).lastIndexOf('.');
      const common = cut === -1 ? '' : first.slice(0, cut + 1).trim();
      if (common) {
        sharedDocumentation.set(name, common);
      }
    }
  }
  return sharedDocumentation;
}
