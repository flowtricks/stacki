// The dialog that follows a changed breakpoint when media queries elsewhere in the project still hold its old value
// (Settings > Breakpoints). Files are rows with a box each (half-checked when only some places are); a row opens to its places,
// each with its line and `before → after`. Exact matches start checked; inclusive 1px forms and places remembered as "Not synced"
// start unchecked and say so. A scan that was cut short or could not be remembered is a warning toast. Nothing is written until the primary button is pressed; "Just save the number" leaves the project's
// files as they are. While the scan is slow the same dialog shows skeleton rows, so it never appears empty.
import { useEffect, useState } from 'react';
import type { BreakpointSyncScan } from '../../../shared/properties/breakpointSyncPlan';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { NoticeToast } from '../../ui/NoticeToast';
import Popup from '../../ui/Popup';
import { Skeleton } from '../../ui/Skeleton';
import {
  allPlaces,
  checkedCount,
  placeCount,
  placeKey,
  toggledFile,
  toggledPlace,
  type CheckedPlaces,
} from '../../../shared/properties/breakpointSyncSelection';
import { SyncFileRow } from './SyncFileRows';
import './breakpointSyncDialog.css';

const SKELETON_ROWS = 3;

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
          {/* What the scan could not read is a warning toast, not a paragraph under the list: the list does not move when it arrives. */}
          <NoticeToast kind="warning" message={scan?.truncated === true ? translate('settings.breakpoints.sync.truncated') : undefined} />
          <NoticeToast kind="warning" message={scan !== undefined && scan.skipped > 0 ? translate('settings.breakpoints.sync.skippedLarge') : undefined} />
          <NoticeToast
            kind="warning"
            message={scan?.recordProblem === undefined ? undefined : translate('settings.breakpoints.sync.recordProblem', { message: scan.recordProblem })}
          />
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
                    <SyncFileRow
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
