// One role in Settings → Roles, as a compact card: a header (name, member count, Duplicate and a "…" menu with
// Rename and Delete), then a short list of flat summary rows: Members, Sidebar apps, Components and
// Permissions, each with a muted summary and a chevron. A row opens that part of the role as a detail view that
// replaces the cards (RoleDetail.tsx), so the card never grows into a wall of switches. Admin's access is fixed
// (no Permissions row) and it is always named "Admin"; every other role, Client included, is renamed in place (its
// id, and so its grants, stay); only custom roles can be deleted, after a confirmation. Client cannot: the parser
// puts it back in every file it reads, and Studio falls back to it (a broken roles file, a signed-in person
// without a file), so deleting it would only reset it to its default access. Every control is disabled when the
// viewer cannot edit roles. Changes save at once (RolesSettings.tsx); a refused or failed one shows its notice
// under the heading.
import { useMemo, useState, type ReactNode } from 'react';
import {
  ADMIN_ROLE_ID,
  CLIENT_ROLE_ID,
  ROLE_LIMITS,
  type AccessFeature,
  type ProjectRole,
  type StaticAccessFeature,
} from '../../../shared/properties/projectRoles';
import { FeatureIcon } from '../featureIcons';
import MoreMenu from '../../ui/MoreMenu';
import { ChevronRightIcon, CopyIcon, ElementComponentIcon, GearIcon, PinIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { buildComponentTree } from './componentTree';
import { permissionCounts, type RoleSection } from './roleDetailModel';
import type { ComponentRule, ComponentState, ComponentTarget } from '../../../shared/properties/componentAccess';

export interface RoleCardActions {
  /** Whether the name was accepted; a refused one says why in the card's notice. */
  readonly rename: (name: string) => boolean;
  readonly remove: () => void;
  readonly addMember: (login: string) => boolean;
  readonly removeMember: (login: string) => void;
  readonly toggle: (feature: AccessFeature, change: 'grant' | 'withdraw') => void;
  readonly toggleGroup: (features: readonly StaticAccessFeature[], change: 'grant' | 'withdraw') => void;
  /** Lets the role use one app, or stops it. */
  readonly setAppAccess: (appId: string, change: 'grant' | 'withdraw') => void;
  /** Turns one app permission, or all of an app's, on or off. */
  readonly setAppPermissions: (appId: string, permissionIds: readonly string[], change: 'grant' | 'withdraw') => void;
  /** Pins an app to the left rail for the role, or unpins it. */
  readonly setPinnedApp: (appId: string, change: 'pin' | 'unpin') => void;
  /** Puts the role's pins in this order, top to bottom. */
  readonly orderPinnedApps: (appIds: readonly string[]) => void;
  /** Shows or hides a component or folder for the role: it may or may not add it. */
  readonly setComponentVisibility: (target: ComponentTarget, state: ComponentState) => void;
  /** Shows every component, or hides every one of the project's files. */
  readonly setAllComponentVisibility: (state: ComponentState, files: readonly string[]) => void;
  /** Takes another role's hidden components. */
  readonly copyComponentRules: (fromRoleId: string) => void;
  /** Drops one stored rule. */
  readonly removeComponentRule: (rule: ComponentRule) => void;
  /** Copies the role, without its members, into a new role right after it. */
  readonly duplicate: () => void;
}

export function RoleCard(props: {
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly actions: RoleCardActions;
  /** Opens one part of the role as a detail view. */
  readonly open: (section: RoleSection) => void;
  /** The open project's component files, for the Components row's count; without them it counts none. */
  readonly componentFiles?: readonly string[];
  /** Why the card's last change was refused or not saved, beside it. */
  readonly notice?: ReactNode;
  /** The card opens with its name field focused: the role was just made by Duplicate. */
  readonly naming?: 'rename' | undefined;
}) {
  const { role, editable, actions } = props;
  const translate = useTranslate();
  // A role just made by Duplicate opens with its name ready to change; the menu's Rename and a click on the name do the same.
  const [naming, setNaming] = useState<'shown' | 'editing'>(props.naming === 'rename' && editable ? 'editing' : 'shown');
  const files = props.componentFiles ?? NO_FILES;
  const tree = useMemo(() => buildComponentTree(files, role.componentRules), [files, role.componentRules]);
  const permissions = permissionCounts(role);
  const rows: readonly SummaryRow[] = [
    {
      section: 'members',
      icon: <FeatureIcon feature="settings:roles" size={14} />,
      label: translate('settings.roles.members.title'),
      summary: String(role.members.length),
    },
    { section: 'pins', icon: <PinIcon size={14} />, label: translate('settings.roles.pins.title'), summary: String(role.pinnedApps.length) },
    {
      section: 'components',
      icon: <ElementComponentIcon size={14} />,
      label: translate('settings.roles.components.title'),
      summary: translate('settings.roles.summary.ofTotal', { count: tree.visible, total: tree.total }),
    },
    ...(role.id === ADMIN_ROLE_ID
      ? []
      : [
          {
            section: 'permissions' as const,
            icon: <GearIcon size={14} />,
            label: translate('settings.roles.permissions.title'),
            summary: translate('settings.roles.summary.ofTotal', { count: permissions.granted, total: permissions.total }),
          },
        ]),
  ];
  return (
    <section className="app-role" aria-label={translate('settings.roles.card.label', { name: role.name })}>
      <div className="app-role-heading">
        <span className="app-role-heading-icon" aria-hidden="true">
          <FeatureIcon feature="settings:roles" size={14} />
        </span>
        {role.id === ADMIN_ROLE_ID ? (
          <h3>{role.name}</h3>
        ) : (
          <RoleName role={role} editable={editable} rename={actions.rename} naming={naming} setNaming={setNaming} />
        )}
        <span className="app-role-count">{role.members.length > 0 && translate('settings.roles.members.count', { count: role.members.length })}</span>
        <RoleHeadingActions role={role} editable={editable} actions={actions} startNaming={() => setNaming('editing')} />
      </div>
      {props.notice}
      {/* Flat rows, transparent at rest: one level of filled surface (the card) and a hover wash, no boxes inside it. */}
      <ul className="app-role-rows">
        {rows.map((row) => (
          <li key={row.section}>
            <button
              type="button"
              className="app-role-row"
              data-section={row.section}
              aria-label={translate('settings.roles.summary.open', { section: row.label, name: role.name })}
              onClick={() => props.open(row.section)}
            >
              <span className="app-role-row-icon" aria-hidden="true">
                {row.icon}
              </span>
              <span className="app-role-row-label">{row.label}</span>
              <span className="app-role-row-summary">{row.summary}</span>
              <ChevronRightIcon size={12} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface SummaryRow {
  readonly section: RoleSection;
  readonly icon: ReactNode;
  readonly label: string;
  readonly summary: string;
}

const NO_FILES: readonly string[] = [];

type SectionProps = {
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly actions: RoleCardActions;
  readonly projectPath: string | undefined;
};

// Duplicate, and the "…" menu: Rename and Delete. Admin is always "Admin" and Client cannot be deleted
// (the parser restores it), so each menu holds only what applies; with nothing to offer it draws nothing.
function RoleHeadingActions(props: Omit<SectionProps, 'projectPath'> & { readonly startNaming: () => void }) {
  const { role, editable, actions } = props;
  const translate = useTranslate();
  if (!editable) {
    return undefined;
  }
  const builtIn = role.id === ADMIN_ROLE_ID || role.id === CLIENT_ROLE_ID;
  return (
    <>
      <button
        type="button"
        className="app-role-icon"
        aria-label={translate('settings.roles.duplicate.label', { name: role.name })}
        title={translate('settings.roles.duplicate.tip', { name: role.name })}
        onClick={actions.duplicate}
      >
        <CopyIcon size={14} />
      </button>
      <MoreMenu
        className="app-role-more"
        title={translate('settings.roles.menu.label', { name: role.name })}
        width={150}
        items={[
          role.id !== ADMIN_ROLE_ID && { label: translate('settings.roles.menu.rename'), onSelect: props.startNaming },
          !builtIn && { label: translate('settings.roles.menu.delete'), danger: true, onSelect: actions.remove },
        ]}
      />
    </>
  );
}

/**
 * A role's name, renamed in place: click it (or choose Rename in the "…" menu) to edit, Enter or leaving
 * the field saves, Escape cancels. A refused name (empty, too long, taken) puts the field back to the
 * saved name and the card's notice says why.
 */
function RoleName(props: {
  readonly role: ProjectRole;
  readonly editable: boolean;
  readonly rename: (name: string) => boolean;
  readonly naming: 'shown' | 'editing';
  readonly setNaming: (naming: 'shown' | 'editing') => void;
}) {
  const { role } = props;
  const translate = useTranslate();
  if (props.naming === 'shown') {
    if (!props.editable) {
      return <h3>{role.name}</h3>;
    }
    return (
      <h3>
        <button
          type="button"
          className="app-role-name-button"
          title={translate('settings.roles.menu.rename')}
          aria-label={translate('settings.roles.name.rename', { name: role.name })}
          onClick={() => props.setNaming('editing')}
        >
          {role.name}
        </button>
      </h3>
    );
  }
  return <RoleNameField role={role} rename={props.rename} setNaming={props.setNaming} />;
}

// Mounted only while naming, so each edit starts from the saved name.
function RoleNameField(props: {
  readonly role: ProjectRole;
  readonly rename: (name: string) => boolean;
  readonly setNaming: (naming: 'shown' | 'editing') => void;
}) {
  const { role } = props;
  const translate = useTranslate();
  const [text, setText] = useState(role.name);
  const commit = (value: string) => {
    props.setNaming('shown');
    if (value.trim() !== role.name) {
      props.rename(value);
    }
  };
  return (
    <input
      className="app-role-name"
      aria-label={translate('settings.roles.name.label')}
      // Focus moves here because the person just clicked the name, chose Rename, or duplicated the role, to rename it.
      autoFocus
      maxLength={ROLE_LIMITS.roleNameCharsMax}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          // Escape cancels the rename only; it must not close Settings too.
          event.preventDefault();
          event.stopPropagation();
          props.setNaming('shown');
        }
      }}
    />
  );
}
