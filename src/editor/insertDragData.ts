// What a drag from the Add elements panel carries: one new node to insert, an HTML tag or one of the editor's own
// node types, never a node of the page. The panel writes it into the drag as text under `avb/insert`; the Navigator
// reads it back at the drop. Drag data can come from any window, so the text is parsed like any other input: a
// payload past its bound, one that is not JSON, or one naming a tag or type the editor cannot insert is no drop at
// all, and the drop that carried it writes nothing.
//
// Kept in the editor layer because both pictures of a drag read it: the Navigator (features/structure) and the
// canvas drag controller (app/state), and the panel that writes it (features/palette) may not import either.
import { assert } from '../../shared/core/assert';
import { HTML_TAGS } from './elementSchemas';

/** The drag data type the Add elements panel sets; the canvas frame and the Navigator accept a drag that has it. */
export const INSERT_DRAG_TYPE = 'avb/insert';

/** The editor's own node types a tile inserts (src/app/model/pageGestures.ts, `insertedNode`). */
export const INSERT_DRAG_CONSTRUCTS = ['map', 'cond', 'text', 'comment', 'expr', 'doctype', 'style', 'script'] as const;
export type InsertDragConstruct = (typeof INSERT_DRAG_CONSTRUCTS)[number];

/** Astro's own image components, from `astro:assets` (src/features/palette/astroAssets.ts names the same two). */
export const INSERT_DRAG_ASSETS = ['Image', 'Picture'] as const;
export type InsertDragAsset = (typeof INSERT_DRAG_ASSETS)[number];

/** Tags beyond HTML_TAGS that are inserted as elements: inline SVG, and Astro's Fragment, Content and slot. */
export const INSERT_DRAG_EXTRA_TAGS = ['svg', 'Fragment', 'Content', 'slot'] as const;

/** One new node a drag or a click inserts. The shape is the insert palette's (src/features/palette/insertItem.ts), narrowed. */
export type InsertDragChoice =
  { readonly type: 'element'; readonly tag: string } | { readonly type: 'astroAsset'; readonly name: InsertDragAsset } | { readonly type: InsertDragConstruct };

// The longest payload text read: the longest choice is a short JSON object, far under this.
const INSERT_DRAG_CHARS_MAX = 256;

const INSERTABLE_TAGS: ReadonlySet<string> = new Set<string>([...HTML_TAGS, ...INSERT_DRAG_EXTRA_TAGS]);

/** Whether `tag` is a tag the panel may insert: every standard HTML tag, inline SVG, and Astro's own three. */
export function isInsertDragTag(tag: string): boolean {
  return INSERTABLE_TAGS.has(tag);
}

/** The text the panel puts on the drag for `choice`; `parseInsertDrag` reads it back to the same choice. */
export function insertDragText(choice: InsertDragChoice): string {
  if (choice.type === 'element') {
    assert(isInsertDragTag(choice.tag), 'insertDragText: the tag is one the panel inserts');
  }
  const text = JSON.stringify(choice);
  assert(text.length <= INSERT_DRAG_CHARS_MAX, 'insertDragText: a payload stays within its bound');
  return text;
}

/** The choice drag text names, or undefined when it names none (`read('avb/insert')` is the empty string for a drag without it). */
export function parseInsertDrag(raw: string): InsertDragChoice | undefined {
  if (raw.length === 0) {
    return undefined;
  }
  if (raw.length > INSERT_DRAG_CHARS_MAX) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const choice = choiceOf(Reflect.get(parsed, 'type'), Reflect.get(parsed, 'tag'), Reflect.get(parsed, 'name'));
  assert(choice === undefined || choice.type !== 'element' || isInsertDragTag(choice.tag), 'parseInsertDrag: a parsed tag is insertable');
  return choice;
}

// The choice the three fields name, read strictly: a field the type does not use must be absent, so a payload that
// says two things at once (an element with a name) is refused rather than half believed.
function choiceOf(type: unknown, tag: unknown, name: unknown): InsertDragChoice | undefined {
  if (type === 'element') {
    if (name !== undefined) {
      return undefined;
    }
    return typeof tag === 'string' && isInsertDragTag(tag) ? { type: 'element', tag } : undefined;
  }
  if (type === 'astroAsset') {
    if (tag !== undefined) {
      return undefined;
    }
    const asset = INSERT_DRAG_ASSETS.find((candidate) => candidate === name);
    return asset === undefined ? undefined : { type: 'astroAsset', name: asset };
  }
  const construct = INSERT_DRAG_CONSTRUCTS.find((candidate) => candidate === type);
  if (construct === undefined) {
    return undefined;
  }
  if (tag !== undefined) {
    return undefined;
  }
  return name === undefined ? { type: construct } : undefined;
}
