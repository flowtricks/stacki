// The pieces every Settings tab is laid out with, so the tabs share one rhythm
// (settings.css): a tab opens with a muted sentence and its save indicator; a
// section is a heading with an optional muted description above its rows; a
// row is a label and its description on the left and the control in a fixed
// column on the right; a notice sits beside the control it is about; an empty
// state says what is missing and what to do about it.
//
// Every tab saves each change as it is made, so none has a Save button: the
// indicator says "Saving…", then "Saved" for a moment, and a failure shows as
// a notice with Retry beside the control that made it.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CheckIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';

/** How long "Saved" stays after a save: long enough to read, short enough to stay quiet. */
const SAVED_SHOWN_MS = 1600;

export type SaveIndicatorState = 'idle' | 'saving' | 'saved';

/** Tracks a tab's saves for its indicator. `track` passes the save's result or failure through unchanged. */
export function useSaveIndicator(): { readonly state: SaveIndicatorState; readonly track: <T>(save: Promise<T>) => Promise<T> } {
  const [state, setState] = useState<SaveIndicatorState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Saves can overlap; the indicator shows "Saving…" until the last one settles.
  const running = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const track = useCallback(async <T,>(save: Promise<T>): Promise<T> => {
    clearTimeout(timer.current);
    running.current += 1;
    setState('saving');
    try {
      const value = await save;
      running.current -= 1;
      assert(running.current >= 0, 'useSaveIndicator: each save settles once');
      if (running.current === 0) {
        setState('saved');
        timer.current = setTimeout(() => setState('idle'), SAVED_SHOWN_MS);
      }
      return value;
    } catch (failure: unknown) {
      running.current -= 1;
      assert(running.current >= 0, 'useSaveIndicator: each save settles once');
      if (running.current === 0) {
        setState('idle');
      }
      throw failure;
    }
  }, []);
  return { state, track };
}

/** A tab's opening sentence, with its save indicator at the right. */
export function SettingsIntro(props: { readonly saving: SaveIndicatorState; readonly children: ReactNode }) {
  return (
    <div className="app-settings-intro-row">
      <p className="app-settings-intro">{props.children}</p>
      <SaveIndicator state={props.saving} />
    </div>
  );
}

function SaveIndicator(props: { readonly state: SaveIndicatorState }) {
  return (
    <span className="app-settings-saved" role="status" data-state={props.state}>
      {props.state === 'saving' && 'Saving…'}
      {props.state === 'saved' && (
        <>
          <CheckIcon size={12} />
          Saved
        </>
      )}
    </span>
  );
}

/**
 * A message beside the control it is about: a change that was refused (the
 * control is back at its saved value), or a save that failed, with Retry.
 */
export function SettingsNotice(props: { readonly message: string; readonly onRetry?: () => void }) {
  return (
    <div className="app-settings-notice" role="alert">
      <span>{props.message}</span>
      {props.onRetry !== undefined && (
        <button type="button" onClick={props.onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function SettingsSection(props: { readonly title: string; readonly description?: ReactNode; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section className="app-settings-section" aria-labelledby={id}>
      <header className="app-settings-section-header">
        <h4 id={id}>{props.title}</h4>
        {props.description !== undefined && <p>{props.description}</p>}
      </header>
      {props.children}
    </section>
  );
}

/** A label, its description beneath it in a muted colour, and its control at the right. */
export function SettingsRow(props: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** The id the control's aria-describedby points at. */
  readonly descriptionId?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="app-settings-row">
      <div className="app-settings-row-text">
        <span className="app-settings-row-label">{props.label}</span>
        {props.description !== undefined && (
          <p className="app-settings-row-description" id={props.descriptionId}>
            {props.description}
          </p>
        )}
      </div>
      <div className="app-settings-row-control">{props.children}</div>
    </div>
  );
}

/** A tab with nothing to show yet: an icon, then a sentence that says what to do. */
export function SettingsEmpty(props: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="app-settings-empty">
      <span className="app-settings-empty-icon" aria-hidden="true">
        {props.icon}
      </span>
      <p>{props.children}</p>
    </div>
  );
}
