import { useTranslate } from '../../vendor/stacki/src/lib/i18n/useTranslate';
import { assert } from '../../vendor/stacki/shared/core/assert';
import { can } from '../../vendor/stacki/shared/properties/projectRoles';
import { dockedWidthPx, isMobileEditor, useEditorLayout, useEditorLayoutSync, useMobileEditor } from './mobileEditor';
import { CanvasContextMenu } from '../features/navigator/CanvasContextMenu';
import { pathFor } from '../features/project/previewSelection';
import { isCanvasPage } from '../../vendor/stacki/shared/properties/defaultsCanvas';
import { DefaultsCanvasBar } from '../../vendor/stacki/src/features/componentDefaults/DefaultsCanvasBar';
import { useStudioDefaultsCanvas } from '../features/settings/useStudioDefaultsCanvas';
import { CmsWorkspace } from '../features/cms/CmsWorkspace';
import { QuickInsert } from '../features/components/QuickInsert';
import type { Peer } from '../features/collaboration/presence';
import type { FollowTarget } from '../features/collaboration/useCollaborators';
import type { PreviewDevice } from '../../vendor/stacki/src/features/preview/PreviewToolbar';
import { StyleSettings } from '../features/settings/StyleSettings';
import { useIdleSession } from '../features/session/useIdleSession';
import { useCallback, useEffect, useState } from 'react';
import { prefetchPanels } from '../../vendor/stacki/src/app/shell/panelPrefetch';
import { routeFor } from '../features/project/projectClient';
import { pageForRoute } from '../features/pages/templateRoutes';
import { canvasRouteFor, chooseTemplateEntry } from '../features/pages/templateEntryStore';
import { pageAddressHost } from '../features/project/pageAddress';
import { canvasRoute, canvasRouteBase } from '../features/preview/canvasRoute';
import { livePageTitles, projectPageLabel } from '../features/project/pageLabels';
import type { Project } from '../features/project/projectClient';
import { useEditor } from '../features/project/useEditor';
import { EditorHeader } from '../features/project/EditorHeader';
import { SyncNotice } from '../features/github/SyncNotice';
import { PreviewCanvas } from '../features/preview/PreviewCanvas';
import { Settings } from '../features/settings/Settings';
import { EditorSidebar } from './EditorSidebar';
import { EditorRail } from './EditorRail';
import type { useEditorView } from './useEditorView';
import type { Session } from '../features/auth/useSession';
import type { ComponentFocus, OpenFile } from '../features/project/editorNavigation';
import { VariablesWorkspace } from '../features/variables/VariablesWorkspace';
import { CodePopup } from '../features/code/CodePopup';
import { CodeAccess } from '../../vendor/stacki/src/ui/CodeAccess';
import { KeptTabPanel } from '../../vendor/stacki/src/ui/KeptTabPanel';
import { getHost, setHost } from '../../vendor/stacki/src/features/style/model/host';
import { PreviewWorkspace, useInteractivePreview } from '../features/preview/InteractivePreview';
import { usePanelResize, usePanelWidths } from '../../vendor/stacki/src/app/shell/ResizablePanel';
import { PanelCloseButton } from './PanelCloseButton';
import { StudioAppsHost } from '../features/apps/StudioApps';
export interface EditorProps {
  readonly session: Session | undefined;
  readonly view: ReturnType<typeof useEditorView>;
  readonly project: Project;
  readonly follow: (peer: Peer) => void;
  readonly followTarget: FollowTarget | undefined;
  readonly file: string;
  readonly previewFile: string;
  readonly open: OpenFile;
  readonly focus: ComponentFocus | undefined;
  readonly refresh: () => void;
  readonly report: (problem: unknown) => void;
}

export function Editor(props: EditorProps) {
  const interactivePreview = useInteractivePreview(props);
  usePanelPrefetch(props.project.workspaceId ?? props.project.name);
  const { panel, setPanel } = props.view;
  const componentOpen = props.file.endsWith('.astro') && !isCanvasPage(props.file);
  useComponentPanel(componentOpen, setPanel);
  const [mobileSettings, setMobileSettings] = useState(false);
  const [canPause, setCanPause] = useState(false);
  const session = useIdleSession(canPause);
  const model = useEditor(
    props.project,
    props.file,
    props.report,
    () => {
      // Phone panels cover the canvas. Selection must not open an overlay.
      if (!isMobileEditor()) {
        // Code and Apps keep their panel: a running app reads the selection while visible.
        setPanel((current) => (current === 'code' || current === 'apps' ? current : 'navigator'));
      }
    },
    !session.paused,
    setCanPause,
    props.previewFile,
    props.open,
    props.followTarget,
    props.session,
    panel !== 'variables' && panel !== 'assets' && panel !== 'collections',
    props.focus,
  );
  const defaultsCanvas = useStudioDefaultsCanvas(props, model);
  const scopedModel = defaultsSelection(model, defaultsCanvas);
  const titledProps = editorTitleProps(props, model);
  const layout = useStudioLayout(panel, !model.collection, setMobileSettings);
  if (session.paused) {
    return <PausedEditor resume={session.resume} />;
  }
  return (
    <CodeAccess.Provider value={can(props.view.studioRole, 'code:edit')}>
      <div className="app studio-app" data-editor-layout={layout} onKeyDown={interactivePreview.active ? (event) => event.stopPropagation() : undefined}>
        <EditorHeader
          closeDefaults={() => void defaultsCanvas.run('done')}
          defaultsMode={defaultsCanvas.state.kind !== 'idle'}
          {...titledProps}
          document={model.document}
          interactivePreview={interactivePreview}
          cursorChat={cursorChatFor(model, props.view.device, interactivePreview)}
        />
        <DefaultsCanvasBar canvas={defaultsCanvas} />
        <CanvasContextMenu props={props} model={scopedModel} defaultsCanvas={defaultsCanvas} />
        <SyncNotice refresh={props.refresh} report={props.report} />
        <PreviewWorkspace preview={interactivePreview}>
          <EditorRail
            componentOpen={componentOpen}
            projectPath={props.project.name}
            panel={panel}
            toggle={(next) => {
              setPanel(next);
              setMobileSettings(false);
            }}
          />
          <Sidebar props={titledProps} model={scopedModel} defaultsCanvas={defaultsCanvas} />
          <EditorContent props={titledProps} model={scopedModel} mobileSettings={mobileSettings} setMobileSettings={setMobileSettings} />
          <StudioAppsHost props={titledProps} model={scopedModel} />
        </PreviewWorkspace>
      </div>
    </CodeAccess.Provider>
  );
}
function editorTitleProps(props: EditorProps, model: ReturnType<typeof useEditor>): EditorProps {
  return { ...props, project: livePageTitles(props.project, props.file, model) };
}

function cursorChatFor(
  model: ReturnType<typeof useEditor>,
  device: PreviewDevice,
  preview: ReturnType<typeof useInteractivePreview>,
): (() => void) | undefined {
  if (model.collection) {
    return undefined;
  }
  if (device === 'canvas') {
    return undefined;
  }
  if (preview.active) {
    return undefined;
  }
  return () => model.preview.send({ type: 'studio:cursor-chat' });
}

function Sidebar({
  props,
  model,
  defaultsCanvas,
}: {
  readonly props: EditorProps;
  readonly model: ReturnType<typeof useEditor>;
  readonly defaultsCanvas: ReturnType<typeof useStudioDefaultsCanvas>;
}) {
  const { panel, setPanel } = props.view;
  if (!panel) {
    return null;
  }
  return (
    <EditorSidebar
      panel={panel}
      defaultsCanvas={defaultsCanvas}
      props={props}
      model={model}
      showNavigator={() => setPanel('navigator')}
      openCode={() => setPanel('code')}
      close={() => setPanel(undefined)}
    />
  );
}

// Desktop's layout rule decides from the room the rail and the open panels take. The floating
// inspector closes when the editor docks, so it does not float open again at the next collapse.
function useStudioLayout(panel: EditorProps['view']['panel'], inspector: boolean, setMobileSettings: (visible: boolean) => void) {
  const widths = usePanelWidths();
  useEditorLayoutSync(dockedWidthPx({ panel, inspector, widths }));
  const layout = useEditorLayout();
  useEffect(() => {
    if (layout === 'docked') {
      setMobileSettings(false);
    }
  }, [layout, setMobileSettings]);
  return layout;
}

// Readies the panels after a project opens, as Desktop's shell does (panelPrefetch.ts): the
// Astro grammar and the variables, assets and CMS reads, under the key Studio's panels read
// the project by. Studio's panels are in its main bundle, so there are no chunks to fetch.
function usePanelPrefetch(projectKey: string) {
  useEffect(() => {
    assert(projectKey.length > 0, 'Editor: an open project has a key');
    return prefetchPanels({ projectPath: 'studio', preloadChunks: undefined, hostReads: [] });
  }, [projectKey]);
}

function useComponentPanel(componentOpen: boolean, setPanel: EditorProps['view']['setPanel']) {
  useEffect(() => {
    if (!componentOpen) {
      setPanel((current) => (current === 'properties' ? 'navigator' : current));
    }
  }, [componentOpen, setPanel]);
}
// Variable pickers read the project from the style panel's shared host. Set it here,
// with the project StyleSettings.tsx passes, so a picker opened before that panel
// still lists the project's variables.
function useStyleProject() {
  useEffect(() => {
    setHost({ ...getHost(), projectPath: 'studio' });
  }, []);
}
function EditorContent({
  props,
  model,
  mobileSettings,
  setMobileSettings,
}: {
  readonly props: EditorProps;
  readonly model: ReturnType<typeof useEditor>;
  readonly mobileSettings: boolean;
  readonly setMobileSettings: (visible: boolean) => void;
}) {
  const { device, setDevice, setPanel } = props.view;
  const translate = useTranslate();
  const mobile = useMobileEditor();
  const toggleInspector = () => {
    if (mobileSettings) {
      setMobileSettings(false);
    } else {
      setMobileSettings(true);
      setPanel(undefined);
    }
  };
  useStyleProject();
  const browseApps = useCallback(() => setPanel('apps'), [setPanel]);
  return (
    <div className="studio-editor-content">
      <PreviewCanvas
        {...model}
        openComponent={can(props.view.studioRole, 'component:edit') ? model.openComponent : undefined}
        focusPath={props.focus?.path}
        device={device}
        onDevice={setDevice}
        dimensions={props.view.dimensions}
        file={props.file}
        projectName={props.project.name}
        components={props.project.components}
        pageLabel={projectPageLabel(props.project, props.file, translate)}
        editRoute={(route) => editCanvasRoute(props, model, route)}
        sitePages={{
          base: canvasRouteBase(model.preview.url, canvasRouteFor(props.previewFile) ?? routeFor(props.previewFile)),
          routes: props.project.pages.map(routeFor),
        }}
        inspector={mobile ? { open: mobileSettings && !props.view.pick, toggle: toggleInspector } : undefined}
      />
      <Inspector
        props={props}
        model={model}
        openCode={() => model.codeWindow.open()}
        device={device}
        visible={mobileSettings && !props.view.pick}
        close={() => setMobileSettings(false)}
      />
      <CmsWorkspace props={props} document={model.document} />
      {can(props.view.studioRole, 'panel:variables') && <VariablesWorkspace props={props} document={model.document} />}
      {can(props.view.studioRole, 'code:edit') && <CodePopup editor={model.codeWindow} />}
      <QuickInsert
        key={props.file}
        model={model}
        project={props.project}
        enabled={!model.collection && !(props.view.panel === 'collections' && props.view.cms) && props.view.panel !== 'variables' && !props.view.pick}
        browseApps={browseApps}
        report={props.report}
      />
    </div>
  );
}
function Inspector({
  props,
  model,
  visible,
  device,
  close,
  openCode,
}: {
  props: EditorProps;
  model: ReturnType<typeof useEditor>;
  visible: boolean;
  device: PreviewDevice;
  openCode: () => void;
  close: () => void;
}) {
  const translate = useTranslate();
  const { tab, setTab } = props.view;
  // Without the Style panel the inspector shows Settings alone, as Client mode did.
  const client = !can(props.view.studioRole, 'panel:style');
  // Desktop's resize handle and stored width. Collapsed, the inspector floats at that width.
  const resize = usePanelResize('right');
  const mobile = useMobileEditor();
  if (model.collection) {
    return null;
  }
  if (client && !can(props.view.studioRole, 'panel:settings')) {
    return null;
  }
  return (
    <aside
      aria-label={translate('studio.inspector.label')}
      className={`studio-right ${visible ? 'mobile-open' : ''} ${client ? 'client-inspector' : ''}`}
      style={{ width: resize.width }}
    >
      {/* The close button shares the tab row, so it takes the tabs' height and centre. */}
      <div className="studio-inspector-head">
        <InspectorTabs client={client} tab={tab} setTab={setTab} />
        <PanelCloseButton label={translate('studio.inspector.close')} close={close} />
      </div>
      {!client && model.document && (
        <KeptTabPanel shown={tab === 'style'}>
          <StyleSettings
            preview={model.preview.outlines}
            document={model.document}
            nodes={model.nodes}
            selected={model.selected}
            classes={props.project.classes}
            lengthUnit={props.project.lengthUnit}
            select={model.select}
            device={device}
            report={props.report}
          />
        </KeptTabPanel>
      )}
      {model.document && (
        <KeptTabPanel shown={tab === 'settings'}>
          <Settings
            key={props.view.role}
            document={model.document}
            node={model.node}
            component={model.component}
            project={props.project}
            selected={model.selected}
            nodes={model.nodes}
            {...(client ? {} : { openCode })}
            error={props.report}
          />
        </KeptTabPanel>
      )}
      {!mobile && resize.handle}
    </aside>
  );
}
function InspectorTabs({
  client,
  tab,
  setTab,
}: {
  readonly client: boolean;
  readonly tab: 'style' | 'settings';
  readonly setTab: (tab: 'style' | 'settings') => void;
}) {
  const translate = useTranslate();
  return (
    <>
      {' '}
      {client ? (
        <div className="right-tabs">{translate('shell.rightTabs.settings')}</div>
      ) : (
        <div className="right-tabs">
          <span
            className="right-tabs-indicator"
            style={{
              left: tab === 'style' ? '10px' : 'calc(50% + 1px)',
              width: 'calc(50% - 11px)',
            }}
          />
          <button className={tab === 'style' ? 'on' : ''} onClick={() => setTab('style')}>
            {translate('shell.rightTabs.style')}
          </button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
            {translate('shell.rightTabs.settings')}
          </button>
        </div>
      )}
    </>
  );
}
function PausedEditor({ resume }: { resume: () => void }) {
  const translate = useTranslate();
  return (
    <div className="boot">
      <p>{translate('studio.paused.title')}</p>
      <p>{translate('studio.paused.body')}</p>
      <button onClick={resume}>{translate('studio.paused.resume')}</button>
    </div>
  );
}

function defaultsSelection(model: ReturnType<typeof useEditor>, canvas: ReturnType<typeof useStudioDefaultsCanvas>): ReturnType<typeof useEditor> {
  return {
    ...model,
    select: (id, occurrence) => {
      if (canvas.isOpen && canvas.state.kind !== 'idle') {
        const path = pathFor(id);
        const root = canvas.state.session.targetPath;
        if (path !== root && !path.startsWith(root + '.')) {
          return;
        }
      }
      model.select(id, occurrence);
    },
  };
}

function editCanvasRoute(props: EditorProps, model: ReturnType<typeof useEditor>, destination: string): void {
  // Under the static demo's base, the frame reports /demo/site/about for the project's /about.
  const route = canvasRoute(destination, model.preview.url, canvasRouteFor(props.previewFile) ?? routeFor(props.previewFile));
  // A route can be a template's entry (/docs/intro): that opens the template showing it.
  const page = pageForRoute(props.project.pages, route, routeFor);
  if (page) {
    if (page.entry !== undefined) {
      chooseTemplateEntry(page.file, page.entry);
    }
    props.open(page.file);
  } else if (pageAddressHost()?.leave(route) !== true) {
    // No host took the visitor to the route as the site serves it, so the canvas reloads its page.
    model.preview.retry();
  }
}
