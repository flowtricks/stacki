// i18n-ignore-file: the returned words are variable type ids (Color, Size, FontFamily, …) that pickers compare, never shown as text here.
// The project's variables, fonts and image assets, as the style panel's
// pickers offer them, and the two facts about a rule they are read by: its
// selector and whether it is global (webflow.ts).

import { splitEmbed } from './css';
import postcss from 'postcss';
import { getHost, onHostChange, walkNodes } from './host';
import type { StyleRegion } from './styleTypes';
import { listAssetEntries } from '../../../ipc/assetBridge';
import { readAstroStyleFiles, readStyleFiles } from '../stylePanelBridge';
import { variableEdit } from '../../../ipc/variableEditBridge';
import { readCSSVariables, type VariablesSnapshot } from '../../../ipc/variablesBridge';
import { onVariablesChanged } from '../../../ipc/editorEnvironment';
import { projectRelative } from '../../../editor/variablePlace';

// Model kinds that render exactly one element (so CSS counts them as a child),
// and kinds whose element count can't be known without running the page.
// Everything else (text, comment, raw-line) renders no element at all.
// A custom property's group is the selector of the rule declaring it; one set
// at the root of a sheet (or inside an at-rule) has none.
export function ruleSelectorOf(parent: unknown): string {
  if (typeof parent === 'object' && parent !== null) {
    if ('selector' in parent) {
      return typeof parent.selector === 'string' ? parent.selector : '';
    }
  }
  return '';
}

// ───────────────────────────── Reading & writing ─────────────────────────────

// Both kinds are raw CSS: a stylesheet is a file of it, and a <style> node
// holds only its inner text — the app keeps the tag itself in the model. So
// each is one region spanning the whole text. (A Webflow embed was HTML with
// <style> blocks inside it, which is why the original had to split it.)
/** Is this `<style>` block global — i.e. does it style the page rather than
 *  only its own component? A block with no opening tag recorded (a stylesheet)
 *  is global by definition. */
export function isGlobalRegion(region: StyleRegion): boolean {
  return region.openTag === undefined || /\bis:global\b/.test(region.openTag);
}

// ───────────────────────── Variables, fonts, assets ─────────────────────────

export type ProjectVariable = {
  collection: string;
  group: string;
  name: string;
  value: string;
  binding: string;
  type: string;
  /** The project-relative Astro file whose `<style>` declares it; absent for a stylesheet's. */
  readonly file?: string;
};

// The panel filters the picker by variable type, and it speaks Webflow's
// vocabulary — notably 'Color' and 'FontFamily', which it treats specially
// (a colour field offers only Color variables, font-family only FontFamily).
// A custom property has no declared type, so infer one; CSS.supports is the
// accurate test, with a regex fallback for non-DOM contexts.
export const supports = (prop: string, value: string): boolean => {
  try {
    return typeof CSS !== 'undefined' && CSS.supports(prop, value);
  } catch {
    return false;
  }
};

// The CSS-wide keywords are valid for EVERY property, so CSS.supports() types them as
// whatever it's asked about first (Color). They're keywords — treat them as such.
export const CSS_WIDE_RE = /^(inherit|initial|unset|revert|revert-layer)$/i;

export const varKind = (name: string, value: string): string => {
  const trimmed = value.trim();
  if (CSS_WIDE_RE.test(trimmed)) {
    return 'String';
  }
  // A value that still carries a var() reference (an alias into CSS we never read, or a
  // fallback chain) is untyped as far as CSS.supports() goes: an unresolved reference
  // parses as valid for EVERY property, so `--h6-font-family: var(--primary-family)`
  // came back as a Color — and then the font field's picker, which shows only
  // FontFamily, had nothing to show. Ask CSS.supports only about resolved values and
  // leave the rest to the literal-syntax regexes, which need real syntax to match.
  const unresolved = /var\(/i.test(trimmed);
  if ((!unresolved && supports('color', trimmed)) || /^#|^rgba?\(|^hsla?\(|^color(-mix)?\(/i.test(trimmed)) {
    return 'Color';
  }
  // Fluid sizing — `clamp(var(--space-5-min) / 16 * 1rem, …)` — keeps var() references
  // inside it that we can't resolve, but math functions only ever produce a length or a
  // number, so the wrapper alone is enough to call it a Size.
  if (/^(calc|clamp|min|max)\(/i.test(trimmed)) {
    return 'Size';
  }
  if ((!unresolved && supports('width', trimmed)) || /^-?[\d.]+(px|rem|em|%|vw|vh|vmin|vmax|ch|ex|pt|cm|mm|in)$/i.test(trimmed)) {
    return 'Size';
  }
  if (/^-?[\d.]+$/.test(trimmed)) {
    return 'Number';
  }
  // Nothing in the value to go on — a font stack has no distinguishing syntax, so the
  // last hint is the name it was given.
  if (/font-?family/i.test(name)) {
    return 'FontFamily';
  }
  return 'String';
};

// Follow a variable that is nothing but a reference to another one
// (`--h6-letter-spacing: var(--letter-spacing-tight)`) to the literal value at the end
// of the chain, so varKind has real syntax to read. Falls back to the var()'s own
// fallback, then gives up and returns what it was handed.
export const ALIAS_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([\s\S]*))?\)$/;
// Hops followed before giving up: a chain this long is a cycle, not a design.
export const ALIAS_LIMITS = { depthMax: 8 } as const;
export function resolveAlias(value: string, values: Map<string, string>, depth = 0): string {
  const trimmed = value.trim();
  if (depth > ALIAS_LIMITS.depthMax) {
    return trimmed;
  }
  const match = ALIAS_RE.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  const target = values.get((match[1] ?? '').slice(2));
  if (target !== undefined) {
    return resolveAlias(target, values, depth + 1);
  }
  const fallback = match[2]?.trim();
  return fallback ? resolveAlias(fallback, values, depth + 1) : trimmed;
}

// Custom properties declared anywhere in the project's CSS. The rule they sit
// in is the closest thing to Webflow's collection, so it groups them.
export async function readAllProjectCss(): Promise<Array<{ label: string; css: string }>> {
  return [...(await readStylesheetCss()), ...(await readAstroGlobalCss()), ...readOpenFileCss()];
}

async function readStylesheetCss(): Promise<Array<{ label: string; css: string }>> {
  const host = getHost();
  const out: Array<{ label: string; css: string }> = [];
  // Ask for the stylesheet list rather than trusting host.files: the variable
  // scan is kicked off once and its result is cached for the session, so if it
  // happened to run before the async file list arrived it would cache "no
  // variables" forever.
  let files = host.files;
  if (!files.length && host.projectPath) {
    try {
      const result = await readStyleFiles(host.projectPath);
      files = result.ok ? [...result.value] : [];
    } catch {
      files = [];
    }
  }
  // All at once. These were read one after another, which on a project with a
  // dozen stylesheets is a dozen round trips end to end — and this runs while the
  // panel is doing its own cold scan, so the two were queueing behind each other.
  // Promise.all keeps the order, so the cascade still reads as it does on disk.
  const read = await Promise.all(
    files.map(async (file) => {
      try {
        const result = await variableEdit('readStyleFile', file.path);
        return { label: file.rel, css: result.ok ? (result.css ?? '') : '' };
      } catch {
        return undefined; // unreadable — skip it rather than fail the whole scan
      }
    }),
  );
  for (const entry of read) {
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

// A component's global blocks, for what is read off every rule (font families).
// Variables come from the panel's reader instead, which knows the template.
async function readAstroGlobalCss(): Promise<Array<{ label: string; css: string }>> {
  const host = getHost();
  const out: Array<{ label: string; css: string }> = [];
  let astro = host.astroFiles;
  if (!astro.length && host.projectPath) {
    try {
      const result = await readAstroStyleFiles(host.projectPath);
      astro = result.ok ? [...result.value] : [];
    } catch {
      astro = [];
    }
  }
  const readAstro = await Promise.all(
    astro.map(async (file) => {
      try {
        const result = await variableEdit('readStyleFile', file.path);
        return { name: file.name, css: result.ok ? (result.css ?? '') : '' };
      } catch {
        return undefined; // unreadable — skip it rather than fail the whole scan
      }
    }),
  );
  for (const entry of readAstro) {
    if (!entry) {
      continue;
    }
    for (const region of splitEmbed(entry.css).regions) {
      if (isGlobalRegion(region)) {
        out.push({ label: entry.name, css: region.css });
      }
    }
  }
  return out;
}

// The open file's blocks come from its model, so they hold what is on the canvas.
// Each carries the file it is in: the list outlives the page, and on the next one
// these must not read as stylesheet variables (variablePlace.ts).
function readOpenFileCss(): Array<{ label: string; css: string; file?: string }> {
  const host = getHost();
  const file = projectRelative(host.projectPath, host.openFilePath);
  const out: Array<{ label: string; css: string; file?: string }> = [];
  walkNodes(host.nodes, (node) => {
    if (node.kind === 'raw' && node.name === 'style') {
      out.push({ label: '<style>', css: String(node.inner ?? ''), ...(file === undefined ? {} : { file }) });
    }
  });
  return out;
}

// Every `<style>` variable in the project, as the Variables panel reads them. One
// reader means the picker sees every block the panel does, `is:inline` and scoped
// ones too, and none of what is only text in a comment, a string or an expression.
async function readBlockVariables(): Promise<VariablesSnapshot | undefined> {
  const { projectPath } = getHost();
  if (projectPath === undefined) {
    return undefined;
  }
  const result = await readCSSVariables(projectPath);
  return result.ok ? result.value : undefined;
}

type BlockVariable = { readonly collection: string; readonly group: string; readonly name: string; readonly value: string; readonly file: string };

function blockVariables(snapshot: VariablesSnapshot | undefined): readonly BlockVariable[] {
  const found: BlockVariable[] = [];
  for (const file of snapshot?.files ?? []) {
    for (const group of file.groups) {
      if (group.scope === undefined) {
        continue;
      }
      for (const block of group.blocks) {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            if (cell !== undefined) {
              found.push({ collection: file.name, group: cell.selector, name: cell.name.slice(2), value: cell.value.trim(), file: file.rel });
            }
          }
        }
      }
    }
  }
  return found;
}

// The panel kicks the variable scan off once and caches the result for the
// session, so an early call that found nothing would leave the picker empty
// for good. Wait for the host to actually have a project before scanning.
export function whenProjectReady(timeoutMs = 4000): Promise<void> {
  if (getHost().projectPath) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = onHostChange(() => {
      if (getHost().projectPath) {
        done();
      }
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

// `onChanged` runs once, at the next change to the project's variables: what this
// read returns is out of date from then on. It listens from before the first read,
// so a change made during the read is not missed.
export async function streamProjectVariables(
  onAdd: (v: ProjectVariable) => void,
  isCancelled: () => boolean = () => false,
  onChanged?: () => void,
): Promise<ProjectVariable[]> {
  if (onChanged !== undefined) {
    const stop = onVariablesChanged(() => {
      stop();
      onChanged();
    });
  }
  await whenProjectReady();
  const all: ProjectVariable[] = [];
  // One entry per name in each file, not per name: a page and a stylesheet may both
  // declare `--accent`, and which one the picker offers depends on the page open
  // when it opens (useSharedVars), long after this list was read.
  const seen = new Set<string>();
  const keyOf = (file: string | undefined, name: string): string => `${file ?? ''}\u0000${name}`;
  // Parse everything up front and index every custom property by name: a variable's type
  // often lives in the variable it aliases (`--h6-font-family: var(--font-display)`),
  // which may be declared in a file we haven't reached yet, so the whole map has to exist
  // before the first type is inferred.
  const parsed: Array<{ label: string; file: string | undefined; root: ReturnType<typeof postcss.parse> }> = [];
  const values = new Map<string, string>();
  // The open file first: where a name is declared twice, its own value is the one
  // this page has. The picker keeps one entry per name, and the canvas decides which
  // of them reach the selected element (useDefinedVariables).
  const sources: ReadonlyArray<{ readonly label: string; readonly css: string; readonly file?: string }> = [
    ...readOpenFileCss(),
    ...(await readStylesheetCss()),
  ];
  for (const { label, css, file } of sources) {
    if (isCancelled()) {
      break;
    }
    let root;
    try {
      root = postcss.parse(css);
    } catch {
      continue;
    }
    parsed.push({ label, file, root });
    root.walkDecls((decl) => {
      const key = decl.prop.startsWith('--') ? decl.prop.slice(2) : undefined;
      if (key && !values.has(key)) {
        values.set(key, decl.value.trim());
      }
    });
  }
  const snapshot = await readBlockVariables();
  const inBlocks = blockVariables(snapshot);
  for (const { name, value } of inBlocks) {
    if (!values.has(name)) {
      values.set(name, value);
    }
  }
  for (const { label, file, root } of parsed) {
    if (isCancelled()) {
      break;
    }
    root.walkDecls((decl) => {
      if (!decl.prop.startsWith('--')) {
        return;
      }
      const name = decl.prop.slice(2);
      if (seen.has(keyOf(file, name))) {
        return;
      }
      seen.add(keyOf(file, name));
      const variable: ProjectVariable = {
        collection: label,
        group: ruleSelectorOf(decl.parent) || ':root',
        name,
        value: decl.value.trim(),
        binding: `var(${decl.prop})`,
        type: varKind(name, resolveAlias(decl.value, values)),
        ...(file === undefined ? {} : { file }),
      };
      all.push(variable);
      onAdd(variable);
    });
  }
  for (const { collection, group, name, value, file } of inBlocks) {
    if (isCancelled()) {
      break;
    }
    if (!seen.has(keyOf(file, name))) {
      seen.add(keyOf(file, name));
      const variable: ProjectVariable = { collection, group, name, value, binding: `var(--${name})`, type: varKind(name, resolveAlias(value, values)), file };
      all.push(variable);
      onAdd(variable);
    }
  }
  return all;
}

export async function getProjectFontFamilies(): Promise<string[]> {
  await whenProjectReady();
  const families = new Set<string>();
  for (const { css } of await readAllProjectCss()) {
    let root;
    try {
      root = postcss.parse(css);
    } catch {
      continue;
    }
    root.walkDecls(/^font-family$/i, (decl) => {
      for (const part of decl.value.split(',')) {
        const name = part.trim().replace(/^['"]|['"]$/g, '');
        if (name && !name.startsWith('var(')) {
          families.add(name);
        }
      }
    });
    root.walkAtRules(/^font-face$/i, (rule) => {
      rule.walkDecls(/^font-family$/i, (decl) => {
        const name = decl.value.trim().replace(/^['"]|['"]$/g, '');
        if (name) {
          families.add(name);
        }
      });
    });
  }
  return [...families].sort((left, right) => left.localeCompare(right));
}

export type ImageAsset = { id: string; name: string; url: string };

export async function getImageAssets(): Promise<ImageAsset[]> {
  const host = getHost();
  if (!host.projectPath) {
    return [];
  }
  try {
    const result = await listAssetEntries(host.projectPath);
    if (!result.ok) {
      return [];
    }
    return result.value
      .filter((entry) => !entry.isDir && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(entry.name))
      .map((entry) => ({ id: entry.rel, name: entry.name, url: `/${entry.rel}` }));
  } catch {
    return [];
  }
}
