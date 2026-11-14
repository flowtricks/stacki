import { ErrorToast } from '../../ui/ErrorToast';
import { CanvasTextFormatBar } from './CanvasTextFormatBar';
import { ResizablePanel } from './ResizablePanel';
import { desktopElementActions } from './desktopElementActions';
import { DefaultsCanvasBar } from '../../features/componentDefaults/DefaultsCanvasBar';
import { DesktopPublishButton } from './DesktopPublishButton';
import { ToastStack } from '../../features/notifications/ToastStack';
// The app's frame: the welcome view, the shell and its overlays, the title
// bar with its URL group and actions, and the left panel with each of its
// tabs (App.tsx).

import ComponentPropertiesPanel from '../../features/componentProperties/ComponentPropertiesPanel';
import PagesPanel from '../../features/pages/PagesPanel';
import { ConnectSanity } from '../../features/cmsConnections/ConnectSanity';
import PalettePanel from '../../features/palette/PalettePanel';
import StructurePanel from '../../features/structure/StructurePanel';
import PanelBoundary from '../../ui/PanelBoundary';
import GitChip from '../../features/git/GitChip';
import HistoryPanel from '../../features/history/HistoryPanel';
import { ConfirmHost, confirmDialog } from '../../ui/ConfirmDialog';
import LeftRail from '../LeftRail';
import PageSwitcher from '../../features/pages/PageSwitcher';
import DynamicPicker from '../DynamicPicker';
import { DesktopInsertSearch } from './DesktopInsertSearch';
import AssetsPanel from '../../features/assets/AssetsPanel';
import TerminalDock from '../../features/terminal/TerminalDock';
import { cleanError, cleanErrorKeepingReference } from '../../lib/cleanError';
import { translateErrorText, translateReference } from '../../lib/i18n/translateErrorText';
import { historyFileLabel } from '../../features/history/historyModel';
import { PlayIcon, RefreshIcon, ExternalIcon, ChevronLeftIcon, ElementComponentIcon, TerminalIcon } from '../../ui/Icons';
import { openAppSettings } from '../settings/LazySettings';
import { AssetPickOverlay } from '../../ui/AssetPickOverlay';
import type { HistoryCommit, HistoryCommitFile } from '../../features/history/historyBridge';
import { currentDesktopPlatform, shortcutLabel } from '../../lib/shortcutLabel';
import { useDelayedTooltip } from '../../ui/delayedTooltip';
import { type LeftTab } from '../appTypes';
import { openExternalURL, restoreProjectFile, restoreProjectVersion } from '../../ipc/appBridge';
import type { Translator } from '../../lib/i18n/localeContext';
import { CmsPanel, VariablesPanel, CodePanel, SelectorsPanel, InstructionsPanel, ProjectSettingsPanel, preloadPanels } from '../appPanels';
import { canvasPageOf } from '../../editor/pageState';
import { projectRelative, type VariablePlace } from '../../editor/variablePlace';
import { prewarmKeepList, prewarmSelectorReport } from '../../features/selectors/selectorsBridge';
import { prewarmInstructionsListing } from '../../features/instructions/instructionsListingCache';
import { prewarmSecretsListing } from '../../features/projectSettings/secretsCache';
import { prewarmInstalledApps } from '../../features/apps/installedAppsCache';
import { prewarmPageOrder } from '../../features/pages/pageOrderPersistence';
import { useEffect } from 'react';
import { prefetchPanels, prefetchTimeline } from './panelPrefetch';
import { CanvasPane, CanvasCovers, OldVersionCover, RightPanel, CodeWindowHost, ConflictNotice, BusyOverlay, pickPseudo } from './AppPanes';
import { selectedPseudo } from '../model/selectionStructure';
import type { ShellView } from '../App';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { canPanel } from '../../lib/roleAccess';
import { can } from '../../../shared/properties/projectRoles';
import { ViewAsChip } from '../roles/ViewAsChip';
import { AppsTab, DesktopAppsHost } from './DesktopApps';
import { AuditsHost, AuditsTab } from './DesktopAudits';
import { AiHost, AiTab, useAiRailButton } from './DesktopAi';
import { selectFromPanel } from './panelSelection';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { SettingsButton } from './WelcomeView';

// The editor around an open project.
export function AppShell({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const projectPath = app.project.path;
  // The style selectors check reads every project file and installed package;
  // done once in the background, opening its panel shows a finished report.
  useEffect(() => prewarmSelectorReport(projectPath), [projectPath]);
  // The other panels' chunks and first reads, so each opens on its content the first time.
  useEffect(() => prefetchPanels({ projectPath, preloadChunks: preloadPanels, hostReads: desktopPanelReads(projectPath) }), [projectPath]);
  const gitRepository = app.gitInfo?.isRepo ? app.gitInfo : undefined;
  const gitBranch = gitRepository?.branch;
  const gitHead = gitRepository?.head;
  const gitTracked = gitRepository !== undefined;
  useEffect(() => (gitTracked ? prefetchTimeline(projectPath, gitBranch, gitHead) : undefined), [projectPath, gitTracked, gitBranch, gitHead]);
  // A panel the role hides closes, including one open when "View as" switched roles.
  const role = useCurrentRole();
  const leftTab = app.leftTab !== undefined && canPanel(role, app.leftTab) ? app.leftTab : undefined;
  const aiButton = useAiRailButton(app);
  return (
    <div className="app">
      {app.propertySave.phase === 'saving' && (
        <div className="property-saving-overlay" role="status">
          {translate('shell.saving.properties')}
        </div>
      )}
      <TitleBar app={app} />
      <DefaultsCanvasBar canvas={app.defaultsCanvas} />
      <div className="main">
        <LeftRail
          active={leftTab === 'ai' ? undefined : leftTab}
          componentOpen={app.componentPropertiesOpen}
          projectPath={projectPath}
          onSelect={(id) => app.setLeftTab((tab) => (tab === id ? undefined : id))}
          aiButton={aiButton}
        />
        {leftTab && <LeftPanel app={app} tab={leftTab} />}
        <div className="center">
          <CanvasPane app={app} />
          <CanvasCovers app={app} />
        </div>
        {app.assetPick?.presentation === 'overlay' && (
          <AssetPickOverlay mediaKind={app.assetPick.mediaKind} onClose={() => app.endAssetPick(false)}>
            <AssetsPanel
              project={app.project}
              showToast={app.showToast}
              pick={app.assetPick}
              onPickCancel={() => app.endAssetPick(false)}
              onRecordUndo={app.pushCommand}
            />
          </AssetPickOverlay>
        )}
        {app.inPreview && app.previewSource && (
          <div className="preview-mode">
            <iframe ref={app.previewIframeRef} src={app.previewSource} title={translate('shell.preview.interactiveTitle')} />
          </div>
        )}
        <OldVersionCover app={app} />
        {app.pageState?.editable && !app.previewRef && (
          // An open CMS item has nothing to style, so the CMS takes the Style and
          // Settings panel's width too. Hidden, not unmounted: closing the CMS
          // returns the panel as it was, on the same tab and scroll.
          <div style={{ display: cmsCovering(app) ? 'none' : 'contents' }}>
            <RightPanel app={app} />
          </div>
        )}
      </div>
      <AppOverlays app={app} />
      <AuditsHost app={app} />
      <AiHost app={app} />
    </div>
  );
}

// The first reads of the panels Desktop has and Studio's prefetch does not cover,
// each into the cache its panel opens on (panelPrefetch.ts).
function desktopPanelReads(projectPath: string): ReadonlyArray<() => Promise<void>> {
  return [
    () => prewarmPageOrder(projectPath),
    () => prewarmInstalledApps(projectPath),
    () => prewarmKeepList(projectPath),
    () => prewarmInstructionsListing(projectPath),
    () => prewarmSecretsListing(projectPath),
  ];
}

/** Whether a CMS collection or item covers the canvas (CanvasCovers). */
function cmsCovering(app: ShellView): boolean {
  if (app.leftTab !== 'cms') {
    return false;
  }
  return Boolean(app.cmsRel ?? app.cmsRemote ?? app.contentName);
}

// What floats over the editor: the terminal, the code window, the insert palette,
// the conflict notice, the busy overlay and the toast.
export function AppOverlays({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const canCode = can(useCurrentRole(), 'code:edit');
  return (
    <>
      {/* Below `.main`, so it spans the full window rather than being boxed in
          by the panels. Always mounted but inert until opened: it spawns no
          shell until then, and once open it hides rather than unmounting, so
          toggling it doesn't discard the scrollback — see TerminalDock. */}
      <TerminalDock projectPath={app.project.path} open={app.termOpen && canCode} onClose={() => app.setTermOpen(false)} />
      <CodeWindowHost app={app} />
      <CanvasTextFormatBar />
      {app.insertOpen && <DesktopInsertSearch app={app} />}
      <ConflictNotice app={app} />
      <ErrorToast
        message={
          app.pageState?.save.tag === 'failed'
            ? app.currentPage === undefined
              ? translate('shell.save.failedFile', { message: app.pageState.save.message })
              : translate('shell.save.failedNamed', { name: app.currentPage.name, message: app.pageState.save.message })
            : undefined
        }
        recovery={[{ label: translate('shell.save.retry'), run: app.flushSave }]}
      />
      {app.busy && <BusyOverlay message={app.busy} />}
      <DesktopAppsHost app={app} />
      <ToastStack notices={app.notices} dismiss={app.dismissToast} />
      <ConfirmHost />
    </>
  );
}

export function TitleBar({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const canPublish = can(useCurrentRole(), 'publish');
  return (
    <div className="titlebar">
      <button
        className="app-title project-back"
        title={translate('shell.titleBar.backToProjects')}
        aria-label={translate('shell.titleBar.backToProjects')}
        disabled={app.propertySave.phase === 'saving' || app.defaultsCanvas.state.kind !== 'idle'}
        onClick={() => {
          void app.leaveProject().catch((error: unknown) => {
            app.showToast(translate('shell.titleBar.backToProjectsFailed', { message: cleanError(error) }), 'error');
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
          title={translate('shell.titleBar.closeDefaults')}
          aria-label={translate('shell.titleBar.closeDefaults')}
          disabled={app.defaultsCanvas.state.kind === 'saving'}
          onClick={() => void app.defaultsCanvas.run('done')}
        >
          <ChevronLeftIcon size={13} />
          <span>{translate('shell.titleBar.closeDefaults')}</span>
        </button>
      ) : app.editStack.length > 1 ? (
        <button
          className="page-switch-btn comp-back"
          title={translate('shell.titleBar.back')}
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
        <PageSwitcher pages={app.scan.pages} currentPage={app.currentScanPage} onSelect={app.onSelectPage} />
      )}
      <UrlGroup app={app} />
      <span className="spacer" />
      <ViewAsChip />
      <TitleActions app={app} />
      {canPublish && (
        <DesktopPublishButton
          projectPath={app.project.path}
          flushSave={app.flushSave}
          refresh={app.refreshGit}
          saveState={app.pageState?.save}
          repository={app.gitInfo}
          onOpenBranches={() => app.setLeftTab('history')}
          withBranchChange={app.withBranchChange}
          onBranchSwitched={app.reloadFromDisk}
        />
      )}
    </div>
  );
}

export function UrlGroup({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const { liveUrl, patternRoute } = app;
  return (
    <div className="url-group">
      {/* A real input, not a label: the URL is something you copy out and
          something you type a route into. Focus selects it all, so one
          click and ⌘C gets the whole thing. */}
      <div className="url-bar">
        <button
          className="titlebar-btn url-reload"
          title={translate('preview.reload')}
          aria-label={translate('preview.reload')}
          disabled={!liveUrl}
          onClick={() => app.setRefreshKey((count) => count + 1)}
        >
          <RefreshIcon size={13} />
        </button>
        <input
          className="url"
          spellCheck={false}
          value={app.urlDraft ?? liveUrl ?? ''}
          placeholder={app.devStatus === 'starting' ? translate('shell.preview.starting') : translate('shell.preview.offline')}
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
        <OpenBrowserButton liveUrl={liveUrl} />
      </div>
      {/* Which entry of a dynamic route the canvas is showing. The template
          is what gets edited either way — this only changes the data it's
          rendered against. */}
      {patternRoute?.includes('[') && (
        <DynamicPicker entries={app.dynamicPaths} index={app.dynamicIndex} onPick={app.setDynamicIndex} error={app.dynamicError} pattern={patternRoute} />
      )}
    </div>
  );
}

function OpenBrowserButton({ liveUrl }: { readonly liveUrl: ShellView['liveUrl'] }) {
  const translate = useTranslate();
  return (
    <button
      className="titlebar-btn url-open"
      title={translate('shell.titleBar.openInBrowser')}
      aria-label={translate('shell.titleBar.openInBrowser')}
      disabled={!liveUrl}
      onClick={() => {
        if (liveUrl) {
          void openExternalURL(liveUrl);
        }
      }}
    >
      <ExternalIcon size={14} />
    </button>
  );
}

// Terminal and interactive preview controls.
export function TitleActions({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const terminalKey = shortcutLabel('J', 'primary', currentDesktopPlatform());
  // The terminal runs anything in the project: it belongs to code editing.
  const canCode = can(useCurrentRole(), 'code:edit');
  return (
    <div className="titlebar-actions">
      {canCode && (
        <button
          className={`titlebar-btn ${app.termOpen ? 'on' : ''}`}
          title={translate(app.termOpen ? 'shell.titleBar.terminalHide' : 'shell.titleBar.terminalShow', { shortcut: terminalKey })}
          onClick={() => app.setTermOpen((open) => !open)}
        >
          <TerminalIcon size={14} />
        </button>
      )}
      {/* Two things put the canvas into a state you are looking at rather
          than working in — the interactive preview, and an older version —
          and this button is where both of them end. Lit for either, so it
          is never on while the only button that turns it off looks idle. */}
      <PreviewButton app={app} />
      <SettingsButton />
    </div>
  );
}

// Lit for either kind of looking-not-working (see TitleActions). Its tip waits for
// a resting pointer and names ⌥P, the key that does the same from anywhere.
function PreviewButton({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const tooltip = useDelayedTooltip();
  const label = previewButtonLabel(app, currentDesktopPlatform(), translate);
  return (
    <>
      <button
        className={`titlebar-btn preview-btn ${app.inPreview || app.previewRef ? 'on' : ''}`}
        aria-label={label}
        disabled={!app.devUrl}
        onMouseEnter={tooltip.show}
        onMouseLeave={tooltip.hide}
        onClick={() => {
          tooltip.hide();
          togglePreview(app);
        }}
      >
        <PlayIcon size={16} />
      </button>
      {tooltip.value ? (
        <div className="rail-tooltip below" style={tooltip.value}>
          {label}
        </div>
      ) : undefined}
    </>
  );
}

// What the preview button does now, with the key for it.
function previewButtonLabel(app: Pick<ShellView, 'inPreview' | 'previewRef'>, platform: NodeJS.Platform, translate: Translator): string {
  const key = platform === 'darwin' ? '⌥P' : 'Alt+P';
  if (app.previewRef) {
    return translate('shell.preview.backToNow', { shortcut: key });
  }
  return translate(app.inPreview ? 'shell.preview.exit' : 'shell.preview.enter', { shortcut: key });
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

// The open file decides which `<style>` variables the panel lists: the page, or
// the component drilled into. The selection does not, so the list holds still.
function variablePlace(app: ShellView): VariablePlace {
  const projectPath = app.project.path;
  return {
    openFile: projectRelative(projectPath, app.openEditableFile?.path),
    contextPage: projectRelative(projectPath, canvasPageOf(app.editStack)),
  };
}

// Only the open tab is mounted. Keeping visited tabs mounted and hidden (as
// KeptTabPanel does for the two inspector tabs) would keep their effects live
// while hidden, and React 18 has no way to pause them: the Navigator's arrow keys
// listen on the window and would move the selection from behind another panel,
// and every hidden panel would re-render on each hover and selection change and
// re-read its data on every file change. Each panel instead opens on what it
// showed last (per-project caches, filled ahead by panelPrefetch.ts) and on
// view state derived in its first render, then refreshes in place, which costs a
// few lists of data rather than a few thousand DOM nodes per panel
// (test/renderer/app/panelSwitch.test.js holds this).
export function LeftPanel({ app, tab }: { readonly app: ShellView; readonly tab: LeftTabName }) {
  return (
    <ResizablePanel kind={tab === 'code' ? 'code' : 'left'}>
      {tab === 'properties' && <PropertiesTab app={app} />}
      {tab === 'pages' && <PagesTab app={app} />}
      {tab === 'navigator' && <NavigatorTab app={app} />}
      {tab === 'components' && <PaletteTab app={app} />}
      {tab === 'cms' && <CmsTab app={app} />}
      {tab === 'variables' && <VariablesPanel project={app.project} place={variablePlace(app)} selected={app.varsGroup} onSelect={app.setVarsGroup} />}
      {tab === 'selectors' && <SelectorsPanel project={app.project} showToast={app.showToast} onRecordUndo={app.pushCommand} />}
      {tab === 'code' && <CodeTab app={app} />}
      {tab === 'history' && <HistoryTab app={app} />}
      {tab === 'apps' && <AppsTab app={app} />}
      {tab === 'instructions' && <InstructionsPanel projectPath={app.project.path} showToast={app.showToast} />}
      {tab === 'audits' && <AuditsTab app={app} />}
      {tab === 'projectSettings' && <ProjectSettingsPanel projectPath={app.project.path} />}
      {tab === 'ai' && <AiTab app={app} />}
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
    </ResizablePanel>
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
      nodes={app.model?.nodes}
      onSelectNode={app.setSelectedId}
      onReplaceProps={app.replaceProps}
      onOpenFile={(rel) => void app.openProjectFile(rel)}
    />
  );
}

export function PagesTab({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  return (
    <PagesPanel
      projectPath={app.project.path}
      scan={app.scan}
      currentPage={app.currentScanPage}
      injectedRoutes={app.injectedRoutes}
      onSelectRoute={app.onSelectRoute}
      onSelect={app.onSelectPage}
      onCreate={app.onCreatePage}
      onCreateTemplate={app.createTemplate}
      connectSanity={(input) => <ConnectSanity {...input} />}
      onDelete={app.onDeletePage}
      onMovePage={app.onMovePage}
      onCreateFolder={app.createPageFolder}
      onRename={async (change) => {
        if (change.kind === 'folder') {
          await app.renamePageFolder(change.from, change.to);
        } else {
          const page = app.scan.pages.find((entry) => entry.name === change.from);
          if (!page) {
            throw new Error(translate('shell.pages.noLongerExists'));
          }
          await app.movePageTo(page, change.to);
        }
      }}
      onRenameFolder={app.onRenamePageFolder}
      onDeleteFolder={app.onDeletePageFolder}
    />
  );
}

export function NavigatorTab({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const page = app.currentPage;
  const selectNavigatorNode = (id: string | undefined): void => selectFromPanel(app, id);
  // A ::before or ::after row selects its element, and asks the Style panel
  // for that pseudo-element's selector (the count makes a repeat a new ask).
  const selectPseudo = (id: string, pseudo: 'before' | 'after'): void => {
    app.setNavigatorSelectionTick((tick) => tick + 1);
    app.setSelectedId(id);
    pickPseudo(app, id, pseudo);
  };
  return (
    <PanelBoundary name="The Navigator" label={translate('shell.navigator.panelName')} resetKey={page?.path}>
      <StructurePanel
        key={page?.path}
        pageState={app.pageState}
        currentPage={page?.kind === 'route' ? { kind: 'route', route: page.route } : page}
        layouts={app.scan.layouts}
        currentLayoutName={app.currentLayoutName}
        selectedId={app.selectedId}
        emptyNodeIds={app.emptyNodeIds ?? new Set<string>()}
        hiddenNodeIds={app.stateIds.hidden}
        inertNodeIds={app.stateIds.inert}
        pseudoNodeIds={{ before: app.stateIds.before, after: app.stateIds.after }}
        selectedPseudo={selectedPseudo(app.selectedId, app.pseudoPick)}
        onSelectPseudo={selectPseudo}
        liveClassesById={app.liveClassesById ?? new Map<string, readonly string[]>()}
        revealTick={app.revealTick}
        onSelect={selectNavigatorNode}
        onHoverNode={(id) => {
          app.hoverPseudo.set(undefined);
          app.setHoverNodeId(id);
        }}
        onHoverPseudo={(id, pseudo) => {
          app.hoverPseudo.set(pseudo);
          app.setHoverNodeId(id);
        }}
        {...desktopElementActions(app)}
        onOpenCode={app.openCodeWindowById}
        onChangeLayout={app.onChangeLayout}
        onDropComponent={app.onDropComponent}
        onMoveNode={app.moveNode}
        onCodeChange={app.onCodeChange}
        onOpenCodePanel={() => app.setLeftTab('code')}
        devLog={app.devLog}
      />
    </PanelBoundary>
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
export function openUsage(app: ShellView, entry: { readonly path: string; readonly rel: string }): void {
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
      selectedRemote={app.cmsRemote}
      onSelectRemote={(selection) => {
        app.setCmsRemote(selection);
        if (selection) {
          app.setCmsRel(undefined);
          app.setContentName(undefined);
          app.setCmsSettings(false);
        }
      }}
      onSelectContent={(name) => {
        app.setContentName(name);
        if (name) {
          app.setCmsRel(undefined);
          app.setCmsRemote(undefined);
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
          app.setCmsRemote(undefined);
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
      onConnect={() => openAppSettings('cms')}
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

export function HistoryTab({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
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
        void restoreHistoryFile(app, commit, file, translate);
      }}
      onRestoreProject={(commit) => {
        // Restoring reports its own failures.
        void restoreHistoryProject(app, commit, translate);
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
      incoming={app.gitIncoming}
      withBranchChange={app.withBranchChange}
      onWorktreeChanged={async () => {
        if (app.previewRef) {
          await app.exitCommitPreview();
        }
        await app.reloadFromDisk();
      }}
    />
  );
}

export async function restoreHistoryFile(app: ShellView, commit: HistoryCommit, file: HistoryCommitFile, translate: Translator): Promise<void> {
  const confirmed = await confirmDialog({
    title: translate('shell.restore.fileTitle', { name: historyFileLabel(file, translate) }),
    body: translate('shell.restore.fileBody', { subject: commit.subject }),
    confirmLabel: translate('shell.restore.fileConfirm'),
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
      app.showToast(translateReference(restored.message ?? translate('shell.restore.fileMissing'), restored.messageRef, translate), 'error');
      return;
    }
    await app.refreshGit();
    await app.reloadFromDisk();
    app.showToast(translate('shell.restore.fileDone', { name: historyFileLabel(file, translate) }), 'success');
  } catch (error: unknown) {
    app.showToast(translateErrorText(cleanErrorKeepingReference(error), translate), 'error');
  }
}

export async function restoreHistoryProject(app: ShellView, commit: HistoryCommit, translate: Translator): Promise<void> {
  const confirmed = await confirmDialog({
    title: translate('shell.restore.projectTitle', { subject: commit.subject }),
    body: translate('shell.restore.projectBody'),
    confirmLabel: translate('shell.restore.projectConfirm'),
  });
  if (!confirmed) {
    return;
  }
  app.setBusy(translate('shell.restore.going'));
  try {
    if (!commit.hash) {
      throw new Error('History commit has no hash');
    }
    const restored = await restoreProjectVersion(app.project.path, commit.hash);
    await app.refreshGit();
    await app.reloadFromDisk();
    app.showToast(translate(restored?.parked ? 'shell.restore.projectParked' : 'shell.restore.projectDone'), 'success');
  } catch (error: unknown) {
    app.showToast(translateErrorText(cleanErrorKeepingReference(error), translate), 'error');
  } finally {
    app.setBusy(undefined);
  }
}
