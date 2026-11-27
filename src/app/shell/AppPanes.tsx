import { projectRelativePath } from '../../lib/projectPath';
import { DEFAULT_SLOT_FIELD } from '../../../shared/properties/componentDefaults';
import { useCodeIntel } from '../../features/codeIntel/useCodeIntel';
import { InspectorTabButton } from './InspectorTabButton';
import { assetScopeOf, shownAssetSource } from '../../editor/richAssetImports';
import { innerSourceOf } from '../../features/props/richTextContent';
import { sourceRangeForSelection } from '../../features/code/codePanelModel';
import { FilesCover } from './DesktopFiles';
import { useFormat, useTranslate, useTranslateRich } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../lib/i18n/localeContext';
import { desktopCanvasText } from './desktopCanvasText';
import { RemoteCmsView } from '../../features/cms/RemoteCmsView';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type React from 'react';
import { pageComponentFiles } from '../model/componentReference';
import { COMPONENT_SOURCES_MAX } from '../../features/style/model/componentSourceCache';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { canPanel } from '../../lib/roleAccess';
import { can } from '../../../shared/properties/projectRoles';
import { ResizablePanel } from './ResizablePanel';
import { ElementContextMenu } from '../../features/structure/ElementContextMenu';
import type { ContextPosition } from '../../features/structure/StructureContextMenu';
import type { ContextPoint } from '../../features/preview/contextPosition';
import { desktopElementActions } from './desktopElementActions';
// The canvas and the right panel: the canvas pane and its covers, selecting
// or opening a canvas path, the right tabs with the style tab and the
// settings handlers, the code window's host, the conflict notice, and the
// busy overlay and toast (App.tsx).

import type { Attr } from '../../../shared/page/pageNode';
import { parsePseudoLayerTarget, type PseudoLayerTarget } from '../../../shared/page/pseudoElements';
import { noteText } from '../../editor/treeSelection';
import { canvasClickAction } from '../../editor/canvasClick';
import { leftTabAfterCanvasSelection } from '../model/canvasSelectionTab';
import { canvasLandingFor, dynamicEntryIndexOf } from '../model/previewPage';
import PreviewPane from '../../features/preview/PreviewPane';
import SaveConflictNotice from '../SaveConflictNotice';
import { nodeAtPath } from '../../editor/editorTree';
import type { AssetReference, PickedAsset } from '../../ui/AssetField';
import type { InlineNode } from '../../features/props/RichContent';
import type { TextPiece } from '../../features/props/textConnect';
import type { Rename } from '../../features/props/propNodeEditors';
import type { PropValues } from '../../features/props/propRules';
import type { LoopApplyResult } from '../../features/props/LoopSettings';
import type { LoopTarget } from '../../editor/loopQueryPlan';
import type { PropDeclaration } from '../../editor/propDeclaration';
import { canvasPageOf, findEditorNodeById as findNodeById } from '../../editor/pageState';
import { rawContentsMatch } from '../model/pageModelGestures';
import { type EditorNode } from '../../editor/pageView';
import { useLiveValue } from '../../ui/liveValue';
import { openAppSettings } from '../settings/LazySettings';
import { PropsPanel, StylePanel, CodeWindow, CmsView, ContentView, VariablesView, InstructionsView } from '../appPanels';
import CmsFileFields from '../../features/cms/CmsFileFields';
import { selectInstruction, useInstructionSelection } from '../../features/instructions/instructionSelection';
import { holdsInlineText, commentAbove, schemaFor, trailOf, withClassField } from '../model/pageGestures';
import type { ShellView } from '../App';
import { editLoopProperty, type LoopPropertyEdit } from '../state/loopPropertyEdit';
import { assert } from '../../../shared/core/assert';
import { useListProps } from '../state/useListProps';
import PanelBoundary from '../../ui/PanelBoundary';
import { KeptTabPanel } from '../../ui/KeptTabPanel';
import { PropPreviewContext } from '../../features/props/propPreviewContext';
import { propPreviewInstance, useDesktopPropPreview } from './desktopPropPreview';
import type { PseudoLayer } from '../../../shared/page/pseudoPath';
import { selectedPseudo } from '../model/selectionStructure';
import { appOverlayLayer, useAppOverlayPaths } from './DesktopApps';
import { usePinCanvas } from './DesktopPins';
import { useCanvasDrag } from '../state/appCanvasDrag';
import { useCanvasImagePopup } from './desktopCanvasImage';
import { ImagePropFields } from '../../features/props/ImagePropFields';
import { NavigatorDropLine, navigatorDropPaths } from '../../features/preview/CanvasDropOverlay';
import { navigatorDropShown, subscribeCanvasDrag } from '../../editor/canvasDragSession';
import { codeChipTextOf, useCodeChips } from '../../features/style/codeChips/CodeChips';
import { pressWasForEditor, type CanvasPress } from '../../features/preview/canvasEditorPress';
import {
  canvasBoxOf,
  canvasInstanceAt,
  canvasRootPath,
  isComponentCanvasPage,
  useComponentCanvas,
} from '../../features/preview/componentCanvas/componentCanvasSession';
import { PropFieldExtrasContext } from '../../features/props/propFieldExtras';
import { useCanvasInstanceSettings, type CanvasInstanceSettings } from './canvasFrameSettings';
import { desktopGuideSubject } from '../../features/preview/guideSettings';
import { CanvasSectionHeading } from '../../features/preview/componentCanvas/CanvasScopeControl';
import type { PropsPanelProps } from '../../features/props/propsPanelTypes';
import { installCssFieldChips } from '../../ui/cssFieldChips';

// The Settings panel's CSS fields (the style prop) draw the code editors' chips.
installCssFieldChips(useCodeChips);

// One function for the life of the app: the Style panel publishes its host on every render, and a
// new arrow each time would wake every host subscriber (StylePanel.tsx useStableList says why).
const openStyleTagSettings = (): void => openAppSettings('styles');
export function CanvasPane({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const hoverNodeId = useLiveValue(app.hoverNode);
  const hoverPseudo = useLiveValue(app.hoverPseudo);
  const context = useCanvasContextMenu(app);
  const image = useCanvasImagePopup(app, (fieldNames) => <CanvasImageFields app={app} fieldNames={fieldNames} />);
  const appOverlayPaths = useAppOverlayPaths(app);
  const onCanvasDrag = useCanvasDrag(app);
  // A drag over the Navigator is drawn on the canvas too: the frame measures the mark's parent and neighbours.
  const navigatorDrop = useSyncExternalStore(subscribeCanvasDrag, navigatorDropShown);
  const dropPaths = navigatorDropPaths(navigatorDrop, (id) => app.pathFor(id));
  const dropKey = dropPaths.join('\n');
  // Comment pins (DesktopPins.tsx): the elements pins sit on are measured too, and their markers drawn over the canvas.
  const pins = usePinCanvas(app);
  const pinPaths = pins.trackPaths;
  const trackPaths = useMemo(() => [...appOverlayPaths, ...pinPaths, ...(dropKey === '' ? [] : dropKey.split('\n'))], [appOverlayPaths, pinPaths, dropKey]);
  const appOverlays = appOverlayLayer(app);
  const guideSubject = useGuideSubject(app);
  return (
    <>
      <PreviewPane
        guideSubject={guideSubject}
        extraTrackPaths={trackPaths}
        overlayLayer={(frame) => (
          <>
            <NavigatorDropLine rects={frame.rects} scale={frame.scale} pathOf={(id) => app.pathFor(id)} />
            {appOverlays(frame)}
            {pins.overlay(frame)}
          </>
        )}
        textDocument={desktopCanvasText(app, translate)}
        spacingHover={app.spacingHover}
        devUrl={app.devUrl}
        devStatus={app.devStatus}
        coveredByBusyOverlay={!!app.busy}
        devLog={app.devLog}
        devDiag={app.devDiag}
        route={app.pageUrlPath}
        pageRoutes={app.scan.pages.map((page) => page.route)}
        onEditRoute={(route) => followCanvasRoute(app, route)}
        refreshKey={app.refreshKey}
        crumbs={app.crumbs}
        onCrumb={(id) => app.setSelectedId(id)}
        onRefresh={() => app.setRefreshKey((count) => count + 1)}
        onPreviewLoaded={app.previewLoaded}
        onRestart={() => {
          // Starting the dev server reports its own failure in the preview area.
          void app.startPreview(app.project.path);
        }}
        pathScope={app.editedRel ? `${app.editedRel}|` : ''}
        selPath={app.pathFor(app.selectedId)}
        navigatorSelectionTick={app.navigatorSelectionTick}
        unhidePath={app.revealedId !== undefined && app.revealedId === app.selectedId ? app.pathFor(app.selectedId) : undefined}
        navHoverPath={app.pathFor(hoverNodeId)}
        navHoverPseudo={hoverPseudo}
        selPseudo={selectedPseudo(app.selectedId, app.pseudoPick)}
        overlayInfo={app.overlayInfo}
        focusPath={app.focusPath}
        focusOcc={app.focusOcc}
        openedOcc={app.openedOcc}
        focusWhole={app.focusWhole}
        device={app.device}
        onDevice={app.setDevice}
        dimensions={app.previewDimensions}
        canvasWidthRequest={app.canvasWidthRequest}
        onViewportWidth={app.setCanvasWidthPx}
        projectPath={app.project.path}
        judgeEvent={app.judgeEvent}
        onCanvasNotice={app.onCanvasNotice}
        onPreviewReload={app.onPreviewReload}
        onContextPath={context.open}
        onSelectPath={(path, info) => selectCanvasPath(app, path ?? undefined, info)}
        {...(atCanvasPage(app) ? { canvasPathOf: canvasPageNodePath, canvasWholePath: canvasRootPath() } : {})}
        onSelectedClasses={app.receiveClasses}
        onRenderedPaths={app.setRenderedPaths}
        onNodeStates={app.setNodeStates}
        onNodeClasses={app.setNodeClasses}
        onOpenPath={(path, occurrence) => openCanvasPath(app, path ?? undefined, occurrence)}
        onEditImage={image.open}
        onCloseImage={image.close}
        onCanvasDrag={onCanvasDrag}
      />
      {context.menu}
      {image.popup}
      {pins.bar}
    </>
  );
}

function useGuideSubject(app: ShellView) {
  const componentCanvas = useComponentCanvas();
  return desktopGuideSubject({
    openFile: app.currentPage,
    componentCanvas: componentCanvas?.state.kind,
    defaultsCanvas: app.defaultsCanvas.state.kind === 'idle' ? 'idle' : 'shown',
  });
}

// The image popup's fields: the Properties panel's own editors for the selected node, only the ones named.
function CanvasImageFields({ app, fieldNames }: { readonly app: ShellView; readonly fieldNames: readonly string[] }) {
  const translate = useTranslate();
  const node = app.selectedNode;
  if (node?.kind !== 'element' && node?.kind !== 'component') {
    return undefined;
  }
  return <ImagePropFields {...settingsValues(app)} {...settingsHandlers(app, translate)} node={node} fieldNames={fieldNames} />;
}

// Where a right-click on the canvas landed, and the ::before or ::after it landed on.
type CanvasContextPoint = ContextPoint & { readonly outside: boolean; readonly pseudo: PseudoLayer | undefined };

function useCanvasContextMenu(app: ShellView) {
  const [position, setPosition] = useState<ContextPosition & { readonly generation: number }>();
  const file = app.openEditableFile?.path;
  const source = app.pageState?.source;
  useEffect(() => setPosition(undefined), [file, source, app.device, app.refreshKey]);
  useEffect(() => {
    if (position?.nodeId !== app.selectedId) {
      setPosition(undefined);
    }
  }, [position, app.selectedId]);
  return {
    open: (path: string | undefined, point: CanvasContextPoint) => {
      const next = canvasContextPosition(app, path, point);
      // Each request remounts the popup so an earlier dismissal cannot close its replacement.
      setPosition(
        (previous) =>
          next && {
            ...next,
            generation: previous ? 1 - previous.generation : 0,
          },
      );
    },
    menu:
      position && app.pageState?.editable && position.nodeId === app.selectedId ? (
        <ElementContextMenu
          key={position.generation}
          {...desktopElementActions(app)}
          nodes={app.pageState.model.nodes}
          position={position}
          onClose={() => setPosition(undefined)}
        />
      ) : undefined,
  };
}

function canvasContextPosition(app: ShellView, framePath: string | undefined, point: CanvasContextPoint): ContextPosition | undefined {
  // On the component canvas's page a right click names what a click there selects: a frame's instance, or the root.
  const path = framePath !== undefined && atCanvasPage(app) ? canvasPageNodePath(framePath) : framePath;
  const action = canvasClickAction({
    path,
    outside: point.outside,
    focusPath: app.focusPath,
    scope: app.editedRel ? `${app.editedRel}|` : '',
    ownedRoot: defaultsRootPath(app),
  });
  if (action.kind === 'close' || action.kind === 'nothing' || !app.pageState?.editable) {
    return undefined;
  }
  const nodes = app.pageState.model.nodes;
  const node = action.kind === 'layout' ? findNodeById(nodes, 'layout') : path ? nodeAtPath(nodes, trailOf(path)) : undefined;
  if (!node) {
    return undefined;
  }
  selectCanvasPath(app, path, point);
  return { ...point, nodeId: node.id };
}

// On the component canvas's page, the node a canvas path stands for: a box (a frame's or a group's) itself, a frame's
// instance for anything inside it, the page's root (<html>) for the space between boxes; a path in another file's
// namespace is left as it is.
function canvasPageNodePath(path: string): string {
  if (path.includes('|') || canvasBoxOf(path) !== undefined) {
    return path;
  }
  const instance = canvasInstanceAt(path);
  return instance !== undefined && (path === instance.path || path.startsWith(instance.path + '.')) ? instance.path : (canvasRootPath() ?? path);
}

// Whether the open file is the component canvas's page itself, not an instance opened inside it.
function atCanvasPage(app: ShellView): boolean {
  return isComponentCanvasPage(app.currentPage?.path) && app.editStack.length <= 1;
}

// The instance the component defaults page edits, while that page is the open file; undefined anywhere else.
function defaultsRootPath(app: ShellView): string | undefined {
  const canvas = app.defaultsCanvas;
  return canvas.isOpen && canvas.state.kind !== 'idle' ? canvas.state.session.targetPath : undefined;
}

// What a click on the canvas MEANT — see canvasClick.js. The canvas answers with a
// path or with nothing, and nothing has two causes that want opposite things: a click
// the open file doesn't own, and a click on something inside it the canvas couldn't
// name.
export function selectCanvasPath(
  app: ShellView,
  path: string | undefined,
  info:
    | {
        readonly outside: boolean;
        readonly pseudo?: PseudoLayer | undefined;
        readonly occurrence?: number;
        readonly copies?: number | undefined;
        readonly iterations?: readonly { readonly path: string; readonly index: number }[] | undefined;
        readonly press?: CanvasPress | undefined;
      }
    | undefined,
): void {
  const reveal = (node: EditorNode | undefined) => {
    if (!node) {
      return;
    }
    app.setSelectedId(node.id);
    // The copy clicked, for the data picker's loop items (editor/loopSelection.ts).
    app.setCanvasCopy(
      info?.occurrence === undefined ? undefined : { nodeId: node.id, occurrence: info.occurrence, copies: info.copies, iterations: info.iterations },
    );
    // A click on a ::before or ::after picks it as its navigator row does; a
    // click on the element itself puts down whatever pseudo-element was held.
    // Only an HTML element owns one (shared/page/pseudoElements.ts): a click the
    // canvas read as a loop's or an instance's ::before selects the node itself.
    const target = info?.pseudo === undefined ? undefined : parsePseudoLayerTarget(node, info.pseudo);
    if (target?.ok === true) {
      pickPseudo(app, target.value);
    } else {
      app.setPseudoPick(undefined);
    }
    // Code and Apps stay open (see leftTabAfterCanvasSelection); every
    // other panel gives way to the navigator so the selected row is visible.
    app.setLeftTab(leftTabAfterCanvasSelection);
    app.setRevealTick((count) => count + 1);
  };
  if (atCanvasPage(app)) {
    // On the component canvas's own page a box (a frame's or a group's) is selected as the div it is; a click inside an
    // instance selects the instance, closed; a click between boxes selects the canvas itself, its root.
    const target = path === undefined ? canvasRootPath() : canvasPageNodePath(path);
    reveal(target === undefined || app.model === undefined ? undefined : nodeAtPath(app.model.nodes, trailOf(target)));
    return;
  }
  const { kind } = canvasClickAction({
    path: path ?? undefined,
    outside: !!info?.outside,
    focusPath: app.focusPath,
    scope: app.editedRel ? `${app.editedRel}|` : '',
    ownedRoot: defaultsRootPath(app),
  });
  if (kind === 'nothing') {
    return;
  }
  if (kind === 'close') {
    if (app.defaultsCanvas.state.kind !== 'idle') {
      // Close defaults' own path: it saves first, and a refused save keeps the editor open and says why. A press
      // that only closed a menu, or landed on one of the editor's tags, is not a press on the dimmed page.
      if (!pressWasForEditor(info?.press)) {
        void app.defaultsCanvas.run('done');
      }
    } else {
      // Opening the parent file reports its own failures.
      void app.closeComponent();
    }
    return;
  }
  const { model } = app;
  if (kind === 'layout') {
    reveal(model && findNodeById(model.nodes, 'layout'));
    return;
  }
  reveal(model && path ? nodeAtPath(model.nodes, trailOf(path)) : undefined);
}

/**
 * Picks the ::before or ::after of the node `id` (already selected by the
 * caller): the Style panel is asked for that pseudo-element's selector, and
 * the count makes a repeat of the same pick a new ask. Shared by the
 * navigator's pseudo rows and canvas clicks, so both pick the same way.
 * The right panel stays on its tab, as selecting any element does: the Style
 * panel reads the pick when it is next shown (usePseudoRequest).
 */
export function pickPseudo(app: Pick<ShellView, 'setPseudoPick'>, target: PseudoLayerTarget): void {
  assert(target.nodeId.length > 0, 'pickPseudo: a pseudo-element belongs to a node');
  app.setPseudoPick((held) => {
    const serial = (held?.serial ?? 0) + 1;
    assert(Number.isSafeInteger(serial), 'pickPseudo: the pick count stays an integer');
    return { nodeId: target.nodeId, pseudo: target.pseudo, serial };
  });
}

// Double-clicking a component on the canvas drills into it. With no path the click
// landed on chrome the layout renders itself (nav, footer) — that markup belongs to
// the layout, so open the layout, matching what a single click there selects.
export function openCanvasPath(app: ShellView, path: string | undefined, occurrence: number): void {
  if (atCanvasPage(app)) {
    // A double click anywhere in a component canvas frame goes inside its instance, as on its navigator row.
    const instance = canvasInstanceAt(path);
    const node = instance === undefined || app.model === undefined ? undefined : nodeAtPath(app.model.nodes, trailOf(instance.path));
    if (instance !== undefined && node?.kind === 'component') {
      void app.openComponent(node.name, instance.path, 0).catch(app.reportFailure);
    }
    return;
  }
  const root = defaultsRootPath(app);
  if (root !== undefined && canvasClickAction({ path, ownedRoot: root }).kind !== 'select') {
    return; // On the dimmed page the first click of a double click has already closed the editor: nothing opens.
  }
  if (!path) {
    if (app.layoutNode?.name) {
      void app.openComponent(app.layoutNode.name, app.pathFor('layout')).catch(app.reportFailure);
    }
    return;
  }
  const node = app.model && nodeAtPath(app.model.nodes, trailOf(path));
  if (!node) {
    return;
  }
  // Astro built-ins have no project component file to open.
  if (node.kind === 'component' && !node.astroAsset && node.name !== 'Fragment') {
    void app.openComponent(node.name, path, occurrence).catch(app.reportFailure);
    return;
  }
  // Nothing to drill into. But a double-click on a paragraph asks
  // to edit its words — that's what the gesture means everywhere
  // else — so it goes where the words are: Settings, caret in
  // Content. Only where that field exists; on a wrapper full of
  // elements the double-click has nothing to offer and does
  // nothing, rather than opening a panel to say so.
  if (holdsInlineText(node)) {
    app.setRightTab('settings');
    app.setContentFocus((count) => count + 1);
  }
}

// The CMS edits content, not layout — it covers the canvas rather than replacing it,
// so the preview keeps its loaded page.
export function CanvasCovers({ app }: { readonly app: ShellView }) {
  return (
    <>
      <InstructionsCover app={app} />
      <FilesCover app={app} />
      {app.varsGroup && (
        <VariablesView
          key={app.project.path}
          project={app.project}
          selected={app.varsGroup}
          hidden={app.leftTab !== 'variables'}
          showToast={app.showToast}
          onRecordUndo={app.pushCommand}
          onClose={() => app.setVarsGroup(undefined)}
          onDock={() => app.setLeftTab('variables')}
        />
      )}
      {app.contentName && (
        <ContentView
          project={app.project}
          name={app.contentName}
          hidden={app.leftTab !== 'cms'}
          showToast={app.showToast}
          onSaved={() => app.setCmsTick((count) => count + 1)}
          onClose={() => app.setContentName(undefined)}
        />
      )}
      {app.cmsRel && (
        <CmsView
          project={app.project}
          rel={app.cmsRel}
          hidden={app.leftTab !== 'cms'}
          settings={app.cmsSettings}
          showToast={app.showToast}
          onRecordUndo={app.pushCommand}
          onSaved={() => app.setCmsTick((count) => count + 1)}
          onCloseSettings={() => app.setCmsSettings(false)}
          onDeleted={() => {
            app.setCmsRel(undefined);
            app.setCmsSettings(false);
          }}
          onClose={() => app.setCmsRel(undefined)}
        />
      )}
      {app.cmsFileSettings && (
        <CmsFileFields
          key={app.cmsFileSettings.fileRel}
          projectPath={app.project.path}
          fileRel={app.cmsFileSettings.fileRel}
          label={app.cmsFileSettings.label}
          hidden={app.leftTab !== 'cms'}
          currentPage={app.openFileSourceRel}
          onClose={() => app.setCmsFileSettings(undefined)}
          onRecordUndo={app.pushCommand}
          showToast={app.showToast}
        />
      )}
      {app.cmsRemote && (
        <RemoteCmsView
          key={`${app.cmsRemote.connection.id}:${app.cmsRemote.collection}`}
          projectPath={app.project.path}
          selection={app.cmsRemote}
          hidden={app.leftTab !== 'cms'}
          onSelect={app.setCmsRemote}
        />
      )}
    </>
  );
}

// The open Instructions file of the Settings panel, over the canvas. Hidden, not unmounted, while
// another panel is shown, so unsaved typing and the caret survive a look elsewhere.
function InstructionsCover({ app }: { readonly app: ShellView }) {
  const file = useInstructionSelection(app.project.path);
  const role = useCurrentRole();
  if (file === undefined || !canPanel(role, 'instructions')) {
    return undefined;
  }
  return (
    <InstructionsView
      key={file}
      projectPath={app.project.path}
      file={file}
      editable={can(role, 'instructions:edit')}
      hidden={app.leftTab !== 'projectSettings'}
      onClose={() => selectInstruction(undefined)}
    />
  );
}

// An old version covers the canvas rather than replacing what it points at. The
// editing canvas draws outlines from the model, and the model is read from the files
// on disk — which are the CURRENT ones. Pointed at an old server it would draw this
// version's boxes over that version's page: every outline in the wrong place, and every
// click editing a file that isn't what's on screen. An overlay cannot do that, because
// there is nothing to click.
export function OldVersionCover({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const translateRich = useTranslateRich();
  const { formatRelativeTime } = useFormat();
  const { oldVersionUrl, previewInfo } = app;
  if (!oldVersionUrl || !previewInfo) {
    return undefined;
  }
  return (
    <div className="preview-mode old-version">
      <div className="preview-banner">
        <span className="preview-banner-text">
          {translateRich('shell.oldVersion.banner', {
            subject: <strong>{previewInfo.subject}</strong>,
            when: Number.isFinite(Date.parse(previewInfo.when ?? '')) ? formatRelativeTime(Date.parse(previewInfo.when ?? ''), Date.now()) : '',
          })}
        </span>
        <button className="preview-banner-exit" onClick={app.onExitCommitPreview}>
          {translate('shell.oldVersion.backToNow')}
        </button>
      </div>
      <iframe src={oldVersionUrl} title={translate('shell.oldVersion.frameTitle')} />
    </div>
  );
}

const RIGHT_TABS = [
  { id: 'style', labelKey: 'shell.rightTabs.style' },
  { id: 'settings', labelKey: 'shell.rightTabs.settings' },
] as const satisfies readonly { readonly id: string; readonly labelKey: MessageKey }[];

export function RightPanel({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  // Hovering a component prop's option previews it on the canvas without writing.
  const propPreview = useDesktopPropPreview(
    propPreviewInstance(app.selectedComponent?.path, app.project.path ?? undefined, app.selectedId ? app.pathFor(app.selectedId) : undefined),
  );
  // A tab the project's role hides moves the panel to the one it shows; with neither, no panel.
  const role = useCurrentRole();
  const visible = RIGHT_TABS.filter((tab) => canPanel(role, tab.id));
  const fallback = visible.some((tab) => tab.id === app.rightTab) ? undefined : visible[0]?.id;
  const { setRightTab } = app;
  // A component canvas frame's instance: its props are that frame's preview values (canvasFrameSettings.tsx).
  const componentCanvas = useComponentCanvas();
  const canvasInstance = useCanvasInstanceSettings(app, componentCanvas);
  // A box or a group on the component canvas shows its frame's instance, as if the instance were selected.
  const canvasComponent = componentCanvas?.state.kind === 'open' && canvasInstance?.kind === 'instance' ? componentCanvas.state.component.file : undefined;
  const scanComponent =
    canvasComponent === undefined ? undefined : app.scan.components.find((entry) => entry.path.replaceAll('\\', '/').endsWith('/' + canvasComponent));
  const canvasListProps = useListProps(app.project.path, scanComponent?.path);
  const settingsApp: ShellView =
    canvasInstance?.kind === 'instance' && app.selectedNode?.id !== canvasInstance.node.id && scanComponent !== undefined
      ? { ...app, selectedNode: canvasInstance.node, selectedComponent: scanComponent, selectedSchema: schemaFor(scanComponent), listProps: canvasListProps }
      : app;
  useEffect(() => {
    if (fallback !== undefined) {
      setRightTab(fallback);
    }
  }, [fallback, setRightTab]);
  if (visible.length === 0) {
    return undefined;
  }
  return (
    <ResizablePanel kind="right">
      <RightTabs app={app} />
      <KeptTabPanel shown={app.rightTab === 'style'}>
        <PanelBoundary name="The Style panel" label={translate('shell.rightTabs.stylePanel')} resetKey={app.selectedId}>
          <StyleTab app={app} />
        </PanelBoundary>
      </KeptTabPanel>
      <KeptTabPanel shown={app.rightTab === 'settings'}>
        {canvasInstance?.kind === 'instance' && componentCanvas?.state.kind === 'open' && (
          <div className="component-canvas-props-scope">
            <CanvasSectionHeading
              canvas={componentCanvas}
              state={componentCanvas.state}
              section="props"
              title={translate('componentCanvas.panel.scope.label')}
            />
          </div>
        )}
        <PropPreviewContext.Provider value={propPreview}>
          <PropFieldExtrasContext.Provider value={canvasInstance === undefined ? undefined : canvasInstance.extras}>
            <PanelBoundary name="The Settings panel" label={translate('shell.rightTabs.settingsPanel')} resetKey={app.selectedId}>
              <PropsPanel {...settingsOf(settingsApp, translate, canvasInstance)} />
            </PanelBoundary>
          </PropFieldExtrasContext.Provider>
        </PropPreviewContext.Provider>
      </KeptTabPanel>
    </ResizablePanel>
  );
}

export function RightTabs({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const role = useCurrentRole();
  const tabs = RIGHT_TABS.filter((tab) => canPanel(role, tab.id));
  const stripRef = useRef<HTMLDivElement>(null);
  const indicator = useTabIndicator(stripRef, app.rightTab, tabs.length);
  return (
    <div className="right-tabs" ref={stripRef}>
      {indicator && <span className="right-tabs-indicator" style={indicator} />}
      {tabs.map((tab) => (
        <InspectorTabButton key={tab.id} tab={tab.id} label={translate(tab.labelKey)} active={app.rightTab === tab.id} select={app.setRightTab} />
      ))}
    </div>
  );
}

type TabIndicator = { readonly left: number; readonly width: number };

// Positions the Style/Settings highlight: on tab change, when the strip first appears,
// and whenever the strip's width changes. The state is local to the strip, so a resize
// of the inspector (a measure each frame of the drag) re-renders the strip alone, not
// the editor; an unchanged measure keeps the previous object and renders nothing.
function useTabIndicator(stripRef: React.RefObject<HTMLDivElement>, tab: string, tabCount: number): TabIndicator | undefined {
  const [indicator, setIndicator] = useState<TabIndicator | undefined>(undefined);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    assert(strip !== null, 'The tab strip is mounted before it is measured');
    const measure = (): void => {
      const button = [...strip.querySelectorAll<HTMLElement>('[data-right-tab]')].find((candidate) => candidate.dataset['rightTab'] === tab);
      const next = button === undefined ? undefined : { left: button.offsetLeft, width: button.offsetWidth };
      setIndicator((previous) => (sameIndicator(previous, next) ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [stripRef, tab, tabCount]);
  return indicator;
}

function sameIndicator(previous: TabIndicator | undefined, next: TabIndicator | undefined): boolean {
  if (previous === undefined || next === undefined) {
    return previous === next;
  }
  return previous.left === next.left && previous.width === next.width;
}

export function StyleTab({ app }: { readonly app: ShellView }) {
  const { selectedId } = app;
  const pageFile = app.editStack[app.editStack.length - 1]?.path || app.currentPage?.path || undefined;
  // Each component the page uses, read as it loads (StylePanel): the first instance
  // picked is then drawn in its settled chip colours rather than blue, then green.
  const renderedClassesKnown = useRenderedClassesKnown(selectedId, { reported: app.classesForRef.current === selectedId });
  const pageComponentPaths = useMemo(
    () =>
      pageComponentFiles(
        app.model?.nodes ?? [],
        { project: app.project.path, file: pageFile, imports: app.model?.imports ?? [], components: app.insertables },
        COMPONENT_SOURCES_MAX,
      ),
    [app.model, app.project.path, pageFile, app.insertables],
  );
  return (
    <StylePanel
      project={app.project}
      lengthUnit={app.scan.lengthUnit}
      model={app.model}
      node={app.selectedNode}
      device={app.device}
      onWriteStyleNode={({ nodeId, filePath }, css, immediate) => {
        // Editing a component: a <style> block of the PAGE is not in
        // the model this writes into, and mutating nothing would look
        // like a save. Report it instead — the panel holds the edit
        // and writes it when the component closes. The file is checked
        // before the node: ids are tree paths, so the page's block and
        // the component's block can share one.
        if (filePath !== app.openEditableFile?.path) {
          return false;
        }
        const state = app.pageStateRef.current.pageState;
        const node = state?.editable ? findNodeById(state.model.nodes, nodeId) : undefined;
        if (node === undefined) {
          return false;
        }
        // A pick commits what its hover preview may already have saved. Main refuses an
        // edit that changes nothing, and that refusal read as an editor error.
        if (rawContentsMatch(node, css)) {
          return true;
        }
        app.setNodeText(nodeId, css, undefined, immediate || 'live');
        return true;
      }}
      onSelectNode={app.setSelectedId}
      onCanvasWidth={app.requestCanvasWidth}
      canvasWidthPx={app.canvasWidthPx}
      onDesktopCanvas={app.showDesktopCanvas}
      onRecordUndo={app.pushCommand}
      onOpenStyleTagSettings={openStyleTagSettings}
      // Each write names the element the panel showed when it was made (StylePanel
      // useShownElementWrites), so a write in flight does not follow a new selection.
      onAddClass={(name, placement, nodeId) => app.addClassToNode(nodeId, name, placement, app.pathFor(nodeId))}
      onAddStyleBlock={(request, nodeId) => app.addStyleBlock(nodeId, request, app.pathFor(nodeId))}
      onRemoveClass={(name, nodeId) => app.removeClassFromNode(nodeId, name, app.pathFor(nodeId))}
      onRemoveAttribute={(name, nodeId) => app.removeAttributeFromNode(nodeId, name)}
      onSetInlineStyle={(nodeId, style) => {
        // The Settings style field's own write (desktopAppHost.ts setStyle): one
        // declaration edit when the attribute stays a plain string.
        app.setProp(nodeId, 'style', style, true);
      }}
      pageComponentPaths={pageComponentPaths}
      onSpacingHover={app.setSpacingHover}
      pathOf={app.pathFor}
      renderedClasses={app.classesForRef.current === selectedId ? app.selectedClasses : []}
      renderedClassesKnown={renderedClassesKnown}
      projectClasses={app.projectClasses}
      historyTick={app.historyTick}
      pseudoRequest={app.pseudoPick}
      pseudoRows
      selectorFocus={app.classFocus}
      openFilePath={app.openEditableFile?.path ?? undefined}
      openFileKind={app.openEditableFile?.kind ?? undefined}
      contextPagePath={canvasPageOf(app.editStack)}
      selectedComponentPath={app.selectedComponentFile}
    />
  );
}

// How long the chips wait, neutral, for the canvas to report what the selection
// renders. Matches the app's own fallback to no classes (appPageOps.ts): an element
// the page does not render never reports, and its chips settle when this runs out.
const RENDERED_CLASSES_WAIT_MS = 600;

// Whether the selection's rendered classes are known: reported, or waited for long enough.
function useRenderedClassesKnown(selectedId: string | undefined, report: { readonly reported: boolean }): boolean {
  const { reported } = report;
  const [gaveUpFor, setGaveUpFor] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (reported) {
      return undefined;
    }
    const timer = setTimeout(() => setGaveUpFor(selectedId), RENDERED_CLASSES_WAIT_MS);
    return () => clearTimeout(timer);
  }, [selectedId, reported]);
  if (reported) {
    return true;
  }
  return gaveUpFor === selectedId;
}

// The selected element's content as the file holds it, for the rich text field and its code view.
function selectedContentSource(app: ShellView): string | undefined {
  const source = app.pageState?.source;
  const range = source === undefined ? undefined : sourceRangeForSelection(app.model, app.selectedId, source.length);
  return source === undefined || range === undefined ? undefined : innerSourceOf(source.slice(range.from, range.to));
}

// The same content as the rich text editor reads it: imported images and videos as their paths.
function shownContentSource(app: ShellView): string | undefined {
  const source = selectedContentSource(app);
  const model = app.pageState?.editable ? app.pageState.model : undefined;
  const file = app.currentPage?.path;
  if (source === undefined || model === undefined || file === undefined || !('imports' in model)) {
    return source;
  }
  return shownAssetSource(source, assetScopeOf(projectRelativePath(app.project.path, file, window.avb.platform), model.imports));
}

// The Settings tab's values and handlers. A component canvas frame's instance is the ordinary panel over the frame's
// preview values (canvasFrameSettings.tsx): its values, its fields' defaults and every writer are the frame's. Its tag,
// free attributes and comment are the generated canvas page's, which is never edited, so they are not offered; nothing
// on that page is in scope, so there is no data to connect to.
function settingsOf(app: ShellView, translate: Translator, canvasInstance: CanvasInstanceSettings | undefined): PropsPanelProps {
  const values = settingsValues(app);
  const handlers = settingsHandlers(app, translate);
  const { onChangeTag, onSetComment, ...kept } = handlers;
  const node = values.node;
  if (canvasInstance?.kind === 'root' && node?.kind === 'element') {
    // The canvas root: its class list is the canvas's own setting, the one field the root has.
    return {
      ...values,
      ...kept,
      // No class attribute where no class is set: an empty one would mark the label set (blue) with nothing in it.
      node: {
        ...node,
        props: canvasInstance.value === undefined ? {} : { class: { type: 'string' as const, value: canvasInstance.value } },
        attrOrder: canvasInstance.value === undefined ? [] : ['class'],
        children: [],
      },
      // The page's own <html>, never a layout: no layout picker, no tag.
      isLayout: false,
      // Its one field, there whether or not a class is set, as an element's class field is.
      schema: withClassField([]),
      onSetProp: canvasInstance.onSetProp,
      // However the class field writes its list (one prop, a patch, or the whole attribute list), it is the root's classes.
      onSetProps: (_nodeId: string, patch: PropValues) => canvasInstance.onSetProp('class', patch['class']),
      onReplaceProps: (_nodeId: string, props: Readonly<Record<string, Attr>>) => canvasInstance.onSetProp('class', props['class']),
      takesSlotText: false,
      allowAttrs: false,
      richTextContent: false,
    };
  }
  if (canvasInstance?.kind !== 'instance') {
    return { ...values, ...kept, onChangeTag, onSetComment };
  }
  // The frame's instance, whether it, its box or a group around it is the selection.
  const instance = canvasInstance.node;
  assert(instance.kind === 'component', 'A canvas frame shows its instance');
  const { id, props, ...frame } = canvasInstance.panel;
  // The writers of a page's own code, loops and expressions have nothing to write to on a frame.
  const general = withoutPageWriters(kept);
  return {
    ...values,
    ...general,
    ...frame,
    valuePolicy: 'preview' as const,
    node: { ...instance, id, props, attrOrder: Object.keys(props), children: undefined },
    allowAttrs: false,
    comment: '',
    bindContext: undefined,
    loopContext: undefined,
    frontmatterImports: undefined,
    onRenameProp: () => undefined,
    onSetContent: () => undefined,
    onSetText: () => undefined,
    onSetTextPieces: undefined,
    onRenameVariable: undefined,
    onCommitLoopHead: undefined,
  };
}

const PAGE_WRITERS = ['onSetFrontmatter', 'onEditLoopProperty', 'onSetLoopSource'] as const;

function withoutPageWriters<T extends object>(handlers: T): Omit<T, (typeof PAGE_WRITERS)[number]> {
  const kept = { ...handlers };
  for (const name of PAGE_WRITERS) {
    Reflect.deleteProperty(kept, name);
  }
  return kept;
}

// What the Settings tab shows about the selection.
export function settingsValues(app: ShellView) {
  const { selectedNode, selectedId } = app;
  const component = app.selectedComponent;
  return {
    valuePolicy: app.defaultsCanvas.isOpen ? ('defaults' as const) : ('instance' as const),
    node: selectedNode,
    focusClass: app.classFocus,
    focusContent: app.contentFocus,
    isLayout: selectedId === 'layout',
    layouts: app.layoutOptions,
    currentLayoutName: app.currentLayoutName,
    schema: app.selectedSchema,
    listProps: app.listProps,
    slotOptions: app.slotOptions,
    // Whether this component takes default slot content — the same
    // test used to decide what an insert or paste can go inside.
    takesSlotText: (component?.slots || []).includes('default'),
    loopContext: app.loopContext,
    bindContext: app.bindContext,
    linkContext: app.linkContext,
    projectClasses: app.projectClasses,
    allowAttrs:
      selectedNode?.kind === 'element' ||
      // A dynamic tag renders a real element, so it takes attributes
      // even though it has no component file behind it.
      (selectedNode !== undefined && selectedNode.kind !== 'frontmatter' && !!selectedNode.dynamicTag) ||
      !!component?.hasRest,
    // An instance's attributes are checked against the tag its component passes them to.
    attributesTag: selectedNode?.kind === 'component' ? component?.extendsTag : undefined,
    comment: noteText(commentAbove(app.model, selectedId)?.value),
    tagOptions: app.tagOptions,
    frontmatterSource: app.frontmatterCode,
    frontmatterImports: app.model?.imports,
    projectPath: app.project.path,
    filePath: app.editStack[app.editStack.length - 1]?.path || app.currentPage?.path || undefined,
  };
}

// What the Settings tab's fields write, each to the selection.
// A list setting's property, renamed or retitled as the Properties panel would.
function loopPropertyEditor(app: ShellView, translate: Translator) {
  return async (key: string, edit: LoopPropertyEdit): Promise<string | undefined> => {
    const file = app.editStack[app.editStack.length - 1]?.path || app.currentPage?.path;
    if (file === undefined) {
      return translate('shell.loop.openComponent');
    }
    const saver = {
      projectPath: app.project.path,
      file,
      flushSave: app.flushSave,
      changePhase: app.propertySave.changePhase,
      recordUndo: app.recordPropertyUndo,
      completeSave: app.completePropertySave,
    };
    return editLoopProperty(saver, key, edit, translate);
  };
}

export function settingsHandlers(app: ShellView, translate: Translator) {
  const { selectedId } = app;
  return {
    ...settingsTextHandlers(app),
    onChangeLayout: app.onChangeLayout,
    onSetComment: (text: string) => {
      if (selectedId) {
        app.setComment(selectedId, text);
      }
    },
    onSetProp: (propName: string, value: Attr | undefined, immediate?: boolean) => {
      if (selectedId) {
        app.setProp(selectedId, propName, value, immediate, app.pathFor(selectedId));
      }
    },
    onSetProps: (nodeId: string, patch: PropValues) => app.setProps(nodeId, patch, true, app.pathFor(nodeId)),
    onReplaceProps: (nodeId: string, props: Readonly<Record<string, Attr>>) => app.replaceProps(nodeId, props),
    onSetAssetProp: (nodeId: string, propName: string, picked: PickedAsset, reference: AssetReference, also?: PropValues) => {
      void app.setAssetProp(nodeId, propName, picked, reference, also).catch(app.reportFailure);
    },
    onRenameProp: (oldName: string, newName: string) => {
      if (selectedId) {
        app.renameProp(selectedId, oldName, newName);
      }
    },
    // A capital is a component name; anything else is a tag. The
    // component path answers whether the name resolves, so the
    // field can put the old value back when it doesn't.
    onChangeTag: (tag: string) => {
      if (!selectedId) {
        return undefined;
      }
      return /^[A-Z]/.test(tag) ? app.changeNodeKind(selectedId, tag) : app.changeElementTag(selectedId, tag);
    },
    onOpenCode: app.openCodeWindow,
    onSetFrontmatter: app.setExtraFrontmatter,
    onSetLoopSource: (target: LoopTarget, sanityClient: 'available' | 'unavailable', declaration?: PropDeclaration): LoopApplyResult =>
      selectedId ? app.setLoopSource(selectedId, target, sanityClient, declaration) : { ok: false, message: translate('shell.loop.selectFirst') },
    onEditLoopProperty: loopPropertyEditor(app, translate),
    onCommitLoopHead: (value: string, renames: readonly Rename[]): string | undefined =>
      selectedId ? app.setLoopHead(selectedId, value, renames) : translate('shell.loop.selectFirst'),
    onRenameVariable: app.renameVariable,
    onOpenSymbol: app.onOpenSymbol,
    onToggleElse: (want: boolean) => {
      if (selectedId) {
        app.toggleElseBranch(selectedId, want);
      }
    },
  };
}

// What the Settings tab's text fields write: the node's text, its content, its words.
export function settingsTextHandlers(app: ShellView) {
  const { selectedId } = app;
  return {
    onSetText: (value: string, renames?: readonly Rename[]) => {
      if (selectedId === 'frontmatter') {
        app.setFrontmatter(value);
      } else if (selectedId) {
        app.setNodeText(selectedId, value, renames);
      }
    },
    onSetContent: (value: string) => {
      if (selectedId) {
        app.setNodeContent(selectedId, value);
      }
    },
    onSetInline: (kids: readonly InlineNode[]) => {
      if (selectedId) {
        app.setNodeInline(selectedId, kids);
      }
    },
    richTextContent: app.selectedNode?.kind === 'component' && app.componentEditing(app.selectedComponent?.path, DEFAULT_SLOT_FIELD).richText === true,
    richTextProps: (app.selectedComponent?.htmlProps ?? []).filter((prop) => app.componentEditing(app.selectedComponent?.path, prop).richText === true),
    contentSource: selectedContentSource(app),
    contentShown: shownContentSource(app),
    onSetContentSource: (source: string) => {
      const shown = selectedContentSource(app);
      if (selectedId && shown !== undefined) {
        app.setNodeContentSource(selectedId, source, shown);
      }
    },
    onSetTextPieces: (pieces: readonly TextPiece[]) => {
      if (selectedId) {
        app.setNodeTextPieces(selectedId, pieces);
      }
    },
  };
}

// The floating code window: page frontmatter, a raw node's inner content, or a text
// file.
export function CodeWindowHost({ app }: { readonly app: ShellView }) {
  const { codeWin, codeWinValue, isFileWin } = app;
  // Raw source is code editing: a role without it never sees the code window.
  const canCode = can(useCurrentRole(), 'code:edit');
  // A stylesheet or a `<style>` node draws CSS chips throughout, a page in its `<style>` blocks, a script none.
  const codeChips = useCodeChips(codeChipTextOf(codeWin?.language));
  // A window on a whole project file knows the project; one on a block of a page (its frontmatter, a script or a style)
  // is a piece of a file, with nothing to ask about on its own.
  const wholeFile = codeWin?.kind === 'file' && codeWin.area === 'src' ? codeWin.rel : undefined;
  const intelligence = useCodeIntel(app.project.path, wholeFile);
  if (!codeWin || codeWinValue === undefined || !canCode) {
    return undefined;
  }
  const targetId = codeWin.targetId;
  return (
    <CodeWindow
      title={codeWin.title}
      language={codeWin.language}
      indentation={codeWin.indentation}
      value={codeWinValue}
      editorKey={isFileWin ? `file:${codeWin.rel}` : targetId}
      revealLine={codeWin.revealLine}
      revealSerial={codeWin.revealSerial}
      extensions={wholeFile === undefined ? codeChips.extension : [codeChips.extension ?? [], intelligence]}
      overlay={codeChips.overlay}
      onChange={(value) => {
        if (isFileWin) {
          app.setAssetFileText(value);
        } else if (targetId === 'frontmatter') {
          app.setFrontmatter(value);
        } else if (targetId) {
          app.setNodeText(targetId, value);
        }
      }}
      onClose={() => app.setCodeWin(undefined)}
    />
  );
}

export function ConflictNotice({ app }: { readonly app: ShellView }) {
  const page = app.currentPage;
  if (app.pageState?.save.tag !== 'conflicted' || !page?.path) {
    return undefined;
  }
  return (
    <SaveConflictNotice
      fileName={page.name}
      reason={app.conflictReason}
      reviewing={app.leftTab === 'code'}
      onReload={() => {
        void app.reloadFromDisk();
      }}
      onReview={() => {
        void app.reviewConflictInCode();
      }}
      onKeep={app.keepLocalVersion}
    />
  );
}

export { BusyOverlay } from './BusyOverlay';

// A canvas in interact mode followed a link to `route` (useCanvasInteraction): the editor opens
// the page the frame landed on, so the model and the visible document stay one page. A dynamic
// page opens at the entry it landed on (canvasLandingFor); a route that is none of the site's
// pages takes the canvas back to the page the editor has open.
function followCanvasRoute(app: ShellView, route: string): void {
  const landing = canvasLandingFor(app.scan.pages, route);
  if (landing === undefined) {
    app.setRefreshKey((count) => count + 1);
    return;
  }
  if (landing.entry === undefined) {
    app.onSelectPage(landing.page);
    return;
  }
  const shownPath = (app.editStack[0] ?? app.currentPage)?.path;
  const index = landing.page.path === shownPath ? dynamicEntryIndexOf(app.dynamicPaths, landing.entry) : undefined;
  if (index !== undefined) {
    // The template is open with its entries read: the entry is picked like any other.
    app.setLinkedEntry(undefined);
    app.setDynamicIndex(index);
    return;
  }
  app.setLinkedEntry({ pagePath: landing.page.path, route: landing.entry });
  if (landing.page.path !== shownPath) {
    app.onSelectPage(landing.page);
  }
}
