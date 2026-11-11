// Loads the project's roles for the signed-in Studio user and sets the shared
// role store (roleStore.ts). The server enforces the same resolution for every
// write (serverAccess.ts); this only decides what the UI shows.
//
// Resolution: a local Studio (no GitHub session) is admin. A GitHub user is the
// role naming them, else the file's default role (admin unless the file says
// otherwise, so every collaborator stays admin as before). No file is admin.
import { useEffect } from 'react';
import {
  ADMIN_ROLE_ID,
  ADMIN_VIEW,
  DEFAULT_PROJECT_ROLES,
  parseProjectRolesSource,
  resolveRole,
  roleViewOf,
  CLIENT_ROLE_ID,
} from '../../../vendor/stacki/shared/properties/projectRoles';
import type { Session } from '../auth/useSession';
import { readMetadata } from '../settings/metadataClient';
import { setStudioRoles } from './roleStore';

export function useStudioRoles(session: Session | undefined, revision: number, report: (error: unknown) => void): void {
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
          return;
        }
        try {
          const roles = parseProjectRolesSource(file.source);
          // A local Studio is the file's admin role, so admin's rail pins apply here too.
          setStudioRoles(roles, session.kind === 'github' ? resolveRole(roles, session.login, 'default') : roleViewOf(roles, ADMIN_ROLE_ID));
        } catch (error: unknown) {
          // The server refuses writes past a broken file as it would for Client; the UI says so.
          setStudioRoles(DEFAULT_PROJECT_ROLES, session.kind === 'github' ? roleViewOf(DEFAULT_PROJECT_ROLES, CLIENT_ROLE_ID) : ADMIN_VIEW);
          report(new Error(`The project's roles file could not be read: ${error instanceof Error ? error.message : String(error)}`));
        }
      },
      (error: unknown) => {
        if (active) {
          report(error);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [session, revision, report]);
}
