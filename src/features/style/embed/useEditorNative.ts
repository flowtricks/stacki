// The native model's hooks: refreshing it when the selection or breakpoint
// changes, and the operations that read and write through it
// (useEditorResolution.ts).

import { useCallback, useRef } from 'react';
import { STATES } from '../model/resolved';
import { type NativeStyleOptions } from '../model/nativeStyles';
import {
  readNativeStyleByName,
  readNativeStyles,
  removeNativePropertyAt,
  resolveIdentityElement,
  liveSetNativeProperty,
  type NativeWriteTarget,
} from '../model/webflow';
import { standaloneNativeClass } from './EditorBasics';
import { nativeModelCache } from './editorModel';
import { useEditorRefs, useBusyState, useScanState, useNativeState } from './useEditorFoundation';

// Re-read the native class styles after a native write.
export function useNativeRefresh(editorRefs: ReturnType<typeof useEditorRefs>, nativeState: ReturnType<typeof useNativeState>) {
  const { selectedRef } = editorRefs;
  const { activeSelectorRef, nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;

  // Native (Webflow class style) writes.
  const refreshNative = useCallback(async () => {
    const selectedElement = selectedRef.current;
    if (!selectedElement) {
      const className = standaloneNativeClass(activeSelectorRef.current);
      if (!className) {
        return;
      }
      const next = await readNativeStyleByName(className, STATES);
      nativeModelRef.current = next;
      nativeIdentityRef.current = `standalone:${className}`;
      setNativeModel(next);
      return;
    }
    nativeModelCache.clear(); // a class edit can change any element that uses it
    const identity = await resolveIdentityElement(selectedElement);
    const model = await readNativeStyles(identity, STATES);
    nativeModelRef.current = model;
    setNativeModel(model);
  }, [activeSelectorRef, nativeIdentityRef, nativeModelRef, selectedRef, setNativeModel]);
  return { refreshNative };
}

// Serialized native writes: clear and live-set a class style's properties.
export function useNativeOps(
  editorRefs: ReturnType<typeof useEditorRefs>,
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  nativeRefresh: ReturnType<typeof useNativeRefresh>,
) {
  const { selectedRef } = editorRefs;
  const { setBusyBoth } = busyState;
  const { setStatus } = scanState;
  const { nativeModelRef } = nativeState;
  const { refreshNative } = nativeRefresh;

  // Serialize native writes. Each write does read-handle → setProperties → commit →
  // refresh; `busy` clears before the refresh finishes, so a rapid second edit (e.g.
  // overflow-x then overflow-y) could overlap the first and clobber it via racing
  // setStyles commits. Chaining every op guarantees strict ordering.
  const nativeOpChain = useRef<Promise<unknown>>(Promise.resolve());
  const runNativeOp = useCallback(<T>(op: () => Promise<T>): Promise<T> => {
    const next = nativeOpChain.current.then(op, op);
    nativeOpChain.current = next.catch(() => {});
    return next;
  }, []);
  // Build the write target for the native style at `index`: applied combos write
  // by their getStyles position; standalone (attribute-only) classes have no such
  // position, so they resolve by name via getStyleByName.
  const nativeWriteTargetAt = useCallback(
    (index: number): NativeWriteTarget => {
      const style = nativeModelRef.current?.styles[index];
      return { namePath: style?.namePath ?? [], index: style && style.applied ? index : undefined };
    },
    [nativeModelRef],
  );
  const nativeClearAt = useCallback(
    (index: number, props: string[], options?: NativeStyleOptions) =>
      runNativeOp(async () => {
        let ok = true;
        try {
          setBusyBoth(true);
          setStatus('Saving…'); // i18n-ignore: write-only status, never rendered.
          const result = await removeNativePropertyAt(selectedRef.current, nativeWriteTargetAt(index), props, options);
          ok = result.ok;
        } finally {
          setBusyBoth(false);
        }
        await refreshNative();
        setStatus(ok ? 'Removed from the Webflow class style.' : 'Couldn’t remove from the Webflow class style.'); // i18n-ignore: write-only status, never rendered.
      }),
    [refreshNative, setBusyBoth, nativeWriteTargetAt, runNativeOp, selectedRef, setStatus],
  );
  // Live scrub: Webflow updates the canvas itself; skip the model refresh (blur commits).
  const nativeLiveSet = useCallback(
    (handle: unknown, prop: string, value: string, options?: NativeStyleOptions) => {
      // Serialize live writes through the native op chain (like commits do). Firing
      // several setProperty calls on one style in a single tick — the four linked
      // border-radius corners, or linked gap's row/column longhands — races inside
      // Webflow's API and only the last sticks; chaining applies each in order.
      void runNativeOp(async () => {
        await liveSetNativeProperty(handle, prop, value, options);
      });
    },
    [runNativeOp],
  );
  return { nativeClearAt, nativeLiveSet, nativeWriteTargetAt, runNativeOp };
}
