// Settings → Roles: who may use which parts of Stacki in this project
// (`.stacki/roles.json`, shared/properties/projectRoles.ts). Admins edit; everyone
// else, and an admin viewing as another role, sees it read-only. A save goes
// through the metadata transport, which main refuses for a non-admin too.
//
// "View as" previews another role's UI without touching the file: it changes
// the renderer's active role only (src/lib/currentRole.ts), never what
// main allows. Only someone whose own role is admin can choose it.
//
// Every change saves at once, like every other tab. Before it is saved it is
// checked: the edit itself (rolesEdits.ts: names, members, the last admin), then
// whether it would remove the saver's own admin access, then the file's own
// parser. A refused change never shows; its reason appears beside the control.
// A failed save puts the controls back to what is saved and offers Retry.
import { useEffect, useRef, useState } from 'react';
import {
  ADMIN_ROLE_ID,
  DEFAULT_PROJECT_ROLES,
  ROLE_LIMITS,
  can,
  roleViewOf,
  serializeProjectRoles,
  type ProjectRole,
  type ProjectRoles,
} from '../../../shared/properties/projectRoles';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import { cleanError } from '../../lib/cleanError';
import { PlusIcon } from '../../ui/Icons';
import { setViewAs, viewingAs } from '../../lib/currentRole';
import { readRolesIdentity, readStoredRoles, saveStoredRoles, type StoredRoles } from '../roles/rolesBridge';
import { reloadProjectRoles } from '../roles/useProjectRoles';
import { useActualRole, useCurrentRole } from '../../lib/useCurrentRole';
import { RoleCard, type RoleCardActions } from './RoleCard';
import {
  addMember,
  addRole,
  deleteRole,
  duplicateRole,
  removeMember,
  renameRole,
  selfLockout,
  setAccess,
  setAppAccess,
  setAppPermissions,
  setDefaultRole,
  setGroupAccess,
  orderPinnedApps,
  setPinnedApp,
} from './rolesEdits';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { DescribedError } from '../../../shared/properties/describedError';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Described, Translator } from '../../../shared/properties/i18n/messageRef';
import { assert } from '../../../shared/core/assert';
import { SettingsSaveRow, SettingsNotice, SettingsRow, SettingsSection, useSaveIndicator } from './SettingsLayout';
import './roles.css';

type Loaded = { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'ready'; readonly stored: StoredRoles };

export function RolesSettings(props: { readonly projectPath: string }) {
  const { projectPath } = props;
  const translate = useTranslate();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [login, setLogin] = useState<string | undefined>(undefined);
  useEffect(() => {
    let lifetime: 'active' | 'disposed' = 'active';
    void Promise.all([readStoredRoles(projectPath), readRolesIdentity(projectPath).catch(() => undefined)]).then(
      ([stored, identity]) => {
        if (lifetime === 'active') {
          setLoaded({ kind: 'ready', stored });
          setLogin(identity);
        }
      },
      (error: unknown) => {
        if (lifetime === 'active') {
          setLoaded({ kind: 'failed', message: cleanError(error) });
        }
      },
    );
    return () => {
      lifetime = 'disposed';
    };
  }, [projectPath]);
  switch (loaded.kind) {
    case 'loading':
      return (
        <p className="app-settings-status" role="status">
          {translate('settings.roles.loading')}
        </p>
      );
    case 'failed':
      return <ErrorToast message={loaded.message} />;
    case 'ready':
      return <RolesEditor projectPath={projectPath} stored={loaded.stored} login={login} />;
    default: {
      const exhaustive: never = loaded;
      return exhaustive;
    }
  }
}

function initialRoles(stored: StoredRoles, login: string | undefined): ProjectRoles {
  if (stored.kind === 'ready') {
    return stored.roles;
  }
  // A new file names the signed-in person as its first admin, so it can be saved.
  const admin = DEFAULT_PROJECT_ROLES.roles[0];
  if (login === undefined || admin === undefined) {
    return DEFAULT_PROJECT_ROLES;
  }
  return { ...DEFAULT_PROJECT_ROLES, roles: [{ ...admin, members: [login] }, ...DEFAULT_PROJECT_ROLES.roles.slice(1)] };
}

/** Where a notice shows: beside a role's card, the access rows, or the new-role field. */
export type RolesNoticeScope = { readonly kind: 'role'; readonly id: string } | { readonly kind: 'access' } | { readonly kind: 'new-role' };
type RolesNotice =
  | { readonly kind: 'none' }
  // The change was not saved and never showed; the control is at its saved value.
  | { readonly kind: 'refused'; readonly scope: RolesNoticeScope; readonly problem: Described }
  // The save failed; the controls went back to the saved roles, and Retry saves `roles` again.
  | { readonly kind: 'failed'; readonly scope: RolesNoticeScope; readonly detail: string; readonly roles: ProjectRoles };

/** Saves waiting behind the one under way: only the latest is kept, so this never grows past one. */
const ROLES_SAVE_ROUNDS_MAX = 64;

/** A refusal that carries a reference keeps it; any other failure is shown as its cleaned message. */
function refusalOf(failure: unknown): Described {
  return failure instanceof DescribedError ? failure.problem : { message: cleanError(failure) };
}

/** Why `next` cannot be saved, or undefined when it can. */
export function rolesRefusal(next: ProjectRoles, login: string | undefined): Described | undefined {
  const lockout = selfLockout(next, login);
  if (lockout !== undefined) {
    return lockout;
  }
  try {
    serializeProjectRoles(next);
    return undefined;
  } catch (failure: unknown) {
    return refusalOf(failure);
  }
}

function RolesEditor(props: { readonly projectPath: string; readonly stored: StoredRoles; readonly login: string | undefined }) {
  const { stored, login } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const role = useCurrentRole();
  const editable = can(role, 'settings:roles');
  const [shown, setShown] = useState<ProjectRoles>(() => initialRoles(stored, login));
  const [notice, setNotice] = useState<RolesNotice>({ kind: 'none' });
  const [newName, setNewName] = useState('');
  // The role Duplicate just made, whose card opens with its name field focused.
  const [naming, setNaming] = useState<string | undefined>(undefined);
  const indicator = useSaveIndicator();
  // What is on disk, the text it was written as (the next write's base), and the save waiting to run.
  const saved = useRef<ProjectRoles>(shown);
  const base = useRef<string | undefined>(stored.kind === 'absent' ? undefined : stored.source);
  const waiting = useRef<{ readonly scope: RolesNoticeScope; readonly roles: ProjectRoles } | undefined>(undefined);
  const writing = useRef<'idle' | 'writing'>('idle');

  // Writes the latest wanted roles, one write at a time, each over the text the last one wrote.
  const persist = async (scope: RolesNoticeScope, roles: ProjectRoles): Promise<void> => {
    waiting.current = { scope, roles };
    if (writing.current === 'writing') {
      return;
    }
    writing.current = 'writing';
    for (let round = 0; waiting.current !== undefined; round += 1) {
      assert(round < ROLES_SAVE_ROUNDS_MAX, 'Roles saves drain: each round takes the one waiting');
      const next = waiting.current;
      waiting.current = undefined;
      try {
        base.current = await indicator.track(saveStoredRoles(props.projectPath, next.roles, base.current));
        saved.current = next.roles;
        reloadProjectRoles();
      } catch (failure: unknown) {
        // A change waiting behind this one was built on it, so it goes too.
        waiting.current = undefined;
        setShown(saved.current);
        setNotice({ kind: 'failed', scope: next.scope, detail: cleanError(failure), roles: next.roles });
      }
    }
    writing.current = 'idle';
  };
  const apply = (scope: RolesNoticeScope, change: (roles: ProjectRoles) => ProjectRoles): boolean => {
    assert(editable, 'Only an editor changes roles');
    let next: ProjectRoles;
    try {
      next = change(shown);
    } catch (failure: unknown) {
      setNotice({ kind: 'refused', scope, problem: refusalOf(failure) });
      return false;
    }
    const refusal = rolesRefusal(next, login);
    if (refusal !== undefined) {
      setNotice({ kind: 'refused', scope, problem: refusal });
      return false;
    }
    setShown(next);
    setNotice({ kind: 'none' });
    void persist(scope, next);
    return true;
  };
  // Deleting asks first (danger: Cancel has focus). Members leave with the role; a
  // default role that goes falls back to admin (deleteRole), and so does a "View as" of it.
  const removeRole = async (id: string): Promise<void> => {
    const role = shown.roles.find((item) => item.id === id);
    assert(role !== undefined, 'A deleted role exists');
    assert(role.id !== ADMIN_ROLE_ID, 'Admin is never deleted');
    const answer = await confirmDialog({
      title: translate('settings.roles.delete.title', { name: role.name }),
      body: deleteRoleSummary(role, { defaultRole: shown.defaultRole, viewing: viewingAs()?.id }, translate),
      confirmLabel: translate('settings.roles.delete.confirm'),
      danger: true,
    });
    if (answer !== true) {
      return;
    }
    if (apply({ kind: 'role', id }, (roles) => deleteRole(roles, id))) {
      if (viewingAs()?.id === id) {
        setViewAs(undefined);
      }
    }
  };
  const noticeFor = (scope: RolesNoticeScope) => {
    if (notice.kind === 'none' || !sameScope(notice.scope, scope)) {
      return undefined;
    }
    if (notice.kind === 'refused') {
      return <SettingsNotice message={translateDescribed(notice.problem)} />;
    }
    const retry = notice.roles;
    return (
      <SettingsNotice
        message={translate('settings.roles.notSaved', { message: notice.detail })}
        onRetry={() => {
          setShown(retry);
          setNotice({ kind: 'none' });
          void persist(scope, retry);
        }}
      />
    );
  };
  return (
    <section className="app-roles" aria-label={translate('settings.roles.screen.label')}>
      <SettingsSaveRow saving={indicator.state} />
      {login === undefined && <p className="app-roles-notice">{translate('settings.roles.signedOut')}</p>}
      {stored.kind === 'invalid' && <ErrorToast message={translate('settings.roles.fileUnreadable', { message: stored.message })} />}
      {!editable && <p className="app-roles-notice">{translate('settings.roles.readOnly')}</p>}
      <SettingsSection title={translate('settings.roles.section.access')}>
        <ViewAs roles={shown} />
        <DefaultRole roles={shown} editable={editable} change={(id) => apply({ kind: 'access' }, (roles) => setDefaultRole(roles, id))} />
        {noticeFor({ kind: 'access' })}
      </SettingsSection>
      <SettingsSection title={translate('settings.roles.section.roles')} info={translate('settings.roles.members.info')}>
        {shown.roles.map((item) => (
          <RoleCard
            key={item.id}
            role={item}
            editable={editable}
            projectPath={props.projectPath}
            currentLogin={login}
            notice={noticeFor({ kind: 'role', id: item.id })}
            naming={item.id === naming ? 'rename' : undefined}
            actions={cardActions(
              item.id,
              translate,
              (change) => apply({ kind: 'role', id: item.id }, change),
              (copyId) => setNaming(copyId),
              () => void removeRole(item.id),
            )}
          />
        ))}
        {editable && (
          <form
            className="app-role-add app-roles-new"
            onSubmit={(event) => {
              event.preventDefault();
              if (apply({ kind: 'new-role' }, (roles) => addRole(roles, newName))) {
                setNewName('');
              }
            }}
          >
            <input
              aria-label={translate('settings.roles.newRole.label')}
              placeholder={translate('settings.roles.newRole.label')}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button type="submit" disabled={newName.trim() === ''}>
              <PlusIcon size={12} /> {translate('settings.roles.newRole.add')}
            </button>
          </form>
        )}
        {noticeFor({ kind: 'new-role' })}
      </SettingsSection>
    </section>
  );
}

/** What deleting `role` does, for its confirmation: its members, and any fallback to Admin. */
export function deleteRoleSummary(
  role: ProjectRole,
  context: { readonly defaultRole: string; readonly viewing: string | undefined },
  translate: Translator = ENGLISH_TRANSLATE,
): string {
  assert(role.id !== ADMIN_ROLE_ID, 'Admin is never deleted');
  assert(role.members.length <= ROLE_LIMITS.membersMax, 'Members are bounded');
  const count = role.members.length;
  const members = count === 0 ? translate('roles.delete.noMembers') : translate('roles.delete.members', { count, members: role.members.join(', ') });
  const parts = [members];
  if (context.defaultRole === role.id) {
    parts.push(translate('roles.delete.defaultRole'));
  }
  if (context.viewing === role.id) {
    parts.push(translate('roles.delete.viewing'));
  }
  return parts.join(' ');
}

function sameScope(left: RolesNoticeScope, right: RolesNoticeScope): boolean {
  if (left.kind === 'role') {
    return right.kind === 'role' && right.id === left.id;
  }
  return left.kind === right.kind;
}

function cardActions(
  id: string,
  translate: Translator,
  apply: (change: (roles: ProjectRoles) => ProjectRoles) => boolean,
  named: (copyId: string) => void,
  remove: () => void,
): RoleCardActions {
  return {
    rename: (name) => apply((roles) => renameRole(roles, id, name)),
    remove,
    addMember: (login) => apply((roles) => addMember(roles, id, login)),
    removeMember: (login) => void apply((roles) => removeMember(roles, id, login)),
    toggle: (feature, change) => void apply((roles) => setAccess(roles, id, feature, change)),
    toggleGroup: (features, change) => void apply((roles) => setGroupAccess(roles, id, features, change)),
    setAppAccess: (appId, change) => void apply((roles) => setAppAccess(roles, id, appId, change)),
    setAppPermissions: (appId, permissionIds, change) => void apply((roles) => setAppPermissions(roles, id, appId, permissionIds, change)),
    setPinnedApp: (appId, change) => void apply((roles) => setPinnedApp(roles, id, appId, change)),
    orderPinnedApps: (appIds) => void apply((roles) => orderPinnedApps(roles, id, appIds)),
    duplicate: () => {
      let copyId: string | undefined;
      const saved = apply((roles) => {
        const copy = duplicateRole(roles, id, translate);
        copyId = copy.id;
        return copy.roles;
      });
      if (saved && copyId !== undefined) {
        named(copyId);
      }
    },
  };
}

// "View as": an admin previews another role. The choice lives in the renderer only.
function ViewAs(props: { readonly roles: ProjectRoles }) {
  const translate = useTranslate();
  const actual = useActualRole();
  useCurrentRole();
  const viewing = viewingAs();
  if (!actual.isAdmin) {
    return undefined;
  }
  return (
    <SettingsRow label={translate('settings.roles.viewAs.label')} info={translate('settings.roles.viewAs.info')}>
      <Dropdown
        ariaLabel={translate('settings.roles.viewAs.label')}
        className="app-roles-dropdown"
        value={viewing?.id ?? 'admin'}
        options={roleOptions(props.roles)}
        onChange={(id) => setViewAs(id === 'admin' ? undefined : roleViewOf(props.roles, id))}
      />
    </SettingsRow>
  );
}

function DefaultRole(props: { readonly roles: ProjectRoles; readonly editable: boolean; readonly change: (id: string) => void }) {
  const translate = useTranslate();
  return (
    <SettingsRow label={translate('settings.roles.defaultRole.label')} info={translate('settings.roles.defaultRole.info')}>
      <Dropdown
        ariaLabel={translate('settings.roles.defaultRole.aria')}
        className="app-roles-dropdown"
        value={props.roles.defaultRole}
        disabled={!props.editable}
        options={roleOptions(props.roles)}
        onChange={props.change}
      />
    </SettingsRow>
  );
}

// Both role pickers list the same roles, by id, in the file's order.
function roleOptions(roles: ProjectRoles): readonly DropdownOption[] {
  return roles.roles.map((item) => ({ value: item.id, label: item.name }));
}
