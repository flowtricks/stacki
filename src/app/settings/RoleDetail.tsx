// One part of a role as its own view in Settings → Roles: a back button and the part's title, a search field
// and the list (members, sidebar apps, components or permissions). It replaces the role cards while it is open,
// so a long list has the whole dialog to itself instead of expanding a card in place; Back or Escape returns to
// the cards. The search text lives in the parent (RolesSettings.tsx), so it is still there when the person goes
// back and opens the same part again. The list scrolls inside the view while the header and search stay put.
//
// Every change goes through the same card actions as before (RoleCard.tsx), so role gating, validation, undo and the
// last-admin refusal behave exactly as they did inline.
import { useId, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { APPS_ACCESS_GROUP, sameLogin, type ProjectRole } from '../../../shared/properties/projectRoles';
import CommitAvatar from '../../features/history/CommitAvatar';
import { ChevronLeftIcon, CloseIcon, SearchIcon } from '../../ui/Icons';
import { Switch } from '../../ui/Switch';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { FeatureIcon } from '../featureIcons';
import { buildComponentTree, type ComponentTree } from './componentTree';
import { memberAvatarURL } from './memberAvatars';
import { MemberPicker } from './MemberPicker';
import { RoleAppPermissions } from './RoleAppPermissions';
import { useInstalledApps } from './RoleAppPicker';
import { RoleComponents } from './RoleComponents';
import { RolePinnedApps } from './RolePinnedApps';
import { permissionCounts, permissionGroups, matchesQuery, type PermissionGroupView, type RoleSection } from './roleDetailModel';
import type { RoleCardActions } from './RoleCard';

const NO_FILES: readonly string[] = [];
const NO_SOURCES: readonly { readonly id: string; readonly name: string }[] = [];

export function RoleDetail(props: {
  readonly role: ProjectRole;
  readonly section: RoleSection;
  readonly editable: boolean;
  readonly actions: RoleCardActions;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  /** Returns to the role cards. */
  readonly back: () => void;
  readonly projectPath?: string;
  /** The signed-in GitHub login, for the "You" tag on its own member row. */
  readonly currentLogin?: string | undefined;
  readonly componentFiles?: readonly string[];
  readonly copySources?: readonly { readonly id: string; readonly name: string }[];
  /** Why the last change was refused or not saved. */
  readonly notice?: ReactNode;
}) {
  const { role, section, editable, actions, query } = props;
  const translate = useTranslate();
  const files = props.componentFiles ?? NO_FILES;
  const title = sectionTitle(section, translate);
  const tree = useMemo(() => buildComponentTree(files, role.componentRules), [files, role.componentRules]);
  // Escape returns to the cards, unless something inside (a menu, the suggestions) already took it.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      props.back();
    }
  };
  return (
    <section className="app-role-detail" aria-label={translate('settings.roles.detail.label', { section: title, name: role.name })} onKeyDown={onKeyDown}>
      <header className="app-role-detail-head">
        <button
          type="button"
          className="app-role-back"
          aria-label={translate('settings.roles.detail.back')}
          title={translate('settings.roles.detail.back')}
          onClick={props.back}
        >
          <ChevronLeftIcon size={14} />
        </button>
        <h3>{title}</h3>
        <span className="app-role-detail-role">{role.name}</span>
        <span className="app-role-detail-count">{sectionCount(role, section, tree, translate)}</span>
        {section === 'components' && editable && (
          <span className="app-role-detail-actions">
            <button type="button" onClick={() => actions.setAllComponentVisibility('visible', files)}>
              {translate('settings.roles.components.showAll')}
            </button>
            <button type="button" onClick={() => actions.setAllComponentVisibility('hidden', files)}>
              {translate('settings.roles.components.hideAll')}
            </button>
          </span>
        )}
      </header>
      {props.notice}
      <DetailSearch section={section} query={query} setQuery={props.setQuery} />
      {section === 'members' && (
        <MembersView role={role} editable={editable} actions={actions} projectPath={props.projectPath} currentLogin={props.currentLogin} query={query} />
      )}
      {section === 'pins' && <PinsView role={role} editable={editable} actions={actions} projectPath={props.projectPath} query={query} />}
      {section === 'components' && (
        <RoleComponents
          role={role}
          editable={editable}
          files={files}
          copySources={props.copySources ?? NO_SOURCES}
          query={query}
          actions={{ setVisibility: actions.setComponentVisibility, copyFrom: actions.copyComponentRules, removeRule: actions.removeComponentRule }}
        />
      )}
      {section === 'permissions' && <PermissionsView role={role} editable={editable} actions={actions} projectPath={props.projectPath} query={query} />}
    </section>
  );
}

function sectionTitle(section: RoleSection, translate: ReturnType<typeof useTranslate>): string {
  switch (section) {
    case 'members':
      return translate('settings.roles.members.title');
    case 'pins':
      return translate('settings.roles.pins.title');
    case 'components':
      return translate('settings.roles.components.title');
    case 'permissions':
      return translate('settings.roles.permissions.title');
    default: {
      const exhaustive: never = section;
      return exhaustive;
    }
  }
}

// The muted count in the header: the same numbers as the card's summary row.
function sectionCount(role: ProjectRole, section: RoleSection, tree: ComponentTree, translate: ReturnType<typeof useTranslate>): string {
  assert(tree.visible <= tree.total, 'A tree shows no more than it holds');
  switch (section) {
    case 'members':
      return translate('settings.roles.members.count', { count: role.members.length });
    case 'pins':
      return String(role.pinnedApps.length);
    case 'components':
      return translate('settings.roles.components.count', { visible: tree.visible, total: tree.total });
    case 'permissions': {
      const { granted, total } = permissionCounts(role);
      return translate('settings.roles.permissions.count', { granted, total });
    }
    default: {
      const exhaustive: never = section;
      return exhaustive;
    }
  }
}

function DetailSearch(props: { readonly section: RoleSection; readonly query: string; readonly setQuery: (query: string) => void }) {
  const translate = useTranslate();
  const label =
    props.section === 'members'
      ? translate('settings.roles.detail.search.members')
      : props.section === 'pins'
        ? translate('settings.roles.detail.search.pins')
        : props.section === 'components'
          ? translate('settings.roles.components.search')
          : translate('settings.roles.detail.search.permissions');
  return (
    <label className="app-role-search">
      <SearchIcon size={12} />
      <input
        value={props.query}
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        // The view opens to search: the person came here to find something in a long list.
        autoFocus
        onChange={(event) => props.setQuery(event.target.value)}
      />
    </label>
  );
}

type ViewProps = {
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly actions: RoleCardActions;
  readonly projectPath: string | undefined;
  readonly query: string;
};

function NoMatch(props: { readonly query: string }) {
  const translate = useTranslate();
  return <p className="app-role-detail-empty">{translate('settings.roles.detail.noMatch', { query: props.query.trim() })}</p>;
}

function MembersView(props: ViewProps & { readonly currentLogin: string | undefined }) {
  const { role, editable, actions } = props;
  const translate = useTranslate();
  const shown = role.members.filter((member) => matchesQuery(member, props.query));
  return (
    <div className="app-role-members">
      <ul className="app-role-people-list app-role-detail-list" aria-label={translate('settings.roles.members.list', { name: role.name })}>
        {shown.map((member) => (
          <li key={member} className="app-role-chip">
            <CommitAvatar name={member} email="" url={memberAvatarURL(member)} />
            <span className="app-role-person-name">{member}</span>
            {props.currentLogin !== undefined && sameLogin(member, props.currentLogin) && (
              <span className="app-role-you">{translate('settings.roles.members.you')}</span>
            )}
            {editable && (
              <button
                type="button"
                aria-label={translate('settings.roles.members.remove', { member })}
                title={translate('settings.roles.members.removeTip')}
                onClick={() => actions.removeMember(member)}
              >
                <CloseIcon size={10} />
              </button>
            )}
          </li>
        ))}
        {role.members.length === 0 && <li className="app-role-none">{translate('settings.roles.members.none')}</li>}
      </ul>
      {role.members.length > 0 && shown.length === 0 && <NoMatch query={props.query} />}
      {editable && <MemberInvite role={role} actions={actions} projectPath={props.projectPath} />}
    </div>
  );
}

/**
 * Extension point: how a person is added to the role. Today the one form is the GitHub username field; the form for
 * the project's active sign-in provider (Google, SSO, access link, passkey invite) goes here, beside it or in its place,
 * and calls the same `actions.addMember`, so the list above and its checks stay the same.
 */
function MemberInvite(props: { readonly role: ProjectRole; readonly actions: RoleCardActions; readonly projectPath: string | undefined }) {
  return <MemberPicker roleName={props.role.name} members={props.role.members} projectPath={props.projectPath} addMember={props.actions.addMember} />;
}

function PinsView(props: ViewProps) {
  const installed = useInstalledApps(props.projectPath);
  return (
    <div className="app-role-pins-view">
      <RolePinnedApps
        role={props.role}
        installed={installed}
        editable={props.editable}
        query={props.query}
        change={props.actions.setPinnedApp}
        order={props.actions.orderPinnedApps}
      />
    </div>
  );
}

function PermissionsView(props: ViewProps) {
  const { role, editable, actions, query } = props;
  const installed = useInstalledApps(props.projectPath);
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const groups = permissionGroups(role, query, translate('settings.roles.permissions.everyApp'), translateDescribed);
  const apps = installed.kind === 'ready' ? installed.apps : [];
  const appsShown =
    query.trim() === '' ||
    apps.some((app) => matchesQuery(app.manifest.name, query) || app.manifest.permissions.some((permission) => matchesQuery(permission.label, query)));
  const nothing = groups.length === 0 && !appsShown;
  const appSections = (
    <RoleAppPermissions role={role} installed={installed} editable={editable} query={query} change={actions.setAppPermissions} access={actions.setAppAccess} />
  );
  return (
    <div className="app-role-detail-list app-role-access">
      {nothing && <NoMatch query={query} />}
      {groups.map((group) => (
        <div key={group.key} className="app-role-group-block">
          <PermissionGroup group={group} role={role} editable={editable} actions={actions} />
          {group.key === APPS_ACCESS_GROUP && appSections}
        </div>
      ))}
      {/* A search that matches only an app's own permissions still shows the apps, after the groups. */}
      {!groups.some((group) => group.key === APPS_ACCESS_GROUP) && appSections}
    </div>
  );
}

function PermissionGroup(props: {
  readonly group: PermissionGroupView;
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly actions: RoleCardActions;
}) {
  const { group, actions } = props;
  const translate = useTranslate();
  const headingId = useId();
  return (
    <div className="app-role-group" role="group" aria-labelledby={headingId}>
      <div className="app-role-group-heading">
        <h4 id={headingId}>{group.label}</h4>
        <span className="app-role-group-count">{translate('settings.roles.summary.ofTotal', { count: group.on, total: group.total })}</span>
        {/* Mixed shows as neither: switching it on grants the whole group, off from "on" withdraws it. */}
        <Switch
          label={translate('settings.roles.permissions.allLabel', { group: group.label })}
          checked={group.state === 'on'}
          mixed={group.state === 'mixed'}
          disabled={!props.editable}
          onToggle={() => actions.toggleGroup(group.features, group.state === 'on' ? 'withdraw' : 'grant')}
        />
      </div>
      {group.rows.map((row) => (
        <div key={row.feature} className="app-role-toggle">
          <span className="app-role-toggle-icon" aria-hidden="true">
            <FeatureIcon feature={row.feature} size={14} />
          </span>
          <span className="app-role-toggle-label">{row.label}</span>
          <Switch
            label={row.label}
            checked={row.checked}
            disabled={!props.editable}
            onToggle={() => actions.toggle(row.feature, row.checked ? 'withdraw' : 'grant')}
          />
        </div>
      ))}
    </div>
  );
}
