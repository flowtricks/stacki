// The dialog that follows a changed breakpoint when media queries elsewhere in the project still hold its old value
// (Settings > Breakpoints). Files are rows with a box each (half-checked when only some places are); a row opens to its places,
// each with its line and `before → after`. Exact matches start checked; inclusive 1px forms and places remembered as "Not synced"
// start unchecked and say so. Nothing is written until the primary button is pressed; "Just save the number" leaves the project's
// files as they are. While the scan is slow the same dialog shows skeleton rows, so it never appears empty.
import { useEffect, useRef, useState } from 'react';
import type { BreakpointSyncScan, SyncFile, SyncFileKind } from '../../../shared/properties/breakpointSyncPlan';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { ChevronDownIcon, ChevronRightIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { Skeleton } from '../../ui/Skeleton';
import {
  allPlaces,
  checkedCount,
  fileCheck,
  middleEllipsis,
  placeCount,
  placeKey,
  placeLabel,
  toggledFile,
  toggledPlace,
  type CheckedPlaces,
} from '../../../shared/properties/breakpointSyncSelection';
import './breakpointSyncDialog.css';

/** Characters of a path shown before it is shortened in the middle (the full path is the tooltip). */
const PATH_CHARS_MAX = 44;
const SKELETON_ROWS = 3;

const KIND_LABELS: Readonly<Record<SyncFileKind, MessageKey>> = {
  css: 'settings.breakpoints.sync.kind.css',
  style: 'settings.breakpoints.sync.kind.style',
  page: 'settings.breakpoints.sync.kind.page',
  component: 'settings.breakpoints.sync.kind.component',
};

const FLAG_LABELS = {
  notSynced: 'settings.breakpoints.sync.notSynced',
  inclusive: 'settings.breakpoints.sync.inclusive',
  exclusive: 'settings.breakpoints.sync.exclusive',
} as const satisfies Record<'notSynced' | 'inclusive' | 'exclusive', MessageKey>;

export type SyncDialogState = { readonly kind: 'scanning' } | { readonly kind: 'ready'; readonly scan: BreakpointSyncScan };

interface Props {
  readonly state: SyncDialogState;
  readonly busy: boolean;
  readonly onApply: (checked: CheckedPlaces) => void;
  readonly onSkip: () => void;
}

export function BreakpointSyncDialog(props: Props) {
  const translate = useTranslate();
  const [checked, setChecked] = useState<CheckedPlaces>(new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const scan = props.state.kind === 'ready' ? props.state.scan : undefined;
  // The scan arrives after the dialog may already be up: its defaults are chosen then, once.
  useEffect(() => {
    if (scan !== undefined) {
      setChecked(new Set(scan.files.flatMap((file) => file.occurrences.filter((place) => place.checked).map((place) => placeKey(file.rel, place.locator)))));
      setOpen(scan.files.length === 1 ? new Set(scan.files.map((file) => file.rel)) : new Set());
    }
  }, [scan]);
  const total = scan === undefined ? 0 : placeCount(scan);
  const selected = scan === undefined ? 0 : checkedCount(scan, checked);
  return (
    <Popup className="modal breakpoint-sync" role="dialog" labelledBy="breakpoint-sync-title" onClose={props.onSkip}>
      {({ close }) => (
        <>
          <div className="modal-header" id="breakpoint-sync-title">
            {scan === undefined ? translate('settings.breakpoints.sync.scanning') : translate('settings.breakpoints.sync.title', { count: total })}
          </div>
          <div className="modal-body breakpoint-sync-body">
            {scan !== undefined && (
              <div className="breakpoint-sync-bar">
                <button type="button" onClick={() => setChecked(allPlaces(scan))}>
                  {translate('settings.breakpoints.sync.all')}
                </button>
                <button type="button" onClick={() => setChecked(new Set())}>
                  {translate('settings.breakpoints.sync.none')}
                </button>
              </div>
            )}
            <div className="breakpoint-sync-list" role="group" aria-busy={scan === undefined}>
              {scan === undefined
                ? Array.from({ length: SKELETON_ROWS }, (_, index) => <Skeleton key={index} height="36px" radius="8px" />)
                : scan.files.map((file) => (
                    <FileRow
                      key={file.rel}
                      file={file}
                      checked={checked}
                      expanded={open.has(file.rel)}
                      onToggleOpen={() => setOpen(toggled(open, file.rel))}
                      onCheckFile={() => setChecked(toggledFile(file, checked))}
                      onCheckPlace={(place) => setChecked(toggledPlace(file, place, checked))}
                    />
                  ))}
            </div>
            {scan?.truncated === true && <p className="breakpoint-sync-note">{translate('settings.breakpoints.sync.truncated')}</p>}
            {scan !== undefined && scan.skipped > 0 && <p className="breakpoint-sync-note">{translate('settings.breakpoints.sync.skippedLarge')}</p>}
            {scan?.recordProblem !== undefined && (
              <p className="breakpoint-sync-note">{translate('settings.breakpoints.sync.recordProblem', { message: scan.recordProblem })}</p>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" onClick={close} disabled={props.busy}>
              {translate('settings.breakpoints.sync.skip')}
            </button>
            <button type="button" className="primary" disabled={scan === undefined || selected === 0 || props.busy} onClick={() => props.onApply(checked)}>
              {translate('settings.breakpoints.sync.apply', { count: selected })}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(value)) {
    next.add(value);
  }
  return next;
}

function FileRow(props: {
  readonly file: SyncFile;
  readonly checked: CheckedPlaces;
  readonly expanded: boolean;
  readonly onToggleOpen: () => void;
  readonly onCheckFile: () => void;
  readonly onCheckPlace: (place: SyncFile['occurrences'][number]) => void;
}) {
  const translate = useTranslate();
  const box = useRef<HTMLInputElement>(null);
  const state = fileCheck(props.file, props.checked);
  useEffect(() => {
    if (box.current !== null) {
      box.current.indeterminate = state === 'some';
    }
  }, [state]);
  const Chevron = props.expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="breakpoint-sync-file" data-kind={props.file.kind}>
      <div className="breakpoint-sync-row">
        <button
          type="button"
          className="breakpoint-sync-open"
          aria-expanded={props.expanded}
          aria-label={translate('settings.breakpoints.sync.open', { file: props.file.rel })}
          onClick={props.onToggleOpen}
        >
          <Chevron size={12} />
        </button>
        <input
          ref={box}
          type="checkbox"
          checked={state === 'all'}
          aria-label={translate('settings.breakpoints.sync.checkFile', { file: props.file.rel })}
          onChange={props.onCheckFile}
        />
        <span className="breakpoint-sync-pill">{translate(KIND_LABELS[props.file.kind])}</span>
        <span className="breakpoint-sync-path" title={props.file.rel}>
          {middleEllipsis(props.file.rel, PATH_CHARS_MAX)}
        </span>
        <span className="breakpoint-sync-count">{props.file.occurrences.length}</span>
      </div>
      {props.expanded && (
        <ul className="breakpoint-sync-places">
          {props.file.occurrences.map((place) => {
            const label = placeLabel(place);
            return (
              <li key={place.locator} className="breakpoint-sync-place">
                <input
                  type="checkbox"
                  checked={props.checked.has(placeKey(props.file.rel, place.locator))}
                  aria-label={translate('settings.breakpoints.sync.checkPlace', { line: place.line })}
                  onChange={() => props.onCheckPlace(place)}
                />
                <span className="breakpoint-sync-line">{translate('settings.breakpoints.sync.line', { line: place.line })}</span>
                <span className="breakpoint-sync-change">
                  <code className="breakpoint-sync-before">{place.beforeText}</code>
                  <code className="breakpoint-sync-after">{place.afterText}</code>
                </span>
                {label !== undefined && <span className="breakpoint-sync-flag">{translate(FLAG_LABELS[label])}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
