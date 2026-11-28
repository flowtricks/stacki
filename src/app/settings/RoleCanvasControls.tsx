// The Canvas controls section of a role's Permissions view in Settings → Roles:
// what the role can do on the page, and whether it sees the canvas toolbar. Every
// switch only takes away (shared/properties/projectRoles.ts); with text, dragging
// and images off the role is read only. What a switch covers, and why one cannot
// be switched, is a tip.
import type { ReactNode } from 'react';
import type { CanvasPart, ProjectRole } from '../../../shared/properties/projectRoles';
import { AssetManagerIcon, CopyIcon, DesktopIcon, DragIcon, LayersIcon, PaperclipIcon, PlusIcon, TextIcon, TrashIcon } from '../../ui/Icons';
import InfoHint from '../../ui/InfoHint';
import { Switch } from '../../ui/Switch';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { canvasRows, type CanvasBlock, type CanvasRow } from './roleCanvasModel';
import { groupState, matchesQuery } from './roleDetailModel';
import type { RoleCardActions } from './RoleCard';

const LABELS: Readonly<Record<CanvasPart, MessageKey>> = {
  text: 'roles.canvas.text',
  drag: 'roles.canvas.drag',
  images: 'roles.canvas.images',
  insert: 'roles.canvas.insert',
  delete: 'roles.canvas.delete',
  duplicate: 'roles.canvas.duplicate',
  copy: 'roles.canvas.copy',
  paste: 'roles.canvas.paste',
  canvasBar: 'roles.canvas.toolbar',
};

const TIPS: Readonly<Record<CanvasPart, MessageKey>> = {
  text: 'roles.canvas.text.tip',
  drag: 'roles.canvas.drag.tip',
  images: 'roles.canvas.images.tip',
  insert: 'roles.canvas.insert.tip',
  delete: 'roles.canvas.delete.tip',
  duplicate: 'roles.canvas.duplicate.tip',
  copy: 'roles.canvas.copy.tip',
  paste: 'roles.canvas.paste.tip',
  canvasBar: 'roles.canvas.toolbar.tip',
};

const BLOCKS: Readonly<Record<CanvasBlock, MessageKey>> = {
  needsImagePanel: 'roles.canvas.blocked.imagePanel',
  needsPageEditing: 'roles.canvas.blocked.pageEditing',
};

const ICONS: Readonly<Record<CanvasPart, ReactNode>> = {
  text: <TextIcon size={14} />,
  drag: <DragIcon size={14} />,
  images: <AssetManagerIcon size={14} />,
  insert: <PlusIcon size={14} />,
  delete: <TrashIcon size={14} />,
  duplicate: <LayersIcon size={14} />,
  copy: <CopyIcon size={14} />,
  paste: <PaperclipIcon size={14} />,
  canvasBar: <DesktopIcon size={14} />,
};

/** The section's rows a search keeps: all of them when the search names the section. */
export function matchingCanvasRows(role: ProjectRole, query: string, translate: Translator): readonly CanvasRow[] {
  const rows = canvasRows(role);
  return matchesQuery(translate('roles.group.canvas'), query) ? rows : rows.filter((row) => matchesQuery(translate(LABELS[row.part]), query));
}

export function RoleCanvasControls(props: {
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly actions: RoleCardActions;
  /** The rows to draw (`matchingCanvasRows`); the count and the group switch speak of the whole section. */
  readonly rows: readonly CanvasRow[];
}) {
  const translate = useTranslate();
  const all = canvasRows(props.role);
  const title = translate('roles.group.canvas');
  // The group's switch counts the controls a person can switch; one the permissions settle is left alone.
  const switchable = all.filter((row) => row.blocked === undefined);
  const on = switchable.filter((row) => row.checked).length;
  const state = groupState(on, switchable.length);
  // Switching the whole group back on also gives back what only waited on another control of the group.
  const parts = all.filter((row) => row.blocked !== 'needsImagePanel').map((row) => row.part);
  return (
    <div className="app-role-group-block">
      <div className="app-role-group" role="group" aria-label={title}>
        <div className="app-role-group-heading">
          <h4>{title}</h4>
          <InfoHint text={translate('roles.canvas.info')} />
          <span className="app-role-group-count">{translate('settings.roles.summary.ofTotal', { count: on, total: all.length })}</span>
          <Switch
            label={translate('settings.roles.permissions.allLabel', { group: title })}
            checked={state === 'on'}
            mixed={state === 'mixed'}
            disabled={!props.editable}
            onToggle={() => props.actions.setEditing(parts, state === 'on' ? 'withdraw' : 'grant')}
          />
        </div>
        {props.rows.map((row) => (
          <CanvasToggle key={row.part} row={row} editable={props.editable} actions={props.actions} />
        ))}
      </div>
    </div>
  );
}

function CanvasToggle({ row, editable, actions }: { readonly row: CanvasRow; readonly editable: boolean; readonly actions: RoleCardActions }) {
  const translate = useTranslate();
  const label = translate(LABELS[row.part]);
  const blocked = row.blocked === undefined ? undefined : translate(BLOCKS[row.blocked]);
  return (
    <div className="app-role-toggle app-role-canvas-toggle" data-part={row.part}>
      <span className="app-role-toggle-icon" aria-hidden="true">
        {ICONS[row.part]}
      </span>
      {/* The reason sits on the name only: a title on the row would draw over the row's own tip. */}
      <span className="app-role-toggle-label" title={blocked}>
        {label}
      </span>
      <InfoHint text={blocked ?? translate(TIPS[row.part])} />
      <Switch
        label={label}
        checked={row.checked}
        disabled={!editable || blocked !== undefined}
        onToggle={() => actions.setEditing([row.part], row.checked ? 'withdraw' : 'grant')}
      />
    </div>
  );
}
