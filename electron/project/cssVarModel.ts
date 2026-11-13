// The model the variables editor shows: one group per set of rules, blocks per
// comment section or prefix, rows and columns of cells (cssVars.ts).

import { variableFiles as fs } from './variableWorkspace';
import path from 'path';
import { MAIN_LIMITS } from './variableWorkspace';
import { assert } from '../../shared/core/assert';
import { described, type MessageRef } from '../../shared/properties/i18n/messageRef';
import { toPosix, findStylesheets, type VarEntry, type Rule, readDeclarations } from './cssVarRead';
import { labelForRule, commonStem, namesOf, groupRules, findFamilies, prefixSections } from './cssVarGroups';
import { resolveValue, colorOf, isUncomputableColor, kindOf } from './cssVarValues';
import { findAstroSources, isAstroFile, readAstroVariables, relativeTo, type VariableScope } from './cssVarRegions';

export interface Column {
  readonly id: string;
  readonly label: string;
  readonly selector: string;
  readonly context: readonly string[];
  readonly line: number;
}

export interface Cell {
  readonly name: string;
  readonly value: string;
  readonly file: string;
  readonly selector: string;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly line: number;
  readonly column: string;
}

export interface Row {
  readonly label: string;
  readonly name?: string;
  // Reassigned centrally in readVariables once cells are described.
  cells: (Cell | undefined)[];
}

export interface Block {
  readonly kind: 'rows' | 'matrix';
  readonly title: string | undefined;
  readonly titleStart?: number;
  readonly titleEnd?: number;
  /** The heading comment in full, when it says more than the title. */
  readonly description?: string;
  readonly rows: Row[];
  readonly columns?: Column[];
}

export interface Group {
  readonly kind: 'modes' | 'single';
  readonly label: string;
  readonly columns: Column[];
  readonly blocks: Block[];
  /** Who a `<style>` block's variables reach; absent for a stylesheet's, which are project CSS. */
  readonly scope?: VariableScope;
}

export interface FileModel {
  readonly rel: string;
  readonly name: string;
  readonly groups: Group[];
  readonly error?: string;
  /** The reference the panel translates `error` from; absent for text received from elsewhere. */
  readonly errorRef?: MessageRef | undefined;
  readonly count?: number;
  declarations?: Rule[];
}

// A variable entry with the rule it came from attached, so a move can look the
// declaration up by selector after the model has travelled to the renderer.
export interface TaggedVar extends VarEntry {
  readonly selector: string;
}

export function buildGroup(members: readonly Rule[], file: string): Group {
  assert(members.length > 0, 'buildGroup: a group has at least one rule');
  const columns = members.map((rule, index) => ({
    id: `${index}`,
    label: labelForRule(rule),
    selector: rule.selector,
    context: rule.context,
    line: rule.line,
  }));
  const byName = members.map((rule): Map<string, TaggedVar> => {
    const map = new Map<string, TaggedVar>();
    for (const entry of rule.entries) {
      if (entry.kind === 'var') {
        map.set(entry.name, { ...entry, selector: rule.selector });
      }
    }
    return map;
  });

  if (members.length > 1) {
    return modesGroup(columns, byName, file);
  }
  // One rule: comments are headings, and the names inside each heading may form
  // tables of their own.
  const rule = members[0];
  if (!rule) {
    return { kind: 'single', label: '', columns, blocks: [] };
  }
  const blocks = commentSections(rule).flatMap((section) => sectionBlocks(section, rule, byName[0], file));
  return { kind: 'single', label: labelForRule(rule), columns, blocks };
}

// Several rules declaring the same names: the columns are the modes, so the names are the rows.
// Sub-sections come from shared prefixes.
export function modesGroup(columns: Column[], byName: readonly Map<string, TaggedVar>[], file: string): Group {
  const cellsFor = (name: string): (Cell | undefined)[] => byName.map((map, index) => cellFor(map, name, file, columns[index]?.id ?? ''));
  const names: string[] = [];
  for (const map of byName) {
    for (const name of map.keys()) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  const blocks: Block[] = [];
  const { loose, sections } = prefixSections(names);
  if (loose.length) {
    blocks.push({
      kind: 'rows',
      title: undefined,
      rows: loose.map((name) => ({ label: shortLabel(name), name, cells: cellsFor(name) })),
    });
  }
  for (const [prefix, group] of sections) {
    blocks.push({
      kind: 'rows',
      title: prefix,
      rows: group.map((name) => ({
        label: shortLabel(name, prefix),
        name,
        cells: cellsFor(name),
      })),
    });
  }
  const firstLabel = columns[0]?.label ?? '';
  return {
    kind: 'modes',
    label: commonStem(columns.map((column) => column.label)) || firstLabel,
    columns,
    blocks,
  };
}

// The names under one comment heading of a rule, with the heading's span in the file.
export interface CommentSection {
  title: string | undefined;
  titleStart?: number;
  titleEnd?: number;
  description?: string;
  names: string[];
}

export function commentSections(rule: Rule): CommentSection[] {
  const sections: CommentSection[] = [];
  let current: CommentSection = { title: undefined, names: [] };
  for (const entry of rule.entries) {
    if (entry.kind === 'comment') {
      // A heading with nothing under it is kept. It used to be dropped, which
      // was tidy right up until the panel grew a way to MAKE one: a new group
      // starts empty, and a group you cannot see is one you cannot fill.
      // (Untitled runs with no names are still nothing at all.)
      if (current.names.length || current.title !== undefined) {
        sections.push(current);
      }
      current = {
        title: entry.text,
        titleStart: entry.textStart,
        titleEnd: entry.textEnd,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        names: [],
      };
      continue;
    }
    current.names.push(entry.name);
  }
  if (current.names.length || current.title !== undefined) {
    sections.push(current);
  }
  return sections;
}

// One heading's blocks: a matrix per family its names form, then a list of whatever is left.
export function sectionBlocks(section: CommentSection, rule: Rule, map: Map<string, TaggedVar> | undefined, file: string): Block[] {
  const blocks: Block[] = [];
  const { families, used } = findFamilies(section.names);
  const claimed = new Set<string>();
  for (const family of families) {
    const rows: Row[] = [];
    if (family.self) {
      rows.push({
        label: 'value',
        cells: family.prefixes.map((prefix) => cellFor(map, `--${prefix}`, file, '0')),
      });
      for (const prefix of family.prefixes) {
        claimed.add(`--${prefix}`);
      }
    }
    for (const suffix of family.rows) {
      rows.push({
        label: suffix,
        cells: family.prefixes.map((prefix) => cellFor(map, `--${prefix}-${suffix}`, file, '0')),
      });
      for (const prefix of family.prefixes) {
        claimed.add(`--${prefix}-${suffix}`);
      }
    }
    blocks.push({
      kind: 'matrix',
      title: section.title,
      columns: family.prefixes.map((prefix): Column => ({
        id: prefix,
        label: prefix,
        selector: rule.selector,
        context: rule.context,
        line: rule.line,
      })),
      rows: rows.filter((row) => row.cells.some(Boolean)),
      // The inner sections of a one-rule file carry their comment's span so
      // the heading can be renamed in place; a comment-less section has none.
      ...(section.titleStart !== undefined ? { titleStart: section.titleStart, titleEnd: section.titleEnd } : {}),
      ...descriptionOf(section),
    });
  }
  const leftovers = section.names.filter((name) => !claimed.has(name) && !used.has(name));
  if (leftovers.length || (!families.length && section.title !== undefined)) {
    blocks.push({
      kind: 'rows',
      title: families.length ? undefined : section.title,
      rows: leftovers.map((name) => ({
        label: shortLabel(name),
        name,
        cells: [cellFor(map, name, file, '0')],
      })),
      ...(families.length ? {} : { titleStart: section.titleStart, titleEnd: section.titleEnd }),
      ...(families.length ? {} : descriptionOf(section)),
    });
  }
  return blocks;
}

// A heading's description as a field to spread in, or nothing when it has none.
function descriptionOf(section: CommentSection): { readonly description?: string } {
  return section.description === undefined ? {} : { description: section.description };
}

export function cellFor(map: Map<string, TaggedVar> | undefined, name: string, file: string, column: string): Cell | undefined {
  const entry = map?.get(name);
  if (!entry) {
    return undefined;
  }
  return {
    name,
    value: entry.value,
    file,
    selector: entry.selector,
    valueStart: entry.valueStart,
    valueEnd: entry.valueEnd,
    line: entry.line,
    column,
  };
}

export interface DescribedCell extends Cell {
  // Absent rather than undefined, so the cell a renderer parses back is the cell sent.
  readonly ref?: string;
  readonly resolved?: string;
  readonly color?: string;
  readonly unknownColor: boolean;
  readonly kind: string;
}

// A cell's value said three ways: what the file holds, what it comes out as,
// and what colour to draw beside it (if any).
export function describeCell(cell: Cell | undefined, map: Map<string, string>): DescribedCell | undefined {
  if (!cell) {
    return undefined;
  }
  const single = String(cell.value)
    .trim()
    .match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/);
  const resolved = resolveValue(cell.value, map);
  const ref = single?.[1];
  const color = colorOf(resolved);
  return {
    ...cell,
    // A value that is nothing but another variable is shown as that variable's
    // name — which is what the author wrote, and what they would search for.
    ...(ref === undefined ? {} : { ref }),
    ...(resolved === cell.value ? {} : { resolved }),
    ...(color === undefined ? {} : { color }),
    unknownColor: isUncomputableColor(resolved),
    kind: kindOf(cell.value, resolved),
  };
}

export const shortLabel = (name: string, prefix?: string): string => {
  const body = name.replace(/^--/, '');
  return prefix && body.startsWith(`${prefix}-`) ? body.slice(prefix.length + 1) : body;
};

/**
 * Every stylesheet and Astro `<style>` block in the project that declares custom
 * properties, as groups of tables. Files with none are left out — a variables
 * panel is a place to find variables, not a file browser. Stylesheets come first:
 * where a name is declared in both, the stylesheet is the project-wide answer.
 */
export function readVariables(projectPath: string): {
  files: FileModel[];
  values: Record<string, string>;
} {
  const files: FileModel[] = [];
  for (const abs of findStylesheets(projectPath)) {
    let text: string;
    try {
      if (fs.statSync(abs).size > MAIN_LIMITS.cssVariableFileBytesMax) {
        continue;
      }
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = toPosix(path.relative(projectPath, abs));
    let rules: Rule[];
    try {
      rules = readDeclarations(text);
    } catch (error: unknown) {
      const parseFailure = described('variables.error.parse', { detail: error instanceof Error ? error.message : String(error) });
      files.push({ rel, name: path.basename(abs), error: parseFailure.message, errorRef: parseFailure.messageRef, groups: [] });
      continue;
    }
    if (!rules.length) {
      continue;
    }
    const groups = groupRules(rules).map((members) => buildGroup(members, rel));
    files.push({
      rel,
      name: path.basename(abs),
      groups,
      declarations: rules,
      count: rules.reduce((sum, rule) => sum + namesOf(rule).length, 0),
    });
  }
  files.push(...readAstroFiles(projectPath));
  // Values reference each other across files as freely as within one, so the
  // map every value is resolved against is the project's, not the file's.
  const map = new Map<string, string>();
  for (const file of files) {
    for (const rule of file.declarations || []) {
      for (const entry of rule.entries) {
        if (entry.kind === 'var') {
          // A `<style>` block's value holds where the block is rendered, so it
          // answers only for a name no stylesheet declares.
          if (!isAstroFile(file.rel) || !map.has(entry.name)) {
            map.set(entry.name, entry.value);
          }
        }
      }
    }
  }
  const values = Object.fromEntries(map);
  const scopes = variableScopes(files);
  for (const file of files) {
    delete file.declarations;
    for (const group of file.groups) {
      for (const block of group.blocks) {
        for (const row of block.rows) {
          row.cells = row.cells.map((cell) => describeCell(cell, cell === undefined ? map : scopes.mapFor(cell)));
        }
      }
    }
  }
  return { files, values };
}

// One model per Astro file whose `<style>` blocks declare custom properties. Its
// offsets are the file's, so a cell is written back exactly as a stylesheet's is.
function readAstroFiles(projectPath: string): FileModel[] {
  const files: FileModel[] = [];
  for (const abs of findAstroSources(projectPath)) {
    let text: string;
    try {
      if (fs.statSync(abs).size > MAIN_LIMITS.cssVariableFileBytesMax) {
        continue;
      }
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = relativeTo(projectPath, abs);
    // Two pages are often both `index.astro`; the folder tells them apart.
    const name = rel.replace(/^src\//, '');
    const read = readAstroVariables(rel, text);
    if (read.kind === 'error') {
      // A reference from the reader already names the whole sentence; one without it is wrapped as the English always was.
      const parseFailure = described('variables.error.parse', { detail: read.message });
      files.push({ rel, name, error: parseFailure.message, errorRef: read.messageRef ?? parseFailure.messageRef, groups: [] });
    } else if (read.kind === 'rules') {
      const rules = read.sections.flatMap((section) => section.rules);
      assert(rules.length > 0, 'readAstroFiles: a read with sections holds rules');
      const groups = read.sections.flatMap((section) => groupRules(section.rules).map((members) => ({ ...buildGroup(members, rel), scope: section.scope })));
      files.push({ rel, name, groups, declarations: rules, count: rules.reduce((sum, rule) => sum + namesOf(rule).length, 0) });
    }
  }
  return files;
}

// The map a cell resolves against: the base values, overlaid with what the
// cell's own rule (its selector, under its at-rules) declares. One flat map let
// the last theme in the project answer for every column, so a light row's
// `var(--surface)` was drawn in the dark theme's colour (issue #69). The base is
// what rules outside any at-rule declare first; a theme overrides it after.
//
// A `<style>` block is its own scope, overlaid with the rest of its file: a page's
// `:root` must not answer for a stylesheet's `:root`, nor for another page's.
// Stylesheets are read first, so they are the base wherever a name is in both.
function variableScopes(files: readonly FileModel[]) {
  const base = new Map<string, string>();
  const fallback = new Map<string, string>();
  const scopes = new Map<string, Map<string, string>>();
  const scopeOfEntry = new Map<string, string>();
  const fileBases = new Map<string, Map<string, string>>();
  for (const file of files) {
    const astro = isAstroFile(file.rel);
    const fileBase = new Map<string, string>();
    if (astro) {
      fileBases.set(file.rel, fileBase);
    }
    for (const rule of file.declarations || []) {
      const scope = `${astro ? file.rel : ''}\n${rule.context.join('\n')}\n${rule.selector}`;
      const declared = scopes.get(scope) ?? new Map<string, string>();
      scopes.set(scope, declared);
      for (const entry of rule.entries) {
        if (entry.kind !== 'var') {
          continue;
        }
        declared.set(entry.name, entry.value);
        scopeOfEntry.set(`${file.rel}:${entry.valueStart}`, scope);
        if (!fallback.has(entry.name)) {
          fallback.set(entry.name, entry.value);
        }
        if (rule.context.length === 0) {
          if (!base.has(entry.name)) {
            base.set(entry.name, entry.value);
          }
          if (!fileBase.has(entry.name)) {
            fileBase.set(entry.name, entry.value);
          }
        }
      }
    }
  }
  assert(base.size <= fallback.size, 'Base values are a subset of every declared name');
  const merged = new Map<string, Map<string, string>>();
  const mapFor = (cell: Cell): Map<string, string> => {
    const scope = scopeOfEntry.get(`${cell.file}:${cell.valueStart}`);
    assert(scope !== undefined, 'Every described cell was read from a rule');
    const known = merged.get(scope);
    if (known !== undefined) {
      return known;
    }
    const map = new Map([...fallback, ...base, ...(fileBases.get(cell.file) ?? []), ...(scopes.get(scope) ?? [])]);
    assert(map.has(cell.name), 'A cell resolves in a scope that declares it');
    merged.set(scope, map);
    return map;
  };
  return { mapFor };
}
