import { desktopCanvasText } from './desktopCanvasText';
import { RemoteCmsView } from '../../features/cms/RemoteCmsView';
import { useEffect, useState } from 'react';
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
import { noteText } from '../../editor/treeSelection';
import { canvasClickAction } from '../../editor/canvasClick';
import PreviewPane from '../../features/preview/PreviewPane';
import { relativeTime } from '../../features/history/HistoryPanel';
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
import { type EditorNode } from '../../editor/pageView';
import { useLiveValue } from '../../ui/liveValue';
import { PropsPanel, StylePanel, CodeWindow, CmsView, ContentView, VariablesView } from '../appPanels';
import { holdsInlineText, commentAbove, trailOf } from '../model/pageGestures';
import type { ShellView } from '../App';
import { editLoopProperty, type LoopPropertyEdit } from '../state/loopPropertyEdit';
import { assert } from '../../../shared/core/assert';
import PanelBoundary from '../../ui/PanelBoundary';
import type { PseudoLayer } from '../../../shared/page/pseudoPath';
import { selectedPseudo } from '../model/selectionStructure';

export function CanvasPane({ app }: { readonly app: ShellView }) {
  const hoverNodeId = useLiveValue(app.hoverNode);
  const hoverPseudo = useLiveValue(app.hoverPseudo);
  const context = useCanvasContextMenu(app);
  return (
    <>
      <PreviewPane
        textDocument={desktopCanvasText(app)}
        spacingHover={app.spacingHover}
        devUrl={app.devUrl}
        devStatus={app.devStatus}
        coveredByBusyOverlay={!!app.busy}
        devLog={app.devLog}
        devDiag={app.devDiag}
        route={app.pageUrlPath}
        onEditRoute={(route) => {
          const page = app.scan.pages.find((entry) => (entry.route.replace(/\/$/, '') || '/') === route);
          if (page) {
            app.onSelectPage(page);
          } else {
            app.setRefreshKey((count) => count + 1);
          }
        }}
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
        navHoverPath={app.pathFor(hoverNodeId)}
        navHoverPseudo={hoverPseudo}
        selPseudo={selectedPseudo(app.selectedId, app.pseudoPick)}
        overlayInfo={app.overlayInfo}
        focusPath={app.focusPath}
        focusOcc={app.focusOcc}
        focusWhole={app.focusWhole}
        device={app.device}
        onDevice={app.setDevice}
        canvasWidthRequest={app.canvasWidthRequest}
        projectPath={app.project.path}
        judgeEvent={app.judgeEvent}
        onStaleEvent={app.onStaleEvent}
        onPreviewReload={app.onPreviewReload}
        onContextPath={context.open}
        onSelectPath={(path, info) => selectCanvasPath(app, path ?? undefined, info)}
        onSelectedClasses={app.receiveClasses}
        onRenderedPaths={app.setRenderedPaths}
        onNodeStates={app.setNodeStates}
        onNodeClasses={app.setNodeClasses}
        onOpenPath={(path, occurrence) => openCanvasPath(app, path ?? undefined, occurrence)}
      />
      {context.menu}
    </>
  );
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

function canvasContextPosition(app: ShellView, path: string | undefined, point: CanvasContextPoint): ContextPosition | undefined {
  const action = canvasClickAction({
    path,
    outside: point.outside,
    focusPath: app.focusPath,
    scope: app.editedRel ? `${app.editedRel}|` : '',
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

// What a click on the canvas MEANT — see canvasClick.js. The canvas answers with a
// path or with nothing, and nothing has two causes that want opposite things: a click
// the open file doesn't own, and a click on something inside it the canvas couldn't
// name.
export function selectCanvasPath(
  app: ShellView,
  path: string | undefined,
  info: { readonly outside: boolean; readonly pseudo?: PseudoLayer | undefined } | undefined,
): void {
  const reveal = (node: EditorNode | undefined) => {
    if (!node) {
      return;
    }
    app.setSelectedId(node.id);
    // A click on a ::before or ::after picks it as its navigator row does; a
    // click on the element itself puts down whatever pseudo-element was held.
    if (info?.pseudo === undefined) {
      app.setPseudoPick(undefined);
    } else {
      pickPseudo(app, node.id, info.pseudo);
    }
    // Code and canvas are two views of the same selection. Keep
    // code open when it is already in use; every other panel gives
    // way to the navigator so the selected row is visible.
    app.setLeftTab((tab) => (tab === 'code' ? tab : 'navigator'));
    app.setRevealTick((count) => count + 1);
  };
  const { kind } = canvasClickAction({
    path: path ?? undefined,
    outside: !!info?.outside,
    focusPath: app.focusPath,
    scope: app.editedRel ? `${app.editedRel}|` : '',
  });
  if (kind === 'nothing') {
    return;
  }
  if (kind === 'close') {
    if (app.defaultsCanvas.state.kind !== 'idle') {
      void app.defaultsCanvas.run('done');
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
export function pickPseudo(app: Pick<ShellView, 'setPseudoPick'>, id: string, pseudo: PseudoLayer): void {
  assert(id.length > 0, 'pickPseudo: a pseudo-element belongs to a node');
  app.setPseudoPick((held) => {
    const serial = (held?.serial ?? 0) + 1;
    assert(Number.isSafeInteger(serial), 'pickPseudo: the pick count stays an integer');
    return { nodeId: id, pseudo, serial };
  });
}

// Double-clicking a component on the canvas drills into it. With no path the click
// landed on chrome the layout renders itself (nav, footer) — that markup belongs to
// the layout, so open the layout, matching what a single click there selects.
export function openCanvasPath(app: ShellView, path: string | undefined, occurrence: number): void {
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

// An old version covers the canvas rather than replacing what it points at. The
// editing canvas draws outlines from the model, and the model is read from the files
// on disk — which are the CURRENT ones. Pointed at an old server it would draw this
// version's boxes over that version's page: every outline in the wrong place, and every
// click editing a file that isn't what's on screen. An overlay cannot do that, because
// there is nothing to click.
export function OldVersionCover({ app }: { readonly app: ShellView }) {
  const { oldVersionUrl, previewInfo } = app;
  if (!oldVersionUrl || !previewInfo) {
    return undefined;
  }
  return (
    <div className="preview-mode old-version">
      <div className="preview-banner">
        <span className="preview-banner-text">
          You’re looking at <strong>{previewInfo.subject}</strong> — how the site was {relativeTime(previewInfo.when ?? '')}. This is a look, not a place to
          work.
        </span>
        <button className="preview-banner-exit" onClick={app.onExitCommitPreview}>
          Back to now
        </button>
      </div>
      <iframe src={oldVersionUrl} title="An earlier version of the site" />
    </div>
  );
}

export function RightPanel({ app }: { readonly app: ShellView }) {
  return (
    <ResizablePanel kind="right">
      <RightTabs app={app} />
      {app.rightTab === 'style' && (
        <PanelBoundary name="The Style panel" resetKey={app.selectedId}>
          <StyleTab app={app} />
        </PanelBoundary>
      )}
      <div style={{ display: app.rightTab === 'settings' ? 'contents' : 'none' }}>
        <PanelBoundary name="The Settings panel" resetKey={app.selectedId}>
          <PropsPanel {...settingsValues(app)} {...settingsHandlers(app)} />
        </PanelBoundary>
      </div>
    </ResizablePanel>
  );
}

export function RightTabs({ app }: { readonly app: ShellView }) {
  const tabs = [
    { id: 'style', label: 'Style' },
    { id: 'settings', label: 'Settings' },
  ] as const;
  const { rightTabRefs } = app;
  return (
    <div className="right-tabs">
      {app.rightTabInd && <span className="right-tabs-indicator" style={app.rightTabInd} />}
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(button) => {
            // React hands a detached button back as null.
            rightTabRefs.current[tab.id] = button ?? undefined;
          }}
          className={app.rightTab === tab.id ? 'on' : ''}
          onClick={() => app.setRightTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function StyleTab({ app }: { readonly app: ShellView }) {
  const { selectedId } = app;
  return (
    <StylePanel
      project={app.project}
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
        if (!state?.editable || !findNodeById(state.model.nodes, nodeId)) {
          return false;
        }
        app.setNodeText(nodeId, css, undefined, immediate || 'live');
        return true;
      }}
      onSelectNode={app.setSelectedId}
      onCanvasWidth={app.requestCanvasWidth}
      onRecordUndo={app.pushCommand}
      onAddClass={(name, placement) =>
        selectedId
          ? app.addClassToNode(selectedId, name, placement, app.pathFor(selectedId))
          : Promise.resolve({ tag: 'refused', message: 'no element is selected' })
      }
      onRemoveClass={(name) =>
        selectedId ? app.removeClassFromNode(selectedId, name, app.pathFor(selectedId)) : Promise.resolve({ tag: 'refused', message: 'no element is selected' })
      }
      onRemoveAttribute={(name) =>
        selectedId ? app.removeAttributeFromNode(selectedId, name) : Promise.resolve({ tag: 'refused', message: 'no element is selected' })
      }
      onSpacingHover={app.setSpacingHover}
      pathOf={app.pathFor}
      renderedClasses={app.classesForRef.current === selectedId ? app.selectedClasses : []}
      projectClasses={app.projectClasses}
      historyTick={app.historyTick}
      pseudoRequest={app.pseudoPick}
      selectorFocus={app.classFocus}
      openFilePath={app.openEditableFile?.path ?? undefined}
      openFileKind={app.openEditableFile?.kind ?? undefined}
      contextPagePath={canvasPageOf(app.editStack)}
    />
  );
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
    layouts: app.scan.layouts,
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
function loopPropertyEditor(app: ShellView) {
  return async (key: string, edit: LoopPropertyEdit): Promise<string | undefined> => {
    const file = app.editStack[app.editStack.length - 1]?.path || app.currentPage?.path;
    if (file === undefined) {
      return 'Open the component first.';
    }
    const saver = {
      projectPath: app.project.path,
      file,
      flushSave: app.flushSave,
      changePhase: app.propertySave.changePhase,
      recordUndo: app.recordPropertyUndo,
      completeSave: app.completePropertySave,
    };
    return editLoopProperty(saver, key, edit);
  };
}

export function settingsHandlers(app: ShellView) {
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
    onSetAssetProp: (nodeId: string, propName: string, picked: PickedAsset, reference: AssetReference) => {
      void app.setAssetProp(nodeId, propName, picked, reference).catch(app.reportFailure);
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
      selectedId ? app.setLoopSource(selectedId, target, sanityClient, declaration) : { ok: false, message: 'Select the loop first.' },
    onEditLoopProperty: loopPropertyEditor(app),
    onCommitLoopHead: (value: string, renames: readonly Rename[]): string | undefined =>
      selectedId ? app.setLoopHead(selectedId, value, renames) : 'Select the loop first.',
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
  if (!codeWin || codeWinValue === undefined) {
    return undefined;
  }
  const targetId = codeWin.targetId;
  return (
    <CodeWindow
      title={codeWin.title}
      language={codeWin.language}
      value={codeWinValue}
      editorKey={isFileWin ? `file:${codeWin.rel}` : targetId}
      revealLine={codeWin.revealLine}
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

export function BusyOverlay({ message }: { readonly message: string }) {
  return (
    <div className="busy-overlay">
      <div className="spinner" />
      <div>{message}</div>
    </div>
  );
}
