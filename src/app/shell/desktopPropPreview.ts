// Desktop's prop hover preview: hovering an option of a component prop's
// dropdown shows the canvas rendered with that option, and nothing is written —
// no source edit, no undo entry (shared/page/variantOverride.ts). Moving away
// or Escape puts the real rendering back; a click commits through the field's
// ordinary onChange, the one write the pick makes, and its rendering replaces
// the preview. Studio provides the same interface from its own server
// (studio/src/features/settings/VariantPreview.tsx).
//
// Hovers are debounced: the pointer crossing a list of options asks for the
// option it rests on, not for every row it passes over.

import { useEffect, useMemo } from 'react';
import { assert } from '../../../shared/core/assert';
import { VARIANT_LIMITS, VARIANT_MESSAGE_TYPES, parseVariantOverride, type VariantOverride } from '../../../shared/page/variantOverride';
import type { PropPreview } from '../../features/props/propPreviewContext';
import { tellCanvas } from '../../editor/canvasQuery';

export const DESKTOP_PROP_PREVIEW_DEBOUNCE_MS = 40;
/** How long after the last live value (a nudge) its preview gives way to the written rendering. */
export const DESKTOP_PROP_LIVE_SETTLE_MS = 1_200;

/** Which instance a preview renders: the component's project-relative file and the instance's marker path. */
export interface PropPreviewInstance {
  readonly component: string;
  readonly target: string;
}

/** The instance a selection previews, or undefined when it cannot: no component file in the project, or no marker path. */
export function propPreviewInstance(
  componentPath: string | undefined,
  projectPath: string | undefined,
  target: string | undefined,
): PropPreviewInstance | undefined {
  if (componentPath === undefined || projectPath === undefined || target === undefined) {
    return undefined;
  }
  const root = projectPath.replaceAll('\\', '/').replace(/\/$/, '');
  const file = componentPath.replaceAll('\\', '/');
  if (!file.startsWith(`${root}/`)) {
    return undefined; // An installed package's component: the canvas does not mark it.
  }
  const component = file.slice(root.length + 1);
  if (!component.startsWith('src/')) {
    return undefined;
  }
  if (component.length > VARIANT_LIMITS.pathCharsMax) {
    return undefined;
  }
  return target.length <= VARIANT_LIMITS.pathCharsMax ? { component, target } : undefined;
}

/** The preview for one instance, sending its messages through `send` and waiting through `schedule`. */
export function createDesktopPropPreview(
  instance: PropPreviewInstance,
  io: {
    readonly send: (message: unknown) => void;
    readonly schedule: (delayMs: number, run: () => void) => () => void;
  },
): PropPreview & { readonly dispose: () => void } {
  let prop: string | undefined;
  let pending: (() => void) | undefined;
  let settling: (() => void) | undefined;
  // Whether the canvas may be showing a preview, so a cancel is sent only when one can be undone.
  let shown = false;
  const stopPending = () => {
    pending?.();
    pending = undefined;
  };
  const stopSettling = () => {
    settling?.();
    settling = undefined;
  };
  const cancel = () => {
    stopPending();
    stopSettling();
    if (shown) {
      shown = false;
      io.send({ type: VARIANT_MESSAGE_TYPES.cancel });
    }
  };
  return {
    prepare: (name) => {
      prop = name;
    },
    hover: (value) => {
      stopPending();
      if (prop === undefined) {
        return;
      }
      const override: VariantOverride | undefined = parseVariantOverride({ ...instance, prop, value });
      if (override === undefined) {
        return; // A prop or value the preview cannot carry: the dropdown still picks it.
      }
      assert(override.target === instance.target, 'desktop prop preview: renders the selected instance');
      pending = io.schedule(DESKTOP_PROP_PREVIEW_DEBOUNCE_MS, () => {
        pending = undefined;
        shown = true;
        io.send({ type: VARIANT_MESSAGE_TYPES.show, override });
      });
    },
    cancel,
    // A write takes a save and an Astro render before the canvas shows it, and a run of
    // arrow keys queues behind itself: a heading's maxWidth nudged down from 17 to 6
    // reached the canvas two seconds after the first press. The canvas renders the
    // value through the hover preview's override at once instead (tens of ms), and any
    // pull the page makes meanwhile keeps it (morphVariant.ts). Once the edits pause,
    // the preview is cancelled: the canvas pulls the written page, which by then says
    // the same thing, and an undo in between is never hidden behind a stale override.
    live: (name, value) => {
      stopPending();
      stopSettling();
      const override: VariantOverride | undefined = parseVariantOverride({ ...instance, prop: name, value });
      if (override === undefined) {
        return; // A prop the preview cannot carry: its write still shows it.
      }
      assert(override.prop === name, 'desktop prop preview: a live value previews its own prop');
      shown = true;
      io.send({ type: VARIANT_MESSAGE_TYPES.show, override });
      settling = io.schedule(DESKTOP_PROP_LIVE_SETTLE_MS, () => {
        settling = undefined;
        cancel();
      });
    },
    commit: () => {
      stopPending();
      stopSettling();
      if (shown) {
        shown = false;
        io.send({ type: VARIANT_MESSAGE_TYPES.commit });
      }
    },
    dispose: cancel,
  };
}

const windowSchedule = (delayMs: number, run: () => void): (() => void) => {
  const timer = window.setTimeout(run, delayMs);
  return () => window.clearTimeout(timer);
};

/** The selection's preview, cancelled whenever the selection changes or the panel goes. */
export function useDesktopPropPreview(instance: PropPreviewInstance | undefined): PropPreview | undefined {
  const component = instance?.component;
  const target = instance?.target;
  const preview = useMemo(
    () =>
      component === undefined || target === undefined
        ? undefined
        : createDesktopPropPreview(
            { component, target },
            {
              send: (message) => {
                tellCanvas(message);
              },
              schedule: windowSchedule,
            },
          ),
    [component, target],
  );
  useEffect(() => () => preview?.dispose(), [preview]);
  return preview;
}
