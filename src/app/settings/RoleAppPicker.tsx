// The apps installed in this project for the Roles tab (`apps:list`, through the Apps
// bridge Studio replaces with its own client), and an app's icon there. With no way to
// ask (no open project, a main that predates Apps), the list reads as none installed.
import { useEffect, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { APP_LIMITS, type AppSummary } from '../../../shared/properties/apps';
import { appFrameURL, listApps } from '../../ipc/appsBridge';
import { AppsIcon } from '../../ui/Icons';

export type InstalledApps = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly apps: readonly AppSummary[] };

/** The project's installed apps, read once per project; any failure reads as none installed. */
export function useInstalledApps(projectPath: string | undefined): InstalledApps {
  const [installed, setInstalled] = useState<{ readonly projectPath: string | undefined; readonly apps: readonly AppSummary[] } | undefined>(undefined);
  useEffect(() => {
    if (projectPath === undefined) {
      return undefined;
    }
    let lifetime: 'active' | 'disposed' = 'active';
    const settle = (apps: readonly AppSummary[]) => {
      if (lifetime === 'active') {
        assert(apps.length <= APP_LIMITS.appsMax, 'Role apps: the installed list is bounded');
        setInstalled({ projectPath, apps });
      }
    };
    void listApps(projectPath).then(
      (answer) => settle(answer.ok ? answer.value : []),
      () => settle([]),
    );
    return () => {
      lifetime = 'disposed';
    };
  }, [projectPath]);
  if (projectPath === undefined) {
    return { kind: 'ready', apps: [] };
  }
  if (installed === undefined || installed.projectPath !== projectPath) {
    return { kind: 'loading' };
  }
  return { kind: 'ready', apps: installed.apps };
}

/** An app's own icon, or the generic apps mark when it has none or the icon fails to load. */
export function RoleAppIcon(props: { readonly app: AppSummary | undefined }) {
  const [failed, setFailed] = useState(false);
  const icon = props.app?.manifest.icon;
  if (props.app === undefined || icon === undefined || failed) {
    return <AppsIcon size={14} className="app-role-app-icon" />;
  }
  return <img className="app-role-app-icon" src={appFrameURL(props.app.manifest.id, icon)} alt="" width={14} height={14} onError={() => setFailed(true)} />;
}
