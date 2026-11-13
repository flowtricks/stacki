// The canvas half of a prop hover preview (shared/page/variantOverride.ts):
// the renderer names one instance's one prop and a value; this fetches the
// page rendered that way and hands it to the patcher as it would any new
// rendering. Cancel puts the page's real rendering back; commit keeps what is
// shown until the write that follows renders: pulls the page makes meanwhile
// keep asking for the committed option (see `hold`), so a rendering of the file from
// before the write lands cannot paint the old value over it. Nothing here writes anything.
//
// Renders are cached per override while one dropdown is open, so moving the
// pointer back over an option shows it at once; the cache is bounded and is
// dropped whenever the preview ends or the page changes underneath it.

import { assert } from '../../shared/core/assert';
import { parseVariantMessage, VARIANT_HEADER, variantHeaderValue, type VariantOverride } from '../../shared/page/variantOverride';

export const VARIANT_PREVIEW_LIMITS = {
  // A dropdown's options: more than any union prop a person picks from.
  rendersMax: 32,
  // The same bound the patcher puts on a pushed rendering.
  htmlCharsMax: 4_000_000,
  // How long a committed option keeps being asked for. A save and an Astro render
  // take well under a second; the hold outlasts a slow one, and its end pulls the
  // written page, so a write that never landed (refused, failed) is not left hidden.
  holdMs: 2_500,
} as const;

export interface VariantPreviewHost {
  /** Show this rendering in place of the page's current one. */
  readonly paint: (html: string) => void;
  /** Put the page's real rendering back. */
  readonly restore: () => void;
  /** Drop a pull of the plain page that is still on its way: it may predate the commit. */
  readonly supersede?: () => void;
  /** Runs `run` after `delayMs`; the returned function cancels it. Defaults to timers. */
  readonly schedule?: (delayMs: number, run: () => void) => () => void;
}

const timerSchedule = (delayMs: number, run: () => void): (() => void) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

export function createVariantPreview(host: VariantPreviewHost) {
  const renders = new Map<string, string>();
  // Each request is answered only while it is still the latest one: a render
  // that lands after the pointer moved on, or after a cancel, is dropped.
  let generation = 0;
  let shown = false;
  // The header of the override on show, kept while it is: any other rendering the
  // page pulls meanwhile (a patch-now, a dev server's page-changed) asks for it too.
  // Without it, such a pull painted the plain page over the preview while the pointer
  // still rested on the option, and the canvas went back to the written value.
  let current: string | undefined;
  // Set from a commit until the write has had time to render. Why it exists: the page
  // pulls itself as soon as the write is applied, and the dev server can still answer
  // with the file as it was; with the override dropped at commit that pull painted the
  // old value over the committed one, and the write's own pull painted the new one
  // again: a flash of the previous value between two identical renderings.
  let endHold: (() => void) | undefined;
  const schedule = host.schedule ?? timerSchedule;
  const dropHold = (): void => {
    endHold?.();
    endHold = undefined;
  };
  const end = (): void => {
    dropHold();
    generation++;
    current = undefined;
    renders.clear();
    if (shown) {
      shown = false;
      host.restore();
    }
  };

  const show = (override: VariantOverride): void => {
    dropHold();
    generation++;
    const asked = generation;
    const header = variantHeaderValue(override);
    current = header;
    const cached = renders.get(header);
    if (cached !== undefined) {
      shown = true;
      host.paint(cached);
      return;
    }
    void fetch(location.href, { cache: 'no-store', headers: { [VARIANT_HEADER]: header } })
      .then((response) => (response.ok ? response.text() : undefined))
      .then((html) => {
        if (html === undefined || html.length > VARIANT_PREVIEW_LIMITS.htmlCharsMax) {
          return;
        }
        if (renders.size < VARIANT_PREVIEW_LIMITS.rendersMax) {
          renders.set(header, html);
        }
        if (asked === generation) {
          shown = true;
          host.paint(html);
        }
      })
      .catch(() => undefined); // A failed preview shows nothing new; the page stays as it is.
  };

  return {
    /** Handles a preview message from the renderer; false when the message is not one. */
    receive(data: unknown): boolean {
      const message = parseVariantMessage(data);
      if (message === undefined) {
        return false;
      }
      switch (message.kind) {
        case 'show':
          show(message.override);
          return true;
        case 'cancel':
          end();
          return true;
        case 'commit':
          // The write is on its way. A show still being fetched is the committed option
          // and may land (the generation is kept); pulls ask for it until the hold ends.
          assert(current !== undefined || !shown, 'a preview on show has its override');
          if (current !== undefined) {
            dropHold();
            host.supersede?.();
            endHold = schedule(VARIANT_PREVIEW_LIMITS.holdMs, () => {
              endHold = undefined;
              end();
            });
          }
          return true;
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    },
    /** The headers a pull of the page carries: the override on show, or none. */
    headers(): Readonly<Record<string, string>> {
      return current === undefined ? {} : { [VARIANT_HEADER]: current };
    },
    /** The page changed under the preview: every cached render is stale. */
    forget(): void {
      renders.clear();
    },
  };
}
