// Where a project's custom properties can be declared, as text the CSS tools
// can read: a stylesheet is one section, an Astro file is one section per
// `<style>` block. Each section's `view` is the file with everything outside the
// section blanked, so every offset and line postcss reports is already the
// file's own and an edit needs no translation (cssVars.ts).

import postcss from 'postcss';
import type { Rule as PostcssRule, Root } from 'postcss';
import path from 'path';
import { assert } from '../../shared/core/assert';
import { readAstroSheet, type StyleBlockWriting, type StyleRegion } from '../documents/astroStyleBlocks';
import { CSS_VARIABLE_LIMITS, SKIPPED_DIRECTORIES, readDeclarations, toPosix, type Rule } from './cssVarRead';
import { variableFiles as fs } from './variableWorkspace';

/** Who a `<style>` block's declaration reaches. A stylesheet has no reach: it is project CSS. */
export type VariableReach = 'page' | 'rendered' | 'scoped';

export interface VariableScope {
  readonly reach: VariableReach;
  readonly written: Exclude<StyleBlockWriting, 'stylesheet'>;
}

export interface CssSection {
  readonly start: number;
  readonly end: number;
  /** The file's text with everything but this section blanked; same length, same lines. */
  readonly view: string;
  readonly written: StyleBlockWriting;
}

export const isAstroFile = (file: string): boolean => /\.astro$/i.test(file);

// A declaration, as opposed to a BEM class (`.card--wide`) or a `var(--x)`. Files
// without one skip the parser: most pages declare nothing, and this runs on every read.
const DECLARATION = /--[^\s:;{}()'"\\,]+\s*:/;

/** Every `.astro` file under `src`, the only place Astro takes pages and components from. */
export function findAstroSources(projectPath: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > CSS_VARIABLE_LIMITS.stylesheetDepthMax) {
      return;
    }
    let entries: ReturnType<typeof fs.readdirSync>;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (isAstroFile(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(path.join(projectPath, 'src'), 0);
  return [...new Set(found)].sort();
}

// A `<style>` in an expression is left out: whether it renders is decided at run
// time, so listing it would state a value the page may never have.
function unconditionalRegions(rel: string, text: string): { readonly regions: readonly StyleRegion[]; readonly unreadable: string | undefined } {
  const sheet = readAstroSheet(rel, text);
  return { regions: sheet.regions.filter((region) => !region.conditional), unreadable: sheet.unreadable };
}

function blankOutside(text: string, start: number, end: number): string {
  assert(start >= 0, 'blankOutside: the section starts inside the file');
  assert(end <= text.length, 'blankOutside: the section ends inside the file');
  const blank = (part: string): string => part.replace(/[^\n]/g, ' ');
  const view = blank(text.slice(0, start)) + text.slice(start, end) + blank(text.slice(end));
  assert(view.length === text.length, 'blankOutside: blanking keeps the length');
  return view;
}

/** The sections of `file` that hold CSS, in file order. */
export function cssSections(file: string, text: string): readonly CssSection[] {
  if (!isAstroFile(file)) {
    return [{ start: 0, end: text.length, view: text, written: 'stylesheet' }];
  }
  return unconditionalRegions(file, text).regions.map((region) => {
    const end = region.start + region.text.length;
    return { start: region.start, end, view: blankOutside(text, region.start, end), written: region.written };
  });
}

export type FoundRule =
  { readonly ok: true; readonly rule: PostcssRule; readonly root: Root; readonly section: number } | { readonly ok: false; readonly error: string };

interface RuleQuery {
  readonly file: string;
  readonly selector: string;
  /** A name the rule must declare, which is how two blocks of one file are told apart. */
  readonly declares?: string | undefined;
  /** The section to look in, when the edit already knows it. */
  readonly section?: number | undefined;
}

function rulesIn(root: Root, selector: string): PostcssRule[] {
  const matches: PostcssRule[] = [];
  root.walkRules((candidate) => {
    if (candidate.selector === selector) {
      matches.push(candidate);
    }
  });
  return matches;
}

const declaresName = (rule: PostcssRule, name: string): boolean => (rule.nodes ?? []).some((node) => node.type === 'decl' && node.prop === name);

/**
 * The rule an edit means. A stylesheet's is the first with that selector. An
 * Astro file can hold that selector in several blocks: the one declaring
 * `declares` is meant, and when that still leaves two the edit is refused, since
 * writing to whichever came first could be the wrong block.
 */
export function findRule(text: string, { file, selector, declares, section }: RuleQuery): FoundRule {
  const sections = cssSections(file, text);
  const hits: Array<Extract<FoundRule, { ok: true }>> = [];
  for (const [index, candidate] of sections.entries()) {
    if (section !== undefined && section !== index) {
      continue;
    }
    const root = postcss.parse(candidate.view);
    const matches = rulesIn(root, selector);
    const rule = (declares === undefined ? undefined : matches.find((match) => declaresName(match, declares))) ?? matches[0];
    if (rule !== undefined) {
      hits.push({ ok: true, rule, root, section: index });
    }
  }
  const declaring = declares === undefined ? hits : hits.filter((hit) => declaresName(hit.rule, declares));
  const candidates = declaring.length > 0 ? declaring : hits;
  const first = candidates[0];
  if (first === undefined) {
    return { ok: false, error: `${selector} is no longer in ${file}.` };
  }
  if (candidates.length > 1) {
    return { ok: false, error: `${selector} is in more than one <style> block of ${file}. Edit this one in the code.` };
  }
  return first;
}

/** The position among `file`'s sections of the one holding `offset`, if any does. */
export function sectionAt(file: string, text: string, offset: number): number | undefined {
  const index = cssSections(file, text).findIndex((section) => section.start <= offset && offset <= section.end);
  return index === -1 ? undefined : index;
}

/** Why `next` may not replace `text`: a write to an Astro file changes what is inside its `<style>` blocks and nothing else. */
export function styleWriteProblem(file: string, text: string, next: string): string | undefined {
  if (!isAstroFile(file)) {
    return undefined;
  }
  const outside = (source: string): string | undefined => {
    const { regions } = readAstroSheet(file, source);
    let cursor = 0;
    let kept = '';
    for (const region of regions) {
      kept += `${source.slice(cursor, region.start)}\u0000`;
      cursor = region.start + region.text.length;
    }
    return kept + source.slice(cursor);
  };
  return outside(text) === outside(next) ? undefined : 'That would change the file outside its <style> block, so it was not saved.';
}

export type AstroVariables =
  | { readonly kind: 'none' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'rules'; readonly sections: ReadonlyArray<{ readonly scope: VariableScope; readonly rules: readonly Rule[] }> };

// Astro leaves these unhashed in a plain `<style>`, checked against its compiler:
// `:root { --a: 1 }` stays `:root`, while `.a { --a: 1 }` gains `:where(.astro-…)`.
const UNSCOPED_SELECTOR = /^(?::root|html|body|:global\(.*\))$/i;

function reachOf(rule: Rule, rel: string, written: VariableScope['written']): VariableReach {
  const page = /^src\/pages\//.test(rel);
  if (written === 'scoped') {
    const nested = rule.context.some((part) => !part.startsWith('@'));
    const unhashed = rule.selectors.every((selector) => UNSCOPED_SELECTOR.test(selector.trim()));
    if (nested || !unhashed) {
      return 'scoped';
    }
  }
  return page ? 'page' : 'rendered';
}

/** The custom properties an Astro file's `<style>` blocks declare, one section per block and reach. */
export function readAstroVariables(rel: string, text: string): AstroVariables {
  if (!DECLARATION.test(text)) {
    return { kind: 'none' };
  }
  const { regions, unreadable } = unconditionalRegions(rel, text);
  const sections: Array<{ readonly scope: VariableScope; readonly rules: readonly Rule[] }> = [];
  for (const region of regions) {
    if (!DECLARATION.test(region.text)) {
      continue;
    }
    assert(region.written !== 'stylesheet', 'readAstroVariables: an Astro region is a block');
    const { written } = region;
    let rules: Rule[];
    try {
      rules = readDeclarations(blankOutside(text, region.start, region.start + region.text.length));
    } catch (error: unknown) {
      return { kind: 'error', message: `The <style> block on line ${region.line}: ${error instanceof Error ? error.message : String(error)}` };
    }
    for (const reach of ['page', 'rendered', 'scoped'] as const) {
      const members = rules.filter((rule) => reachOf(rule, rel, written) === reach);
      if (members.length > 0) {
        sections.push({ scope: { reach, written }, rules: members });
      }
    }
  }
  if (sections.length > 0) {
    return { kind: 'rules', sections };
  }
  return unreadable === undefined ? { kind: 'none' } : { kind: 'error', message: unreadable };
}

/** The names `text` declares in its `<style>` blocks; none when they cannot be read. */
export function astroDeclaredNames(rel: string, text: string): readonly string[] {
  const read = readAstroVariables(rel, text);
  if (read.kind !== 'rules') {
    return [];
  }
  return read.sections.flatMap((section) => section.rules.flatMap((rule) => rule.entries.flatMap((entry) => (entry.kind === 'var' ? [entry.name] : []))));
}

export const relativeTo = (projectPath: string, absolute: string): string => toPosix(path.relative(projectPath, absolute));
