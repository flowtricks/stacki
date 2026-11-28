// The Right panel section of a role's Permissions view: the group switch shows or
// hides the whole panel, and a row each for the Style and Settings tabs. A panel
// switched off, by either route, also locks every other way to reach styles
// (`setRightPanel`, rolesEdits.ts); the heading's tip says so.
import { useId } from 'react';
import type { ProjectRole } from '../../../shared/properties/projectRoles';
import { useTranslate } from '../../lib/i18n/useTranslate';
import InfoHint from '../../ui/InfoHint';
import { Switch } from '../../ui/Switch';
import { FeatureIcon } from '../featureIcons';
import { rightPanelView } from './roleCanvasModel';
import type { PermissionGroupView } from './roleDetailModel';
import type { RoleCardActions } from './RoleCard';

export function RoleRightPanel(props: {
  /** The section as the search left it (`permissionGroups`): its title and the rows to draw. */
  readonly group: PermissionGroupView;
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly actions: RoleCardActions;
}) {
  const { group, actions } = props;
  const translate = useTranslate();
  const headingId = useId();
  const view = rightPanelView(props.role);
  return (
    <div className="app-role-group-block">
      <div className="app-role-group" role="group" aria-labelledby={headingId}>
        <div className="app-role-group-heading">
          <h4 id={headingId}>{group.label}</h4>
          <InfoHint text={translate('roles.rightPanel.info')} />
          <span className="app-role-group-count">
            {translate('settings.roles.summary.ofTotal', { count: view.rows.filter((row) => row.checked).length, total: view.rows.length })}
          </span>
          {/* On or off, never mixed: it says whether the role sees the panel at all. */}
          <Switch
            label={translate('settings.roles.permissions.allLabel', { group: group.label })}
            checked={view.shown}
            disabled={!props.editable}
            onToggle={() => actions.setRightPanel({ kind: 'panel', change: view.shown ? 'withdraw' : 'grant' })}
          />
        </div>
        {group.rows.map((row) => {
          const tab = view.rows.find((candidate) => candidate.feature === row.feature);
          if (tab === undefined) {
            return undefined;
          }
          return (
            <div key={tab.feature} className="app-role-toggle">
              <span className="app-role-toggle-icon" aria-hidden="true">
                <FeatureIcon feature={tab.feature} size={14} />
              </span>
              <span className="app-role-toggle-label">{row.label}</span>
              <Switch
                label={row.label}
                checked={tab.checked}
                disabled={!props.editable}
                onToggle={() => actions.setRightPanel({ kind: 'tab', feature: tab.feature, change: tab.checked ? 'withdraw' : 'grant' })}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
