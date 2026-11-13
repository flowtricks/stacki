// The pieces every Settings tab is laid out with, so the tabs share one rhythm
// (settings.css): a tab opens with its save indicator; a section is a heading
// above its rows; a row is a label on the left and the control in a fixed
// column on the right; a notice sits beside the control it is about; an empty
// state says what is missing and what to do about it. A card never holds a
// paragraph: its title may carry an (i) (InfoHint) whose tip explains it, and
// a row may add one short dim line only when the title leaves something out.
//
// Every tab saves each change as it is made, so none has a Save button: the
// indicator says "Saving…", then "Saved" for a moment, and a failure shows as
// a notice with Retry beside the control that made it.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CheckIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import InfoHint from '../../ui/InfoHint';

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

/** A tab's save indicator, at the right above its sections. */
export function SettingsSaveRow(props: { readonly saving: SaveIndicatorState }) {
  return (
    <div className="app-settings-save-row">
      <SaveIndicator state={props.saving} />
    </div>
  );
}

function SaveIndicator(props: { readonly state: SaveIndicatorState }) {
  const translate = useTranslate();
  return (
    <span className="app-settings-saved" role="status" data-state={props.state}>
      {props.state === 'saving' && translate('settings.saving')}
      {props.state === 'saved' && (
        <>
          <CheckIcon size={12} />
          {translate('settings.saved')}
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
  const translate = useTranslate();
  return (
    <div className="app-settings-notice" role="alert">
      <span>{props.message}</span>
      {props.onRetry !== undefined && (
        <button type="button" onClick={props.onRetry}>
          {translate('settings.retry')}
        </button>
      )}
    </div>
  );
}

/** A section: its heading, with an (i) when `info` explains what the section holds, then its rows. */
export function SettingsSection(props: { readonly title: string; readonly info?: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section className="app-settings-section" aria-labelledby={id}>
      <header className="app-settings-section-header">
        {/* The (i) sits beside the heading, not inside it, so the section's accessible name stays its title. */}
        <div className="app-settings-section-title">
          <h4 id={id}>{props.title}</h4>
          {props.info !== undefined && <InfoHint text={props.info} />}
        </div>
      </header>
      {props.children}
    </section>
  );
}

/** A label, with an (i) when `info` explains it, and its control at the right; `description` is one short dim line, rarely. */
export function SettingsRow(props: {
  readonly label: ReactNode;
  /** The longer explanation, in a tooltip after the label. */
  readonly info?: string;
  readonly description?: ReactNode;
  /** The id the control's aria-describedby points at. */
  readonly descriptionId?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="app-settings-row">
      <div className="app-settings-row-text">
        <span className="app-settings-row-label">
          {props.label}
          {props.info !== undefined && <InfoHint text={props.info} />}
        </span>
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
