// A role's Editing view in Settings → Roles: which parts of the editor around the
// page the role sees, and what it can do on the page. Every switch only takes away
// (shared/properties/projectRoles.ts); with dragging, text and images off the role
// is read only. What a switch covers, and why one cannot be switched, is a tip.
import type { ReactNode } from 'react';
import { CHROME_PARTS, PAGE_PARTS, type EditorPart } from '../../../shared/properties/projectRoles';
import type { ProjectRole } from '../../../shared/properties/projectRoles';
import { AssetManagerIcon, DesktopIcon, DragIcon, NavigatorIcon, PanelRightIcon, PlusIcon, TextIcon } from '../../ui/Icons';
import InfoHint from '../../ui/InfoHint';
import { Switch } from '../../ui/Switch';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { editingRows, type EditingBlock, type EditingRow } from './roleEditingModel';
import { groupState, matchesQuery } from './roleDetailModel';
import type { RoleCardActions } from './RoleCard';

const LABELS: Readonly<Record<EditorPart, MessageKey>> = {
  sidePanel: 'roles.editing.sidePanel',
  navigator: 'roles.editing.navigator',
  canvasBar: 'roles.editing.canvasBar',
  drag: 'roles.editing.drag',
  text: 'roles.editing.text',
  images: 'roles.editing.images',
  elements: 'roles.editing.elements',
};

const TIPS: Readonly<Record<EditorPart, MessageKey>> = {
  sidePanel: 'roles.editing.sidePanel.tip',
  navigator: 'roles.editing.navigator.tip',
  canvasBar: 'roles.editing.canvasBar.tip',
  drag: 'roles.editing.drag.tip',
  text: 'roles.editing.text.tip',
  images: 'roles.editing.images.tip',
  elements: 'roles.editing.elements.tip',
};

const BLOCKS: Readonly<Record<EditingBlock, MessageKey>> = {
  needsRightPanel: 'roles.editing.blocked.rightPanel',
  needsNavigator: 'roles.editing.blocked.navigator',
  needsImagePanel: 'roles.editing.blocked.imagePanel',
  needsPageEditing: 'roles.editing.blocked.pageEditing',
};

const ICONS: Readonly<Record<EditorPart, ReactNode>> = {
  sidePanel: <PanelRightIcon size={14} />,
  navigator: <NavigatorIcon size={14} />,
  canvasBar: <DesktopIcon size={14} />,
  drag: <DragIcon size={14} />,
  text: <TextIcon size={14} />,
  images: <AssetManagerIcon size={14} />,
  elements: <PlusIcon size={14} />,
};

interface Props {
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly actions: RoleCardActions;
  readonly query: string;
}

export function RoleEditing(props: Props) {
  const translate = useTranslate();
  const rows = editingRows(props.role);
  const groups: readonly { readonly title: MessageKey; readonly parts: readonly EditorPart[] }[] = [
    { title: 'roles.editing.group.around', parts: CHROME_PARTS },
    { title: 'roles.editing.group.page', parts: PAGE_PARTS },
  ];
  const shown = groups
    .map((group) => {
      const all = rows.filter((row) => group.parts.includes(row.part));
      const title = translate(group.title);
      const matching = matchesQuery(title, props.query) ? all : all.filter((row) => matchesQuery(translate(LABELS[row.part]), props.query));
      return { title, all, matching };
    })
    .filter((group) => group.matching.length > 0);
  return (
    <div className="app-role-detail-list app-role-access">
      {shown.length === 0 && <p className="app-role-detail-empty">{translate('settings.roles.detail.noMatch', { query: props.query.trim() })}</p>}
      {shown.map((group) => (
        <EditingGroup key={group.title} title={group.title} all={group.all} rows={group.matching} editable={props.editable} actions={props.actions} />
      ))}
    </div>
  );
}

function EditingGroup(props: {
  readonly title: string;
  readonly all: readonly EditingRow[];
  readonly rows: readonly EditingRow[];
  readonly editable: boolean;
  readonly actions: RoleCardActions;
}) {
  const translate = useTranslate();
  // The group's switch counts the options a person can switch; one the permissions settle is left alone.
  const switchable = props.all.filter((row) => row.blocked === undefined);
  const on = switchable.filter((row) => row.checked).length;
  const state = groupState(on, switchable.length);
  // Switching a whole group back on also gives back what only waited on another option of the group.
  const parts = props.all.filter((row) => row.blocked === undefined || row.blocked === 'needsPageEditing').map((row) => row.part);
  return (
    <div className="app-role-group-block">
      <div className="app-role-group" role="group" aria-label={props.title}>
        <div className="app-role-group-heading">
          <h4>{props.title}</h4>
          <span className="app-role-group-count">{translate('settings.roles.summary.ofTotal', { count: on, total: props.all.length })}</span>
          <Switch
            label={translate('settings.roles.permissions.allLabel', { group: props.title })}
            checked={state === 'on' && switchable.length > 0}
            mixed={state === 'mixed'}
            disabled={!props.editable || parts.length === 0}
            onToggle={() => props.actions.setEditing(parts, state === 'on' ? 'withdraw' : 'grant')}
          />
        </div>
        {props.rows.map((row) => (
          <EditingToggle key={row.part} row={row} editable={props.editable} actions={props.actions} />
        ))}
      </div>
    </div>
  );
}

function EditingToggle({ row, editable, actions }: { readonly row: EditingRow; readonly editable: boolean; readonly actions: RoleCardActions }) {
  const translate = useTranslate();
  const label = translate(LABELS[row.part]);
  const blocked = row.blocked === undefined ? undefined : translate(BLOCKS[row.blocked]);
  return (
    <div className="app-role-toggle app-role-editing-toggle" data-part={row.part} title={blocked}>
      <span className="app-role-toggle-icon" aria-hidden="true">
        {ICONS[row.part]}
      </span>
      <span className="app-role-toggle-label">{label}</span>
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
