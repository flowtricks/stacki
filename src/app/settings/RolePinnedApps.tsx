// A role card's "Sidebar apps" section: the apps the role sees as their own
// buttons on the left rail (`pinnedApps`, src/app/railApps.tsx), in rail order.
// Each pin is a row, its app's tile and name, a grip to drag it to another place
// and a remove button (grip and remove show on hover or focus); Alt+↑ and Alt+↓ move a focused row.
// After the rows, a ghost "+ Add app" dropdown offers every installed app not yet pinned, so several can be
// pinned one after another; one the role may not use says "Also gives <Role>
// access", and pinning it grants the app in the same save. Every change saves at once,
// and the rail follows the saved order.
//
// A pin whose app was uninstalled, or that the role may no longer use, stays in
// the file and is ignored by the rail; its row is muted with the reason, and can
// still be moved or removed.
import type { KeyboardEvent } from 'react';
import { assert } from '../../../shared/core/assert';
import { APP_LIMITS, type AppSummary } from '../../../shared/properties/apps';
import { ROLE_LIMITS, can, roleView, type ProjectRole } from '../../../shared/properties/projectRoles';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import useListReorder from '../../ui/useListReorder';
import { DropLine } from '../../ui/DropLine';
import { Skeleton } from '../../ui/Skeleton';
import { CloseIcon, DragIcon, PinIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { RoleAppIcon, type InstalledApps } from './RoleAppPicker';
import { movedPin } from './rolesEdits';

export type PinnedAppChange = (appId: string, change: 'pin' | 'unpin') => void;
export type PinnedAppOrder = (appIds: readonly string[]) => void;

/** One pinned app as its row: the app when installed, and why the rail ignores it, if it does. */
export interface PinnedAppRow {
  readonly appId: string;
  readonly label: string;
  readonly app: AppSummary | undefined;
  readonly ignored: 'not-installed' | 'no-access' | undefined;
}

/** The role's pins in rail order, each with the reason the rail ignores it, if any. */
export function pinnedAppRows(role: ProjectRole, installed: readonly AppSummary[]): readonly PinnedAppRow[] {
  assert(installed.length <= APP_LIMITS.appsMax, 'Pinned rows: the installed list is bounded');
  assert(role.pinnedApps.length <= ROLE_LIMITS.pinnedAppsMax, 'Pinned rows: pins are bounded');
  const view = roleView(role);
  return role.pinnedApps.map((appId): PinnedAppRow => {
    const app = installed.find((candidate) => candidate.manifest.id === appId);
    if (app === undefined) {
      return { appId, label: appId, app, ignored: 'not-installed' };
    }
    return { appId, label: app.manifest.name, app, ignored: can(view, `app:${appId}`) ? undefined : 'no-access' };
  });
}

/** The installed apps the role may use and has not pinned: "Add app" pins these without granting anything. */
export function addablePinnedApps(role: ProjectRole, installed: readonly AppSummary[]): readonly AppSummary[] {
  assert(installed.length <= APP_LIMITS.appsMax, 'Addable pins: the installed list is bounded');
  const view = roleView(role);
  const addable = installed.filter((app) => !role.pinnedApps.includes(app.manifest.id) && can(view, `app:${app.manifest.id}`));
  assert(addable.length <= installed.length, 'Only installed apps are offered');
  return addable;
}

export function RolePinnedApps(props: {
  readonly role: ProjectRole;
  readonly installed: InstalledApps;
  readonly editable: boolean;
  readonly change: PinnedAppChange;
  readonly order: PinnedAppOrder;
}) {
  const { role, installed } = props;
  const translate = useTranslate();
  return (
    <div className="app-role-pins" role="group" aria-label={translate('settings.roles.pins.group', { name: role.name })}>
      <div className="app-role-section-heading">
        <PinIcon size={12} />
        <h4>{translate('settings.roles.pins.title')}</h4>
      </div>
      {installed.kind === 'loading' ? (
        <PinsSkeleton />
      ) : (
        <>
          <PinnedList role={role} rows={pinnedAppRows(role, installed.apps)} editable={props.editable} change={props.change} order={props.order} />
          {props.editable && <AddPin role={role} installed={installed.apps} change={props.change} />}
        </>
      )}
    </div>
  );
}

// Instant UI: the section's frame paints at once and the installed apps fill in as quiet shapes, never text.
function PinsSkeleton() {
  return (
    <div className="app-role-pins-skeleton" aria-hidden="true">
      <Skeleton width="120px" height="26px" radius="6px" />
      <Skeleton width="84px" height="26px" radius="6px" />
    </div>
  );
}

function PinnedList(props: {
  readonly role: ProjectRole;
  readonly rows: readonly PinnedAppRow[];
  readonly editable: boolean;
  readonly change: PinnedAppChange;
  readonly order: PinnedAppOrder;
}) {
  const { rows } = props;
  const translate = useTranslate();
  const pinned = rows.map((row) => row.appId);
  const move = (source: number, gap: number) => {
    const next = movedPin(pinned, source, gap);
    // A drop back in its own place changes nothing, so writes nothing.
    if (next.every((appId, index) => pinned[index] === appId)) {
      return;
    }
    props.order(next);
  };
  const reorder = useListReorder({ count: rows.length, onMove: move, disabled: !props.editable });
  // An empty list draws nothing: the "Add app" dropdown beside it already says what to do.
  if (rows.length === 0) {
    return undefined;
  }
  const ignoredText = (ignored: NonNullable<PinnedAppRow['ignored']>) =>
    translate(ignored === 'not-installed' ? 'settings.roles.pins.ignored.notInstalled' : 'settings.roles.pins.ignored.noAccess');
  // Alt+↑ moves the row up one place, Alt+↓ down one; the gap is measured before removal.
  const onKey = (index: number) => (event: KeyboardEvent<HTMLElement>) => {
    if (!props.editable || !event.altKey) {
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index > 0) {
        move(index, index - 1);
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (index < rows.length - 1) {
        move(index, index + 2);
      }
    }
  };
  // While a row is dragged, the gap it would land in: 0 before the first row, `rows.length` after the last.
  const lineGap = reorder.dragIndex === undefined ? undefined : reorder.dropIndex;
  assert(lineGap === undefined || lineGap <= rows.length, 'The drop gap is within the list');
  return (
    <ol className="app-role-pin-list" aria-label={translate('settings.roles.pins.list', { name: props.role.name })}>
      {rows.map((row, index) => (
        <li
          key={row.appId}
          {...reorder.rowProps(index)}
          tabIndex={0}
          aria-label={row.ignored === undefined ? row.label : translate('settings.roles.pins.rowIgnored', { app: row.label, reason: ignoredText(row.ignored) })}
          className={`app-role-pin ${row.ignored === undefined ? '' : 'is-ignored'} ${reorder.dragIndex === index ? 'is-dragging' : ''}`}
          onKeyDown={onKey(index)}
        >
          {/* The Navigator's line, in the gap above this row; after the last row, in the gap below it. */}
          {lineGap === index && <PinGap side="before" />}
          {lineGap === rows.length && index === rows.length - 1 && <PinGap side="after" />}
          {props.editable && (
            <button
              type="button"
              className="app-role-pin-grip"
              aria-label={translate('settings.roles.pins.drag', { app: row.label })}
              data-drag-through
              tabIndex={-1}
            >
              <DragIcon size={12} />
            </button>
          )}
          <RoleAppIcon app={row.app} />
          <span className="app-role-pin-name">{row.label}</span>
          {row.ignored !== undefined && <span className="app-role-pin-reason">{ignoredText(row.ignored)}</span>}
          {props.editable && (
            <button
              type="button"
              className="app-role-pin-remove"
              aria-label={translate('settings.roles.pins.unpin', { app: row.label })}
              onClick={() => props.change(row.appId, 'unpin')}
            >
              <CloseIcon size={10} />
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

// A zero-height strip centred in the gap between rows, holding the shared drop line,
// so drawing the line moves nothing and recolours no row.
function PinGap(props: { readonly side: 'before' | 'after' }) {
  return (
    <span className={`app-role-pin-gap is-${props.side}`}>
      <DropLine />
    </span>
  );
}

function AddPin(props: { readonly role: ProjectRole; readonly installed: readonly AppSummary[]; readonly change: PinnedAppChange }) {
  const { role } = props;
  const translate = useTranslate();
  if (props.installed.length === 0) {
    return <p className="app-role-pins-empty">{translate('settings.roles.pins.noneInstalled')}</p>;
  }
  // Every unpinned app is listed. Pinning one the role may not use also lets it use the
  // app, in the same save (setPinnedApp), so the row says so instead of refusing.
  const unpinned = props.installed.filter((app) => !role.pinnedApps.includes(app.manifest.id));
  if (unpinned.length === 0) {
    return undefined;
  }
  const addable = addablePinnedApps(role, props.installed);
  assert(addable.length <= unpinned.length, 'Addable apps are a subset of the unpinned ones');
  const full = role.pinnedApps.length >= ROLE_LIMITS.pinnedAppsMax;
  const options: readonly DropdownOption[] = unpinned.map((app) =>
    addable.includes(app)
      ? { value: app.manifest.id, label: app.manifest.name, icon: <RoleAppIcon app={app} /> }
      : {
          value: app.manifest.id,
          label: app.manifest.name,
          icon: <RoleAppIcon app={app} />,
          hint: translate('settings.roles.pins.alsoGives', { name: role.name }),
        },
  );
  return (
    <div className="app-role-pins-add">
      <Dropdown
        ariaLabel={translate('settings.roles.pins.addLabel', { name: role.name })}
        className="app-role-pins-dropdown"
        value=""
        placeholder={full ? translate('settings.roles.pins.full', { max: ROLE_LIMITS.pinnedAppsMax }) : translate('settings.roles.pins.add')}
        disabled={full}
        options={options}
        onChange={(appId) => props.change(appId, 'pin')}
      />
    </div>
  );
}
