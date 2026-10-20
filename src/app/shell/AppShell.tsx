import { desktopElementActions } from './desktopElementActions';
import { DefaultsCanvasBar } from '../../features/componentDefaults/DefaultsCanvasBar';
import { DesktopPublishButton } from './DesktopPublishButton';
import { ToastStack } from '../../features/notifications/ToastStack';
// The app's frame: the welcome view, the shell and its overlays, the title
// bar with its URL group and actions, and the left panel with each of its
// tabs (App.tsx).

import ComponentPropertiesPanel from '../../features/componentProperties/ComponentPropertiesPanel';
import WelcomeScreen from '../../features/welcome/WelcomeScreen';
import PagesPanel from '../../features/pages/PagesPanel';
import PalettePanel from '../../features/palette/PalettePanel';
import StructurePanel from '../../features/structure/StructurePanel';
import GitChip from '../../features/git/GitChip';
import HistoryPanel from '../../features/history/HistoryPanel';
import { ConfirmHost, confirmDialog } from '../../ui/ConfirmDialog';
import LeftRail from '../LeftRail';
import PageSwitcher from '../../features/pages/PageSwitcher';
import DynamicPicker from '../DynamicPicker';
import InsertSearch from '../../features/palette/InsertSearch';
import AssetsPanel from '../../features/assets/AssetsPanel';
import TerminalDock from '../../features/terminal/TerminalDock';
import { cleanError } from '../../lib/cleanError';
import {
  PreviewIcon,
  RefreshIcon,
  ExternalIcon,
  ChevronLeftIcon,
  ElementComponentIcon,
  TerminalIcon,
} from '../../ui/Icons';
import type { HistoryCommit, HistoryCommitFile } from '../../features/history/historyBridge';
import { currentDesktopPlatform, shortcutLabel } from '../../lib/shortcutLabel';
import { type LeftTab } from '../appTypes';
import { openExternalURL, restoreProjectFile, restoreProjectVersion } from '../../ipc/appBridge';
import { CmsPanel, VariablesPanel, CodePanel, FeedbackPanel } from '../appPanels';
import {
  CanvasPane,
  CanvasCovers,
  OldVersionCover,
  RightPanel,
  CodeWindowHost,
  ConflictNotice,
  BusyOverlay,
  selectCanvasPath,
} from './AppPanes';
import type { AppView, ShellView } from '../App';

// The start screen, before a project is open.
export function WelcomeView({ app }: { readonly app: AppView }) {
  // The welcome mode floats the title bar over the start screen so the
  // interactive backdrop runs edge to edge, behind the window controls.
  return (
    <div className="app welcome-mode">
      <div className="titlebar">
        <span className="spacer" />
      </div>
      <WelcomeScreen onOpen={app.onOpenProject} showToast={app.showToast} />
      {app.busy && <BusyOverlay message={app.busy} />}
      <ToastStack notices={app.notices} dismiss={app.dismissToast} />
      <ConfirmHost />
    </div>
  );
}

// The editor around an open project.
export function AppShell({ app }: { readonly app: ShellView }) {
  return (
    <div className="app">
      {app.propertySave.phase === 'saving' && (
        <div className="property-saving-overlay" role="status">
          Saving component properties…
        </div>
      )}
      <TitleBar app={app} />
      <DefaultsCanvasBar canvas={app.defaultsCanvas} />
      <div className="main">
        <LeftRail
          active={app.leftTab}
          componentOpen={app.componentPropertiesOpen}
          onSelect={(id) => app.setLeftTab((tab) => (tab === id ? undefined : id))}
        />
        {app.leftTab && <LeftPanel app={app} tab={app.leftTab} />}
        <div className="center">
          <CanvasPane app={app} />
          <CanvasCovers app={app} />
        </div>
        {app.inPreview && app.previewSource && (
          <div className="preview-mode">
            <iframe
              ref={app.previewIframeRef}
              src={app.previewSource}
              title="Site preview (interactive)"
            />
          </div>
        )}
        <OldVersionCover app={app} />
        {app.pageState?.editable && !app.previewRef && <RightPanel app={app} />}
      </div>
      <AppOverlays app={app} />
    </div>
  );
}

// What floats over the editor: the terminal, the code window, the insert palette,
// the conflict notice, the busy overlay and the toast.
export function AppOverlays({ app }: { readonly app: ShellView }) {
  return (
    <>
      {/* Below `.main`, so it spans the full window rather than being boxed in
          by the panels. Always mounted but inert until opened: it spawns no
          shell until then, and once open it hides rather than unmounting, so
          toggling it doesn't discard the scrollback — see TerminalDock. */}
      <TerminalDock
        projectPath={app.project.path}
        open={app.termOpen}
        onClose={() => app.setTermOpen(false)}
      />
      <CodeWindowHost app={app} />
      {app.insertOpen && (
        <InsertSearch
          components={app.insertables}
          allowSlot={app.currentPage?.kind === 'component'}
          onInsert={app.insertItem}
          onClose={() => app.setInsertOpen(false)}
        />
      )}
      <ConflictNotice app={app} />
      {app.busy && <BusyOverlay message={app.busy} />}
      <ToastStack notices={app.notices} dismiss={app.dismissToast} />
      <ConfirmHost />
    </>
  );
}

export function TitleBar({ app }: { readonly app: ShellView }) {
  return (
    <div className="titlebar">
      <button
        className="app-title project-back"
        title="Back to all projects"
        aria-label="Back to all projects"
        disabled={app.propertySave.phase === 'saving' || app.defaultsCanvas.state.kind !== 'idle'}
        onClick={() => {
          void app.leaveProject().catch((error: unknown) => {
            app.showToast(`Could not return to projects: ${cleanError(error)}`, 'error');
          });
        }}
      >
        <ChevronLeftIcon size={13} />
        <span>{app.project.name}</span>
      </button>
      <span className="spacer" />
      {app.defaultsCanvas.state.kind !== 'idle' ? (
        <button
          className="page-switch-btn comp-back"
          title="Close defaults"
          aria-label="Close defaults"
          disabled={app.defaultsCanvas.state.kind === 'saving'}
          onClick={() => void app.defaultsCanvas.run('done')}
        >
          <ChevronLeftIcon size={13} />
          <span>Close defaults</span>
        </button>
      ) : app.editStack.length > 1 ? (
        <button
          className="page-switch-btn comp-back"
          title="Back (Esc)"
          onClick={() => {
            // Opening the parent file reports its own failures.
            void app.closeComponent();
          }}
        >
          <ChevronLeftIcon size={13} />
          <span className="comp-back-sep" />
          <ElementComponentIcon size={13} />
          <span className="page-switch-label">{app.currentPage?.name}</span>
        </button>
      ) : (
        <PageSwitcher
          pages={app.scan.pages}
          currentPage={app.currentScanPage}
          onSelect={app.onSelectPage}
        />
      )}
      <UrlGroup app={app} />
      <span className="spacer" />
      <TitleActions app={app} />
      <DesktopPublishButton
        projectPath={app.project.path}
        flushSave={app.flushSave}
        refresh={app.refreshGit}
      />
    </div>
  );
}

export function UrlGroup({ app }: { readonly app: ShellView }) {
  const { liveUrl, patternRoute } = app;
  return (
    <div className="url-group">
      <span
        className={`status-dot ${
          app.devStatus === 'on' ? 'on' : app.devStatus === 'starting' ? 'starting' : 'off'
        }`}
        title={`Dev server: ${app.devStatus}`}
      />
      <button
        className="ghost"
        title="Reload preview"
        disabled={!liveUrl}
        onClick={() => app.setRefreshKey((count) => count + 1)}
      >
        <RefreshIcon size={13} />
      </button>
      {/* A real input, not a label: the URL is something you copy out and
          something you type a route into. Focus selects it all, so one
          click and ⌘C gets the whole thing. */}
      <input
        className="url"
        spellCheck={false}
        value={app.urlDraft ?? liveUrl ?? ''}
        placeholder={
          app.devStatus === 'starting' ? 'Starting Astro dev server…' : 'Preview offline'
        }
        readOnly={!liveUrl}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => app.setUrlDraft(event.target.value)}
        onBlur={() => app.setUrlDraft(undefined)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            app.setUrlDraft(undefined);
            event.currentTarget.blur();
            return;
          }
          if (event.key !== 'Enter') {
            return;
          }
          event.currentTarget.blur();
          app.goToUrl(event.currentTarget.value);
        }}
      />
      {/* Which entry of a dynamic route the canvas is showing. The template
          is what gets edited either way — this only changes the data it's
          rendered against. */}
      {patternRoute?.includes('[') && (
        <DynamicPicker
          entries={app.dynamicPaths}
          index={app.dynamicIndex}
          onPick={app.setDynamicIndex}
          error={app.dynamicError}
          pattern={patternRoute}
        />
      )}
    </div>
  );
}

// Both ways of viewing the site, kept together.
export function TitleActions({ app }: { readonly app: ShellView }) {
  const { liveUrl } = app;
  const terminalKey = shortcutLabel('J', 'primary', currentDesktopPlatform());
  return (
    <div className="titlebar-actions">
      <button
        className={`titlebar-btn ${app.termOpen ? 'on' : ''}`}
        title={`${app.termOpen ? 'Hide' : 'Show'} terminal (${terminalKey})`}
        onClick={() => app.setTermOpen((open) => !open)}
      >
        <TerminalIcon size={14} />
      </button>
      <button
        className="titlebar-btn"
        title="Open in browser"
        disabled={!liveUrl}
        onClick={() => {
          if (liveUrl) {
            void openExternalURL(liveUrl);
          }
        }}
      >
        <ExternalIcon size={14} />
      </button>
      {/* Two things put the canvas into a state you are looking at rather
          than working in — the interactive preview, and an older version —
          and this button is where both of them end. Lit for either, so it
          is never on while the only button that turns it off looks idle. */}
      <button
        className={`titlebar-btn preview-btn ${app.inPreview || app.previewRef ? 'on' : ''}`}
        title={
          app.previewRef
            ? 'Back to now (Esc)'
            : app.inPreview
              ? 'Exit preview (Esc)'
              : 'Preview the site'
        }
        disabled={!app.devUrl}
        onClick={() => togglePreview(app)}
      >
        <PreviewIcon size={15} />
      </button>
    </div>
  );
}

// The preview button: back from an older version, out of the preview, or into it.
export function togglePreview(app: ShellView): void {
  if (app.previewRef) {
    app.onExitCommitPreview();
    return;
  }
  if (app.inPreview) {
    app.exitPreview();
    return;
  }
  app.enterPreview();
}

export function LeftPanel({ app, tab }: { readonly app: ShellView; readonly tab: LeftTabName }) {
  return (
    <div className={`panel left ${tab === 'code' ? 'code-panel-shell' : ''}`}>
      {tab === 'properties' && <PropertiesTab app={app} />}
      {tab === 'pages' && <PagesTab app={app} />}
      {tab === 'navigator' && <NavigatorTab app={app} />}
      {tab === 'components' && <PaletteTab app={app} />}
      {tab === 'cms' && <CmsTab app={app} />}
      {tab === 'variables' && (
        <VariablesPanel
          project={app.project}
          selected={app.varsGroup}
          onSelect={app.setVarsGroup}
        />
      )}
      {tab === 'code' && <CodeTab app={app} />}
      {tab === 'history' && <HistoryTab app={app} />}
      {tab === 'feedback' && <FeedbackTab app={app} />}
      {tab === 'assets' && (
        <AssetsPanel
          project={app.project}
          showToast={app.showToast}
          onOpenFile={app.onOpenAssetFile}
          pick={app.assetPick}
          onPickCancel={() => app.endAssetPick(false)}
          onRecordUndo={app.pushCommand}
        />
      )}
    </div>
  );
}

export type LeftTabName = NonNullable<LeftTab>;

export function PropertiesTab({ app }: { readonly app: ShellView }) {
  const page = app.currentPage;
  if (page?.kind !== 'component') {
    return undefined;
  }
  return (
    <ComponentPropertiesPanel
      key={page.path}
      projectPath={app.project.path}
      file={page.path}
      name={page.name}
      flushSave={app.flushSave}
      onSavePhase={app.propertySave.changePhase}
      onSaved={app.completePropertySave}
      onRecordUndo={app.recordPropertyUndo}
    />
  );
}

export function PagesTab({ app }: { readonly app: ShellView }) {
  return (
    <PagesPanel
      scan={app.scan}
      currentPage={app.currentScanPage}
      injectedRoutes={app.injectedRoutes}
      onSelectRoute={app.onSelectRoute}
      onSelect={app.onSelectPage}
      onCreate={app.onCreatePage}
      onDelete={app.onDeletePage}
      onRescan={() => {
        void app.rescan(app.project.path).catch(app.reportFailure);
      }}
      onMovePage={app.onMovePage}
      onCreateFolder={app.createPageFolder}
      onRenameFolder={app.onRenamePageFolder}
      onDeleteFolder={app.onDeletePageFolder}
    />
  );
}

export function NavigatorTab({ app }: { readonly app: ShellView }) {
  const page = app.currentPage;
  const selectNavigatorNode = (id: string | undefined): void => {
    app.setNavigatorSelectionTick((tick) => tick + 1);
    app.setSelectedId(id);
  };
  return (
    <StructurePanel
      pageState={app.pageState}
      currentPage={page?.kind === 'route' ? { kind: 'route', route: page.route } : page}
      layouts={app.scan.layouts}
      currentLayoutName={app.currentLayoutName}
      selectedId={app.selectedId}
      emptyNodeIds={app.emptyNodeIds ?? new Set<string>()}
      hiddenNodeIds={app.stateIds.hidden}
      inertNodeIds={app.stateIds.inert}
      liveClassesById={app.liveClassesById ?? new Map<string, readonly string[]>()}
      revealTick={app.revealTick}
      onSelect={selectNavigatorNode}
      onHoverNode={app.setHoverNodeId}
      {...desktopElementActions(app)}
      onOpenCode={app.openCodeWindowById}
      onChangeLayout={app.onChangeLayout}
      onDropComponent={app.onDropComponent}
      onMoveNode={app.moveNode}
      onCodeChange={app.onCodeChange}
      onOpenCodePanel={() => app.setLeftTab('code')}
      devLog={app.devLog}
    />
  );
}

export function PaletteTab({ app }: { readonly app: ShellView }) {
  return (
    <PalettePanel
      components={app.insertables}
      devUrl={app.devUrl}
      trailingSlash={app.trailingSlash}
      onInsert={(name) => {
        void app.addComponent(name, undefined).catch(app.reportFailure);
      }}
      onDragBegin={() => app.setLeftTab('navigator')}
      createFrom={app.createFrom}
      createRequest={app.createRequest}
      onCreateComponent={app.onCreateComponent}
      onUsage={app.componentUsage}
      pageInstances={app.pageInstancesOf}
      onSelectInstance={(id) => {
        app.setLeftTab('navigator');
        app.setSelectedId(id);
      }}
      onOpenUsage={(entry) => openUsage(app, entry)}
    />
  );
}

// A page is opened as a page; a component or layout is drilled into, the same as
// opening one from the canvas.
export function openUsage(
  app: ShellView,
  entry: { readonly path: string; readonly rel: string },
): void {
  const page = app.scan.pages.find((candidate) => candidate.path === entry.path);
  if (page) {
    app.onSelectPage(page);
    return;
  }
  const name = entry.rel
    .split('/')
    .pop()
    ?.replace(/\.astro$/, '');
  if (name) {
    void app.openComponent(name, undefined, 0, entry.path).catch(app.reportFailure);
  }
}

export function CmsTab({ app }: { readonly app: ShellView }) {
  return (
    <CmsPanel
      project={app.project}
      selectedRel={app.cmsRel}
      selectedContent={app.contentName}
      onSelectContent={(name) => {
        app.setContentName(name);
        if (name) {
          app.setCmsRel(undefined);
          app.setCmsSettings(false);
        }
      }}
      currentFile={app.openFileSourceRel}
      refreshKey={app.cmsTick}
      onSelect={(rel) => {
        app.setCmsRel(rel);
        app.setCmsSettings(false);
        if (rel) {
          app.setContentName(undefined);
        }
        // Closing a collection leaves nothing selected anywhere, so
        // the right-hand panels show their empty state rather than
        // the node that happened to be picked before.
        if (!rel) {
          app.setSelectedId(undefined);
        }
      }}
      onOpenSettings={(rel) => {
        app.setCmsRel(rel);
        app.setCmsSettings(true);
      }}
      showToast={app.showToast}
    />
  );
}

export function CodeTab({ app }: { readonly app: ShellView }) {
  const page = app.currentPage;
  const state = app.pageState;
  if (!page || page.kind === 'route' || !state) {
    return undefined;
  }
  return (
    <CodePanel
      source={state.source}
      relativePath={app.openRel ?? page.name}
      model={app.model}
      selectedId={app.selectedId}
      onChange={app.onCodeChange}
      onSelect={app.setSelectedId}
      onOpenComponent={(name, id) => {
        void app.openComponent(name, app.pathFor(id)).catch(app.reportFailure);
      }}
    />
  );
}

export function FeedbackTab({ app }: { readonly app: ShellView }) {
  return (
    <FeedbackPanel
      feedback={app.feedback}
      target={app.overlayInfo(app.pathFor(app.selectedId) ?? '')?.label}
      selectedKey={app.selectionKeysRef.current.at(-1)}
      onSelectPin={(pin) => {
        selectCanvasPath(app, pin.path, { outside: false });
        // Selecting reveals the node in the Navigator; a note's row keeps its panel.
        app.setLeftTab('feedback');
      }}
      showToast={app.showToast}
    />
  );
}

export function HistoryTab({ app }: { readonly app: ShellView }) {
  return (
    <HistoryPanel
      project={app.project}
      gitInfo={app.gitInfo}
      controls={<HistoryGitControls app={app} />}
      previewRef={app.previewRef}
      onPreviewCommit={app.onPreviewCommit}
      onExitPreview={app.onExitCommitPreview}
      onRestoreFile={(commit, file) => {
        // Restoring reports its own failures.
        void restoreHistoryFile(app, commit, file);
      }}
      onRestoreProject={(commit) => {
        // Restoring reports its own failures.
        void restoreHistoryProject(app, commit);
      }}
    />
  );
}

function HistoryGitControls({ app }: { readonly app: ShellView }) {
  return (
    <GitChip
      key={app.project.path}
      project={app.project}
      info={app.gitInfo}
      refresh={app.refreshGit}
      busy={app.busy}
      showToast={app.showToast}
      flushSave={app.flushSave}
      onWorktreeChanged={async () => {
        if (app.previewRef) {
          await app.exitCommitPreview();
        }
        await app.reloadFromDisk();
      }}
    />
  );
}

export async function restoreHistoryFile(
  app: ShellView,
  commit: HistoryCommit,
  file: HistoryCommitFile,
): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Put ${file.label} back?`,
    body:
      `It goes back to how it was in “${commit.subject}”, ` +
      'and lands as an unsaved change — ' +
      'so you can look at it and undo it like any other edit.',
    confirmLabel: 'Put it back',
  });
  if (!confirmed) {
    return;
  }
  try {
    if (!commit.hash) {
      throw new Error('History commit has no hash');
    }
    const restored = await restoreProjectFile(app.project.path, commit.hash, file.path);
    if (restored.missing) {
      app.showToast(restored.message ?? 'That version no longer contains the file.', 'error');
      return;
    }
    await app.refreshGit();
    await app.reloadFromDisk();
    app.showToast(`${file.label} is back to how it was`, 'success');
  } catch (error: unknown) {
    app.showToast(cleanError(error), 'error');
  }
}

export async function restoreHistoryProject(app: ShellView, commit: HistoryCommit): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Take everything back to “${commit.subject}”?`,
    body:
      'Anything you haven’t saved is put aside first, so nothing is lost. ' +
      'Your saved history stays exactly as it is — ' +
      'this lands as a set of unsaved changes you can look over, keep, or undo.',
    confirmLabel: 'Take it back',
  });
  if (!confirmed) {
    return;
  }
  app.setBusy('Going back…');
  try {
    if (!commit.hash) {
      throw new Error('History commit has no hash');
    }
    const restored = await restoreProjectVersion(app.project.path, commit.hash);
    await app.refreshGit();
    await app.reloadFromDisk();
    app.showToast(
      restored?.parked
        ? 'The project is back — your unsaved work is waiting on this branch'
        : 'The project is back to how it was',
      'success',
    );
  } catch (error: unknown) {
    app.showToast(cleanError(error), 'error');
  } finally {
    app.setBusy(undefined);
  }
}
