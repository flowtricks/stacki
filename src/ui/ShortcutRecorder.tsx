// A field that records a keyboard shortcut, rather than offering a list to pick
// from. It shows the current key (or what having none means, such as "None");
// a click puts it in recording mode ("Press keys…"), and the next key combination
// the caller accepts is saved. Escape cancels, Backspace or Delete clears it, and
// a key it cannot take leaves it recording with a hint that says why: outside the
// accepted range, or held by something else. A small reset button, in the blue
// reset-label style, appears when the value differs from its default.
//
// What a shortcut may be and who holds one are the caller's: the field knows
// keys, not app commands. Shortcuts are canonical text (`Mod+Alt+Shift+1`,
// shared/properties/appShortcuts.ts); `Mod` is ⌘ on macOS and Ctrl elsewhere, so
// on macOS Ctrl is no modifier a shortcut can use, and elsewhere the Windows key
// is not. Every press is decided by `recorderStep`, a pure function the tests
// drive directly.
import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { assert } from '../../shared/core/assert';
import { shortcutOfPress, type AppKeyPress } from '../../shared/properties/appShortcuts';
import { ResetIcon } from './Icons';
import './shortcutRecorder.css';
import { useTranslate } from '../lib/i18n/useTranslate';

export type ShortcutPlatform = 'mac' | 'other';

/** What the field accepts, and why it would refuse a key. */
export interface ShortcutRules {
  /** What an accepted shortcut looks like, shown when a press is outside it ("Use ⌘⌥⇧ with a number from 1 to 9"). */
  readonly hint: string;
  readonly accepts: (shortcut: string) => boolean;
  /** Why an accepted shortcut cannot be taken ("Used by Heat map"), or undefined when it is free. */
  readonly conflict: (shortcut: string) => string | undefined;
}

export interface ShortcutRecorderProps extends ShortcutRules {
  readonly ariaLabel: string;
  /** The shortcut as canonical text, or undefined when there is none. */
  readonly value: string | undefined;
  /** What the field shows when `value` is undefined. */
  readonly emptyLabel: string;
  readonly platform: ShortcutPlatform;
  /** A shortcut as this platform writes it (`⌘⌥⇧1`, `Ctrl+Alt+Shift+1`). */
  readonly format: (shortcut: string) => string;
  /** The reset button, present only while the value differs from its default. */
  readonly reset: { readonly label: string; readonly onReset: () => void } | undefined;
  readonly onClear: () => void;
  readonly onChange: (shortcut: string) => void;
}

/** What one press does to a recording field. */
export type RecorderStep =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'clear' }
  /** A bare modifier, or Tab: the field waits for more, or lets focus move on. */
  | { readonly kind: 'wait' }
  | { readonly kind: 'pass' }
  | { readonly kind: 'refuse'; readonly hint: string }
  | { readonly kind: 'record'; readonly shortcut: string };

type RecorderState = { readonly kind: 'idle' } | { readonly kind: 'recording'; readonly hint: string | undefined };

const MODIFIER_KEYS: readonly string[] = ['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'OS'];
const RECORDING_ATTRIBUTE = 'data-shortcut-recording';

/**
 * True for a key event aimed at a recording field. Global shortcut listeners
 * that run before the field (a window capture listener) skip these presses, so
 * the key a person is recording does not also run whatever holds it now.
 */
export function isShortcutRecorderTarget(target: unknown): boolean {
  if (target instanceof Element) {
    return target.closest(`[${RECORDING_ATTRIBUTE}="true"]`) !== null;
  }
  return false;
}

/** What a press does while the field records: pure, so the tests can walk every branch. */
export function recorderStep(press: AppKeyPress, platform: ShortcutPlatform, rules: ShortcutRules): RecorderStep {
  assert(rules.hint.length > 0, 'A recorder has a hint to show');
  if (MODIFIER_KEYS.includes(press.key)) {
    return { kind: 'wait' };
  }
  const modified = press.metaKey || press.ctrlKey || press.altKey || press.shiftKey;
  if (!modified) {
    if (press.key === 'Escape') {
      return { kind: 'cancel' };
    }
    if (press.key === 'Backspace' || press.key === 'Delete') {
      return { kind: 'clear' };
    }
    if (press.key === 'Tab') {
      return { kind: 'pass' };
    }
  }
  // `Mod` is one key per platform: ⌘ on macOS, Ctrl elsewhere. The other cannot be written down.
  if (platform === 'mac') {
    if (press.ctrlKey) {
      return { kind: 'refuse', hint: rules.hint };
    }
  } else {
    if (press.metaKey) {
      return { kind: 'refuse', hint: rules.hint };
    }
  }
  const shortcut = shortcutOfPress(press);
  if (shortcut === undefined) {
    return { kind: 'refuse', hint: rules.hint };
  }
  if (!rules.accepts(shortcut)) {
    return { kind: 'refuse', hint: rules.hint };
  }
  const conflict = rules.conflict(shortcut);
  if (conflict !== undefined) {
    assert(conflict.length > 0, 'A conflict says what holds the key');
    return { kind: 'refuse', hint: conflict };
  }
  return { kind: 'record', shortcut };
}

export function ShortcutRecorder(props: ShortcutRecorderProps) {
  const translate = useTranslate();
  assert(props.ariaLabel.length > 0, 'A shortcut field is labelled');
  assert(props.emptyLabel.length > 0, 'A shortcut field says what having no key means');
  const [state, setState] = useState<RecorderState>({ kind: 'idle' });
  const recording = state.kind === 'recording';
  const hint = state.kind === 'recording' ? state.hint : undefined;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (state.kind === 'idle') {
      return; // Enter and Space reach the button's click, which starts recording.
    }
    const step = recorderStep(event.nativeEvent, props.platform, props);
    if (step.kind === 'pass') {
      return;
    }
    // Every other press belongs to the field: no editor shortcut and no popup's Escape sees it.
    event.preventDefault();
    event.stopPropagation();
    switch (step.kind) {
      case 'wait':
        return;
      case 'cancel':
        setState({ kind: 'idle' });
        return;
      case 'clear':
        setState({ kind: 'idle' });
        props.onClear();
        return;
      case 'refuse':
        setState({ kind: 'recording', hint: step.hint });
        return;
      case 'record':
        setState({ kind: 'idle' });
        props.onChange(step.shortcut);
        return;
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
  };
  return (
    <span className="shortcut-recorder">
      <span className="shortcut-recorder-controls">
        <button
          type="button"
          className="shortcut-recorder-field"
          aria-label={props.ariaLabel}
          data-shortcut-recording={recording ? 'true' : 'false'}
          data-empty={props.value === undefined ? 'true' : undefined}
          onClick={() => setState({ kind: 'recording', hint: undefined })}
          onBlur={() => setState({ kind: 'idle' })}
          onKeyDown={onKeyDown}
        >
          {recording ? translate('ui.shortcutRecorder.pressKeys') : props.value === undefined ? props.emptyLabel : props.format(props.value)}
        </button>
        {props.reset !== undefined && (
          <button
            type="button"
            className="shortcut-recorder-reset"
            aria-label={props.reset.label}
            title={props.reset.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.reset.onReset}
          >
            <ResetIcon size={12} />
          </button>
        )}
      </span>
      {hint !== undefined && (
        <span className="shortcut-recorder-hint" role="status">
          {hint}
        </span>
      )}
    </span>
  );
}
