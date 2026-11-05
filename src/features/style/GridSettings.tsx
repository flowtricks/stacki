import { useEffect, useRef, useState } from 'react';
import VariableConnect from './VariableConnect';
import { GroupLabel } from './TypographySection';
import {
  parseTrackList,
  serializeTrackList,
  serializeTrackSize,
  trackKind,
  trackLabel,
  isFixedSizeTrack,
  trackForm,
  asTrackList,
  asRepeat,
  canEditAsTracks,
  type TrackSize,
} from './model/gridTemplate';
import { openAfterRemoval } from './model/fieldHooks';
import {
  type SetProp,
  type ClearProp,
  type Read,
  type OnProvenance,
  type OnSelectSelector,
  type LabelProps,
  resolvedValue,
  PlusIcon,
  TrashIcon,
  DuplicateIcon,
  GripIcon,
} from './GridSettingsKit';
import { TrackIcon, type AutoFit, TrackSizeEditor, TrackPopover } from './TrackEditor';
import { AreasSection } from './GridAreas';
import { type TrackSectionProps, AutoSection, Modal } from './GridAutoSection';
import { withImportant } from './model/styleDisplay';

// The "Grid settings" modal (Webflow's Configure-grid popup): the Columns and Rows
// track lists — drag to reorder, click a track to size it (a single Default size or a
// minmax(min, max) pair) — plus the auto-generated track sizes and (read-only for now)
// the areas. Resolved-model API; writes an explicit space-separated grid-template.

const BRACES_ICON_PATH =
  'M6.4 2.5c-1.2 0-1.7.6-1.7 1.7v1.9c0 1-.3 1.4-1.2 1.4v1c.9 0 1.2.4 1.2 1.4v1.9' +
  'c0 1.1.5 1.7 1.7 1.7M9.6 2.5c1.2 0 1.7.6 1.7 1.7v1.9c0 1 .3 1.4 1.2 1.4v1' +
  'c-.9 0-1.2.4-1.2 1.4v1.9c0 1.1-.5 1.7-1.7 1.7';

// The expression toggle's glyph: the braces you write one in.
const BracesIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <path d={BRACES_ICON_PATH} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// The whole track list as one field, for a value the list cannot hold: a
// variable standing in for every track (`var(--columns)`), an !important, a
// subgrid. The tracks are how you build a grid; this is how you say one the
// builder has no controls for.
//
// It is the same editor the panel opens over a cramped field — multi-line, with
// variables as chips and the value coloured as code — but sitting in the panel
// rather than in a box over it. A field that already has the room does not need
// one opened in front of it, which is what `expanded` says.
function ExpressionField({
  prop,
  value,
  title,
  busy,
  onCommit,
}: {
  prop: string;
  value: string;
  title: string;
  busy: boolean;
  onCommit: (v: string, important: boolean) => void;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(value);
    }
  }, [value]);
  // Whatever is in the field is the value, `!important` included — this is the
  // way in for everything the track controls have no way to say.
  const commit = (typed: string) => {
    const trimmed = typed.trim();
    const match = trimmed.match(/!\s*important\s*$/i);
    onCommit(match ? trimmed.slice(0, match.index).trim() : trimmed, !!match);
  };
  return (
    <VariableConnect
      className="is-multiline"
      code
      expanded
      ariaLabel={`${title} expression`}
      disabled={busy}
      prop={prop}
      onPick={(next) => {
        setText(next);
        commit(next);
      }}
    >
      <textarea
        className="embed-editor_grid-expression"
        value={text}
        spellCheck={false}
        rows={3}
        disabled={busy}
        aria-label={`${title} expression`}
        placeholder="repeat(auto-fit, minmax(12rem, 1fr))"
        onChange={(event) => setText(event.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={(event) => {
          focused.current = false;
          commit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          // A CSS value has no need for a line break, so Enter is "done".
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </VariableConnect>
  );
}

// The repeat() switch: which of the two ways this track list is written (see
// trackForm). On, `repeat(3, 1fr)`; off, `1fr 1fr 1fr` — the same grid either
// way, so this is about the CSS you end up reading, not the layout.
//
// It stays on through an edit: adding a fourth track to `repeat(3, 1fr)` writes
// `repeat(4, 1fr)` rather than quietly writing them all out, which is what used
// to happen. Tracks that differ cannot be a repeat() at all, so there the
// switch is off and says why.
function RepeatSwitch({
  on,
  can,
  why,
  busy,
  title,
  onChange,
}: {
  on: boolean;
  can: boolean;
  why: string;
  busy: boolean;
  title: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <label
      className={`embed-editor_switch ${on ? 'is-on' : ''} ${can ? '' : 'is-disabled'}`}
      title={can ? why : `Tracks that differ can’t be written as repeat()`}
    >
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={busy || !can}
        aria-label={`Use repeat() for ${title.toLowerCase()}`}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="embed-editor_switch-label">repeat()</span>
    </label>
  );
}

// Whether a list is several copies of one track — the only lists a repeat() can say.
const sameTracks = (list: string[]) => list.length > 1 && list.every((x) => x === list[0]);

// A reorderable track list (Columns / Rows). Drag the grip to reorder, click a row to
// open its size editor (popup), trash to remove, + to append a 1fr track.
function TrackSection({ title, prop, axis, setProp, labels }: TrackSectionProps) {
  const { busy, clearProp } = labels;
  const list = useTrackList({ prop, setProp, labels });
  const { tracks, rawTemplate, important } = list;
  // Editing the value as text rather than as tracks. Asked for with the braces
  // — or forced, when the value is one the track list cannot hold: showing
  // `var(--columns)` or an !important as tracks would read it as a track with a
  // strange name, and the first edit would write that reading back over it. In
  // that case the braces are pressed and stuck, which is the honest state.
  const [expression, setExpression] = useState(false);
  const tracksCanHold = canEditAsTracks(withImportant({ value: rawTemplate, important }));
  const asExpression = expression || !tracksCanHold;
  const edits = useTrackEdits({ tracks, axis, write: list.write });
  const { open } = edits;
  const openTrack = open === undefined ? undefined : tracks[open];

  return (
    <section className="embed-editor_grid-section">
      <TrackSectionHead
        title={title}
        prop={prop}
        labels={labels}
        list={list}
        setProp={setProp}
        tracksCanHold={tracksCanHold}
        asExpression={asExpression}
        onToggleExpression={() => setExpression((wasOn) => !wasOn)}
        onAdd={edits.add}
      />
      {asExpression ? (
        <ExpressionField
          prop={prop}
          value={list.shown}
          title={title}
          busy={busy}
          onCommit={(next, imp) => {
            if (next) {
              setProp(prop, next, imp);
            } else {
              clearProp(prop);
            }
          }}
        />
      ) : tracks.length ? (
        <ul className="embed-editor_grid-track-list">
          {tracks.map((track, i) => (
            <TrackRow key={i} track={track} index={i} axis={axis} busy={busy} edits={edits} />
          ))}
        </ul>
      ) : (
        <div className="embed-editor_grid-empty">No {title.toLowerCase()}</div>
      )}
      {open !== undefined && edits.anchorElement && openTrack ? (
        <TrackPopover anchorElement={edits.anchorElement} onClose={() => edits.setOpen(undefined)}>
          <TrackSizeEditor track={openTrack} busy={busy} autoFit={list.autoFit} onChange={(size) => edits.setTrack(open, size)} />
        </TrackPopover>
      ) : undefined}
    </section>
  );
}

type TrackList = ReturnType<typeof useTrackList>;

// The track list as the value says it, and how it is written back. Every edit writes
// the list in the form the repeat() switch is showing, so adding a track to a
// repeat() keeps it one.
function useTrackList({ prop, setProp, labels }: Pick<TrackSectionProps, 'prop' | 'setProp' | 'labels'>) {
  const { read, clearProp } = labels;
  const rawTemplate = resolvedValue(read, prop);
  // `!important` is carried beside the value, not in it — the field shows it,
  // since the field is where it can be typed.
  const important = !!(read(prop)?.selectedValue ?? read(prop)?.winner)?.important;
  const shown = withImportant({ value: rawTemplate, important: important && rawTemplate !== '' });
  const tracks = parseTrackList(rawTemplate);
  // Which way this list is written. The value answers whenever it can — it is
  // either a repeat() or it isn't — and the preference only decides the cases
  // where the question doesn't arise yet: no tracks, or one. A new grid is a
  // repeat(), which is what the count stepper writes, so that is the default.
  const form = trackForm(rawTemplate);
  const [preferRepeat, setPreferRepeat] = useState(true);
  // A value that says which form it is IS the setting; remember it for the next
  // time the value can't say (emptied, down to one track).
  useEffect(() => {
    if (form === 'repeat') {
      setPreferRepeat(true);
    } else if (form === 'list') {
      setPreferRepeat(false);
    }
  }, [form]);
  // Under two tracks there is nothing a repeat() would say differently, so the
  // switch stays available and simply waits.
  const canRepeat = tracks.length < 2 || sameTracks(tracks);
  const repeatOn = form === 'repeat' ? true : form === 'list' ? false : canRepeat && preferRepeat;
  const asWritten = (next: string[]) => (repeatOn && sameTracks(next) ? `repeat(${next.length}, ${next[0]})` : serializeTrackList(next));
  const write = (next: string[]) => {
    const written = asWritten(next);
    if (written) {
      setProp(prop, written, false);
    } else {
      clearProp(prop);
    }
  };
  const autoFit = autoFitFor({ prop, rawTemplate, tracks, setProp });
  return {
    rawTemplate,
    important,
    shown,
    tracks,
    canRepeat,
    repeatOn,
    setPreferRepeat,
    write,
    autoFit,
  };
}

// Auto-fit wraps the whole track list in repeat(auto-fit, …) — valid only when every
// track is a `<fixed-size>` (a fixed length or a minmax() with a fixed min, e.g.
// minmax(20rem, 1fr)); otherwise the warning explains why.
function autoFitFor({ prop, rawTemplate, tracks, setProp }: { prop: string; rawTemplate: string; tracks: string[]; setProp: SetProp }): AutoFit {
  return {
    on: /\bauto-fit\b/i.test(rawTemplate),
    can: tracks.length > 0 && tracks.every(isFixedSizeTrack),
    onToggle: (on: boolean) => {
      if (on) {
        // Reuse an existing fixed-size track as-is (e.g. minmax(20rem, 1fr)); turn a
        // bare fixed length into a responsive minmax(<len>, 1fr) so columns flex to fill.
        const base = tracks.find(isFixedSizeTrack) ?? tracks[0] ?? '200px';
        const pattern = trackKind(base) === 'length' ? `minmax(${base}, 1fr)` : base;
        setProp(prop, `repeat(auto-fit, ${pattern})`, false);
      } else {
        const match = rawTemplate.match(/repeat\(\s*auto-fit\s*,\s*(.+)\)\s*$/is);
        setProp(prop, match ? (match[1] ?? '').trim() : (tracks[0] ?? '1fr'), false);
      }
    },
  };
}

type TrackEdits = ReturnType<typeof useTrackEdits>;

// Which track's popover is open (and the row it hangs from), the drag in progress,
// and the list edits — each written back through `write`.
function useTrackEdits({ tracks, axis, write }: { tracks: string[]; axis: 'column' | 'row'; write: (next: string[]) => void }) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  const [anchorElement, setAnchorElement] = useState<HTMLElement | undefined>(undefined);
  const [dragFrom, setDragFrom] = useState<number | undefined>(undefined);
  const [dragOver, setDragOver] = useState<number | undefined>(undefined);
  const openAt = (i: number, element: HTMLElement) => {
    if (open === i) {
      setOpen(undefined);
      return;
    }
    setOpen(i);
    setAnchorElement(element.closest('li') ?? element);
  };
  // New tracks use Webflow's defaults: a column is minmax(0px, 1fr) (fills its share but can
  // shrink so content can't overflow the grid), a row is auto (content-sized). The min needs
  // a unit — a bare `0` makes Webflow read the whole grid-template as a custom value.
  // Adding to a list whose tracks are all the same adds another of THOSE — a
  // fourth column of `repeat(3, 1fr)` is a 1fr, not the generic default, which
  // would differ by a character (`minmax(0px, 1fr)` vs `minmax(0, 1fr)`) and
  // quietly break the list into one that can no longer be a repeat().
  const add = () => {
    const fallback = axis === 'column' ? 'minmax(0px, 1fr)' : 'auto';
    const fresh = sameTracks(tracks) ? (tracks[0] ?? fallback) : fallback;
    write([...tracks, fresh]);
    setOpen(tracks.length);
  };
  const remove = (i: number) => {
    write(tracks.filter((_, other) => other !== i));
    setOpen((previous) => openAfterRemoval(previous, i));
  };
  const setTrack = (i: number, size: TrackSize) => write(tracks.map((track, other) => (other === i ? serializeTrackSize(size) : track)));
  const duplicate = (i: number) => {
    const track = tracks[i];
    if (track === undefined) {
      return;
    }
    write([...tracks.slice(0, i + 1), track, ...tracks.slice(i + 1)]);
  };
  const reorder = (from: number, to: number) => {
    if (from === to) {
      return;
    }
    const next = [...tracks];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) {
      return;
    }
    next.splice(to, 0, moved);
    write(next);
    setOpen((previous) => (previous === from ? to : previous));
  };
  const drag = { dragFrom, dragOver, setDragFrom, setDragOver };
  return { open, setOpen, anchorElement, openAt, add, remove, setTrack, duplicate, reorder, drag };
}

// The section head: label, then how the value is written, then the field for writing
// it by hand — all packed left, so the eye reads along the row instead of crossing a
// gap between them. The + stays where every other section keeps its add.
function TrackSectionHead({
  title,
  prop,
  labels,
  list,
  setProp,
  tracksCanHold,
  asExpression,
  onToggleExpression,
  onAdd,
}: {
  title: string;
  prop: string;
  labels: LabelProps;
  list: TrackList;
  setProp: SetProp;
  tracksCanHold: boolean;
  asExpression: boolean;
  onToggleExpression: () => void;
  onAdd: () => void;
}) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = labels;
  const { tracks, repeatOn } = list;
  return (
    <div className="embed-editor_grid-section-head">
      <span className="embed-editor_grid-section-title">
        <GroupLabel
          label={title}
          props={[prop]}
          read={read}
          busy={busy}
          onClear={() => clearProp(prop)}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
        <span className="embed-editor_grid-section-count">({tracks.length})</span>
      </span>
      <RepeatSwitch
        on={repeatOn}
        can={list.canRepeat && !asExpression}
        why={repeatOn ? `Written as repeat(${tracks.length}, …)` : 'Write these tracks as repeat()'}
        busy={busy}
        title={title}
        onChange={(next) => switchRepeat({ next, prop, list, setProp })}
      />
      <ExpressionToggle title={title} busy={busy} tracksCanHold={tracksCanHold} asExpression={asExpression} onToggle={onToggleExpression} />
      {asExpression ? undefined : (
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={onAdd}
          disabled={busy}
          title={`Add a ${title.toLowerCase().replace(/s$/, '')}`}
          aria-label={`Add a ${title}`}
        >
          <PlusIcon />
        </button>
      )}
    </div>
  );
}

// Flipping the repeat() switch remembers the choice, then rewrites a non-empty list
// in the chosen form.
function switchRepeat({ next, prop, list, setProp }: { next: boolean; prop: string; list: TrackList; setProp: SetProp }) {
  list.setPreferRepeat(next);
  if (!list.tracks.length) {
    return;
  }
  const value = next ? asRepeat(list.rawTemplate) : asTrackList(list.rawTemplate);
  if (value) {
    setProp(prop, value, false);
  }
}

// The braces: edit the whole value as an expression, or back to tracks.
function ExpressionToggle({
  title,
  busy,
  tracksCanHold,
  asExpression,
  onToggle,
}: {
  title: string;
  busy: boolean;
  tracksCanHold: boolean;
  asExpression: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`embed-editor_icon-btn ${asExpression ? 'is-active' : ''}`}
      disabled={busy || !tracksCanHold}
      aria-pressed={asExpression}
      aria-label={`Edit ${title.toLowerCase()} as an expression`}
      title={!tracksCanHold ? 'This value can’t be shown as tracks' : asExpression ? 'Back to tracks' : 'Edit the whole value as an expression'}
      onClick={onToggle}
    >
      <BracesIcon />
    </button>
  );
}

// One track row: the drag grip, the track (click to open its size popover), and its
// duplicate / remove actions. The row is also the drop target while dragging.
function TrackRow({ track, index, axis, busy, edits }: { track: string; index: number; axis: 'column' | 'row'; busy: boolean; edits: TrackEdits }) {
  const { dragFrom, dragOver, setDragFrom, setDragOver } = edits.drag;
  const isOpen = edits.open === index;
  return (
    <li
      className={
        `embed-editor_grid-track ${isOpen ? 'is-open' : ''} ` + `${dragOver === index ? 'is-drop-target' : ''} ${dragFrom === index ? 'is-dragging' : ''}`
      }
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(index);
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (dragFrom !== undefined) {
          edits.reorder(dragFrom, index);
        }
        setDragFrom(undefined);
        setDragOver(undefined);
      }}
    >
      <div className="embed-editor_grid-track-row">
        <span
          className="embed-editor_bg-grip"
          draggable={!busy}
          onDragStart={(event) => {
            setDragFrom(index);
            const transfer = event.dataTransfer;
            transfer.effectAllowed = 'move';
            transfer.setData('text/plain', String(index));
          }}
          onDragEnd={() => {
            setDragFrom(undefined);
            setDragOver(undefined);
          }}
          title="Drag to reorder"
          aria-label="Drag to reorder"
        >
          <GripIcon />
        </span>
        <button type="button" className="embed-editor_grid-track-main" onClick={(event) => edits.openAt(index, event.currentTarget)} disabled={busy}>
          <span className="embed-editor_grid-track-glyph" aria-hidden="true">
            <TrackIcon track={track} axis={axis} />
          </span>
          <span className="embed-editor_grid-track-label">{trackLabel(track)}</span>
        </button>
        <TrackActions index={index} busy={busy} edits={edits} />
      </div>
    </li>
  );
}

function TrackActions({ index, busy, edits }: { index: number; busy: boolean; edits: TrackEdits }) {
  return (
    <div className="embed-editor_grid-track-actions">
      <button
        type="button"
        className="embed-editor_grid-track-action"
        onClick={() => edits.duplicate(index)}
        disabled={busy}
        title="Duplicate track"
        aria-label="Duplicate track"
      >
        <DuplicateIcon />
      </button>
      <button
        type="button"
        className={'embed-editor_grid-track-action ' + 'embed-editor_grid-track-action-danger'}
        onClick={() => edits.remove(index)}
        disabled={busy}
        title="Remove track"
        aria-label="Remove track"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

export default function GridSettings({
  read,
  busy,
  setProp,
  clearProp,
  onProvenance,
  onSelectSelector,
  onClose,
}: {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  onProvenance: OnProvenance;
  onSelectSelector: OnSelectSelector;
  onClose: () => void;
}) {
  const labels: LabelProps = { read, busy, clearProp, onProvenance, onSelectSelector };
  return (
    <Modal onClose={onClose}>
      <TrackSection title="Columns" prop="grid-template-columns" axis="column" setProp={setProp} labels={labels} />
      <AutoSection title="Auto-generated columns" prop="grid-auto-columns" axis="column" setProp={setProp} labels={labels} />
      <TrackSection title="Rows" prop="grid-template-rows" axis="row" setProp={setProp} labels={labels} />
      <AutoSection title="Auto-generated rows" prop="grid-auto-rows" axis="row" setProp={setProp} labels={labels} />
      <AreasSection setProp={setProp} labels={labels} />
    </Modal>
  );
}
