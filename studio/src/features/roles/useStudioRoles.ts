// Loads the project's roles for the signed-in Studio user and sets the shared
// role store (roleStore.ts). The server enforces the same resolution for every
// write (serverAccess.ts); this only decides what the UI shows.
//
// Resolution: a local Studio (no GitHub session) is admin. A GitHub user is the
// role naming them, else the file's default role (admin unless the file says
// otherwise, so every collaborator stays admin as before). No file is admin.
import { useEffect, useState } from 'react';
import { lockedClientRole } from './editorRoutes';
import {
  ADMIN_ROLE_ID,
  ADMIN_VIEW,
  DEFAULT_PROJECT_ROLES,
  parseProjectRolesSource,
  resolveRole,
  roleViewOf,
  CLIENT_ROLE_ID,
  type ProjectRoles,
  type RoleView,
} from '../../../vendor/stacki/shared/properties/projectRoles';
import type { Session } from '../auth/useSession';
import { readMetadata } from '../settings/metadataClient';
import { setStudioRoles } from './roleStore';

/**
 * Whether the person's role has been read. The editor waits for it, so a panel the
 * role does not have is never drawn, not even for a moment.
 */
export function useStudioRoles(session: Session | undefined, revision: number, report: (error: unknown) => void): 'loading' | 'ready' {
  const [state, setState] = useState<'loading' | 'ready'>('loading');
  useEffect(() => {
    if (session === undefined) {
      return undefined;
    }
    let active = true;
    void readMetadata('studio', 'roles').then(
      (file) => {
        if (!active) {
          return;
        }
        if (file.source === undefined) {
          setStudioRoles(DEFAULT_PROJECT_ROLES, ADMIN_VIEW);
          setState('ready');
          return;
        }
        try {
          const roles = parseProjectRolesSource(file.source);
          // A local Studio is the file's admin role, so admin's rail pins apply here too.
          setStudioRoles(roles, hostedRole(roles, session));
        } catch (error: unknown) {
          // The server refuses writes past a broken file as it would for Client; the UI says so.
          const fallback = lockedClientRole(file.source) ?? roleViewOf(DEFAULT_PROJECT_ROLES, CLIENT_ROLE_ID);
          setStudioRoles(DEFAULT_PROJECT_ROLES, session.kind === 'local' ? ADMIN_VIEW : fallback);
          report(new Error(`The project's roles file could not be read: ${error instanceof Error ? error.message : String(error)}`));
        }
        setState('ready');
      },
      (error: unknown) => {
        if (active) {
          report(error);
          // The role could not be asked for. A hosted person may have a restricted one, so the editor does not
          // open on guesses: the next project load asks again.
          if (session.kind === 'local') {
            setState('ready');
          }
        }
      },
    );
    return () => {
      active = false;
    };
  }, [session, revision, report]);
  return state;
}

// The role the server will apply to this person (serverAccess.ts), shown so the interface matches it. A person signed
// in by another provider is matched on their provider-qualified identity and the aliases core vouched for.
function hostedRole(roles: ProjectRoles, session: Session): RoleView {
  switch (session.kind) {
    case 'github':
      return resolveRole(roles, session.login, 'default');
    case 'account':
      return resolveRole(roles, session.identity, 'default', session.aliases);
    case 'local':
      return roleViewOf(roles, ADMIN_ROLE_ID);
    default: {
      const exhaustive: never = session;
      return exhaustive;
    }
  }
}
