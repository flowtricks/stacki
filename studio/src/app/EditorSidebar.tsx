import { GitPanel } from '../features/history/GitPanel';
import type { useStudioDefaultsCanvas } from '../features/settings/useStudioDefaultsCanvas';
import { CmsNavigation } from '../features/cms/CmsWorkspace';
import { CodePanel } from '../features/code/CodePanel';
import { ComponentProperties } from '../features/componentProperties/ComponentProperties';
import { VariableNavigation } from '../features/variables/VariablesWorkspace';
import { Navigator } from '../features/navigator/Navigator';
import { PagesPanel } from '../features/pages/PagesPanel';
import { AssetsPanel } from '../features/assets/AssetsPanel';
import { ComponentsPanel } from '../features/components/ComponentsPanel';
import { ChatPanel } from '../features/ai/ChatPanel';
import type { EditorProps } from './Editor';
import type { useEditor } from '../features/project/useEditor';
import type { Panel } from './EditorRail';
interface SidebarProps {
  readonly panel: Panel;
  readonly defaultsCanvas: ReturnType<typeof useStudioDefaultsCanvas>;
  readonly close: () => void;
  readonly openCode: () => void;
  readonly showNavigator: () => void;
  readonly props: EditorProps;
  readonly model: ReturnType<typeof useEditor>;
}
export function EditorSidebar({ panel, close, props, model, openCode, showNavigator, defaultsCanvas }: SidebarProps) {
  const { project, file, open, refresh, report } = props;
  const { selected, document, openComponent } = model;
  return (
    <aside
      className={`studio-left ${panel === 'code' ? 'code-panel-shell' : ''}`}
      data-variable-selected={(panel === 'variables' && !!props.view.variable) || (panel === 'collections' && !!props.view.cms)}
    >
      <button className="mobile-close ghost" onClick={() => close()} aria-label="Close panel">
        ×
      </button>
      {panel === 'navigator' && <DefaultsNavigator props={props} model={model} defaultsCanvas={defaultsCanvas} openCode={openCode} />}
      {panel === 'collections' && <CmsNavigation props={props} />}
      {panel === 'pages' && (
        <PagesPanel
          flushSave={() => document?.whenSaved() ?? Promise.resolve()}
          project={project}
          peers={document?.peers ?? []}
          file={file}
          open={open}
          refresh={refresh}
          error={report}
          collection={false}
        />
      )}
      {panel === 'components' && <ComponentsSidebar props={props} model={model} showNavigator={showNavigator} />}
      {panel === 'assets' && (
        <AssetsPanel
          key={`${selected}:${props.view.pick?.current ?? ''}:${props.view.pick?.mediaKind ?? ''}`}
          project={project}
          refresh={refresh}
          error={report}
          pick={props.view.pick}
        />
      )}
      {panel === 'code' && <CodePanel {...model} openComponent={openComponent} />}
      {panel === 'properties' && document && !file.startsWith('src/pages/') && <ComponentProperties key={file} document={document} refresh={refresh} />}
      {panel === 'variables' && <VariableNavigation view={props.view} />}
      {panel === 'history' && <HistorySidebar props={props} model={model} />}
      {panel === 'ai' && <ChatPanel file={file} refresh={refresh} error={report} />}
    </aside>
  );
}
function ComponentsSidebar({ props, model, showNavigator }: Pick<SidebarProps, 'props' | 'model' | 'showNavigator'>) {
  return (
    <ComponentsPanel
      project={props.project}
      insert={model.insert}
      onDragBegin={showNavigator}
      nodes={model.nodes}
      report={props.report}
      select={(id) => {
        model.select(id);
        showNavigator();
      }}
      open={(file) => {
        props.open(file);
        showNavigator();
      }}
    />
  );
}

function DefaultsNavigator({ props, model, defaultsCanvas, openCode }: Pick<SidebarProps, 'props' | 'model' | 'defaultsCanvas' | 'openCode'>) {
  const { project, report } = props;
  const { selected, select, action, insert, document, openComponent } = model;
  return (
    <Navigator
      editRootId={defaultsCanvas.rootId}
      {...(defaultsCanvas.state.kind === 'idle'
        ? {
            setDefaults: (name: string, id: string) => {
              void defaultsCanvas.startForNode(name, id).catch(report);
            },
          }
        : {})}
      components={project.components}
      document={document}
      selected={selected}
      select={select}
      hover={model.hover}
      action={action}
      insert={insert}
      openCode={openCode}
      openCodeWindow={model.codeWindow.open}
      openComponent={openComponent}
      report={report}
    />
  );
}

function HistorySidebar({ props, model }: Pick<SidebarProps, 'props' | 'model'>) {
  return (
    <GitPanel
      project={props.project}
      report={props.report}
      flushSave={() => model.document?.whenSaved() ?? Promise.resolve()}
      refreshProject={async () => {
        await props.refresh();
      }}
    />
  );
}
