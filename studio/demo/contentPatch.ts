// A content collection edit, shown where the page shows the field. The bake recorded
// which baked pages hold an entry field as the whole text of an element or an
// attribute; an edit to that field replaces exactly that text on those pages. A field shown any other way (formatted, truncated, through markdown, or on
// a page the bake could not render) keeps the edit and says it shows after a build.
import type { SnapshotContent } from '../src/features/bake/bakeSnapshot';
import { entryNow } from './contentRoutes';

const TEXT_WALK_MAX = 50_000;
const TEXT_ATTRIBUTES = ['content', 'title', 'alt', 'aria-label', 'placeholder'] as const;

export interface FieldChange {
  readonly before: string;
  readonly after: string;
  readonly pages: readonly string[];
}

function fieldOf(data: unknown, field: string): unknown {
  return typeof data === 'object' && data !== null ? Object.entries(data).find(([key]) => key === field)?.[1] : undefined;
}

/** Every recorded field whose text an edit changed, and whether anything else changed
 * that no page patch can show (another field, the body). */
export function contentChanges(
  content: SnapshotContent | undefined,
  edited: ReadonlyMap<string, string>,
  baked: (file: string) => string | undefined,
): { readonly fields: readonly FieldChange[]; readonly unshown: boolean } {
  const fields: FieldChange[] = [];
  let unshown = false;
  for (const ref of content?.fields ?? []) {
    const text = edited.get(ref.file);
    const original = baked(ref.file);
    if (text !== undefined && original !== undefined) {
      const before = fieldOf(entryNow(original, ref.file, ref.locator)?.data, ref.field);
      const after = fieldOf(entryNow(text, ref.file, ref.locator)?.data, ref.field);
      if (typeof before === 'string' && before !== after) {
        if (typeof after === 'string' && ref.pages.length > 0) {
          fields.push({ before, after, pages: ref.pages });
        } else {
          unshown = true;
        }
      }
    }
  }
  return { fields, unshown };
}

/** Replaces each changed field's text on this page. Returns false when the page was
 * meant to show a field and no longer holds its text as written. */
export function patchContent(document: Document, page: string, fields: readonly FieldChange[]): boolean {
  let complete = true;
  for (const field of fields.filter((change) => change.pages.includes(page))) {
    let found = false;
    const walker = document.createTreeWalker(document.documentElement, 4);
    for (let visited = 0; walker.nextNode() && visited < TEXT_WALK_MAX; visited++) {
      const node = walker.currentNode;
      if (node instanceof Text && node.data.trim() === field.before) {
        node.data = node.data.replace(field.before, field.after);
        found = true;
      }
    }
    const holders = document.querySelectorAll(TEXT_ATTRIBUTES.map((name) => `[${name}]`).join(','));
    for (let index = 0; index < holders.length && index < TEXT_WALK_MAX; index++) {
      const element = holders[index];
      for (const name of TEXT_ATTRIBUTES) {
        const value = element?.getAttribute(name);
        if (element !== undefined && value === field.before) {
          element.setAttribute(name, field.after);
          found = true;
        }
      }
    }
    complete = complete && found;
  }
  return complete;
}
