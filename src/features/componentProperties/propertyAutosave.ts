// An existing prop's settings save themselves: there is no Save button, and
// both places a prop is edited (PropertyEditor.tsx, PropertySettingsDialog.tsx)
// keep their draft here. A new prop has nothing to save yet, so with no host
// this holds the draft and writes nothing.
//
// Typing waits for a pause, so a burst of keys is one save and one undo step;
// a pick, a toggle or a list edit saves at once. Saves run one at a time, each
// sending the latest draft, because a save is checked against the source the
// last one left. A name is held apart from the draft until it is committed, on
// blur or Enter: a rename rewrites every file that passes the prop, which is
// not something to do once per letter.
//
// What is invalid is not written. Its text stays, and the reason shows beside
// it. A file changed on disk is reloaded under the form, and the fields this
// form changed are laid back over it and saved, so the edit survives.

import { useCallback, useEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { Result } from '../../../shared/core/result';
import { reportErrorToast } from '../../ui/errorNotices';
import type { ComponentProperty, PropertyChange, PropertyOptionRename } from '../../../shared/properties/propertyEditing';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import type { EditPace } from '../props/propBindings';

/** How long typing has to pause before it is saved. */
export const AUTOSAVE_DELAY_MS = 600;
// Each pass saves what has changed since the last. Edits outrunning this many
// back-to-back saves wait for the next edit, or for the form closing.
const AUTOSAVE_PASSES_MAX = 16;
const NAME = /^[A-Za-z_$][\w$]*$/;
const STATED_FIELDS = ['name', 'type', 'required', 'readonly', 'defaultValue', 'description'] as const;

export const CONFLICT_NOTICE = 'This file changed on disk, so the form reloaded. Your edit was kept.';

export interface PropertyDraft {
  readonly property: ComponentProperty;
  readonly optionRenames: readonly PropertyOptionRename[];
}

export type PropertySaveOutcome =
  | { readonly kind: 'saved'; readonly source: string }
  /** Not written, and saving the same again would not help: bad code, a name already taken. */
  | { readonly kind: 'refused'; readonly message: string }
  /** The file is newer than the source the save was checked against. */
  | { readonly kind: 'conflict'; readonly message: string };

/** How a form reaches its file. */
export interface PropertySaveHost {
  readonly save: (change: PropertyChange) => Promise<PropertySaveOutcome>;
  /** The property as the file holds it now, after which saves are checked against that file. */
  readonly reload: (name: string) => Promise<Result<ComponentProperty, string>>;
}

/**
 * How much of the app a save holds still. A rename changes other files, and the
 * open page's model is stale until it is replaced, so nothing may touch it. Any
 * other edit is to this one file, and the person is still typing in the form.
 */
export function savePhaseOf(change: PropertyChange): 'saving' | 'autosaving' {
  if (change.kind === 'save' && change.originalName !== change.property.name) {
    return 'saving';
  }
  return 'autosaving';
}

/** Why a property cannot be written as it stands, or undefined when it can. */
export function propertyProblem(property: Pick<ComponentProperty, 'name' | 'type'>): string | undefined {
  if (!NAME.test(property.name)) {
    return 'Use a name such as title, imageUrl, or isVisible.';
  }
  return property.type.trim() === '' ? 'Give the property a type.' : undefined;
}

function sameStatement(left: ComponentProperty, right: ComponentProperty): boolean {
  return STATED_FIELDS.every((key) => left[key] === right[key]);
}

/** The property on disk, with the fields this form changed since `base` laid over it. */
export function mergedProperty(base: ComponentProperty, draft: ComponentProperty, fresh: ComponentProperty): ComponentProperty {
  const out = STATED_FIELDS.reduce((merged, key) => (draft[key] === base[key] ? merged : { ...merged, [key]: draft[key] }), fresh);
  assert(out.editing === fresh.editing, 'mergedProperty: what the file says about editing is the file’s');
  return out;
}

interface FormStatus {
  readonly error: string;
  readonly notice: string;
  /** The name the file holds the prop by, which a rename moves. */
  readonly savedName: string;
}

interface Autosave {
  draft: PropertyDraft;
  saved: ComponentProperty;
  /** What the name box holds, which is the draft's name once committed. */
  nameText: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: boolean;
  /** The draft a host refused, not sent again until it changes. */
  refused: ComponentProperty | undefined;
  conflictRetried: boolean;
  /** A field is mid-way through being invalid, and has said so itself. */
  hold: 'free' | 'held';
  mounted: boolean;
}

export function usePropertyAutosave(initial: PropertyDraft, host: PropertySaveHost | undefined) {
  const [draft, setDraft] = useState(initial);
  const [nameText, setNameText] = useState(initial.property.name);
  const [status, setStatus] = useState<FormStatus>({ error: '', notice: '', savedName: initial.property.name });
  const state = useRef<Autosave>({
    draft: initial,
    saved: initial.property,
    nameText: initial.property.name,
    timer: undefined,
    running: false,
    refused: undefined,
    conflictRetried: false,
    hold: 'free',
    mounted: true,
  });
  const hostRef = useRef(host);
  hostRef.current = host;

  const report = useCallback((next: Pick<FormStatus, 'error' | 'notice'>): void => {
    if (state.current.mounted) {
      setStatus((previous) => ({ ...previous, ...next }));
    } else if (next.error !== '') {
      // The form closed with this save pending, so nothing is left to show it beside.
      reportErrorToast(next.error, []);
    }
  }, []);

  const replaceDraft = useCallback((next: PropertyDraft): void => {
    state.current.draft = next;
    if (state.current.mounted) {
      setDraft(next);
    }
  }, []);

  const recover = useCallback(
    async (target: PropertySaveHost, message: string): Promise<'retry' | 'stop'> => {
      const own = state.current;
      if (own.conflictRetried) {
        report({ error: message, notice: '' });
        return 'stop';
      }
      own.conflictRetried = true;
      const fresh = await target.reload(own.saved.name);
      if (!fresh.ok) {
        report({ error: fresh.error, notice: '' });
        return 'stop';
      }
      const property = mergedProperty(own.saved, own.draft.property, fresh.value);
      own.saved = fresh.value;
      replaceDraft({ ...own.draft, property });
      report({ error: '', notice: CONFLICT_NOTICE });
      return 'retry';
    },
    [replaceDraft, report],
  );

  const landed = useCallback(
    (sent: PropertyDraft): void => {
      const own = state.current;
      own.saved = sent.property;
      own.conflictRetried = false;
      own.refused = undefined;
      // A rename of an option applies once: only what came after this save is still owed.
      replaceDraft({ ...own.draft, optionRenames: own.draft.optionRenames.filter((rename) => !sent.optionRenames.includes(rename)) });
      if (own.mounted) {
        setStatus((previous) => ({ ...previous, error: '', savedName: sent.property.name }));
      }
    },
    [replaceDraft],
  );

  const pump = useCallback(async (): Promise<void> => {
    const own = state.current;
    const target = hostRef.current;
    if (target === undefined || own.running) {
      return;
    }
    own.running = true;
    try {
      for (let pass = 0; pass < AUTOSAVE_PASSES_MAX; pass++) {
        const sent = own.draft;
        // A timer still running is a burst still going: it saves when it pauses.
        if (own.timer !== undefined || own.hold === 'held' || own.refused === sent.property) {
          return;
        }
        if (sameStatement(sent.property, own.saved) && sent.optionRenames.length === 0) {
          return;
        }
        const problem = propertyProblem(sent.property);
        if (problem !== undefined) {
          report({ error: problem, notice: '' });
          return;
        }
        const options = sent.optionRenames.length > 0 ? { optionRenames: sent.optionRenames } : {};
        const outcome = await target.save({ kind: 'save', originalName: own.saved.name, property: sent.property, ...options });
        switch (outcome.kind) {
          case 'saved':
            landed(sent);
            break;
          case 'refused':
            own.refused = sent.property;
            report({ error: outcome.message, notice: '' });
            return;
          case 'conflict':
            if ((await recover(target, outcome.message)) === 'stop') {
              return;
            }
            break;
          default: {
            const exhaustive: never = outcome;
            return exhaustive;
          }
        }
      }
    } finally {
      own.running = false;
    }
  }, [landed, recover, report]);

  const stopTimer = useCallback((): void => {
    const own = state.current;
    if (own.timer !== undefined) {
      clearTimeout(own.timer);
      own.timer = undefined;
    }
  }, []);

  const change = useCallback(
    (pace: EditPace, next: (current: PropertyDraft) => PropertyDraft): void => {
      const own = state.current;
      replaceDraft(next(own.draft));
      report({ error: '', notice: '' });
      if (hostRef.current === undefined) {
        return;
      }
      stopTimer();
      if (pace === 'at-once') {
        void pump();
        return;
      }
      own.timer = setTimeout(() => {
        own.timer = undefined;
        void pump();
      }, AUTOSAVE_DELAY_MS);
    },
    [pump, replaceDraft, report, stopTimer],
  );

  // The name box's text, committed only when it can be: the rest of the form
  // keeps saving under the name the file holds while a bad one is being fixed.
  const commitName = useCallback((): void => {
    const own = state.current;
    if (own.nameText === own.draft.property.name) {
      return;
    }
    const problem = propertyProblem({ name: own.nameText, type: own.draft.property.type });
    if (problem !== undefined) {
      report({ error: problem, notice: '' });
      return;
    }
    const name = own.nameText;
    change('at-once', (current) => ({ ...current, property: { ...current.property, name } }));
  }, [change, report]);

  const flush = useCallback((): void => {
    if (hostRef.current === undefined) {
      return;
    }
    stopTimer();
    commitName();
    void pump();
  }, [commitName, pump, stopTimer]);

  // From here nothing draws the form again, even in the moment before it
  // unmounts, so what becomes of the last save is reported as a toast.
  const close = useCallback((): void => {
    state.current.mounted = false;
    flush();
  }, [flush]);

  useEffect(() => {
    state.current.mounted = true;
    return close;
  }, [close]);

  const setName = (text: string): void => {
    assert(text.length <= PROPERTY_LIMITS.textCharsMax, 'usePropertyAutosave: a name box is bounded');
    state.current.nameText = text;
    setNameText(text);
    if (hostRef.current === undefined) {
      change('typing', (current) => ({ ...current, property: { ...current.property, name: text } }));
    }
  };

  return {
    draft,
    nameText,
    ...status,
    change,
    setName,
    commitName,
    close,
    report,
    /** Whether a field is part-way through something it cannot write; it says why itself. */
    hold: (hold: Autosave['hold']): void => {
      state.current.hold = hold;
    },
    /** Forgets what is pending, for a prop about to be deleted. */
    discard: (): void => {
      stopTimer();
      const own = state.current;
      own.nameText = own.saved.name;
      replaceDraft({ property: own.saved, optionRenames: [] });
    },
  };
}
