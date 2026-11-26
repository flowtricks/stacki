import { ErrorToast } from '../../ui/ErrorToast';
import { PREVIEW_SHORTCUT, railShortcutLabel } from '../railShortcuts';
import { FilesTab } from './DesktopFiles';
import { FilesKeeper } from '../../features/files/FilesKeeper';
import { DesktopPageSettings } from './PageSettingsDesktop';
import { CanvasTextFormatBar } from './CanvasTextFormatBar';
import { CanvasTextSourceCue } from './CanvasTextSourceCue';
import { ResizablePanel } from './ResizablePanel';
import { desktopElementActions } from './desktopElementActions';
import { DefaultsCanvasBar } from '../../features/componentDefaults/DefaultsCanvasBar';
import { desktopDefaultsHost, relativeComponentPath } from '../../features/componentDefaults/defaultsHost';
import { FieldEditingContext, type FieldEditingHost } from '../../features/componentProperties/PropertyEditingSettings';
import { editingOffered, withEditingFieldMoved, withFieldEditing } from '../../../shared/properties/componentDefaults';
import { useDesktopComponentCanvas } from '../state/useDesktopComponentCanvas';
import { ComponentCanvasContext, useComponentCanvas, type ComponentCanvasControl } from '../../features/preview/componentCanvas/componentCanvasSession';
import { ComponentCanvasFramePopup } from '../../features/preview/componentCanvas/ComponentCanvasFramePopup';
import { canvasNavigatorView } from './canvasFrameSettings';
import { ComponentCanvasBack, ComponentCanvasZoom } from '../../features/preview/componentCanvas/ComponentCanvasControls';
import { DesktopPublishButton } from './DesktopPublishButton';
import { ToastStack } from '../../features/notifications/ToastStack';
import { ProjectFolderDrop } from './ProjectFolderDrop';
// The app's frame: the welcome view, the shell and its overlays, the title
// bar with its URL group and actions, and the left panel with each of its
// tabs (App.tsx).

import { useComponentManagement } from './useComponentManagement';
import ComponentPropertiesPanel from '../../features/componentProperties/ComponentPropertiesPanel';
import PagesPanel from '../../features/pages/PagesPanel';
import { usePageBulkRemoveHost } from './pageBulkRemoveDesktop';
import { ConnectSanity } from '../../features/cmsConnections/ConnectSanity';
import PalettePanel from '../../features/palette/PalettePanel';
import AddElementsPanel from '../../features/palette/AddElementsPanel';
import { navigatorShown, useElementDragNavigator } from '../state/elementDragNavigator';
import { useComponentRoleRules } from '../roles/componentRoleRules';
import StructurePanel from '../../features/structure/StructurePanel';
import PanelBoundary from '../../ui/PanelBoundary';
import GitChip from '../../features/git/GitChip';
import HistoryPanel from '../../features/history/HistoryPanel';
import { ConfirmHost, confirmDialog } from '../../ui/ConfirmDialog';
import { UpdatePopupHost } from '../../features/update/UpdatePopup';
import LeftRail from '../LeftRail';
import PageSwitcher from '../../features/pages/PageSwitcher';
import DynamicPicker from '../DynamicPicker';
import { DesktopInsertSearch } from './DesktopInsertSearch';
import { usePreviewPrewarm } from '../../features/palette/previewTiles';
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
import FittedTooltip from '../../ui/FittedTooltip';
import { type LeftTab } from '../appTypes';
import type { CodeReveal, SourceRange } from '../../features/code/codePanelModel';
import { openExternalURL, restoreProjectFile, restoreProjectVersion } from '../../ipc/appBridge';
import { PhonePreviewButton } from '../../features/preview/phone/PhonePreviewMenu';
import type { ReactNode } from 'react';
import type { Translator } from '../../lib/i18n/localeContext';
import { CmsPanel, VariablesPanel, CodePanel, SelectorsPanel, ProjectSettingsPanel, preloadPanels } from '../appPanels';
import { canvasPageOf, findEditorNodeById } from '../../editor/pageState';
import { parsePseudoLayerTarget } from '../../../shared/page/pseudoElements';
import { projectRelative, type VariablePlace } from '../../editor/variablePlace';
import { prewarmKeepList, prewarmSelectorReport } from '../../features/selectors/selectorsBridge';
import { prewarmInstructionsListing } from '../../features/instructions/instructionsListingCache';
import { prewarmSecretsListing } from '../../features/projectSettings/secretsCache';
import { prewarmProjectRoles } from '../roles/rolesCache';
import { prewarmInstalledApps } from '../../features/apps/installedAppsCache';
import { prewarmPageOrder } from '../../features/pages/pageOrderPersistence';
import { useCallback, useEffect, useMemo } from 'react';
import { rootSwatchScope, SwatchScopeContext } from '../../features/style/model/computedColor';
import { useSharedVars } from '../../features/style/sharedVars';
import { PreviewModeStage } from '../../features/preview/SizedFrame';
import { usePreviewSizing } from '../../features/preview/usePreviewSizing';
import { useProjectBreakpoints } from '../../ipc/useProjectBreakpoints';
import { prefetchPanels, prefetchTimeline } from './panelPrefetch';
import { useLiveInsertables } from './useLiveInsertables';
import { CanvasPane, CanvasCovers, OldVersionCover, RightPanel, CodeWindowHost, ConflictNotice, BusyOverlay, pickPseudo } from './AppPanes';
import { selectedPseudo } from '../model/selectionStructure';
import type { ShellView } from '../App';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { canPanel, canRailTab } from '../../lib/roleAccess';
import { requestSettingsSection } from '../../lib/settingsSections';
import { can } from '../../../shared/properties/projectRoles';
import { ViewAsChip } from '../roles/ViewAsChip';
import { AppsTab, DesktopAppsHost } from './DesktopApps';
import { AuditsHost, AuditsTab } from './DesktopAudits';
import { AiCover, AiHost, AiTab, useAiRailButton } from './DesktopAi';
import { PinsHost } from './DesktopPins';
import { selectFromPanel } from './panelSelection';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { SettingsButton } from './WelcomeView';
import { SettingsBackScope } from '../SettingsBackScope';
import { PageLoadLine } from '../../features/preview/PageLoadLine';
import { useCodeChips } from '../../features/style/codeChips/CodeChips';
import { DesignModeHost } from '../designMode/DesignModeHost'; // Design mode (experimental): docs/design-mode/REMOVE.md

// The editor around an open project.
export function AppShell({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const projectPath = app.project.path;
  // The style selectors check reads every project file and installed package;
  // done once in the background, opening its panel shows a finished report.
  useEffect(() => prewarmSelectorReport(projectPath), [projectPath]);
  // The other panels' chunks and first reads, so each opens on its content the first time.
  useEffect(() => prefetchPanels({ projectPath, preloadChunks: preloadPanels, hostReads: desktopPanelReads(projectPath) }), [projectPath]);
  // The component pictures of the insert palette, made in the background once the dev server is up, so the palette opens on them.
  usePreviewPrewarm(projectPath, app.insertables, { devURL: app.devUrl, trailingSlash: app.trailingSlash });
  const gitRepository = app.gitInfo?.isRepo ? app.gitInfo : undefined;
  const gitBranch = gitRepository?.branch;
  const gitHead = gitRepository?.head;
  const gitTracked = gitRepository !== undefined;
  useEffect(() => (gitTracked ? prefetchTimeline(projectPath, gitBranch, gitHead) : undefined), [projectPath, gitTracked, gitBranch, gitHead]);
  // A panel the role hides closes, including one open when "View as" switched roles.
  const role = useCurrentRole();
  const leftTab = app.leftTab !== undefined && canRailTab(role, app.leftTab) ? app.leftTab : undefined;
  const aiButton = useAiRailButton(app);
  // The component canvas (useDesktopComponentCanvas.ts): the title bar, the Components panel and the right panel read it.
  const componentCanvas = useDesktopComponentCanvas(app);
  return (
    <ComponentCanvasContext.Provider value={componentCanvas}>
      <div className="app" data-component-canvas={componentCanvas.state.kind === 'idle' ? undefined : ''}>
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
            onOpenSettings={(target) => {
              // Opens, never toggles: the shortcut for a section must not close Settings that is already showing it.
              requestSettingsSection(target);
              app.setLeftTab('projectSettings');
            }}
            aiButton={aiButton}
          />
          {leftTab && <LeftPanel app={app} tab={leftTab} />}
          <div className="center">
            {/* Each pane is its own boundary, so one that throws names itself and the rest of the window keeps working. */}
            <PanelBoundary name="The canvas" label={translate('recovery.pane.canvas')} resetKey={app.pageUrlPath}>
              <CanvasPane app={app} />
            </PanelBoundary>
            <PanelBoundary name="The canvas cover" label={translate('recovery.pane.canvas')} resetKey={app.leftTab}>
              <CanvasCovers app={app} />
              {/* Last, so an expanded chat is on top of any other cover: it is the mode the person just chose. */}
              <AiCover app={app} />
            </PanelBoundary>
            <ComponentCanvasZoom canvas={componentCanvas} />
            <CanvasFramePopup canvas={componentCanvas} />
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
          {app.inPreview && app.previewSource && <PreviewModeView app={app} source={app.previewSource} />}
          <OldVersionCover app={app} />
          {app.pageState?.editable && !app.previewRef && (
            // An open CMS item has nothing to style, so the CMS takes the Style and
            // Settings panel's width too. Hidden, not unmounted: closing the CMS
            // returns the panel as it was, on the same tab and scroll.
            <div style={{ display: cmsCovering(app) ? 'none' : 'contents' }}>
              <PanelBoundary name="The right panel" label={translate('recovery.pane.rightPanel')} resetKey={app.selectedId}>
                <RightPanel app={app} />
              </PanelBoundary>
            </div>
          )}
        </div>
        {/* Reads the project's files ahead and keeps them current, so the Files panel opens on its tree. */}
        {canRailTab(role, 'files') && <FilesKeeper key={projectPath} projectPath={projectPath} />}
        <AppOverlays app={app} />
        <AuditsHost app={app} />
        <AiHost app={app} />
        <PinsHost app={app} />
        <DesignModeHost app={app} /> {/* Design mode (experimental): docs/design-mode/REMOVE.md */}
      </div>
    </ComponentCanvasContext.Provider>
  );
}

// The selected frame's settings, over the canvas, while the frame is selected and no element in it is. The right panel
// stays the ordinary Style and Settings panel throughout; drilling into a component inside a frame hides this too.
function CanvasFramePopup({ canvas }: { readonly canvas: ComponentCanvasControl }) {
  const state = canvas.state;
  // Frame settings speak of the selected frame (the instance selected on the canvas page, or the one opened inside), so
  // they show at any depth until closed; the zoom bar's toggle and a frame's label open them again.
  if (state.kind !== 'open' || state.framePanel === 'hidden') {
    return undefined;
  }
  return <CanvasSwatches>{<ComponentCanvasFramePopup canvas={canvas} state={state} />}</CanvasSwatches>;
}

// The popover's swatches are not an element's styles: a frame background is drawn on the canvas page, so a
// `var(--background)` in it is resolved on that page's root element (where a site declares its theme), with or
// without a selection, instead of against a selected element, which painted a checkerboard while none was.
function CanvasSwatches({ children }: { readonly children: ReactNode }) {
  const { vars } = useSharedVars({ active: true });
  const scope = useMemo(() => rootSwatchScope(vars), [vars]);
  return <SwatchScopeContext.Provider value={scope}>{children}</SwatchScopeContext.Provider>;
}

// The site with no editing, over the panels, at the canvas's own size: the width and height
// handles resize it as they do the canvas, and into the same custom size, so leaving the
// preview keeps the size picked in it. The canvas below keeps listening for the device keys.
function PreviewModeView({ app, source }: { readonly app: ShellView; readonly source: string }) {
  const translate = useTranslate();
  const { resolved: breakpoints, desktopFramePx } = useProjectBreakpoints(app.project.path);
  const sizing = usePreviewSizing(app.device, app.previewDimensions, breakpoints, { deviceShortcuts: false, desktopFramePx }, app.setDevice);
  return (
    <PreviewModeStage sizing={sizing}>
      <iframe ref={app.previewIframeRef} src={source} title={translate('shell.preview.interactiveTitle')} />
    </PreviewModeStage>
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
    // The login behind Settings → Roles comes from `gh auth status`, about a second: read it before the tab opens.
    () => prewarmProjectRoles(projectPath),
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
      <PanelBoundary name="The code window" label={translate('recovery.pane.codeView')} resetKey={app.codeWin?.targetId}>
        <CodeWindowHost app={app} />
      </PanelBoundary>
      <CanvasTextFormatBar />
      <CanvasTextSourceCue />
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
      <ProjectFolderDrop app={app} />
      <ToastStack notices={app.notices} dismiss={app.dismissToast} />
      <ConfirmHost />
      <UpdatePopupHost />
    </>
  );
}

export function TitleBar({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const canPublish = can(useCurrentRole(), 'publish');
  const componentCanvas = useComponentCanvas();
  // On the canvas page the way back leaves the canvas; inside an instance, back steps out one level as anywhere, and
  // Close canvas beside it leaves from any depth.
  const canvasOpen = componentCanvas !== undefined && componentCanvas.state.kind !== 'idle';
  const atCanvas = canvasOpen && app.editStack.length <= 1;
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
      ) : atCanvas ? (
        <ComponentCanvasBack canvas={componentCanvas} />
      ) : app.editStack.length > 1 ? (
        <>
          {canvasOpen && <ComponentCanvasBack canvas={componentCanvas} />}
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
        </>
      ) : (
        <PageSwitcher pages={app.scan.pages} currentPage={app.currentScanPage} onSelect={app.onSelectPage} />
      )}
      <UrlGroup
        app={app}
        trailing={
          <PhonePreviewButton projectPath={app.project.path} devUrl={app.devUrl} devStatus={app.devStatus} route={app.pageUrlPath} showToast={app.showToast} />
        }
      />
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

/**
 * The address bar. `trailing` is a host's own control drawn in it before "Open in browser" (Desktop's phone
 * preview, PhonePreviewMenu.tsx); a host without one passes nothing, and the bar is as it always was.
 */
export function UrlGroup({ app, trailing }: { readonly app: ShellView; readonly trailing?: ReactNode }) {
  const translate = useTranslate();
  const { liveUrl, patternRoute } = app;
  return (
    <div className="url-group">
      {/* A real input, not a label: the URL is something you copy out and
          something you type a route into. Focus selects it all, so one
          click and ⌘C gets the whole thing. */}
      <div className="url-bar">
        <ReloadButton disabled={!liveUrl} onReload={() => app.setRefreshKey((count) => count + 1)} />
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
        {trailing}
        <OpenBrowserButton liveUrl={liveUrl} />
        <PageLoadLine />
      </div>
      {/* Which entry of a dynamic route the canvas is showing. The template
          is what gets edited either way — this only changes the data it's
          rendered against. */}
      {patternRoute?.includes('[') && (
        <DynamicPicker
          entries={app.dynamicPaths}
          index={app.dynamicIndex}
          onPick={(index) => {
            // A pick is the person's: the entry a canvas link landed on stops standing in.
            app.setLinkedEntry(undefined);
            app.setDynamicIndex(index);
          }}
          error={app.dynamicError}
          pattern={patternRoute}
        />
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

// The refresh button beside the address. Its tip waits for a resting pointer and names the shortcut that does the same from
// anywhere, since the menu always hands ⌘R to the site (electron/app/reloadRouting.ts). The shortcut is never drawn on the button.
export function ReloadButton({ disabled, onReload }: { readonly disabled: boolean; readonly onReload: () => void }) {
  const translate = useTranslate();
  const tooltip = useDelayedTooltip();
  const label = translate('preview.reload');
  const shortcut = shortcutLabel('R', 'primary', currentDesktopPlatform());
  return (
    <>
      <button
        className="titlebar-btn url-reload"
        aria-label={label}
        disabled={disabled}
        onMouseEnter={tooltip.show}
        onMouseLeave={tooltip.hide}
        onClick={() => {
          tooltip.hide();
          onReload();
        }}
      >
        <RefreshIcon size={13} />
      </button>
      {tooltip.value ? (
        <FittedTooltip anchor={tooltip.value}>
          {label} <span className="rail-tooltip-shortcut">{shortcut}</span>
        </FittedTooltip>
      ) : undefined}
    </>
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
          aria-pressed={app.termOpen}
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
// a resting pointer and names ⌥⇧P, the key that does the same from anywhere.
function PreviewButton({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const tooltip = useDelayedTooltip();
  const label = previewButtonLabel(app, currentDesktopPlatform(), translate);
  return (
    <>
      <button
        className={`titlebar-btn preview-btn ${app.inPreview || app.previewRef ? 'on' : ''}`}
        aria-label={label}
        aria-pressed={app.inPreview || app.previewRef !== undefined}
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
      {tooltip.value ? <FittedTooltip anchor={tooltip.value}>{label}</FittedTooltip> : undefined}
    </>
  );
}

// What the preview button does now, with the key for it.
function previewButtonLabel(app: Pick<ShellView, 'inPreview' | 'previewRef'>, platform: NodeJS.Platform, translate: Translator): string {
  const key = platform === 'darwin' ? railShortcutLabel(PREVIEW_SHORTCUT) : 'Alt+Shift+P';
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
  const translate = useTranslate();
  const { setLeftTab } = app;
  const backToSettings = useCallback(() => setLeftTab('projectSettings'), [setLeftTab]);
  return (
    <ResizablePanel kind={tab === 'code' ? 'code' : 'left'}>
      <PanelBoundary name="The left panel" label={translate('recovery.pane.leftPanel')} resetKey={tab}>
        {/* A panel a person moved into Settings gets Settings' back chevron in its header (SettingsBackScope.tsx). */}
        <SettingsBackScope tab={tab} onBack={backToSettings}>
          <LeftPanelBody app={app} tab={tab} />
        </SettingsBackScope>
      </PanelBoundary>
    </ResizablePanel>
  );
}

function LeftPanelBody({ app, tab }: { readonly app: ShellView; readonly tab: LeftTabName }) {
  return (
    <>
      {tab === 'properties' && <PropertiesTab app={app} />}
      {tab === 'elements' && <ElementsTab app={app} />}
      {tab === 'pages' && <PagesTab app={app} />}
      {tab === 'navigator' && <NavigatorTab app={app} />}
      {tab === 'components' && <PaletteTab app={app} />}
      {tab === 'cms' && <CmsTab app={app} />}
      {tab === 'variables' && <VariablesPanel project={app.project} place={variablePlace(app)} selected={app.varsGroup} onSelect={app.setVarsGroup} />}
      {tab === 'selectors' && <SelectorsPanel project={app.project} showToast={app.showToast} onRecordUndo={app.pushCommand} />}
      {tab === 'code' && <CodeTab app={app} />}
      {tab === 'files' && <FilesTab app={app} />}
      {tab === 'history' && <HistoryTab app={app} />}
      {tab === 'apps' && <AppsTab app={app} />}
      {tab === 'audits' && <AuditsTab app={app} />}
      {tab === 'projectSettings' && (
        <ProjectSettingsPanel
          projectPath={app.project.path}
          showToast={app.showToast}
          onOpenPanel={(panel) => app.setLeftTab(panel)}
          componentOpen={app.componentPropertiesOpen}
        />
      )}
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
    </>
  );
}

export type LeftTabName = NonNullable<LeftTab>;

export function PropertiesTab({ app }: { readonly app: ShellView }) {
  const page = app.currentPage;
  if (page?.kind !== 'component') {
    return undefined;
  }
  return (
    <FieldEditingContext.Provider value={desktopFieldEditing(app, page.path)}>
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
        onFieldMoved={(from, to) => moveFieldEditing(app, page.path, { from, to })}
      />
    </FieldEditingContext.Provider>
  );
}

// The open component's fields as the Properties panel's editing rows read and write them (.stacki/components.json).
function desktopFieldEditing(app: ShellView, componentPath: string): FieldEditingHost | undefined {
  const component = app.scan.components.find((entry) => entry.path === componentPath);
  if (component === undefined) {
    return undefined;
  }
  const catalogEntry = {
    slots: component.slots ?? [],
    slotText: component.slotText ?? false,
    ...(component.htmlProps === undefined ? {} : { htmlProps: component.htmlProps }),
  };
  return {
    slots: catalogEntry.slots,
    offered: (field) => editingOffered(catalogEntry, field),
    settings: (field) => app.componentEditing(componentPath, field),
    change: (field, setting, state) => {
      const host = desktopDefaultsHost(app.project.path);
      void host
        .load()
        .then((snapshot) => {
          const file = component.file ?? relativeComponentPath(app.project.path, componentPath);
          return host.save({ ...snapshot, config: withFieldEditing(snapshot.config, { file, field }, { setting, state }) });
        })
        .catch(app.reportFailure);
    },
  };
}

// A renamed or deleted prop's editing settings go with it; a file with none for it is not written.
function moveFieldEditing(app: ShellView, componentPath: string, move: { readonly from: string; readonly to: string | undefined }): void {
  const host = desktopDefaultsHost(app.project.path);
  const file = app.scan.components.find((entry) => entry.path === componentPath)?.file ?? relativeComponentPath(app.project.path, componentPath);
  void host
    .load()
    .then((snapshot) => {
      const config = withEditingFieldMoved(snapshot.config, file, move.from, move.to);
      return config === snapshot.config ? snapshot : host.save({ ...snapshot, config });
    })
    .catch(app.reportFailure);
}

export function PagesTab({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const bulkRemove = usePageBulkRemoveHost(app);
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
      bulkRemove={bulkRemove}
      renderPageSettings={(page, close) => <DesktopPageSettings app={app} page={page} close={close} />}
    />
  );
}

export function NavigatorTab({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const componentCanvas = useComponentCanvas();
  const page = app.currentPage;
  const selectNavigatorNode = (id: string | undefined): void => selectFromPanel(app, id);
  // A ::before or ::after row selects its element, and asks the Style panel
  // for that pseudo-element's selector (the count makes a repeat a new ask).
  const selectPseudo = (id: string, pseudo: 'before' | 'after'): void => {
    app.setNavigatorSelectionTick((tick) => tick + 1);
    app.setSelectedId(id);
    // The row exists only for an HTML element (StructureTree asserts it); a node
    // gone from the model since the row drew selects as itself.
    const target = parsePseudoLayerTarget(findEditorNodeById(app.model?.nodes, id), pseudo);
    if (target.ok) {
      pickPseudo(app, target.value);
    } else {
      app.setPseudoPick(undefined);
    }
  };
  // On the component canvas's page the tree is its boxes, as divs, and in each frame its closed instance
  // (canvasFrameSettings.tsx). The page is generated, so nothing on it can be changed from here.
  const canvasView = canvasNavigatorView(app, componentCanvas);
  const pseudoNodeIds = canvasView === undefined ? { before: app.stateIds.before, after: app.stateIds.after } : withoutBoxes(app.stateIds, canvasView.boxIds);
  return (
    <PanelBoundary name="The Navigator" label={translate('shell.navigator.panelName')} resetKey={page?.path}>
      <StructurePanel
        key={page?.path}
        pageState={canvasView?.pageState ?? app.pageState}
        {...(canvasView === undefined ? {} : { rowLabels: canvasView.rowLabels })}
        currentPage={page?.kind === 'route' ? { kind: 'route', route: page.route } : page}
        layouts={app.scan.layouts}
        insertables={app.insertables}
        currentLayoutName={app.currentLayoutName}
        selectedId={app.selectedId}
        emptyNodeIds={app.emptyNodeIds ?? new Set<string>()}
        hiddenNodeIds={app.stateIds.hidden}
        inertNodeIds={app.stateIds.inert}
        pseudoNodeIds={pseudoNodeIds}
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
        {...(canvasView === undefined ? { onDropInsert: app.insertItemAt, onDropComponent: app.onDropComponent, onMoveNode: app.moveNode } : CANVAS_READ_ONLY)}
        onCodeChange={app.onCodeChange}
        onOpenCodePanel={() => app.setLeftTab('code')}
        devLog={app.devLog}
      />
    </PanelBoundary>
  );
}

// What the Navigator may do on the component canvas's page, which is generated and never edited: nothing that would
// change it. Delete, Cut, Copy, Duplicate and Wrap are greyed out (canChangeStructure), Paste and drops land nowhere.
const CANVAS_READ_ONLY = {
  canChangeStructure: () => false,
  onPasteNode: () => undefined,
  hasClipboard: false,
  onMoveNode: () => undefined,
  onDropComponent: () => undefined,
} as const;

// The page's ::before and ::after rows without the canvas boxes': a box's caption is its ::before, drawn by the canvas.
function withoutBoxes(
  states: { readonly before: ReadonlySet<string>; readonly after: ReadonlySet<string> },
  boxIds: ReadonlySet<string>,
): { readonly before: ReadonlySet<string>; readonly after: ReadonlySet<string> } {
  return {
    before: new Set([...states.before].filter((id) => !boxIds.has(id))),
    after: new Set([...states.after].filter((id) => !boxIds.has(id))),
  };
}

// The Add elements panel. A click inserts at the selection through the palette's insert; a tile dragged out shows
// the Navigator over the panel until the drag ends (elementDragNavigator.ts), so it is a drop target without the
// left panel changing under the drag.
export function ElementsTab({ app }: { readonly app: ShellView }) {
  const role = useCurrentRole();
  const drag = useElementDragNavigator(canPanel(role, 'navigator') ? 'allowed' : 'denied');
  return (
    <div className="elements-tab">
      <AddElementsPanel
        allowSlot={app.currentPage?.kind === 'component'}
        onInsert={app.insertItem}
        onPickComponent={() => app.setLeftTab('components')}
        onDragPhase={drag.onDragPhase}
      />
      {navigatorShown(drag.state) && (
        <div className="elements-drag-navigator">
          <NavigatorTab app={app} />
        </div>
      )}
    </div>
  );
}

export function PaletteTab({ app }: { readonly app: ShellView }) {
  const roleRules = useComponentRoleRules(app.project.path, app.reportFailure);
  const management = useComponentManagement(app);
  // Counts that follow the open tree: an instance deleted on the page is gone from the count in the same frame.
  const components = useLiveInsertables(app);
  const canvas = useComponentCanvas();
  return (
    <PalettePanel
      canvas={canvas}
      components={components}
      roleRules={roleRules}
      management={management}
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
    void app.openComponent(name, undefined, 0, entry.path, 'jump').catch(app.reportFailure);
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
        app.setCmsFileSettings(undefined);
        if (selection) {
          app.setCmsRel(undefined);
          app.setContentName(undefined);
          app.setCmsSettings(false);
        }
      }}
      onSelectContent={(name) => {
        app.setContentName(name);
        app.setCmsFileSettings(undefined);
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
        // Any selection in the list, or closing one, leaves a file's settings.
        app.setCmsFileSettings(undefined);
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
        app.setCmsFileSettings(undefined);
        app.setCmsRel(rel);
        app.setCmsSettings(true);
      }}
      onConnect={() => openAppSettings('cms')}
      showToast={app.showToast}
      // A data file's gear opens its settings in the main view, in place of whatever was open there.
      onNavigate={() => app.setCmsFileSettings(undefined)}
      onOpenFileSettings={(file) => {
        app.setCmsRel(undefined);
        app.setCmsSettings(false);
        app.setContentName(undefined);
        app.setCmsRemote(undefined);
        app.setCmsFileSettings(file);
      }}
    />
  );
}

export function CodeTab({ app }: { readonly app: ShellView }) {
  const page = app.currentPage;
  const state = app.pageState;
  // The page's `<style>` blocks draw CSS chips; the markup around them is left as it is.
  const codeChips = useCodeChips('markup');
  if (!page || page.kind === 'route' || !state) {
    return undefined;
  }
  return (
    <CodePanel
      source={state.source}
      relativePath={app.openRel ?? page.name}
      model={app.model}
      selectedId={app.selectedId}
      revealRange={revealedCode(app.codeReveal, app.selectedId, state.source)}
      onChange={app.onCodeChange}
      onSelect={app.setSelectedId}
      onOpenComponent={(name, id) => {
        void app.openComponent(name, app.pathFor(id)).catch(app.reportFailure);
      }}
      extensions={codeChips.extension}
      overlay={codeChips.overlay}
    />
  );
}

// The code a refusal pointed at, while it still applies: its element is the one
// selected and the source still holds that code there. Anything else shows the element.
function revealedCode(reveal: CodeReveal | undefined, selectedId: string | undefined, source: string): SourceRange | undefined {
  if (reveal === undefined || reveal.nodeId !== selectedId) {
    return undefined;
  }
  return source.slice(reveal.from, reveal.to) === reveal.code ? { from: reveal.from, to: reveal.to } : undefined;
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
