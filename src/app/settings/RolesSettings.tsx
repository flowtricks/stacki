// Settings → Roles: who may use which parts of Stacki in this project
// (`.stacki/roles.json`, shared/properties/projectRoles.ts). On Desktop everyone edits,
// even while viewing as another role: Desktop previews roles and only Studio enforces
// them (Studio's own Roles view is read-only for a non-admin, enforced by its server).
//
// "View as" previews another role's UI without touching the file: it changes
// the renderer's active role only (src/lib/currentRole.ts), never what
// main allows. Only someone whose own role is admin can choose it.
//
// Every change saves at once, like every other tab. Before it is saved it is
// checked: the edit itself (rolesEdits.ts: names, members, the last admin), then the file's own
// parser. A refused change never shows; its reason appears beside the control.
// A failed save puts the controls back to what is saved and offers Retry.
import { useEffect, useRef, useState } from 'react';
import {
  ADMIN_ROLE_ID,
  DEFAULT_PROJECT_ROLES,
  ROLE_LIMITS,
  roleViewOf,
  serializeProjectRoles,
  type ProjectRole,
  type ProjectRoles,
} from '../../../shared/properties/projectRoles';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import { NoticeToast } from '../../ui/NoticeToast';
import { cleanError } from '../../lib/cleanError';
import { PlusIcon } from '../../ui/Icons';
import { setViewAs, viewingAs } from '../../lib/currentRole';
import { saveStoredRoles, type StoredRoles } from '../roles/rolesBridge';
import { rolesCache, storedRolesSource, useRolesSnapshot, type RolesIdentityState } from '../roles/rolesCache';
import { Skeleton } from '../../ui/Skeleton';
import { reloadProjectRoles } from '../roles/useProjectRoles';
import { useActualRole, useCurrentRole } from '../../lib/useCurrentRole';
import { RoleCard, type RoleCardActions } from './RoleCard';
import { RoleDetail } from './RoleDetail';
import { type RoleSection, type RolesView } from './roleDetailModel';
import {
  addInvitedMemberTo,
  addMember,
  addRole,
  deleteRole,
  duplicateRole,
  removeMember,
  renameRole,
  setAccess,
  setAppAccess,
  setAppPermissions,
  setDefaultRole,
  setGroupAccess,
  orderPinnedApps,
  setPinnedApp,
  setComponentVisibility,
  setEditorParts,
  setAllComponentVisibility,
  copyComponentRules,
  removeComponentRule,
} from './rolesEdits';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { DescribedError } from '../../../shared/properties/describedError';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Described, Translator } from '../../../shared/properties/i18n/messageRef';
import { assert } from '../../../shared/core/assert';
import { SettingsSaveRow, SettingsRow, SettingsSection, useSaveIndicator } from './SettingsLayout';
import './roles.css';

export function RolesSettings(props: { readonly projectPath: string; readonly componentFiles?: readonly string[] }) {
  const { projectPath } = props;
  // The last-known file and login paint in the first frame (rolesCache.ts); both are read again behind them.
  const snapshot = useRolesSnapshot(projectPath);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  useEffect(() => {
    let lifetime: 'active' | 'disposed' = 'active';
    void rolesCache.refreshStoredRoles(projectPath).then(
      () => {
        if (lifetime === 'active') {
          setFailure(undefined);
        }
      },
      (error: unknown) => {
        if (lifetime === 'active') {
          setFailure(cleanError(error));
        }
      },
    );
    void rolesCache.refreshRolesIdentity(projectPath);
    return () => {
      lifetime = 'disposed';
    };
  }, [projectPath]);
  const login = snapshot.identity.kind === 'known' ? snapshot.identity.login : undefined;
  switch (snapshot.file.kind) {
    case 'unknown':
      // Nothing read yet this session: the real headings, with the pickers and cards drawn as their shapes.
      return failure === undefined ? <RolesSkeleton /> : <ErrorToast message={failure} />;
    case 'known':
      // A failed refresh keeps the cards as last read and says so beside them.
      return (
        <>
          {failure !== undefined && <ErrorToast message={failure} />}
          <RolesEditor
            projectPath={projectPath}
            stored={snapshot.file.stored}
            login={login}
            identity={snapshot.identity.kind}
            componentFiles={props.componentFiles}
          />
        </>
      );
    default: {
      const exhaustive: never = snapshot.file;
      return exhaustive;
    }
  }
}

/** Summary rows on each card a new file starts with: Admin (Members, Sidebar apps, Components) and Client (and Permissions). */
const ROLES_SKELETON_CARD_ROWS = [3, 4] as const;
/** Widths of the summary labels, in percent of the row: fixed, so nothing moves between renders. */
const ROLES_SKELETON_ROW_WIDTHS_PERCENT = [38, 46, 42, 50] as const;

// The Roles tab before its first read this session: the real sections, picker rows and card boxes at their real
// sizes, with filled shapes where the file's names and counts go. One hidden status tells assistive technology.
export function RolesSkeleton() {
  const translate = useTranslate();
  const picker = (
    <span className="app-roles-dropdown app-roles-skeleton-picker">
      <Skeleton height="28px" radius="6px" />
    </span>
  );
  return (
    <section className="app-roles" aria-label={translate('settings.roles.screen.label')} aria-busy="true">
      <span className="ui-skeleton-status" role="status">
        {translate('ui.loading')}
      </span>
      <SettingsSection title={translate('settings.roles.section.access')}>
        <div className="app-roles-access">
          <div className="app-roles-access-grid">
            <SettingsRow label={translate('settings.roles.viewAs.label')} info={translate('settings.roles.viewAs.info')}>
              {picker}
            </SettingsRow>
            <SettingsRow label={translate('settings.roles.defaultRole.label')} info={translate('settings.roles.defaultRole.info')}>
              {picker}
            </SettingsRow>
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title={translate('settings.roles.section.roles')} info={translate('settings.roles.members.info')}>
        {ROLES_SKELETON_CARD_ROWS.map((rows, card) => (
          <div key={card} className="app-role" data-skeleton="role" aria-hidden="true">
            <div className="app-role-heading">
              <Skeleton width="96px" height="14px" />
            </div>
            <div className="app-role-rows">
              {ROLES_SKELETON_ROW_WIDTHS_PERCENT.slice(0, rows).map((widthPercent) => (
                <div key={widthPercent} className="app-role-row app-role-skeleton-row">
                  <Skeleton width={`${widthPercent}%`} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </SettingsSection>
    </section>
  );
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

/** What a notice is about: a role's card, the access rows, or the new-role field (a failed save retries that scope). */
export type RolesNoticeScope = { readonly kind: 'role'; readonly id: string } | { readonly kind: 'access' } | { readonly kind: 'new-role' };
type RolesNotice =
  | { readonly kind: 'none' }
  // The change was not saved and never showed; the control is at its saved value.
  | { readonly kind: 'refused'; readonly scope: RolesNoticeScope; readonly problem: Described }
  // The save failed; the controls went back to the saved roles, and Retry saves `roles` again.
  | { readonly kind: 'failed'; readonly scope: RolesNoticeScope; readonly detail: string; readonly roles: ProjectRoles };

/** Saves waiting behind the one under way: only the latest is kept, so this never grows past one. */
const ROLES_SAVE_ROUNDS_MAX = 64;

/** Every Roles edit is allowed on Desktop, which previews roles; hosted Studio enforces them (studio/src/features/roles). */
export const DESKTOP_EDITS_ROLES = true;

/** A refusal that carries a reference keeps it; any other failure is shown as its cleaned message. */
function refusalOf(failure: unknown): Described {
  return failure instanceof DescribedError ? failure.problem : { message: cleanError(failure) };
}

/** Why `next` cannot be saved, or undefined when it can. */
export function rolesRefusal(next: ProjectRoles): Described | undefined {
  try {
    serializeProjectRoles(next);
    return undefined;
  } catch (failure: unknown) {
    return refusalOf(failure);
  }
}

function RolesEditor(props: {
  readonly projectPath: string;
  readonly stored: StoredRoles;
  readonly login: string | undefined;
  /** Whether `login` is read yet: until it is, the signed-out notice stays hidden rather than flashing. */
  readonly identity: RolesIdentityState['kind'];
  readonly componentFiles: readonly string[] | undefined;
}) {
  const { stored, login } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  // Desktop never restricts the person editing: it previews roles and Studio enforces them. So this does not
  // follow the active role either: while an admin views as Client the controls stay editable.
  const editable = DESKTOP_EDITS_ROLES;
  const [shown, setShown] = useState<ProjectRoles>(() => initialRoles(stored, login));
  const [shownNotice, setShownNotice] = useState<{ readonly notice: RolesNotice; readonly serial: number }>({ notice: { kind: 'none' }, serial: 0 });
  const notice = shownNotice.notice;
  // Each notice is its own toast, even when a second refusal reads the same as the first.
  const setNotice = (next: RolesNotice): void => setShownNotice((current) => ({ notice: next, serial: current.serial + 1 }));
  const [newName, setNewName] = useState('');
  // The role Duplicate just made, whose card opens with its name field focused.
  const [naming, setNaming] = useState<string | undefined>(undefined);
  const indicator = useSaveIndicator();
  // Which part of a role is open, if any, and each part's search text, kept per role and part so going back and forth loses nothing.
  const [view, setView] = useState<RolesView>({ kind: 'cards' });
  const [queries, setQueries] = useState<Readonly<Record<string, string>>>({});
  // What is on disk, the text it was written as (the next write's base), and the save waiting to run.
  const saved = useRef<ProjectRoles>(shown);
  const base = useRef<string | undefined>(storedRolesSource(stored));
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
        const source = await indicator.track(saveStoredRoles(props.projectPath, next.roles, base.current));
        base.current = source;
        saved.current = next.roles;
        // The cache holds what was just written, so the next open paints it without a read.
        rolesCache.rememberStoredRoles(props.projectPath, { kind: 'ready', roles: next.roles, source });
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
  // The tab opened on the file as last read; a newer read (the background refresh, an edit from another window)
  // replaces it in place. While a save runs its own reload follows, so a read then is skipped. With no file yet,
  // nothing is saved, so a login that arrives late only names the first admin.
  useEffect(() => {
    if (writing.current === 'writing') {
      return;
    }
    const source = storedRolesSource(stored);
    if (source !== undefined && source === base.current) {
      return;
    }
    const next = initialRoles(stored, login);
    base.current = source;
    saved.current = next;
    setShown(next);
  }, [stored, login]);
  const apply = (scope: RolesNoticeScope, change: (roles: ProjectRoles) => ProjectRoles): boolean => {
    assert(editable, 'Only an editor changes roles');
    let next: ProjectRoles;
    try {
      next = change(shown);
    } catch (failure: unknown) {
      setNotice({ kind: 'refused', scope, problem: refusalOf(failure) });
      return false;
    }
    const refusal = rolesRefusal(next);
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
  // One toast owner for every view: a notice made in the cards must not be reported again when the detail view opens.
  const noticeToast = (() => {
    if (notice.kind === 'none') {
      return undefined;
    }
    if (notice.kind === 'refused') {
      return <ErrorToast key={shownNotice.serial} message={translateDescribed(notice.problem)} />;
    }
    const retry = notice.roles;
    return (
      <ErrorToast
        key={shownNotice.serial}
        message={translate('settings.roles.notSaved', { message: notice.detail })}
        recovery={[
          {
            label: translate('settings.retry'),
            run: () => {
              setShown(retry);
              setNotice({ kind: 'none' });
              void persist(notice.scope, retry);
            },
          },
        ]}
      />
    );
  })();
  const detailRole = view.kind === 'detail' ? shown.roles.find((item) => item.id === view.roleId) : undefined;
  const open = (roleId: string, section: RoleSection) => setView({ kind: 'detail', roleId, section });
  if (view.kind === 'detail' && detailRole !== undefined) {
    const queryKey = `${view.roleId}:${view.section}`;
    return (
      <section className="app-roles" aria-label={translate('settings.roles.screen.label')}>
        <SettingsSaveRow saving={indicator.state} />
        {noticeToast}
        <RoleDetail
          role={detailRole}
          section={view.section}
          editable={editable}
          projectPath={props.projectPath}
          currentLogin={login}
          {...(props.componentFiles === undefined ? {} : { componentFiles: props.componentFiles })}
          copySources={shown.roles.filter((other) => other.id !== detailRole.id).map((other) => ({ id: other.id, name: other.name }))}
          query={queries[queryKey] ?? ''}
          setQuery={(query) => setQueries({ ...queries, [queryKey]: query })}
          back={() => setView({ kind: 'cards' })}
          actions={cardActions(
            detailRole.id,
            translate,
            (change) => apply({ kind: 'role', id: detailRole.id }, change),
            (copyId) => setNaming(copyId),
            () => void removeRole(detailRole.id),
          )}
        />
      </section>
    );
  }
  return (
    <section className="app-roles" aria-label={translate('settings.roles.screen.label')}>
      <SettingsSaveRow saving={indicator.state} />
      {noticeToast}
      <NoticeToast kind="info" message={props.identity === 'known' && login === undefined ? translate('settings.roles.signedOut') : undefined} />
      {stored.kind === 'invalid' && <ErrorToast message={translate('settings.roles.fileUnreadable', { message: stored.message })} />}
      <SettingsSection title={translate('settings.roles.section.access')}>
        {/* The two pickers share one grid row (roles.css); the outer box is the container the grid's width query reads. */}
        <div className="app-roles-access">
          <div className="app-roles-access-grid">
            <ViewAs roles={shown} />
            <DefaultRole roles={shown} editable={editable} change={(id) => apply({ kind: 'access' }, (roles) => setDefaultRole(roles, id))} />
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title={translate('settings.roles.section.roles')} info={translate('settings.roles.members.info')}>
        {shown.roles.map((item) => (
          <RoleCard
            key={item.id}
            role={item}
            editable={editable}
            open={(section) => open(item.id, section)}
            {...(props.componentFiles === undefined ? {} : { componentFiles: props.componentFiles })}
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
    addInvitedMember: (member) => apply((roles) => addInvitedMemberTo(roles, id, member)),
    removeMember: (login) => void apply((roles) => removeMember(roles, id, login)),
    toggle: (feature, change) => void apply((roles) => setAccess(roles, id, feature, change)),
    toggleGroup: (features, change) => void apply((roles) => setGroupAccess(roles, id, features, change)),
    setEditing: (parts, change) => void apply((roles) => setEditorParts(roles, id, parts, change)),
    setAppAccess: (appId, change) => void apply((roles) => setAppAccess(roles, id, appId, change)),
    setAppPermissions: (appId, permissionIds, change) => void apply((roles) => setAppPermissions(roles, id, appId, permissionIds, change)),
    setComponentVisibility: (target, state) => void apply((roles) => setComponentVisibility(roles, id, target, state)),
    setAllComponentVisibility: (state, files) => void apply((roles) => setAllComponentVisibility(roles, id, state, files)),
    copyComponentRules: (fromId) => void apply((roles) => copyComponentRules(roles, id, fromId)),
    removeComponentRule: (rule) => void apply((roles) => removeComponentRule(roles, id, rule)),
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
