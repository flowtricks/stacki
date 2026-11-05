// What the background section's parts share: the writers they are handed,
// replacing one layer, the live-write timer, the label and field every
// background input is drawn with, and the layer editor's modal
// (BackgroundSection.tsx).

import { useEffect, useRef } from 'react';
import PanelSheet from './components/PanelSheet';
import type { ReactNode } from 'react';
import { useFieldDraft } from './model/fieldDraft';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import useScrub, { type ScrubHandlers } from './components/useScrub';
import { handleArrowStep } from './model/numberStep';
import ProvenanceList from './ProvenanceList';
import { type BgLayer } from './model/background';
import VariableConnect from './VariableConnect';
import ColorSwatch from './components/ColorSwatch';
import { useLiveColor } from './model/liveColor';
import type { Contributor, ResolvedProp } from './model/resolved';
import { commitInPlace } from './model/commitInPlace';
import { displayOf, displayText, keepImportant, parseImportant, withImportant, type Display } from './model/styleDisplay';

export type SetProp = (prop: string, value: string, important: boolean) => void;
export type ClearProp = (prop: string | string[]) => void;
export type LiveSetProp = (prop: string, value: string | undefined, important: boolean) => void;
export type Read = (prop: string) => ResolvedProp | undefined;

export type Props = {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
};

// How a write lands: live while typing or dragging, or committed.
export interface WriteOptions {
  readonly live: boolean;
}

// The layers with one layer's fields replaced.
export function replaceLayer<K extends keyof BgLayer>(layers: BgLayer[], index: number, patch: Pick<BgLayer, K>): BgLayer[] {
  return layers.map((layer, i) => (i === index ? { ...layer, ...patch } : layer));
}

// Enter commits in place; ↑/↓ step the number under the caret (unit preserved) in the
// field itself. Returns the stepped text, or undefined when the key did not step.
export function stepInPlace(event: React.KeyboardEvent<HTMLInputElement>): string | undefined {
  const input = event.currentTarget;
  if (event.key === 'Enter') {
    commitInPlace(input);
    return undefined;
  }
  const stepped = handleArrowStep(event);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// Debounces live writes while typing: the text reaches `liveNow` 100ms after the last
// keystroke; `cancelLive` drops a pending one.
export function useLiveTimer(liveNow: (text: string) => void) {
  const liveTimer = useRef<number | undefined>(undefined);
  const cancelLive = () => {
    if (liveTimer.current !== undefined) {
      window.clearTimeout(liveTimer.current);
      liveTimer.current = undefined;
    }
  };
  useEffect(() => cancelLive, []);
  const scheduleLive = (text: string) => {
    cancelLive();
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = undefined;
      liveNow(text);
    }, 100);
  };
  return { scheduleLive, cancelLive };
}

// ─────────────────────────── Shared label ───────────────────────────

export function BgLabel({
  label,
  prop,
  d: display,
  contributors,
  busy,
  scrubProps,
  onClear,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  d: Display;
  contributors: Contributor[];
  busy: boolean;
  scrubProps?: ScrubHandlers;
  onClear: () => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  if (display.present && !display.isSelected) {
    return <ProvenanceLabel label={label} props={[prop]} busy={busy} onProvenance={onProvenance} />;
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${display.overridden ? 'is-overridden' : ''}`}
      active={display.isSelected}
      {...(display.present ? {} : { inheritedProp: prop })}
      disabled={busy}
      onReset={onClear}
      resetLabel="Clear"
      tooltip={<PropTip props={[prop]} />}
      {...(display.overridden ? { title: `Overridden by ${display.winnerSelector}` } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={contributors}
          prop={prop}
          onSelect={(selector, selectedProp) => {
            onSelectSelector(selector, selectedProp);
            close();
          }}
        />
      )}
      {...(scrubProps === undefined ? {} : { scrubProps })}
    >
      {label}
    </FieldLabel>
  );
}

// A live text field bound to one property (Color, and inside the layer editor).
export function BgField({
  prop,
  label,
  placeholder,
  prefix,
  swatchLabel,
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  prop: string;
  label: string;
  placeholder: string;
  prefix?: ReactNode;
  /** Render a colour swatch before the field, editing this same property. Owned
   *  here rather than passed in as `prefix` so a drag on it shows in the field. */
  swatchLabel?: string;
} & Props) {
  const display = displayOf(read(prop));
  const external = displayText(display);
  const field = useBgFieldEditing({ prop, external, busy, setProp, clearProp, liveSetProp });
  const input = <BgFieldInput prop={prop} label={label} placeholder={placeholder} field={field} />;
  const swatch = swatchLabel ? (
    <ColorSwatch value={field.shown} busy={busy} ariaLabel={swatchLabel} onChange={(color, live) => field.swatchChange(color, { live })} />
  ) : undefined;
  const before = swatch ?? prefix;

  return (
    <>
      <BgLabel
        label={label}
        prop={prop}
        d={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        scrubProps={field.scrub.label}
        onClear={() => {
          field.cleared();
          clearProp(prop);
        }}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      {before ? (
        <div className="embed-editor_bg-inline">
          {before}
          {input}
        </div>
      ) : (
        input
      )}
    </>
  );
}

export type BgFieldEditing = ReturnType<typeof useBgFieldEditing>;

// The field's own handlers, spread onto the input after the scrub's: typing drops any
// live swatch colour and schedules a live write, blur commits, ↑/↓ step in place.
export function bgInputHandlers({
  focusedRef,
  noteLive,
  setDraft,
  scheduleLive,
  cancelLive,
  commit,
}: {
  focusedRef: React.MutableRefObject<boolean>;
  noteLive: ReturnType<typeof useLiveColor>[1];
  setDraft: (draft: string) => void;
  scheduleLive: (text: string) => void;
  cancelLive: () => void;
  commit: () => void;
}) {
  return {
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      noteLive(undefined);
      setDraft(event.target.value);
      scheduleLive(event.target.value);
    },
    onFocus: () => {
      focusedRef.current = true;
    },
    onBlur: () => {
      focusedRef.current = false;
      cancelLive();
      commit();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      const stepped = stepInPlace(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        scheduleLive(stepped);
      }
    },
  };
}

// The field's editing state: the draft (and a live colour drag shown over it), live
// writes 100ms after typing stops (undelayed for the scrub, which throttles its own —
// see useScrub), and the commit on blur, which clears the property when emptied.
export function useBgFieldEditing({
  prop,
  external,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: Pick<Props, 'busy' | 'setProp' | 'clearProp' | 'liveSetProp'> & {
  prop: string;
  external: string;
}) {
  const { draft, setDraft, focused, cleared } = useFieldDraft(external, { busy });
  const [shown, noteLive] = useLiveColor(draft);
  const liveNow = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const parsed = parseImportant(trimmed);
    liveSetProp(prop, parsed.value, parsed.important);
  };
  const { scheduleLive, cancelLive } = useLiveTimer(liveNow);
  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      clearProp(prop);
      return;
    }
    const parsed = parseImportant(trimmed);
    setProp(prop, parsed.value, parsed.important);
  };
  const commitScrub = (text: string) => {
    setDraft(text);
    commit(text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: commitScrub,
  });
  const inputHandlers = bgInputHandlers({
    focusedRef: focused,
    noteLive,
    setDraft,
    scheduleLive,
    cancelLive,
    commit,
  });
  // A variable pick and the swatch change the colour, not the flag: they have no
  // text to delete `!important` from, so they keep the one the field shows.
  const shownImportant = { important: parseImportant(external).important };
  const pick = (binding: string) => {
    const kept = keepImportant(binding, shownImportant);
    setProp(prop, kept.value, kept.important);
  };
  // Show a swatch drag in the field as it happens; the model only hears about it when
  // the drag ends, and only then is `shown` handed back to it.
  const swatchChange = (color: string, options: WriteOptions) => {
    const kept = keepImportant(color, shownImportant);
    const text = withImportant(kept);
    noteLive(options.live ? text : undefined);
    if (options.live) {
      liveSetProp(prop, kept.value, kept.important);
      return;
    }
    setDraft(text);
    setProp(prop, kept.value, kept.important);
  };
  return { busy, shown, cleared, scrub, inputHandlers, pick, swatchChange };
}

export function BgFieldInput({ prop, label, placeholder, field }: { prop: string; label: string; placeholder: string; field: BgFieldEditing }) {
  return (
    <VariableConnect code ariaLabel={`Connect ${label} to a variable`} disabled={field.busy} prop={prop} onPick={field.pick}>
      <input
        {...field.scrub.input}
        className="u-input embed-editor_size-input"
        data-prop={prop}
        value={field.shown}
        {...field.inputHandlers}
        disabled={field.busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={label}
      />
    </VariableConnect>
  );
}

// ─────────────────────────── Icons ───────────────────────────

// The layer editor lives in a full-width popup over the panel (dark backdrop),
// rather than expanding inline. Portaled to <body> so it escapes the panel's
// clipping / stacking; closes on backdrop click or Escape. No header — the rows
// (label left / control right, divider-separated) run edge to edge like Webflow.
export function LayerEditorModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <PanelSheet className="embed-editor_bg-modal u-surface-surface" label="Background layer" onClose={onClose}>
      {children}
    </PanelSheet>
  );
}
