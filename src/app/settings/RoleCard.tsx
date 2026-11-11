// One role in Settings → Roles: its name, its members as GitHub username chips
// with their pictures, and its access as switches grouped by area, collapsed
// behind a "Permissions · n of m on" row (RolePermissions.tsx). Admin's access
// is fixed ("Full access") and it is always named "Admin"; every other role,
// Client included, is renamed in place (its id, and so its grants, stay); only
// custom roles can be deleted, after a confirmation. Client cannot: the parser
// puts it back in every file it reads, and Studio falls back to it (a broken roles
// file, a signed-in person without a file), so deleting it would only reset it to
// its default access. Each switch has its feature's icon (featureIcons.ts)
// and each group an "All" switch. Every control is disabled when the viewer
// cannot edit roles. Changes save at once (RolesSettings.tsx); a refused or
// failed one shows its notice under the heading.
//
// Under the Apps group, each installed app that declares permissions gets its own
// group of switches (RoleAppPermissions.tsx).
//
// Every card, admin's included, has its own "Pinned to sidebar" list under its
// members and above its permissions (RolePinnedApps.tsx): each role pins its own
// apps in its own order, so it sits where it reads as the role's, not inside the
// collapsed permissions.
//
// Members are added through MemberPicker (GitHub suggestions while typing); apps
// are the project's installed ones (useInstalledApps), each with its own switch.
// Both need the open project; without `projectPath` the username field still adds
// what is typed, and no app sections show.
import { Fragment, useState, type ReactNode } from 'react';
import {
  ACCESS_GROUPS,
  ADMIN_ROLE_ID,
  APPS_ACCESS_GROUP,
  APP_ACCESS_ALL,
  CLIENT_ROLE_ID,
  ROLE_LIMITS,
  type ProjectRole,
  type StaticAccessFeature,
} from '../../../shared/properties/projectRoles';
import { Switch } from '../../ui/Switch';
import CommitAvatar from '../../features/history/CommitAvatar';
import { FeatureIcon } from '../featureIcons';
import { CloseIcon, CopyIcon, TrashIcon } from '../../ui/Icons';
import { memberAvatarURL } from './memberAvatars';
import { MemberPicker } from './MemberPicker';
import { useInstalledApps } from './RoleAppPicker';
import { RoleAppPermissions } from './RoleAppPermissions';
import { RolePermissions } from './RolePermissions';
import { RolePinnedApps } from './RolePinnedApps';

export interface RoleCardActions {
  /** Whether the name was accepted; a refused one says why in the card's notice. */
  readonly rename: (name: string) => boolean;
  readonly remove: () => void;
  readonly addMember: (login: string) => boolean;
  readonly removeMember: (login: string) => void;
  readonly toggle: (feature: ProjectRole['access'][number], change: 'grant' | 'withdraw') => void;
  readonly toggleGroup: (features: readonly StaticAccessFeature[], change: 'grant' | 'withdraw') => void;
  /** Lets the role use one app, or stops it. */
  readonly setAppAccess: (appId: string, change: 'grant' | 'withdraw') => void;
  /** Turns one app permission, or all of an app's, on or off. */
  readonly setAppPermissions: (appId: string, permissionIds: readonly string[], change: 'grant' | 'withdraw') => void;
  /** Pins an app to the left rail for the role, or unpins it. */
  readonly setPinnedApp: (appId: string, change: 'pin' | 'unpin') => void;
  /** Puts the role's pins in this order, top to bottom. */
  readonly orderPinnedApps: (appIds: readonly string[]) => void;
  /** Copies the role, without its members, into a new role right after it. */
  readonly duplicate: () => void;
}

export function RoleCard(props: {
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly actions: RoleCardActions;
  /** The open project, for member suggestions and installed apps. */
  readonly projectPath?: string;
  /** Why the card's last change was refused or not saved, beside it. */
  readonly notice?: ReactNode;
  /** The card opens with its name field focused: the role was just made by Duplicate. */
  readonly naming?: 'rename' | undefined;
}) {
  const { role, editable, actions } = props;
  const projectPath = props.projectPath;
  const builtIn = role.id === ADMIN_ROLE_ID || role.id === CLIENT_ROLE_ID;
  return (
    <section className="app-role" aria-label={`${role.name} role`}>
      <div className="app-role-heading">
        <span className="app-role-heading-icon" aria-hidden="true">
          <FeatureIcon feature="settings:roles" size={14} />
        </span>
        {role.id === ADMIN_ROLE_ID ? <h3>{role.name}</h3> : <RoleName role={role} editable={editable} rename={actions.rename} naming={props.naming} />}
        {role.id === ADMIN_ROLE_ID && <span className="app-role-badge">Full access</span>}
        {editable && (
          <button
            type="button"
            className="app-role-icon"
            aria-label={`Duplicate ${role.name}`}
            title={`Duplicate ${role.name} as a new role, without its members`}
            onClick={actions.duplicate}
          >
            <CopyIcon size={14} />
          </button>
        )}
        {!builtIn && (
          <button
            type="button"
            className="app-role-icon is-danger"
            aria-label={`Delete ${role.name}`}
            title={`Delete ${role.name}`}
            disabled={!editable}
            onClick={actions.remove}
          >
            <TrashIcon size={14} />
          </button>
        )}
      </div>
      {props.notice}
      <Members role={role} editable={editable} actions={actions} projectPath={projectPath} />
      <RolePins role={role} editable={editable} actions={actions} projectPath={projectPath} />
      {role.id !== ADMIN_ROLE_ID && (
        <RolePermissions role={role} projectPath={projectPath}>
          <Access role={role} editable={editable} actions={actions} projectPath={projectPath} />
        </RolePermissions>
      )}
    </section>
  );
}

type SectionProps = {
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly actions: RoleCardActions;
  readonly projectPath: string | undefined;
};

function Members(props: SectionProps) {
  const { role, editable, actions } = props;
  return (
    <div className="app-role-members">
      <ul aria-label={`${role.name} members`}>
        {role.members.map((member) => (
          <li key={member} className="app-role-chip">
            <CommitAvatar name={member} email="" url={memberAvatarURL(member)} />
            <span>{member}</span>
            {editable && (
              <button type="button" aria-label={`Remove ${member}`} onClick={() => actions.removeMember(member)}>
                <CloseIcon size={10} />
              </button>
            )}
          </li>
        ))}
        {role.members.length === 0 && <li className="app-role-none">No members</li>}
      </ul>
      {editable && <MemberPicker roleName={role.name} members={role.members} projectPath={props.projectPath} addMember={actions.addMember} />}
    </div>
  );
}

function Access(props: SectionProps) {
  const { role, editable, actions } = props;
  const granted = new Set(role.access);
  const installed = useInstalledApps(props.projectPath);
  return (
    <div className="app-role-access">
      {ACCESS_GROUPS.map((group) => {
        const features = group.features.map((item) => item.feature);
        const all = features.every((feature) => granted.has(feature));
        return (
          <Fragment key={group.label}>
            <div className="app-role-group">
              <div className="app-role-group-heading">
                <h4>{group.label}</h4>
                {/* Mixed reads as off: switching it on grants the whole group. */}
                <span className="app-role-group-all">
                  All
                  <Switch
                    label={`All ${group.label}`}
                    checked={all}
                    disabled={!editable}
                    onToggle={() => actions.toggleGroup(features, all ? 'withdraw' : 'grant')}
                  />
                </span>
              </div>
              {group.features.map(({ feature, label }) => (
                <Toggle
                  key={feature}
                  feature={feature}
                  label={label}
                  checked={granted.has(feature)}
                  disabled={!editable}
                  onToggle={() => actions.toggle(feature, granted.has(feature) ? 'withdraw' : 'grant')}
                />
              ))}
              {group.label === APPS_ACCESS_GROUP && <AllApps role={role} editable={editable} actions={actions} />}
            </div>
            {group.label === APPS_ACCESS_GROUP && (
              <RoleAppPermissions role={role} installed={installed} editable={editable} change={actions.setAppPermissions} access={actions.setAppAccess} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// The role's own rail pins, offered from the installed apps it may use.
function RolePins(props: SectionProps) {
  const installed = useInstalledApps(props.projectPath);
  return (
    <div className="app-role-pins-section">
      <RolePinnedApps
        role={props.role}
        installed={installed}
        editable={props.editable}
        change={props.actions.setPinnedApp}
        order={props.actions.orderPinnedApps}
      />
    </div>
  );
}

// "Every app" (`app:*`), under the Apps group's marketplace switches: every installed
// app now and later. (Not "All apps": the group's own "All Apps" switch has that name.) Each app has its own switch in its section below (RoleAppPermissions.tsx).
function AllApps(props: Omit<SectionProps, 'projectPath'>) {
  const { role, editable, actions } = props;
  const all = role.access.includes(APP_ACCESS_ALL);
  return (
    <Toggle
      feature={APP_ACCESS_ALL}
      label="Every app"
      checked={all}
      disabled={!editable}
      onToggle={() => actions.toggle(APP_ACCESS_ALL, all ? 'withdraw' : 'grant')}
    />
  );
}

function Toggle(props: {
  readonly feature: StaticAccessFeature | typeof APP_ACCESS_ALL;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="app-role-toggle">
      <span className="app-role-toggle-icon" aria-hidden="true">
        <FeatureIcon feature={props.feature} size={14} />
      </span>
      <span className="app-role-toggle-label">{props.label}</span>
      <Switch label={props.label} checked={props.checked} disabled={props.disabled} onToggle={props.onToggle} />
    </div>
  );
}

/**
 * A role's name, renamed in place: click it to edit, Enter or leaving the field
 * saves, Escape cancels. A refused name (empty, too long, taken) puts the field
 * back to the saved name and the card's notice says why.
 */
function RoleName(props: {
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly rename: (name: string) => boolean;
  readonly naming: 'rename' | undefined;
}) {
  const { role } = props;
  // A role just made by Duplicate opens with its name ready to change.
  const [editing, setEditing] = useState<{ readonly kind: 'shown' } | { readonly kind: 'editing'; readonly text: string }>(() =>
    props.naming === 'rename' && props.editable ? { kind: 'editing', text: role.name } : { kind: 'shown' },
  );
  if (editing.kind === 'shown') {
    if (!props.editable) {
      return <h3>{role.name}</h3>;
    }
    return (
      <h3>
        <button
          type="button"
          className="app-role-name-button"
          title="Rename"
          aria-label={`Rename ${role.name}`}
          onClick={() => setEditing({ kind: 'editing', text: role.name })}
        >
          {role.name}
        </button>
      </h3>
    );
  }
  const commit = (text: string) => {
    setEditing({ kind: 'shown' });
    if (text.trim() !== role.name) {
      props.rename(text);
    }
  };
  return (
    <input
      className="app-role-name"
      aria-label="Role name"
      // Focus moves here because the person just clicked the name, or duplicated the role, to rename it.
      autoFocus
      maxLength={ROLE_LIMITS.roleNameCharsMax}
      value={editing.text}
      onChange={(event) => setEditing({ kind: 'editing', text: event.target.value })}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          // Escape cancels the rename only; it must not close Settings too.
          event.preventDefault();
          event.stopPropagation();
          setEditing({ kind: 'shown' });
        }
      }}
    />
  );
}
