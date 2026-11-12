import { useDesktopDefaultsCanvas } from './state/useDesktopDefaultsCanvas';
import { useCallback } from 'react';
import Settings from './settings/Settings';
import { useProjectRoles } from './roles/useProjectRoles';
import { type DynamicEntry, type ProjectIdentity } from './appTypes';
import { routeToPath } from './model/nodeFactory';
import { schemaFor } from './model/pageGestures';
import { useAppScope } from './state/appComposers';
import { WelcomeView, AppShell } from './shell/AppShell';
import { collectionReader } from '../editor/collectionReader';
import { canvasPageOf } from '../editor/pageState';
import { readPropsDestructure } from '../editor/loopProps';
import { readRestBinding } from '../editor/propDeclaration';
import { imagePropsOf, propKeysByLocal, type NewPropHost, type PropSettingsOffer } from '../features/props/newPropModel';
import PropertySettingsDialog from '../features/componentProperties/PropertySettingsDialog';
import PanelBoundary from '../ui/PanelBoundary';
import { shownPickerCollections } from './state/projectSources';

export default function App() {
  const scope = useAppScope();
  const actions = useUiActions(scope);
  const defaultsCanvas = useDesktopDefaultsCanvas(scope);
  // The project's role (.stacki/roles.json and the signed-in GitHub user) drives what the UI shows.
  useProjectRoles(scope.project?.path);
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
      />
    </>
  );
}

function AppContent({ app }: { readonly app: AppView }) {
  const { project } = app;
  if (!project) {
    return <WelcomeView app={app} />;
  }
  const route = canvasRouteOf(app);
  // The preview's callbacks read the canvas path when they run.
  const { livePathRef } = app;
  livePathRef.current = route.pageUrlPath;
  const shell: ShellView = { ...app, ...route, bindContext: bindContextOf(app, route), project };
  return <AppShell app={shell} />;
}

type AppScope = ReturnType<typeof useAppScope>;
export type AppView = AppScope &
  ReturnType<typeof useUiActions> & {
    readonly defaultsCanvas: ReturnType<typeof useDesktopDefaultsCanvas>;
  };
type CanvasRoute = ReturnType<typeof canvasRouteOf>;
export type ShellView = AppView &
  CanvasRoute & {
    readonly bindContext: ReturnType<typeof bindContextOf>;
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

// Where the canvas is pointed, and what the titlebar says about it.
function canvasRouteOf(app: AppView) {
  // The canvas always renders the page — editing a component just dims
  // everything outside the instance being worked on.
  const pageEntry = app.editStack[0] || app.currentPage;
  const patternRoute = pageEntry?.route;
  const component = app.currentPage?.kind === 'component' ? app.currentPage : undefined;
  const focusPath = app.defaultsCanvas.state.kind === 'idle' ? component?.focusPath : app.defaultsCanvas.state.session.targetPath;
  const focusOcc = component ? (component.focusOcc ?? 0) : 0;
  // The focus routes clicks either way; this says whether it also draws.
  const focusWhole = !!component?.focusWhole;
  // A dynamic page's route is a pattern, not a URL — /posts/[slug] is a 404.
  // Preview one of the entries it actually stands for; `dynamicEntry` is which.
  const dynamicEntry = app.dynamicPaths[app.dynamicIndex] || undefined;
  // With no page selected and none to select — a project whose routes all come
  // from an integration, before one is picked — the dev server is still serving
  // a site. Show its root rather than an empty canvas: something running should
  // look like it is running.
  const rootFallback = !patternRoute && !app.scan.pages.length && app.devStatus === 'on' ? '/' : undefined;
  const pageRoute = dynamicEntry ? dynamicEntry.route : patternRoute || rootFallback;
  const pageUrlPath = pageRoute ? routeToPath(pageRoute, app.trailingSlash) : undefined;
  const liveUrl = app.devUrl && pageUrlPath ? app.devUrl + pageUrlPath : undefined;
  // The old version is served by its own dev server, on the same route the
  // editor is on, so switching in and out is a like-for-like comparison.
  const oldVersionUrl = app.previewInfo && pageUrlPath ? app.previewInfo.url + pageUrlPath : undefined;
  const openPath = app.currentPage?.path;
  const currentScanPage = openPath === undefined ? undefined : app.scan.pages.find((page) => page.path === openPath);
  const repository = app.gitInfo?.isRepo ? app.gitInfo : undefined;
  return {
    patternRoute,
    focusPath,
    focusOcc,
    focusWhole,
    dynamicEntry,
    pageUrlPath,
    liveUrl,
    oldVersionUrl,
    currentScanPage,
    repository,
  };
}

// What the binding picker shows: the names in scope, plus the DATA behind
// them wherever the app can see it. Two sources, and between them a designer
// gets real values rather than a list of identifiers:
//   the entry on the canvas — getStaticPaths' props ARE Astro.props for a
//     dynamic route, so `post.data.title` shows this post's actual title
//   this file's own `interface Props` — no values, but every prop still says
//     what it is, which is all a component outside a page can offer.
function bindContextOf(app: AppView, route: CanvasRoute) {
  const { dynamicEntry } = route;
  const editedEntry = app.insertables.find((component) => {
    return component.path === app.currentPage?.path;
  });
  return (
    app.loopContext && {
      ...app.loopContext,
      // Which collection a value lists, however the page reshapes it, so a
      // builder export's loop item shows its fields (collectionReader.ts).
      collectionReader,
      // Which item of a loop's list the picker reads the item's values as. A loop
      // hands `service` one entry of `times`, and the picker showed the first one
      // forever — so the fields under it were one service's, and the others could
      // only be taken on trust. Keyed by the item's own name, so two loops on a
      // page are two places.
      itemIndex: app.itemIndex,
      onStepItem: (name: string, step: number, count: number) =>
        app.setItemIndex((current) => ({
          ...current,
          [name]: ((((current[name] ?? 0) + step) % count) + count) % count,
        })),
      // A component's frontmatter is not the page's, so the page's entry is not
      // its data. What it does have is the instance it was opened from, whose
      // props are its Astro.props — the values it is rendering with right now.
      propsSample: app.currentPage?.kind === 'component' ? app.instanceProps : dynamicEntry?.props || undefined,
      // Edited from an instance: what it passes, so a prop it leaves out reads its default or "not set".
      ...(app.currentPage?.kind === 'component' && app.instancePassed !== undefined ? { propsInstance: { passed: app.instancePassed } } : {}),
      propsSchema: schemaFor(editedEntry),
      collectionSamples: app.collectionSamples,
      // The render's own values win: they are what the canvas is showing.
      valueSamples: {
        ...valueSamplesOf(app.valueSamples, app.currentPage?.path),
        ...valueSamplesOf(app.scopeSamples, app.currentPage?.path),
      },
      // What the file's imports hold, read from their modules: `APP_VERSION`
      // from src/consts.ts is a value to bind to, not a missing field.
      importedValues: app.importedValues,
      // The project's collections and data file exports the file does not read
      // yet, less what Settings → Folders leaves out of the picker: picking from
      // one writes its query or import, then binds (projectSources.ts).
      collections: shownPickerCollections(app.collections, app.projectSources.config),
      projectSources: app.projectSources.nodes,
      projectModules: app.projectSources.imported,
      // Opening a collection in the picker asks for one entry of it; nothing is
      // fetched for collections nobody looks at.
      onNeedSample: app.requestCollectionSample,
      // Picking from a collection this page doesn't read yet writes the query
      // that fetches it, and answers with the name it ended up under.
      ensureQuery: app.ensureCollectionQuery,
      ensureImport: app.ensureDataImport,
      entryNav: entryNavOf(app, dynamicEntry),
      // Which file a binding is written into, and the page a component is shown
      // on: the picker heads each group of rows by where its data lives, so a
      // component's own props never read as the page's.
      origin: { file: app.currentPage?.path, page: canvasPageOf(app.editStack) },
      // In a component (or layout), the picker offers the component's own
      // props fitted to the field, and a new prop made for it.
      newProp: newPropHostOf(app, editedEntry),
    }
  );
}

function newPropHostOf(
  app: AppView,
  entry: { readonly name: string; readonly schema?: readonly { readonly name: string }[] | undefined } | undefined,
): NewPropHost | undefined {
  const page = app.currentPage;
  if (page?.kind !== 'component' || app.model === undefined) {
    return undefined;
  }
  const frontmatter = app.model.extraFrontmatter;
  const entries = readPropsDestructure(frontmatter)?.entries ?? [];
  const declared = (entry?.schema ?? []).map((prop) => prop.name);
  const keys = new Set([...entries.map((prop) => prop.key), ...declared]);
  const projectPath = app.project?.path;
  const restLocal = readRestBinding(frontmatter)?.local;
  return {
    componentName: page.path.split(/[\\/]/).pop() ?? page.path,
    propKeys: [...keys],
    restLocal,
    create: app.createBoundProp,
    imageProps: imagePropsOf(frontmatter),
    projectPath,
    fileDirectory: projectDirectoryOf(projectPath, page.path),
    propSettings: projectPath === undefined ? undefined : propSettingsOf(app, projectPath, page.path, propKeysByLocal(entries, declared, restLocal)),
  };
}

// A picker row's way to its prop's settings, saved as the Properties panel saves.
function propSettingsOf(app: AppView, projectPath: string, file: string, keys: ReadonlyMap<string, string>): PropSettingsOffer {
  const saver = {
    projectPath,
    file,
    flushSave: app.flushSave,
    changePhase: app.propertySave.changePhase,
    recordUndo: app.recordPropertyUndo,
    completeSave: app.completePropertySave,
    openFile: (rel: string) => void app.openProjectFile(rel),
  };
  return {
    keyOf: (path) => keys.get(path),
    render: (key, onClose) => <PropertySettingsDialog propertyKey={key} saver={saver} onClose={onClose} />,
  };
}

// The folder a file is in, relative to the project (`src/components`), or
// undefined for a file outside it.
function projectDirectoryOf(projectPath: string | undefined, filePath: string): string | undefined {
  if (projectPath === undefined) {
    return undefined;
  }
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = filePath.replace(/\\/g, '/');
  // A path is the project's own when it is under its folder, or already relative to it.
  const absolute = file.startsWith('/') || /^[A-Za-z]:\//.test(file);
  if (absolute && !file.startsWith(`${root}/`)) {
    return undefined;
  }
  const relative = absolute ? file.slice(root.length + 1) : file;
  const slash = relative.lastIndexOf('/');
  return slash < 0 ? '' : relative.slice(0, slash);
}

// Stepping through a dynamic route's entries from inside the picker. It is the SAME
// index the canvas renders against, so moving it previews the page against other
// content and re-reads the sample values at once — which is the point: you are
// checking a layout against real data, not one post.
function entryNavOf(app: AppView, dynamicEntry: DynamicEntry | undefined) {
  const count = app.dynamicPaths.length;
  if (count <= 1) {
    return undefined;
  }
  return {
    index: app.dynamicIndex,
    count,
    label: dynamicEntry?.label || '',
    onStep: (step: number) => app.setDynamicIndex((i) => (i + step + count) % count),
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

// The open file's own value samples, by value name: the store keys them by
// file too, so two files' `pastors` never answer for each other.
function valueSamplesOf(samples: Readonly<Record<string, unknown>>, file: string | undefined): Record<string, unknown> {
  const prefix = `${file ?? ''}|`;
  return Object.fromEntries(
    Object.entries(samples)
      .filter(([key]) => file !== undefined && key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]),
  );
}
