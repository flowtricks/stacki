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
// dropped whenever the preview ends or the page changes underneath it. One
// render is on its way at a time, with only the latest option waiting behind it.

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
  // One render on its way at most, and the latest option waiting behind it. Why: a
  // large page renders in about a second (more in workerd), and the pointer crossing
  // a list of seven options asked for seven renders at once, which the dev server ran
  // side by side while the option the pointer rested on waited behind all of them.
  // An option passed over is never asked for; the one the pointer rests on is next.
  // `asked` is the generation the render paints for: hovering back to the option on its
  // way makes it the one on show again.
  let flight: { readonly header: string; readonly abort: AbortController; asked: number } | undefined;
  let waiting: string | undefined;
  // `landed` runs once the render is done with, so the option waiting behind it can fly.
  const fly = (header: string, landed: () => void): void => {
    assert(flight === undefined, 'variant preview: one render on its way at most');
    const abort = new AbortController();
    const trip = { header, abort, asked: generation };
    flight = trip;
    void fetch(location.href, { cache: 'no-store', headers: { [VARIANT_HEADER]: header }, signal: abort.signal })
      .then((response) => (response.ok ? response.text() : undefined))
      .then((html) => {
        if (html === undefined || html.length > VARIANT_PREVIEW_LIMITS.htmlCharsMax) {
          return;
        }
        if (flight !== trip) {
          return; // The preview ended while this was on its way: its cache is gone, and so is it.
        }
        if (renders.size < VARIANT_PREVIEW_LIMITS.rendersMax) {
          renders.set(header, html);
        }
        if (trip.asked === generation) {
          shown = true;
          host.paint(html);
        }
      })
      .catch(() => undefined) // A failed or aborted preview shows nothing new; the page stays as it is.
      .finally(() => {
        if (flight !== trip) {
          return; // Ended while on its way (`land` dropped it); the next show flies on its own.
        }
        flight = undefined;
        landed();
      });
  };
  const flyWaiting = (): void => {
    const next = waiting;
    waiting = undefined;
    if (next === undefined) {
      return;
    }
    assert(next === current, 'variant preview: only the option on show waits');
    fly(next, flyWaiting);
  };
  // Ends what is on its way: a preview that ended has nothing left to ask for.
  const land = (): void => {
    waiting = undefined;
    flight?.abort.abort();
    flight = undefined;
  };

  const end = (): void => {
    dropHold();
    land();
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
    const header = variantHeaderValue(override);
    current = header;
    const cached = renders.get(header);
    if (cached !== undefined) {
      waiting = undefined;
      shown = true;
      host.paint(cached);
      return;
    }
    if (flight === undefined) {
      fly(header, flyWaiting);
      return;
    }
    // The render on its way is kept (its option may be hovered again, and it is cached
    // when it lands) but is no longer painted: its generation has passed.
    if (flight.header === header) {
      flight.asked = generation;
      waiting = undefined;
    } else {
      waiting = header;
    }
    assert(waiting === undefined || waiting === current, 'variant preview: only the option on show waits');
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
