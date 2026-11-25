// The demo's counterpart to Vite's CSS hot update. A Style panel scrub writes on every
// tick; re-rendering and morphing the whole page for each one made the canvas lag and
// flicker. A change that touches only styles instead becomes new text for the affected
// `<style>` sections, sent straight to the frame once per animation frame, and the
// page itself is left alone. The save and the full rendering follow once the ticks rest,
// and find the styles already in place.
import type { BakeSection } from '../src/features/bake/bakeSnapshot';
import { BAKE_MESSAGES } from '../src/features/bake/bakeProtocol';
import { STYLE_UPDATE_LIMITS, type SectionUpdate } from '../src/features/bake/bakeStyleUpdate';
import { markupOf } from './pageChange';
import { renderSection } from './styleSections';

/** Whether `after` differs from `before` in its styles alone. */
export function isStyleOnlyChange(file: string, before: string, after: string): boolean {
  if (file.endsWith('.css')) {
    return true;
  }
  if (file.endsWith('.astro')) {
    return markupOf(before) === markupOf(after);
  }
  return false;
}

/** The sections a change to `file` can reach: its own blocks, and for a stylesheet
 * every stylesheet, since one may `@import` another. */
export function sectionsOf(sections: readonly BakeSection[], file: string): readonly BakeSection[] {
  return sections.filter((section) => section.file === file || (file.endsWith('.css') && section.file.endsWith('.css')));
}

/** New text for each reachable section. CSS that does not parse mid-edit is skipped:
 * the section keeps its last good text, as Vite keeps it on a failed update. */
export function sectionUpdates(sections: readonly BakeSection[], files: Iterable<string>, sources: Readonly<Record<string, string>>): readonly SectionUpdate[] {
  const updates = new Map<string, string>();
  for (const file of files) {
    for (const section of sectionsOf(sections, file)) {
      try {
        const css = renderSection(section, sources);
        if (css !== undefined) {
          updates.set(section.id, css);
        }
      } catch {
        /* Mid-edit CSS: the section keeps its last rendering. */
      }
    }
  }
  return [...updates].map(([id, css]) => ({ id, css }));
}

export interface StyleMessage {
  readonly type: typeof BAKE_MESSAGES.styleUpdate;
  readonly sections: readonly SectionUpdate[];
}

export function styleMessage(sections: readonly SectionUpdate[]): StyleMessage {
  if (sections.length > STYLE_UPDATE_LIMITS.sectionsMax) {
    throw new Error('A style update exceeds its section limit');
  }
  return { type: BAKE_MESSAGES.styleUpdate, sections };
}

/** Collects style-only changes and sends them at most once per animation frame. */
export class StylePreview {
  private readonly pending = new Set<string>();
  private scheduled = false;
  private readonly seen = new Map<string, string>();

  constructor(
    private readonly sections: readonly BakeSection[],
    private readonly baked: (file: string) => string | undefined,
    private readonly sources: () => Readonly<Record<string, string>>,
    private readonly send: (message: StyleMessage) => void,
    private readonly schedule: (flush: () => void) => void = (flush) => requestAnimationFrame(flush),
  ) {}

  /** A change as it lands. Only a style-only change, compared with the text this saw
   * last, is previewed; anything else waits for the full rendering. */
  changed(file: string, text: string): void {
    const before = this.seen.get(file) ?? this.baked(file);
    this.seen.set(file, text);
    if (before === undefined || !isStyleOnlyChange(file, before, text) || sectionsOf(this.sections, file).length === 0) {
      return;
    }
    this.pending.add(file);
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    const files = [...this.pending];
    this.pending.clear();
    const updates = sectionUpdates(this.sections, files, this.sources());
    if (updates.length > 0) {
      this.send(styleMessage(updates));
    }
  }
}
