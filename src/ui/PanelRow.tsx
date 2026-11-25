// One row of a side panel's list, in the Pages tree's own look (`.list-item`): a chevron column (empty for a
// leaf) keeps every icon on one line per depth, the label can carry a second muted line, and a menu sits at
// the end. A row is a tab stop; Enter or Space activates it and the arrow keys move between the rows of
// its panel, as in the other lists.
import type { ReactNode } from 'react';
import { useTranslate } from '../lib/i18n/useTranslate';
import { ChevronDownIcon, ChevronRightIcon } from './Icons';
import MoreMenu, { type MenuItem } from './MoreMenu';
import './panelSection.css';

/** The rows one panel draws at most; a bounded walk for the arrow keys. */
const ROWS_WALK_MAX = 4096;

export interface PanelRowProps {
  readonly depth: number;
  readonly label: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly selected: boolean;
  /** Present for a folder: whether it is open. A leaf has none. */
  readonly folder: { readonly open: boolean } | undefined;
  readonly menu: readonly MenuItem[];
  /** The row's menu button label, when it has a menu. */
  readonly menuTitle?: string;
  readonly detail?: ReactNode;
  readonly onActivate: () => void;
}

/** One row's inset at its start: the panel's 8px, then 14px per level, as the Pages tree indents. */
function indentOf(depth: number): { readonly paddingInlineStart: number } {
  return { paddingInlineStart: 8 + depth * 14 };
}

export function PanelRow(props: PanelRowProps) {
  const translate = useTranslate();
  return (
    <div
      className={`list-item panel-row ${props.folder === undefined ? '' : 'folder'} ${props.selected ? 'active' : ''}`}
      style={indentOf(props.depth)}
      role="treeitem"
      tabIndex={0}
      title={props.title}
      aria-selected={props.selected}
      aria-expanded={props.folder?.open}
      onClick={props.onActivate}
      onKeyDown={(event) => {
        // Keys on the row's own menu button are the menu's.
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onActivate();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    >
      <span className="panel-block-chevron">
        {props.folder === undefined ? undefined : props.folder.open ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}
      </span>
      <span className="icon">{props.icon}</span>
      <span className="panel-row-copy">
        <span className="label panel-row-label">{props.label}</span>
        {props.detail === undefined ? undefined : <span className="panel-row-detail">{props.detail}</span>}
      </span>
      {props.menu.length > 0 && (
        <MoreMenu
          className="row-action rename-action"
          title={props.menuTitle ?? translate('instructionsPanel.rowOptions', { label: props.label })}
          items={props.menu}
          width={170}
        />
      )}
    </div>
  );
}

// Focus moves to the neighbouring row of the same panel, and stops at either end.
function moveFocus(from: HTMLElement, step: 1 | -1): void {
  const scope = from.closest('.panel-body') ?? from.ownerDocument.body;
  const rows = [...scope.querySelectorAll<HTMLElement>('.panel-row[role="treeitem"]')].slice(0, ROWS_WALK_MAX);
  const next = rows[rows.indexOf(from) + step];
  next?.focus();
}
