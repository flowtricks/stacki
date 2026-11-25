// What a baked page and the code reading it agree on. This module runs in Node and
// in the browser, so it imports neither. Bump BAKE_PROTOCOL whenever a baked site
// stops working with a client built against the previous number: marker shape,
// section fences, runtime file names, or the snapshot format.
// 4: a template page's entries are pages that share its file (BakePage.entry).
export const BAKE_PROTOCOL = 4;
export const BAKE_RUNTIME_DIRECTORY = 'stacki-runtime';
export const BAKE_SNAPSHOT_FILE = 'snapshot.json';
/** The attribute on a section's `<style>`. morph.js replaces such tags in place. */
export const BAKE_SECTION_ATTRIBUTE = 'data-vite-dev-id';

export const BAKE_MESSAGES = {
  renderRequest: 'studio:bake-render',
  renderResult: 'studio:bake-render-result',
  /** New text for named style sections, applied in place like Vite's CSS update. */
  styleUpdate: 'studio:bake-style-update',
  /** A prop hover preview: the frame asks for its page rendered with each option of one prop. */
  variantRequest: 'studio:bake-variants',
  /** The frame's preview ended; renders still on their way are dropped. */
  variantCancel: 'studio:bake-variants-cancel',
  /** The option the pointer rests on, rendered next. */
  variantPriority: 'studio:bake-variants-priority',
  /** One option's rendering, or the page as it is when the message carries no value. */
  variantRender: 'studio:bake-variant-render',
  variantFailed: 'studio:bake-variant-failed',
} as const;

/** The parent window's function that hands a frame its current rendering. */
export const BAKE_RENDERING_GLOBAL = '__stackiBakeRendering';

const FENCE = /\.stacki-([se])-([0-9a-f]+)\s*\{\s*--stacki-[se]-[0-9a-f]+:\s*0;?\s*\}\s*/g;

function encodeSection(section: string): string {
  return [...new TextEncoder().encode(section)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeSection(hex: string): string {
  const pairs = hex.match(/../g) ?? [];
  return new TextDecoder().decode(Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16)));
}

// A fence is a real rule on a name no page uses, because that is what survives:
// comments are not guaranteed to, and an `@layer` statement can be hoisted. Fences
// go in after Vite has inlined `@import`, so one cannot void the imports that
// follow it. The declaration is unique too, because a CSS optimizer merges and
// moves identical rules.
export function sectionFences(section: string): { readonly start: string; readonly end: string } {
  const name = encodeSection(section);
  return { start: `.stacki-s-${name}{--stacki-s-${name}:0}`, end: `.stacki-e-${name}{--stacki-e-${name}:0}` };
}

export interface StyleSection {
  /** The authored source, or undefined for CSS the site's own sources did not write. */
  readonly section: string | undefined;
  readonly css: string;
}

/** Cuts finished CSS back into its fenced sections, in order. A broken fence throws:
 * a misplaced section would silently reorder the cascade of every baked page. */
export function splitStyleSections(css: string): readonly StyleSection[] {
  const pieces: StyleSection[] = [];
  let open: string | undefined;
  let position = 0;
  for (const match of css.matchAll(FENCE)) {
    const section = decodeSection(match[2] ?? '');
    const text = css.slice(position, match.index);
    if (text.trim().length > 0) {
      pieces.push({ section: open, css: text });
    } else if (open !== undefined) {
      pieces.push({ section: open, css: '' });
    }
    position = match.index + match[0].length;
    if (match[1] === 's') {
      if (open !== undefined) {
        throw new Error(`Style section ${section} starts inside ${open}`);
      }
      open = section;
    } else {
      if (open !== section) {
        throw new Error(`Style section ${section} ends without its start`);
      }
      open = undefined;
    }
  }
  if (open !== undefined) {
    throw new Error(`Style section ${open} never ends`);
  }
  const rest = css.slice(position);
  if (rest.trim().length > 0) {
    pieces.push({ section: undefined, css: rest });
  }
  return pieces;
}
