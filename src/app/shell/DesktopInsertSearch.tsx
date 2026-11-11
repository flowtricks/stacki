// Desktop's insert palette: the shared palette (src/features/palette/InsertSearch.tsx) with the project's
// installed apps for its Apps tab (insertApps.ts, which Studio's palette shares).
import { useCallback } from 'react';
import type { ShellView } from '../App';
import InsertSearch from '../../features/palette/InsertSearch';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useInsertAppsSource, type InsertAppsNotify } from './insertApps';

export function DesktopInsertSearch({ app }: { readonly app: ShellView }) {
  const projectPath = app.project.path;
  const role = useCurrentRole();
  const setLeftTab = app.setLeftTab;
  const showToast = app.showToast;
  const browse = useCallback((): void => setLeftTab('apps'), [setLeftTab]);
  const notify = useCallback<InsertAppsNotify>((message, kind) => showToast(message, kind), [showToast]);
  const apps = useInsertAppsSource({ projectPath, role, browse, notify });
  return (
    <InsertSearch
      projectKey={projectPath}
      components={app.insertables}
      allowSlot={app.currentPage?.kind === 'component'}
      devUrl={app.devUrl}
      trailingSlash={app.trailingSlash}
      apps={apps}
      onInsert={app.insertItem}
      onClose={() => app.setInsertOpen(false)}
    />
  );
}
