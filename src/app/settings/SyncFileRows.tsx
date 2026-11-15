// The rows of a sync list: a file (kind pill, path shortened in the middle with the full path as its tooltip, how many places), a box
// that is checked when all its places are and half-checked when some are, and under it the places (line, before and after, a label for
// an inclusive, exclusive or remembered one). The sync dialog and each breakpoint card on the Breakpoints screen draw the same rows.
import { useEffect, useRef } from 'react';
import type { SyncFile, SyncFileKind } from '../../../shared/properties/breakpointSyncPlan';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { ChevronDownIcon, ChevronRightIcon, ExternalIcon } from '../../ui/Icons';
import { fileCheck, middleEllipsis, placeKey, placeLabel, type CheckedPlaces } from '../../../shared/properties/breakpointSyncSelection';
import './breakpointSyncDialog.css';

/** Characters of a path shown before it is shortened in the middle (the full path is the tooltip). */
const PATH_CHARS_MAX = 44;

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

export function SyncFileRow(props: {
  readonly file: SyncFile;
  readonly checked: CheckedPlaces;
  readonly expanded: boolean;
  readonly onToggleOpen: () => void;
  readonly onCheckFile: () => void;
  readonly onCheckPlace: (place: SyncFile['occurrences'][number]) => void;
  /** Opens the file in the Code panel; the row offers the link only when this is given. */
  readonly onOpenFile?: ((rel: string) => void) | undefined;
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
        {props.onOpenFile !== undefined && (
          <button
            type="button"
            className="breakpoint-sync-link"
            data-tooltip={translate('settings.breakpoints.usage.open', { file: props.file.rel })}
            aria-label={translate('settings.breakpoints.usage.open', { file: props.file.rel })}
            onClick={() => props.onOpenFile?.(props.file.rel)}
          >
            <ExternalIcon size={12} />
          </button>
        )}
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
