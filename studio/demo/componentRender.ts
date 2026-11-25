// Component instances rendered from the bake's templates (componentTemplates.ts).
// An existing instance is re-rendered in the baked page's own text, before the page is
// parsed: its run between its anchor comments is the template's old output with the
// slot content in between, so the slot content is lifted out as written and put back
// into the new output untouched. Everything else on the page stays as baked.
import { assert } from '../vendor/stacki/shared/core/assert';
import type { Attr } from '../vendor/stacki/shared/page/pageNodeTypes';
import { BAKE_HEAD_INSERTION } from '../src/features/bake/bakeHtml';
import {
  entryInstancesKey,
  joinOutput,
  renderTemplate,
  transitionScopes,
  type ComponentCatalog,
  type ComponentTemplate,
  type TemplateOutput,
} from '../src/features/bake/componentTemplates';

/** An instance whose props or slots changed, by its baked path. */
export interface ComponentEdit {
  readonly path: string;
  /** The component file, when the page's import resolves; undefined otherwise. */
  readonly file: string | undefined;
  readonly attrs: Readonly<Record<string, Attr>>;
  readonly slots: readonly string[];
}

/** A new instance, as the page now writes it. */
export interface ComponentUse {
  readonly file: string | undefined;
  readonly path: string;
  readonly attrs: Readonly<Record<string, Attr>>;
  readonly slots: readonly string[];
}

const TEMPLATE_TRIES_MAX = 64;

/** The attributes a template's base was rendered with. */
export function baseAttrs(template: ComponentTemplate): Readonly<Record<string, Attr>> {
  const attrs: Record<string, Attr> = { ...template.fixed };
  for (const [name, prop] of Object.entries(template.props)) {
    if (prop.attr !== undefined) {
      attrs[name] = prop.attr;
    }
  }
  return attrs;
}

/** The instance's template: the entry's own when the instance depends on the entry,
 * otherwise the page file's, which every entry shares. */
function instanceTemplate(catalog: ComponentCatalog, page: string, path: string, entry?: string): ComponentTemplate | undefined {
  const own = entry === undefined ? undefined : catalog.instances[entryInstancesKey(page, entry)]?.[path];
  const index = own ?? catalog.instances[page]?.[path];
  return index === undefined ? undefined : catalog.templates[index];
}

/** Any template of the file that renders this use: the instance's own first, then
 * every other use of the component the bake saw, recipes included. */
export function renderUse(
  catalog: ComponentCatalog,
  use: ComponentUse,
  own: ComponentTemplate | undefined,
  scopes: readonly string[] = [],
): TemplateOutput | undefined {
  const candidates = [own, ...catalog.templates.filter((template) => template.file === use.file && template !== own)];
  for (const template of candidates.slice(0, TEMPLATE_TRIES_MAX)) {
    if (template !== undefined && use.file !== undefined && template.file === use.file) {
      const result = renderTemplate(template, use.attrs, use.slots, use.path, scopes);
      if (result.ok) {
        return result.output;
      }
    }
  }
  return undefined;
}

/** Whether the demo can show this edit at all, for refusing it before it lands. */
export function canRenderEdit(catalog: ComponentCatalog, page: string, edit: ComponentEdit, entry?: string): boolean {
  const own = instanceTemplate(catalog, page, edit.path, entry);
  return own !== undefined && renderUse(catalog, edit, own) !== undefined;
}

export function canRenderUse(catalog: ComponentCatalog, use: ComponentUse): boolean {
  return renderUse(catalog, use, undefined) !== undefined;
}

/** Whether any template could re-render the instance at this path. */
export function hasTemplate(catalog: ComponentCatalog, page: string, path: string, entry?: string): boolean {
  return instanceTemplate(catalog, page, path, entry) !== undefined;
}

/** Lifts each slot's content out of `run`, given the old output the run was made from.
 * Undefined when the run is not that output: something the template cannot see. The
 * text before the first slot and after the last is matched at the run's two ends, so
 * a slot's own content can never be mistaken for the markup around it. */
export function liftSlots(run: string, output: TemplateOutput): ReadonlyMap<string, string> | undefined {
  const texts: string[] = [''];
  const names: string[] = [];
  for (const part of output) {
    if (typeof part === 'string') {
      texts[texts.length - 1] += part;
    } else {
      names.push(part.slot);
      texts.push('');
    }
  }
  assert(texts.length === names.length + 1, 'Slots alternate with the text around them');
  const head = texts[0] ?? '';
  const tail = texts[texts.length - 1] ?? '';
  if (names.length === 0) {
    return run === head ? new Map() : undefined;
  }
  if (run.length < head.length + tail.length || !run.startsWith(head) || !run.endsWith(tail)) {
    return undefined;
  }
  const slots = new Map<string, string>();
  const end = run.length - tail.length;
  let position = head.length;
  for (let index = 0; index < names.length; index++) {
    const separator = texts[index + 1] ?? '';
    const last = index === names.length - 1;
    const stop = last ? end : run.indexOf(separator, position);
    if (stop < position || stop > end) {
      return undefined;
    }
    slots.set(names[index] ?? '', run.slice(position, stop));
    position = last ? end : stop + separator.length;
  }
  return slots;
}

function anchors(path: string): { readonly start: string; readonly end: string } {
  return { start: `<!--avb-s:${path}-->`, end: `<!--avb-e:${path}-->` };
}

/** Re-renders each edited instance in the baked page's text. Inner instances first, so
 * an outer one lifts slot content that already holds them. Returns the edits it could
 * not show. */
export function renderEditsInText(
  html: string,
  edits: readonly ComponentEdit[],
  catalog: ComponentCatalog,
  page: string,
  entry?: string,
): { readonly html: string; readonly failed: readonly ComponentEdit[] } {
  const failed: ComponentEdit[] = [];
  let result = html;
  const ordered = [...edits].sort((left, right) => right.path.split('.').length - left.path.split('.').length);
  for (const edit of ordered) {
    const next = renderEditInText(result, edit, catalog, page, entry);
    if (next === undefined) {
      failed.push(edit);
    } else {
      result = next;
    }
  }
  return { html: result, failed };
}

function renderEditInText(html: string, edit: ComponentEdit, catalog: ComponentCatalog, page: string, entry: string | undefined): string | undefined {
  const own = instanceTemplate(catalog, page, edit.path, entry);
  const run = own === undefined ? undefined : locateRun(html, edit.path);
  if (own === undefined || run === undefined) {
    return undefined; // Not on the page, or rendered more than once (a loop): Astro's to redo.
  }
  // The run's own transition scopes, so the template reproduces it and the edit keeps them.
  const scopes = transitionScopes(html.slice(run.start, run.end));
  const before = renderTemplate(own, baseAttrs(own), own.slots, edit.path, scopes);
  const after = renderUse(catalog, edit, own, scopes);
  if (!before.ok || after === undefined) {
    return undefined;
  }
  // A run found by its element sits in a slot whose comments its parent stripped, so
  // the template's comments go too; the markup around them must still match exactly.
  const shape = (output: TemplateOutput) => trimOutput(run.anchored ? output : withoutComments(output));
  // The page indents the instance; the template knows nothing of the indent. The
  // whitespace around the run stays as the page wrote it.
  const text = html.slice(run.start, run.end);
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  const tail = text.length > lead.length ? (/\s*$/.exec(text)?.[0] ?? '') : '';
  const body = text.slice(lead.length, text.length - tail.length);
  // Astro writes some things once per page, with the first instance that asks: a
  // deduplicated component script, and the head's stylesheets and scripts. A probe
  // renders after the page has, so its template lacks them; the run has them. They are
  // set aside, the run is lifted without them, and they go back where they were.
  const once =
    liftSlots(body, shape(before.output)) === undefined
      ? pageOnce(
          body,
          joinOutput(shape(before.output), () => ''),
        )
      : undefined;
  const slots = liftSlots(once?.text ?? body, shape(before.output));
  if (slots === undefined) {
    return undefined;
  }
  for (const part of after) {
    if (typeof part !== 'string' && !slots.has(part.slot)) {
      return undefined; // The new state shows a slot the old one never rendered.
    }
  }
  const rendered = joinOutput(shape(after), (name) => slots.get(name) ?? '');
  const restored = once === undefined ? rendered : restorePageOnce(rendered, once);
  return restored === undefined ? undefined : html.slice(0, run.start) + lead + restored + tail + html.slice(run.end);
}

/** Elements Astro writes once per page rather than once per instance, with the line
 * break Astro writes after each one it injects into the head. */
const PAGE_ONCE = new RegExp(
  // The bake's own insertion after the head tag first, exactly, with no line break of its own.
  `${BAKE_HEAD_INSERTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|(?:<script\\b[^>]*>[\\s\\S]*?<\\/script>|<style\\b[^>]*>[\\s\\S]*?<\\/style>|<link\\b[^>]*>)\\n?`,
  'g',
);
const PAGE_ONCE_MAX = 400;
/** The text before a set-aside element that finds its place again. */
const PAGE_ONCE_CONTEXT_CHARS = 160;

interface PageOnce {
  /** The run without the elements. */
  readonly text: string;
  /** Each element and where it stood in `text`, in order. */
  readonly removed: readonly { readonly position: number; readonly element: string }[];
}

/** Takes out of `run` each page-once element the template does not render itself. */
export function pageOnce(run: string, template: string): PageOnce | undefined {
  const removed: { position: number; element: string }[] = [];
  let text = '';
  let position = 0;
  for (const match of run.matchAll(PAGE_ONCE)) {
    if (template.includes(match[0])) {
      continue;
    }
    if (removed.length >= PAGE_ONCE_MAX) {
      return undefined;
    }
    text += run.slice(position, match.index);
    removed.push({ position: text.length, element: match[0] });
    position = match.index + match[0].length;
  }
  return removed.length === 0 ? undefined : { text: text + run.slice(position), removed };
}

/** Puts each set-aside element back after the text that stood before it, or undefined
 * when the edit changed that text and the element has no place to go. */
export function restorePageOnce(rendered: string, once: PageOnce): string | undefined {
  // Every place is found in the rendering as it came, then the elements go in from the
  // last place back, so no insertion moves a place still to be filled.
  const places: number[] = [];
  let cursor = 0;
  let previous = -1;
  for (const { position } of once.removed) {
    if (position === previous) {
      places.push(cursor); // Elements that stood together go back together, in order.
      continue;
    }
    // Never reaching back past the last place, which the search has already passed.
    const context = once.text.slice(Math.max(0, previous, position - PAGE_ONCE_CONTEXT_CHARS), position);
    previous = position;
    const found = context === '' ? cursor : rendered.indexOf(context, cursor);
    if (found < 0) {
      return undefined;
    }
    cursor = found + context.length;
    places.push(cursor);
  }
  assert(places.length === once.removed.length, 'Every set-aside element has its place');
  let result = rendered;
  // From the last place back; elements sharing a place keep their order.
  for (let index = places.length - 1; index >= 0; index--) {
    const at = places[index] ?? 0;
    result = result.slice(0, at) + (once.removed[index]?.element ?? '') + result.slice(at);
  }
  return result;
}

interface Run {
  readonly start: number;
  readonly end: number;
  /** Found between its anchor comments, rather than by its root element. */
  readonly anchored: boolean;
}

/** Where the instance's rendering sits: between its anchors, or, where a component above
 * it stripped comments from its slot, its one root element, the element that carries
 * the instance's path. Undefined when neither is there exactly once. */
export function locateRun(html: string, path: string): Run | undefined {
  const { start, end } = anchors(path);
  const open = html.indexOf(start);
  if (open >= 0) {
    const close = html.indexOf(end, open);
    if (close < 0 || html.indexOf(start, open + start.length) >= 0) {
      return undefined;
    }
    return { start: open + start.length, end: close, anchored: true };
  }
  // A root that forwards its props names the path twice in one tag; one tag is one root.
  const starts = new Set(
    [...html.matchAll(new RegExp(`data-avb-p="(?:[^"]* )?${escapePattern(path)}"`, 'g'))].map((carrier) => html.lastIndexOf('<', carrier.index)),
  );
  const [tagStart] = starts;
  if (starts.size !== 1 || tagStart === undefined || tagStart < 0) {
    return undefined;
  }
  const close = elementEnd(html, tagStart);
  return close === undefined ? undefined : { start: tagStart, end: close, anchored: false };
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
const ELEMENT_TAGS_MAX = 200_000;

/** The end of the element whose start tag begins at `start`, counting nested elements
 * of the same name; script and style text is skipped whole. */
function elementEnd(html: string, start: number): number | undefined {
  TAG.lastIndex = start;
  const first = TAG.exec(html);
  if (first === null || first.index !== start || first[2] === undefined) {
    return undefined;
  }
  const name = first[2].toLowerCase();
  if (VOID.has(name) || first[3] === '/') {
    return TAG.lastIndex;
  }
  let depth = 1;
  for (let count = 0; count < ELEMENT_TAGS_MAX; count++) {
    const match = TAG.exec(html);
    if (match === null) {
      return undefined;
    }
    const tag = match[2]?.toLowerCase();
    if (tag === 'script' || tag === 'style') {
      if (match[1] !== '/') {
        const closing = html.toLowerCase().indexOf(`</${tag}`, TAG.lastIndex);
        if (closing < 0) {
          return undefined;
        }
        TAG.lastIndex = closing;
      }
    } else if (tag === name) {
      depth += match[1] === '/' ? -1 : 1;
      if (depth === 0) {
        return TAG.lastIndex;
      }
    }
  }
  return undefined;
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withoutComments(output: TemplateOutput): TemplateOutput {
  return output.map((part) => (typeof part === 'string' ? part.replace(/<!--[\s\S]*?-->/g, '') : part));
}

/** The output without whitespace at its two ends. */
function trimOutput(output: TemplateOutput): TemplateOutput {
  const parts = [...output];
  const first = parts[0];
  if (typeof first === 'string') {
    parts[0] = first.trimStart();
  }
  const last = parts[parts.length - 1];
  if (typeof last === 'string') {
    parts[parts.length - 1] = last.trimEnd();
  }
  return parts;
}

/** The component files whose markup a rendering includes, for their styles. */
export function componentFilesIn(html: string): readonly string[] {
  const files = new Set<string>();
  for (const match of html.matchAll(/avb-[se]:(src\/[^|\s"<>]+\.astro)\||data-avb-p="(src\/[^|\s"<>]+\.astro)\|/g)) {
    files.add(match[1] ?? match[2] ?? '');
  }
  files.delete('');
  return [...files];
}
