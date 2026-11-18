// A committed or cleared value shows in the frame it is made in.
//
// Committing or clearing a property is a save followed by a model rebuild (every rule re-resolved
// against the element), and every field reads that model. So the field kept the value from before
// the edit until both finished: measured in the real app on a 3,000-rule stylesheet, a custom
// colour committed with Enter painted the old chip for 2 to 6 frames, and a clear painted the empty
// placeholder for about 100 ms before the value under it came back (test/integration/
// styleFieldLatency.js). On a slower machine and a bigger project that is the "big delay" people see.
//
// Here the panel holds each edited property from the press until its save settles, and reads it
// from the model already loaded with the edit applied (model/optimisticProp.ts): a commit shows the
// committed value, a clear shows the next value in the cascade. Every section reads through this
// one place, so every field, chip, swatch and label follows at once.
//
// Reconciling, by revision: each edit of a property gets the next revision, and only the save of
// the newest revision lifts the hold. An older save that finishes while a newer edit is on its way
// (and the model it rebuilt, which holds the older value) never shows. Once the newest save settles
// the model is what the field reads: if the save worked it holds the edit already, so nothing
// changes on screen; if it failed it still holds the old value, which is the rollback. A write made
// synchronously (the style attribute) is held until the model next moves; a refused one (nothing
// written) is never held. A save that never settles lets go after a bound, as the canvas's own
// previews do.

import { useCallback, useEffect, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import { writtenValue } from '../model/lengthUnit';
import { withCleared, withCommitted } from '../model/optimisticProp';
import type { ResolvedProp } from '../model/resolved';
import type { WriteSettle } from './EditorBasics';

// Properties one clear may hold. Group clears are the widest (a gap, a border side).
const HELD_PER_CLEAR_MAX = 64;
// Properties held at once: one entry per property, and the panel shows a few hundred at most.
const HOLDS_MAX = 1024;
// A save that has not settled by now is not coming; the model shows again (the canvas's preview bound).
const HOLD_MS_MAX = 20_000;

type Model = ReadonlyMap<string, ResolvedProp>;

/** What ends a hold: its own save settling, or (with no save to wait on) the model moving on. */
type Release = { readonly kind: 'save' } | { readonly kind: 'model'; readonly model: Model };

type Hold =
  | {
      readonly kind: 'committed';
      readonly revision: number;
      readonly value: string;
      readonly important: boolean;
      readonly selector: string;
      readonly release: Release;
    }
  | { readonly kind: 'cleared'; readonly revision: number; readonly release: Release };

/** A write that settles once the save and the model rebuild behind it are done; undefined when there is nothing to wait on. */
export type SettlingSet = (prop: string, value: string, important: boolean) => WriteSettle;
/** The commit the sections are handed: it shows at once and needs no waiting on. */
export type CommitProp = (prop: string, value: string, important: boolean) => void;
export type SettlingClear = (prop: string | string[]) => WriteSettle;

export function useOptimisticEdits(
  props: Model,
  writes: { readonly setProp: SettlingSet; readonly clearProp: SettlingClear; readonly selector: string },
): {
  readonly read: (prop: string) => ResolvedProp | undefined;
  readonly setProp: CommitProp;
  readonly clearProp: (prop: string | string[]) => void;
} {
  const [holds, setHolds] = useState<ReadonlyMap<string, Hold>>(new Map());
  const revisionRef = useRef(0);
  // Each revision's bound timer, cleared when its hold ends some other way (and on unmount).
  const timersRef = useRef(new Map<number, number>());
  const forgetTimer = useCallback((revision: number) => {
    const timer = timersRef.current.get(revision);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(revision);
    }
  }, []);
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // Lifts the holds `revision` put on `names`; a newer edit's hold on a name stays.
  const release = useCallback(
    (names: readonly string[], revision: number) => {
      forgetTimer(revision);
      setHolds((previous) => {
        const next = new Map(previous);
        for (const name of names) {
          if (next.get(name)?.revision === revision) {
            next.delete(name);
          }
        }
        return next.size === previous.size ? previous : next;
      });
    },
    [forgetTimer],
  );

  const hold = (names: readonly string[], settled: WriteSettle, make: (revision: number, release: Release) => Hold): void => {
    if (settled === undefined) {
      return; // Nothing was written (refused, or nothing to style): the model is already the answer.
    }
    revisionRef.current += 1;
    const revision = revisionRef.current;
    assert(Number.isSafeInteger(revision), 'useOptimisticEdits: revisions stay safe integers');
    const until: Release = settled === 'until-model' ? { kind: 'model', model: props } : { kind: 'save' };
    setHolds((previous) => {
      const next = new Map(previous);
      for (const name of names) {
        next.set(name, make(revision, until));
      }
      assert(next.size <= HOLDS_MAX, 'useOptimisticEdits: holds stay bounded');
      return next;
    });
    if (settled !== 'until-model') {
      // A rejected save stays loud (unhandled, as before): the finally only lifts the hold.
      void settled.finally(() => release(names, revision));
    }
    timersRef.current.set(
      revision,
      window.setTimeout(() => release(names, revision), HOLD_MS_MAX),
    );
    assert(timersRef.current.size <= HOLDS_MAX, 'useOptimisticEdits: hold timers stay bounded');
  };

  // A hold waiting on the model goes once the model has moved (it has heard about the edit).
  useEffect(() => {
    const heard = (entry: Hold): boolean => entry.release.kind === 'model' && entry.release.model !== props;
    for (const entry of holds.values()) {
      if (heard(entry)) {
        forgetTimer(entry.revision);
      }
    }
    setHolds((previous) => {
      const next = new Map([...previous].filter(([, entry]) => !heard(entry)));
      return next.size === previous.size ? previous : next;
    });
  }, [props, holds, forgetTimer]);

  const setProp: CommitProp = (prop, value, important) => {
    // The write starts in this same call, so the canvas preview is not delayed by the hold.
    const settled = writes.setProp(prop, value, important);
    // What the write puts in the file (a length in the project's unit, never below zero).
    const shown = writtenValue(prop, value);
    hold([prop], settled, (revision, until) => ({ kind: 'committed', revision, value: shown, important, selector: writes.selector, release: until }));
  };

  const clearProp = (prop: string | string[]): void => {
    const names = Array.isArray(prop) ? prop : [prop];
    assert(names.length <= HELD_PER_CLEAR_MAX, 'useOptimisticEdits: one clear holds a bounded group');
    const settled = writes.clearProp(prop);
    hold(names, settled, (revision, until) => ({ kind: 'cleared', revision, release: until }));
  };

  const read = (prop: string): ResolvedProp | undefined => {
    const model = props.get(prop);
    const entry = holds.get(prop);
    if (entry === undefined) {
      return model;
    }
    if (entry.release.kind === 'model' && entry.release.model !== props) {
      return model; // The model moved since the edit: it is the answer now (the effect above tidies up).
    }
    switch (entry.kind) {
      case 'committed':
        return withCommitted(model, { prop, value: entry.value, important: entry.important, selector: entry.selector });
      case 'cleared':
        return withCleared(model);
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  };

  return { read, setProp, clearProp };
}
