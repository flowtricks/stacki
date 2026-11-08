// A style-only edit in a baked site, as the frame applies it: new text for named
// `<style>` sections, set in place the way Vite's CSS hot update sets it. The demo
// sends it on each tick of a Style panel scrub; nothing on the page is removed or
// re-inserted, so animations, scripts and layout state all survive. Runs in the
// frame and in the demo, so it imports nothing.
export const STYLE_UPDATE_LIMITS = {
  /** Sections one update can carry: every section of a site fits. */
  sectionsMax: 2_000,
  cssCharsMax: 4_000_000,
} as const satisfies Record<string, number>;

export interface SectionUpdate {
  readonly id: string;
  readonly css: string;
}

/** Reads a message's sections, refusing any shape or size it cannot trust. */
export function parseSectionUpdates(input: unknown): readonly SectionUpdate[] {
  if (!Array.isArray(input) || input.length > STYLE_UPDATE_LIMITS.sectionsMax) {
    throw new Error('Style update sections are missing or too many');
  }
  return input.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('id' in item) || !('css' in item)) {
      throw new Error('Style update section is not an id and its CSS');
    }
    const { id, css } = item;
    if (typeof id !== 'string' || typeof css !== 'string' || id.length > 520 || css.length > STYLE_UPDATE_LIMITS.cssCharsMax) {
      throw new Error('Style update section is out of bounds');
    }
    return { id, css };
  });
}

interface StyleElement {
  readonly getAttribute: (name: string) => string | null;
  textContent: string | null;
}

/** The frame's half: each named section's text, set in place. Nothing is removed or
 * inserted, so nothing restarts, and a section the page does not have is ignored. */
export function applySectionUpdates(styles: ArrayLike<StyleElement>, attribute: string, updates: readonly SectionUpdate[]): number {
  const texts = new Map(updates.map((update) => [update.id, update.css]));
  let changed = 0;
  for (let index = 0; index < styles.length && index < STYLE_UPDATE_LIMITS.sectionsMax; index++) {
    const style = styles[index];
    const css = style === undefined ? undefined : texts.get(style.getAttribute(attribute) ?? '');
    if (style !== undefined && css !== undefined && style.textContent !== css) {
      style.textContent = css;
      changed++;
    }
  }
  return changed;
}
