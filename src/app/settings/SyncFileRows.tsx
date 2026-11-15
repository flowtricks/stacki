// The rows of a sync list: a file (kind pill, path shortened in the middle with the full path as its tooltip, how many places), a box
// that is checked when all its places are and half-checked when some are, and under it the places (line, before and after, a label for
// an inclusive, exclusive or remembered one). The sync dialog and each breakpoint card on the Breakpoints screen draw the same rows.
import { useEffect, useRef } from 'react';
import type { SyncFile, SyncFileKind } from '../../../shared/properties/breakpointSyncPlan';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import type { ComponentType } from 'react';
import type { IconProps } from '../../ui/Icons';
import { ChevronDownIcon, ChevronRightIcon, CodeIcon, ComponentIcon, DropletIcon, ExternalIcon, FileIcon } from '../../ui/Icons';
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

// The icon of each kind of file, the ones the app already uses for it: a component is the green cube of the Navigator and the Components
// panel, a page is the Pages panel's file, a stylesheet has no icon of its own so it wears the generic code one, and an HTML file with a
// `<style>` tag wears the Style panel's droplet. A place inside a page, a component or an HTML file is a `<style>` tag, marked the same way.
const KIND_ICONS: Readonly<Record<SyncFileKind, ComponentType<IconProps>>> = {
  css: CodeIcon,
  style: DropletIcon,
  page: FileIcon,
  component: ComponentIcon,
};
const KIND_ICON_PX = 14;

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
        <KindIcon kind={props.file.kind} />
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
                {props.file.kind !== 'css' && (
                  <span className="breakpoint-sync-style-tag" role="img" data-tooltip={translate(KIND_LABELS.style)} aria-label={translate(KIND_LABELS.style)}>
                    <DropletIcon size={11} />
                  </span>
                )}
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

// A file's kind as an icon in a column of fixed width, so the paths line up; the kind's words are its tooltip and its label.
function KindIcon(props: { readonly kind: SyncFileKind }) {
  const translate = useTranslate();
  const Icon = KIND_ICONS[props.kind];
  const label = translate(KIND_LABELS[props.kind]);
  return (
    <span className="breakpoint-sync-kind" data-kind={props.kind} role="img" data-tooltip={label} aria-label={label}>
      <Icon size={KIND_ICON_PX} />
    </span>
  );
}
