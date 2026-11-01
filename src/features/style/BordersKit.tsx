// What the borders section's controls share: the writers they are handed,
// `!important` split and joined, the provenance-aware label and the live
// value field (BordersSection.tsx).

import type { ReactNode } from 'react';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import ProvenanceList from './ProvenanceList';
import type { ResolvedProp } from './model/resolved';
import SharedLiveInput from './components/LiveInput';
import { displayOf } from './model/styleDisplay';

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

export const stripImportant = (value: string) => value.replace(/\s*!important\s*$/i, '').trim();
export const joinImportant = (parsed: { readonly value: string; readonly important: boolean }) =>
  parsed.important ? `${parsed.value} !important` : parsed.value;

// ─────────────────── Provenance-aware label (mirrors SizeLabel) ───────────────────

export function OverrideNote({ selector, onSelect }: { selector: string; onSelect: () => void }) {
  return (
    <div className="embed-editor_override-note">
      <span>Overridden by a more specific selector:</span>
      <button type="button" className="embed-editor_override-note-sel" title="Select this selector" onClick={onSelect}>
        {selector}
      </button>
    </div>
  );
}

export function PropLabel({
  label,
  prop,
  clearProps,
  className = '',
  read,
  busy,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  label: ReactNode;
  prop: string;
  clearProps?: string[];
  /** Extra class on the label — the corner glyphs use it to size their pill. */
  className?: string;
} & Pick<Props, 'read' | 'busy' | 'clearProp' | 'onProvenance' | 'onSelectSelector'>) {
  const resolved = read(prop);
  const display = displayOf(resolved);
  const contributors = resolved?.contributors ?? [];
  // A grouped label (the four corners, all four edges) names every property it
  // writes in its tooltip; a single-property one just names its own.
  const tip = clearProps ?? [prop];
  if (display.present && !display.isSelected) {
    return (
      <ProvenanceLabel label={label} props={tip} className={`embed-editor_size-label ${className}`} anchorProp={prop} busy={busy} onProvenance={onProvenance} />
    );
  }
  const overriddenClass = display.overridden ? 'is-overridden' : '';
  return (
    <FieldLabel
      className={`embed-editor_size-label ${className} ${overriddenClass}`}
      active={display.isSelected}
      {...(display.present ? {} : { inheritedProp: prop })}
      disabled={busy}
      onReset={() => clearProp(clearProps ?? prop)}
      resetLabel="Clear"
      tooltip={<PropTip props={tip} />}
      {...(display.overridden ? { title: `Overridden by ${display.winnerSelector}` } : {})}
      menuNote={(close) => (
        <>
          {display.overridden ? (
            <OverrideNote
              selector={display.winnerSelector}
              onSelect={() => {
                onSelectSelector(display.winnerSelector, prop);
                close();
              }}
            />
          ) : undefined}
          <ProvenanceList
            contributors={contributors}
            prop={prop}
            onSelect={(selector, selectedProp) => {
              onSelectSelector(selector, selectedProp);
              close();
            }}
          />
        </>
      )}
    >
      {label}
    </FieldLabel>
  );
}

// ─────────────────── Live value field ───────────────────

// The panel's shared field (components/LiveInput), in this section's own box —
// the border rows lay their fields out beside a swatch, so the wrapper is theirs
// while the field itself is the same one every other row uses.
export function LiveInput(props: Omit<Parameters<typeof SharedLiveInput>[0], 'wrapClassName'>) {
  return <SharedLiveInput wrapClassName="embed-editor_field embed-editor_border-field" {...props} />;
}
