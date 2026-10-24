import { isMobileEditor, useMobileEditor } from './mobileEditor';
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
import { useEffect, useState } from 'react';
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
import { getHost, setHost } from '../../vendor/stacki/src/features/style/model/host';
import { PreviewWorkspace, useInteractivePreview } from '../features/preview/InteractivePreview';
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
        setPanel((current) => (current === 'code' ? current : 'navigator'));
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
  if (session.paused) {
    return <PausedEditor resume={session.resume} />;
  }
  return (
    <CodeAccess.Provider value={props.view.role !== 'client'}>
      <div
        className="app studio-app"
        onKeyDown={interactivePreview.active ? (event) => event.stopPropagation() : undefined}
      >
        <EditorHeader
          closeDefaults={() => void defaultsCanvas.run('done')}
          defaultsMode={defaultsCanvas.state.kind !== 'idle'}
          {...props}
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
            panel={panel}
            toggle={(next) => {
              setPanel(next);
              setMobileSettings(false);
            }}
          />
          <Sidebar props={props} model={scopedModel} defaultsCanvas={defaultsCanvas} />
          <EditorContent
            props={props}
            model={scopedModel}
            mobileSettings={mobileSettings}
            setMobileSettings={setMobileSettings}
          />
        </PreviewWorkspace>
      </div>
    </CodeAccess.Provider>
  );
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
  const { device, setDevice, setPanel, setTab } = props.view;
  const mobile = useMobileEditor();
  const openInspector = (tab: 'settings' | 'style') => {
    setTab(tab);
    setMobileSettings(true);
    setPanel(undefined);
  };
  useStyleProject();
  return (
    <div className="studio-editor-content">
      <PreviewCanvas
        {...model}
        focusPath={props.focus?.path}
        device={device}
        onDevice={setDevice}
        dimensions={props.view.dimensions}
        file={props.file}
        projectName={props.project.name}
        inspector={
          mobile
            ? {
                settings: () => openInspector('settings'),
                style: props.view.role === 'client' ? undefined : () => openInspector('style'),
              }
            : undefined
        }
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
      {props.view.role !== 'client' && (
        <VariablesWorkspace props={props} document={model.document} />
      )}
      {props.view.role !== 'client' && <CodePopup editor={model.codeWindow} />}
      <QuickInsert
        key={props.file}
        model={model}
        project={props.project}
        enabled={
          !model.collection &&
          !(props.view.panel === 'collections' && props.view.cms) &&
          props.view.panel !== 'variables' &&
          !props.view.pick
        }
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
  const { tab, setTab } = props.view;
  const client = props.view.role === 'client';
  if (model.collection) {
    return null;
  }
  return (
    <aside
      aria-label="Element inspector"
      className={`studio-right ${visible ? 'mobile-open' : ''} ${client ? 'client-inspector' : ''}`}
    >
      <button className="mobile-close ghost" onClick={close} aria-label="Close settings">
        ×
      </button>
      <InspectorTabs client={client} tab={tab} setTab={setTab} />
      {!client && model.document && tab === 'style' && (
        <StyleSettings
          preview={model.preview.outlines}
          document={model.document}
          nodes={model.nodes}
          selected={model.selected}
          classes={props.project.classes}
          select={model.select}
          device={device}
          report={props.report}
        />
      )}
      {model.document && tab === 'settings' && (
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
      )}
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
  return (
    <>
      {' '}
      {client ? (
        <div className="right-tabs">Settings</div>
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
            Style
          </button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
        </div>
      )}
    </>
  );
}
function PausedEditor({ resume }: { resume: () => void }) {
  return (
    <div className="boot">
      <p>Studio paused to save hosting costs.</p>
      <p>Your saved draft is safe.</p>
      <button onClick={resume}>Resume editing</button>
    </div>
  );
}

function defaultsSelection(
  model: ReturnType<typeof useEditor>,
  canvas: ReturnType<typeof useStudioDefaultsCanvas>,
): ReturnType<typeof useEditor> {
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
