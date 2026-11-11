import { centralIcon } from '../../ui/central/CentralIcon';
import { lock as centralLock, unlock as centralUnlock } from '../../ui/central/centralGeometry';
import { useEffect, useRef, useState } from 'react';
import { GroupLabel, PropLabel } from './TypographySection';
import { displayOf, parseImportant, withImportant } from './model/styleDisplay';
import useScrub from './components/useScrub';
import { handleArrowStep } from './model/numberStep';
import { isNonNegative } from './model/cssProperties';
import VariableConnect from './VariableConnect';
import type { ResolvedProp } from './model/resolved';
import { splitTopLevelSpaces } from './model/background';
import { useGapHover, type GapAxis } from './model/gapHover';

// The Gap control for the Layout section: a lock toggle plus one field (linked →
// both gaps equal) or two fields (unlinked → separate row/column).
// Native-first / embed-fallback is handled by the parent's set/clear/liveSet.
//
// A gap can be written three ways: the modern `row-gap`/`column-gap` longhands, the
// legacy `grid-*-gap` aliases (what Webflow emits, and all this control used to read or
// write), or the `gap` shorthand. Reading only the aliases meant a rule using the modern
// longhands showed an empty field, and writing only the aliases appended a SECOND
// declaration for a gap the rule already had — so the field read 0, the edit duplicated
// the property, and if the value matched what was already there nothing moved on the
// canvas. So: read whichever form the CSS uses, and write the form(s) already present.

type SetProp = (prop: string, value: string, important: boolean) => void;
type ClearProp = (prop: string | string[]) => void;
type LiveSetProp = (prop: string, value: string | undefined, important: boolean) => void;

const ROW = 'row-gap';
const COL = 'column-gap';
const ROW_LEGACY = 'grid-row-gap';
const COL_LEGACY = 'grid-column-gap';
const SHORTHAND = 'gap';
/** Every declaration this row represents — for the label's active state and Clear. */
const GAP_PROPS = [ROW, COL, ROW_LEGACY, COL_LEGACY, SHORTHAND];

// `gap: <row> [<column>]` — one value sets both axes.
function shorthandPart(value: string, axis: 'row' | 'col'): string {
  const parts = splitTopLevelSpaces(value).filter(Boolean);
  if (!parts.length) {
    return '';
  }
  return axis === 'row' ? (parts[0] ?? '') : (parts[1] ?? parts[0] ?? '');
}

type Axis = {
  /** The value, without its flag. */
  value: string;
  important: boolean;
  /** What the field shows: the value with its `!important`, the way every field
   *  in the panel spells it (model/styleDisplay.ts). */
  text: string;
  /** Declarations a write should update — empty means nothing is set yet. */
  targets: string[];
  /** The declaration the shown value came from (for the label + provenance). */
  resolved: ResolvedProp | undefined;
};

// One axis's state: where its value comes from, and what a write should touch.
function axisState(modern: string, legacy: string, axis: 'row' | 'col', read: (prop: string) => ResolvedProp | undefined): Axis {
  const modernResolved = read(modern);
  const legacyResolved = read(legacy);
  const modernSet = modernResolved?.source === 'selected';
  const legacySet = legacyResolved?.source === 'selected';
  // Update every form the picked rule already carries: with both present the later one
  // wins and we can't see declaration order from here, so keeping them in step is the
  // only way the edit is guaranteed to show. Nothing set → write the modern longhand.
  const targets: string[] = [];
  if (modernSet) {
    targets.push(modern);
  }
  if (legacySet) {
    targets.push(legacy);
  }
  // Show the picked rule's own value (preferring the alias — when both exist it's the one
  // the old write path appended last, so it's what the canvas is using), else an
  // inherited longhand, else the `gap` shorthand's part for this axis.
  const own = legacySet ? legacyResolved : modernSet ? modernResolved : undefined;
  const effective = own ?? legacyResolved ?? modernResolved;
  if (effective) {
    const raw = rawEffective(effective);
    return { value: raw.value, important: raw.important, text: withImportant(raw), targets, resolved: effective };
  }
  const short = read(SHORTHAND);
  if (short) {
    const raw = rawEffective(short);
    const part = shorthandPart(raw.value, axis);
    return {
      value: part,
      important: raw.important,
      text: withImportant({ value: part, important: raw.important }),
      targets,
      resolved: short,
    };
  }
  return { value: '', important: false, text: '', targets, resolved: undefined };
}

// The effective raw value + !important (not lowercased) — mirrors EmbedEditor's helper.
function rawEffective(resolved: ResolvedProp | undefined): { value: string; important: boolean } {
  if (!resolved) {
    return { value: '', important: false };
  }
  const effective = resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue : resolved.winner;
  return { value: effective.value, important: effective.important };
}

const LockedIcon = centralIcon(centralLock);
const UnlockedIcon = centralIcon(centralUnlock);

// A length field: live-as-you-type updates, commit on blur, ↑/↓ number stepping.
// Which axes a field is responsible for: the linked field is both, the split
// ones are one each. Hovering says which spaces on the page this number holds
// open, the same way hovering a padding side does.
function axesFor(prop: string, layout: 'linked' | 'split'): GapAxis[] {
  if (layout === 'linked') {
    return ['row', 'column'];
  }
  return prop === COL ? ['column'] : ['row'];
}

interface GapFieldOptions {
  prop: string;
  value: string;
  busy: boolean;
  axes: GapAxis[];
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}

function GapInput({
  ariaLabel,
  ...field
}: GapFieldOptions & {
  ariaLabel: string;
}) {
  const inputProps = useGapField(field);
  return (
    <VariableConnect
      code
      // A gap has no negative side to step onto.
      {...(isNonNegative(field.prop) ? { stepMin: 0 } : {})}
      className="is-fill"
      ariaLabel={`Connect ${ariaLabel} to a variable`}
      disabled={field.busy}
      prop={field.prop}
      onPick={(binding) => field.onCommit(binding)}
    >
      <input {...inputProps} className="u-input embed-editor_size-input" disabled={field.busy} spellCheck={false} placeholder="0" aria-label={ariaLabel} />
    </VariableConnect>
  );
}

// The field's behavior: scrubbing, live-as-you-type writes, commit on blur, arrow-key
// stepping, and the gap bands on hover or focus. Spread onto the input, in this order.
function useGapField({ prop, value, busy, axes, onLive, onCommit }: GapFieldOptions) {
  const { draft, setDraft, focused } = useExternalDraft(value);
  const { scheduleLive, cancelLive } = useLiveTimer(onLive);
  const gapHover = useGapHover(axes, draft || value);
  const commitScrub = (text: string) => {
    setDraft(text);
    onCommit(text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: onLive,
    onCommit: commitScrub,
  });
  return {
    ...scrub.input,
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      setDraft(event.target.value);
      scheduleLive(event.target.value);
      gapHover.onValue(event.target.value);
    },
    ...gapHover.handlers,
    onFocus: () => {
      focused.current = true;
      gapHover.onFocus();
    },
    onBlur: () => {
      focused.current = false;
      gapHover.onBlur();
      cancelLive();
      onCommit(draft);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      const stepped = stepOnKey(event, prop);
      if (stepped !== undefined) {
        setDraft(stepped);
        scheduleLive(stepped);
      }
    },
  };
}

// The field's draft: it mirrors external edits, but never clobbers what the user is
// typing (while `focused` holds).
function useExternalDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  return { draft, setDraft, focused };
}

// Enter blurs (which commits); ↑/↓ step the number in place. Returns the stepped text,
// or undefined when the key did not step.
function stepOnKey(event: React.KeyboardEvent<HTMLInputElement>, prop: string) {
  if (event.key === 'Enter') {
    event.currentTarget.blur();
    return undefined;
  }
  // A gap has no negative side to step onto.
  const stepped = handleArrowStep(event, isNonNegative(prop) ? 0 : undefined);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  const input = event.currentTarget;
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// Debounces live writes while typing: the draft reaches `onLive` 100ms after the last
// keystroke; `cancelLive` drops a pending one.
function useLiveTimer(onLive: (value: string) => void) {
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
      onLive(text);
    }, 100);
  };
  return { scheduleLive, cancelLive };
}

interface GapControlProps {
  // Whether the row is applicable (flex/grid, or a gap already set). Passed in
  // (rather than gating the mount in the parent) so this component stays mounted
  // across background refreshes — otherwise the link-toggle state would reset.
  show: boolean;
  read: (prop: string) => ResolvedProp | undefined;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}

// How a write lands: live while typing, or committed.
interface WriteOptions {
  readonly live: boolean;
}

export default function GapControl(props: GapControlProps) {
  const { show, read, busy, setProp, clearProp, liveSetProp } = props;
  const rowAxis = axisState(ROW, ROW_LEGACY, 'row', read);
  const columnAxis = axisState(COL, COL_LEGACY, 'col', read);
  const row = rowAxis.text;
  const column = columnAxis.text;
  const [linkOverride, setLinkOverride] = useState<boolean | undefined>(undefined);
  const linked = linkOverride ?? row === column;

  // All hooks run above this guard so the component keeps its state while hidden.
  if (!show) {
    return undefined;
  }

  const writeAxis = axisWriter({ setProp, liveSetProp, clearProp });
  // Linked → both axes take the same value; unlinked → each field owns one.
  const writeBoth = (next: string, options: WriteOptions) => {
    writeAxis(rowAxis, ROW, next, options);
    writeAxis(columnAxis, COL, next, options);
  };
  // Linking writes the one shown value to both axes (or clears both when neither is set).
  const toggleLink = () => {
    setLinkOverride(!linked);
    if (linked) {
      return;
    }
    const single = row || column;
    if (single) {
      writeBoth(single, { live: false });
    } else {
      clearProp(GAP_PROPS);
    }
  };
  const { onProvenance, onSelectSelector } = props;
  const labelProps = { busy, onProvenance, onSelectSelector };

  return (
    <div className="embed-editor_size-row">
      <GroupLabel
        label="Gap"
        props={GAP_PROPS}
        read={read}
        {...labelProps}
        onClear={() => {
          setLinkOverride(undefined);
          clearProp(GAP_PROPS);
        }}
      />
      <div className="embed-editor_gap">
        {linked ? (
          <GapInput
            prop={ROW}
            value={row}
            busy={busy}
            ariaLabel="Gap"
            axes={axesFor(ROW, 'linked')}
            onLive={(next) => writeBoth(next, { live: true })}
            onCommit={(next) => writeBoth(next, { live: false })}
          />
        ) : (
          <SplitGapFields rowAxis={rowAxis} columnAxis={columnAxis} {...labelProps} clearProp={clearProp} writeAxis={writeAxis} />
        )}
        <GapLinkButton linked={linked} busy={busy} onToggle={toggleLink} />
      </div>
    </div>
  );
}

// Write an axis: update whatever form(s) it already uses, or add the modern longhand.
function axisWriter({ setProp, liveSetProp, clearProp }: Pick<GapControlProps, 'setProp' | 'liveSetProp' | 'clearProp'>) {
  return (axis: Axis, fallback: string, next: string, options: WriteOptions) => {
    const trimmed = next.trim();
    const targets = axis.targets.length ? axis.targets : [fallback];
    if (!trimmed) {
      if (!options.live) {
        clearProp(targets);
      }
      return;
    }
    // The flag is what the text says: a field that shows `!important` keeps it
    // through an edit, and deleting it from the text removes it. Before, the
    // field hid the flag and every write re-applied it, so it could not go.
    const parsed = parseImportant(trimmed);
    const put = options.live ? liveSetProp : setProp;
    targets.forEach((prop) => put(prop, parsed.value, parsed.important));
  };
}

// Unlinked: one field per axis, columns first.
function SplitGapFields({
  rowAxis,
  columnAxis,
  writeAxis,
  ...shared
}: Pick<GapControlProps, 'busy' | 'clearProp' | 'onProvenance' | 'onSelectSelector'> & {
  rowAxis: Axis;
  columnAxis: Axis;
  writeAxis: ReturnType<typeof axisWriter>;
}) {
  return (
    <>
      <GapCell
        axis={columnAxis}
        prop={COL}
        legacy={COL_LEGACY}
        label="Columns"
        ariaLabel="Column gap"
        {...shared}
        write={(next, options) => writeAxis(columnAxis, COL, next, options)}
      />
      <GapCell
        axis={rowAxis}
        prop={ROW}
        legacy={ROW_LEGACY}
        label="Rows"
        ariaLabel="Row gap"
        {...shared}
        write={(next, options) => writeAxis(rowAxis, ROW, next, options)}
      />
    </>
  );
}

// One axis of the unlinked pair: its field and its label.
function GapCell({
  axis,
  prop,
  legacy,
  label,
  ariaLabel,
  busy,
  clearProp,
  write,
  onProvenance,
  onSelectSelector,
}: Pick<GapControlProps, 'busy' | 'clearProp' | 'onProvenance' | 'onSelectSelector'> & {
  axis: Axis;
  prop: string;
  legacy: string;
  label: string;
  ariaLabel: string;
  write: (next: string, options: WriteOptions) => void;
}) {
  const resolved = axis.resolved;
  return (
    <div className="embed-editor_gap-cell">
      <GapInput
        prop={prop}
        value={axis.text}
        busy={busy}
        ariaLabel={ariaLabel}
        axes={axesFor(prop, 'split')}
        onLive={(next) => write(next, { live: true })}
        onCommit={(next) => write(next, { live: false })}
      />
      <PropLabel
        label={label}
        prop={prop}
        display={displayOf(resolved)}
        contributors={resolved?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(axis.targets.length ? axis.targets : [prop, legacy])}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
    </div>
  );
}

function GapLinkButton({ linked, busy, onToggle }: { linked: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`embed-editor_icon-btn embed-editor_gap-link ${linked ? 'is-active' : ''}`}
      disabled={busy}
      aria-pressed={linked}
      title={linked ? 'Linked — one gap for rows and columns' : 'Unlinked — separate row and column gaps'}
      onClick={onToggle}
    >
      {linked ? <LockedIcon /> : <UnlockedIcon />}
    </button>
  );
}
