import { useDesktopDefaultsCanvas } from './state/useDesktopDefaultsCanvas';
import { useCallback } from 'react';
import Settings from './settings/LazySettings';
import { useProjectRoles } from './roles/useProjectRoles';
import { type ProjectIdentity } from './appTypes';
import { useAppScope } from './state/appComposers';
import { lazy, Suspense, useState } from 'react';
import { loadShell, loadedShell } from './shell/lazyShell';
import type { BindContext, CanvasRoute } from './shell/ProjectWindow';
import { useBootSnapshotWriter } from './boot/useBootSnapshotWriter';
import { WelcomeView } from './shell/WelcomeView';
import PanelBoundary from '../ui/PanelBoundary';

// The project window (the editor shell and everything only it needs) loads behind the start screen
// (lazyShell.ts). A window that opens a project awaits it before its first render (src/main.tsx), so the first
// frame is the real shell; a project opened from the start screen before the chunk has arrived stays on the
// start screen, which is real, until it does. No skeleton or placeholder stands in for the shell.
const ProjectWindow = lazy(() => loadShell());

export default function App() {
  const scope = useAppScope();
  const actions = useUiActions(scope);
  const defaultsCanvas = useDesktopDefaultsCanvas(scope);
  // The project's role (.stacki/roles.json and the signed-in GitHub user) drives what the UI shows.
  useProjectRoles(scope.project?.path);
  // Keeps the next session's first frame real (src/app/boot): the page list, the open page and the left panel.
  useBootSnapshotWriter({ project: scope.project, scan: scope.scan, pageName: scope.currentPage?.name, leftTab: scope.leftTab });
  const app: AppView = {
    ...scope,
    ...actions,
    defaultsCanvas,
    setSelectedId: defaultsSelection(scope, defaultsCanvas),
  };
  return (
    <>
      <PanelBoundary name="Stacki" resetKey={app.project?.path}>
        <AppContent app={app} />
      </PanelBoundary>
      <Settings
        projectPath={app.project?.path}
        previewURL={app.devStatus === 'on' ? app.devUrl : undefined}
        pages={{ folder: app.scan.pagesFolder ?? 'src/pages', configFile: app.scan.astroConfig }}
        onOpenFile={(rel) => void app.openProjectFile(rel)}
        onRecordUndo={app.pushCommand}
      />
    </>
  );
}

function AppContent({ app }: { readonly app: AppView }) {
  const { project } = app;
  if (!project) {
    return <WelcomeView app={app} />;
  }
  return <ShellHost app={app} project={project} />;
}

// Chosen once per project open: a shell whose chunk has loaded renders directly, in the first frame; one that has
// not stays on the start screen until it arrives. Switching between the two later would remount the shell and
// lose its state, so the choice is made when this mounts.
function ShellHost({ app, project }: { readonly app: AppView; readonly project: ProjectIdentity }) {
  const [Ready] = useState(() => loadedShell()?.default);
  if (Ready !== undefined) {
    return <Ready app={app} project={project} />;
  }
  return (
    <Suspense fallback={<WelcomeView app={app} />}>
      <ProjectWindow app={app} project={project} />
    </Suspense>
  );
}

type AppScope = ReturnType<typeof useAppScope>;
export type AppView = AppScope &
  ReturnType<typeof useUiActions> & {
    readonly defaultsCanvas: ReturnType<typeof useDesktopDefaultsCanvas>;
  };
export type ShellView = AppView &
  CanvasRoute & {
    readonly bindContext: BindContext;
    readonly project: ProjectIdentity;
  };

// A void callback over an async action, for props typed to return nothing: the child
// never reads the promise, so a failure the action did not handle itself is reported.
function useVoidAction<Args extends readonly unknown[]>(
  report: (error: unknown) => void,
  action: (...args: Args) => Promise<unknown>,
): (...args: Args) => void {
  return useCallback(
    (...args: Args) => {
      void action(...args).catch(report);
    },
    [report, action],
  );
}

// The async actions the panels call as plain callbacks, each as stable as the action.
function useUiActions(scope: AppScope) {
  const { reportFailure: report } = scope;
  const onOpenProject = useVoidAction(report, scope.loadProject);
  const onSelectPage = useVoidAction(report, scope.selectPage);
  const onSelectRoute = useVoidAction(report, scope.selectRoute);
  const onCreatePage = useVoidAction(report, scope.createPage);
  const onDeletePage = useVoidAction(report, scope.deletePage);
  const onMovePage = useVoidAction(report, scope.movePageTo);
  const onRenamePageFolder = useVoidAction(report, scope.renamePageFolder);
  const onDeletePageFolder = useVoidAction(report, scope.deletePageFolder);
  const onChangeLayout = useVoidAction(report, scope.changeLayout);
  const onDropComponent = useVoidAction(report, scope.addComponent);
  const onPasteNode = useVoidAction(report, scope.pasteNode);
  const onCodeChange = useVoidAction(report, scope.changeCodeSource);
  const onCreateComponent = useVoidAction(report, scope.createComponentFromSelection);
  const onPreviewCommit = useVoidAction(report, scope.previewCommit);
  const onExitCommitPreview = useVoidAction(report, scope.exitCommitPreview);
  const onOpenAssetFile = useVoidAction(report, scope.openAssetFile);
  const onOpenSymbol = useVoidAction(report, scope.openSymbolFile);
  return {
    onOpenProject,
    onSelectPage,
    onSelectRoute,
    onCreatePage,
    onDeletePage,
    onMovePage,
    onRenamePageFolder,
    onDeletePageFolder,
    onChangeLayout,
    onDropComponent,
    onPasteNode,
    onCodeChange,
    onCreateComponent,
    onPreviewCommit,
    onExitCommitPreview,
    onOpenAssetFile,
    onOpenSymbol,
  };
}

function defaultsSelection(scope: AppScope, canvas: AppView['defaultsCanvas']): AppScope['setSelectedId'] {
  return (input) => {
    const id = typeof input === 'function' ? input(scope.selectedId) : input;
    if (canvas.isOpen && canvas.state.kind !== 'idle') {
      const path = scope.pathFor(id);
      const root = canvas.state.session.targetPath;
      if (path !== root && !path?.startsWith(root + '.')) {
        return;
      }
    }
    scope.setSelectedId(id);
  };
}
