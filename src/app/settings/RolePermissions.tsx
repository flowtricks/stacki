// The collapsible permissions section of a non-admin role card: a disclosure row
// ("Permissions", "On 9 of 22" dim, a chevron at the end; the whole row is the button) that opens the access grid with a height animation.
// Collapsed by default, so a card reads as its name and members first. Whether a
// role's section is open is remembered for the window's session (sessionStorage,
// with an in-memory copy when storage is unavailable), keyed by project and role.
// The grid itself is passed in unchanged, so its markup can be restyled on its own.
import { useId, useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { ACCESS_GROUPS, APP_ACCESS_ALL, type ProjectRole } from '../../../shared/properties/projectRoles';
import { ChevronRightIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';

const STORAGE_PREFIX = 'stacki-role-permissions:';
type Disclosure = 'open' | 'closed';
const remembered = new Map<string, Disclosure>();

/** Granted and total switches: every grouped feature plus "Every app". */
export function permissionCounts(role: ProjectRole): { readonly granted: number; readonly total: number } {
  const features = ACCESS_GROUPS.flatMap((group) => group.features.map((item) => item.feature));
  const total = features.length + 1;
  const granted = features.filter((feature) => role.access.includes(feature)).length + (role.access.includes(APP_ACCESS_ALL) ? 1 : 0);
  assert(granted <= total, 'Role permissions: granted switches are among the listed ones');
  assert(total > 1, 'Role permissions: the grid lists features');
  return { granted, total };
}

export function RolePermissions(props: { readonly role: ProjectRole; readonly projectPath: string | undefined; readonly children: ReactNode }) {
  const key = `${STORAGE_PREFIX}${props.projectPath ?? ''}:${props.role.id}`;
  const [disclosure, setDisclosure] = useState<Disclosure>(() => readDisclosure(key));
  const open = disclosure === 'open';
  const bodyId = useId();
  const translate = useTranslate();
  const { granted, total } = permissionCounts(props.role);
  const toggle = () => {
    const next: Disclosure = open ? 'closed' : 'open';
    setDisclosure(next);
    writeDisclosure(key, next);
  };
  return (
    <div className="app-role-permissions" data-open={open ? 'true' : 'false'}>
      <button type="button" className="app-role-permissions-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        <span className="app-role-permissions-title">{translate('settings.roles.permissions.title')}</span>
        <span className="app-role-permissions-count">{translate('settings.roles.permissions.count', { granted, total })}</span>
        <ChevronRightIcon size={12} />
      </button>
      {/* The body stays mounted so the height can animate; collapsed, it is inert to focus and assistive tech. */}
      <div id={bodyId} className="app-role-permissions-body" {...(open ? {} : { inert: '', 'aria-hidden': true })}>
        <div className="app-role-permissions-inner">{props.children}</div>
      </div>
    </div>
  );
}

function readDisclosure(key: string): Disclosure {
  const known = remembered.get(key);
  if (known !== undefined) {
    return known;
  }
  try {
    return window.sessionStorage.getItem(key) === 'open' ? 'open' : 'closed';
  } catch {
    return 'closed';
  }
}

function writeDisclosure(key: string, disclosure: Disclosure): void {
  remembered.set(key, disclosure);
  try {
    window.sessionStorage.setItem(key, disclosure);
  } catch {
    // Storage can be blocked; the in-memory copy still holds for this window.
  }
}
