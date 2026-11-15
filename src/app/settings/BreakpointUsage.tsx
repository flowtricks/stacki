// What a breakpoint card says about the project: one quiet line, `Used in 12 places · 5 files`, with a chevron that opens the files
// (the same rows the sync dialog draws): a box per file and per place, checked = updated when this breakpoint's number changes,
// unchecked = left alone and shown as "Not synced". The counts describe the breakpoint's SAVED value; while a different valid value is
// being typed the line says what that change will touch (`Will update 12 places in 5 files`). Every tick is saved at once, so the
// dialog that follows a change shows exactly this set. Nothing here writes project CSS.
import { useState } from 'react';
import type { SyncFile } from '../../../shared/properties/breakpointSyncPlan';
import {
  checkedOf,
  checkedTotals,
  foundTotals,
  placeKey,
  toggledFile,
  toggledPlace,
  type CheckedPlaces,
  type PlaceChoice,
} from '../../../shared/properties/breakpointSyncSelection';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { ChevronRightIcon } from '../../ui/Icons';
import { Skeleton } from '../../ui/Skeleton';
import { SyncFileRow } from './SyncFileRows';
import type { UsageState } from './useBreakpointUsage';

interface LineProps {
  readonly id: string;
  readonly name: string;
  readonly state: UsageState;
  /** True while the field holds a different valid value: the line then says what that change will touch. */
  readonly pending: boolean;
  readonly expanded: boolean;
  readonly onExpand: () => void;
}

interface ListProps {
  readonly id: string;
  readonly state: UsageState;
  readonly editable: boolean;
  readonly onToggle: (id: string, choices: readonly PlaceChoice[]) => Promise<string | undefined>;
  readonly onOpenFile?: ((rel: string) => void) | undefined;
}

function filesOf(state: UsageState, id: string): readonly SyncFile[] {
  return state.kind === 'ready' ? (state.usage.entries.find((entry) => entry.id === id)?.files ?? []) : [];
}

/** Whether this card has anything to expand: the chevron and the list only exist then. */
export function hasUsage(state: UsageState, id: string): boolean {
  return foundTotals(filesOf(state, id)).places > 0;
}

/** The quiet line under the subtitle, and its chevron. */
export function BreakpointUsageLine(props: LineProps) {
  const translate = useTranslate();
  if (props.state.kind === 'unavailable') {
    return undefined;
  }
  if (props.state.kind === 'scanning') {
    // A chip the size of the line, so the card does not jump when the answer arrives.
    return (
      <span className="breakpoints-usage" role="status" aria-busy="true">
        <Skeleton height="12px" width="9rem" radius="6px" />
      </span>
    );
  }
  const files = filesOf(props.state, props.id);
  const found = foundTotals(files);
  const will = checkedTotals(files);
  const line =
    found.places === 0
      ? translate('settings.breakpoints.usage.none')
      : props.pending
        ? `${translate('settings.breakpoints.usage.willPlaces', { count: will.places })} ${translate('settings.breakpoints.usage.inFiles', { count: will.files })}`
        : `${translate('settings.breakpoints.usage.places', { count: found.places })} · ${translate('settings.breakpoints.usage.files', { count: found.files })}`;
  const text = <span className="breakpoints-usage-line">{line}</span>;
  return (
    <span className="breakpoints-usage">
      {found.places > 0 ? (
        // The whole line is the disclosure: its text and its chevron, on one line, centered on each other.
        <button
          type="button"
          className="breakpoints-usage-toggle"
          aria-expanded={props.expanded}
          aria-controls={`breakpoints-usage-list-${props.id}`}
          aria-label={`${translate('settings.breakpoints.usage.expand', { name: props.name })}: ${line}`}
          onClick={props.onExpand}
        >
          {text}
          <ChevronRightIcon size={12} className="breakpoints-usage-chevron" />
        </button>
      ) : (
        text
      )}
      {props.state.problem !== undefined && (
        <span className="breakpoints-usage-problem">{translate('settings.breakpoints.usage.problem', { message: props.state.problem })}</span>
      )}
    </span>
  );
}

/** The files of a card, across its full width. */
export function BreakpointUsageList(props: ListProps) {
  const translate = useTranslate();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string>();
  const files = filesOf(props.state, props.id);
  const checked = checkedOf(files);
  const choose = async (next: CheckedPlaces): Promise<void> => {
    const choices = files.flatMap((file) =>
      file.occurrences.flatMap((place) => {
        const now = next.has(placeKey(file.rel, place.locator));
        return now === checked.has(placeKey(file.rel, place.locator)) ? [] : [{ file: file.rel, locator: place.locator, reason: place.reason, checked: now }];
      }),
    );
    if (choices.length > 0) {
      setProblem(await props.onToggle(props.id, choices));
    }
  };
  const all = new Set(files.flatMap((file) => file.occurrences.map((place) => placeKey(file.rel, place.locator))));
  return (
    <div className="breakpoints-usage-list" id={`breakpoints-usage-list-${props.id}`}>
      <div className="breakpoint-sync-bar">
        <button type="button" disabled={!props.editable} onClick={() => void choose(all)}>
          {translate('settings.breakpoints.sync.all')}
        </button>
        <button type="button" disabled={!props.editable} onClick={() => void choose(new Set())}>
          {translate('settings.breakpoints.sync.none')}
        </button>
      </div>
      <div className="breakpoints-usage-files">
        {files.map((file) => (
          <SyncFileRow
            key={file.rel}
            file={file}
            checked={checked}
            expanded={open.has(file.rel)}
            onToggleOpen={() => setOpen(toggled(open, file.rel))}
            onCheckFile={() => void choose(toggledFile(file, checked))}
            onCheckPlace={(place) => void choose(toggledPlace(file, place, checked))}
            onOpenFile={props.onOpenFile}
          />
        ))}
      </div>
      {problem !== undefined && <p className="breakpoints-usage-problem">{problem}</p>}
    </div>
  );
}

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(value)) {
    next.add(value);
  }
  return next;
}
