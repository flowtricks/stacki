// The Apps panel (rail key E). A heading with a + menu of every way to add an
// app (Load App From GitHub; Build an app, which opens the AI chat with the build
// prompt waiting unsent in its message box, appPrompt.ts), a
// search field over the installed apps, and one row per app: its icon tile,
// name, one-line description, where it lives (Local, GitHub · Private
// or Public, Marketplace: appPlaces.tsx) and its author's picture when the app
// names an author, with Open, Update
// and a ⋯ menu (Details, Share to GitHub…, Submit to marketplace, Remove app) on
// hover. With no apps, a short empty state points at the + menu. A running panel
// app takes the panel's place until it is closed. Admins install, update and
// remove; other roles see the apps their role allows (`app:<id>`). A role with
// `marketplace:view` also gets an Installed / Marketplace switch: the Marketplace
// tab lists community apps (marketplace/MarketplaceView.tsx), installable with
// `marketplace:install`. Share to GitHub (`apps:share`, ShareApp.tsx) applies to
// an uploaded app that no repository holds yet; Submit to marketplace
// (`marketplace:publish`, PublishMarketplace.tsx) opens the publish popup at the
// app's own repository (or, for a file or folder app already on GitHub, at that one,
// publishFlow.ts appPublication), or leads an uploaded app through Share first. An app
// the marketplace already lists has no Submit: the marketplace follows its repository's
// releases, so a new version is a new GitHub release. A row click opens the app's
// details popup (AppDetails.tsx): about, App settings, commands, updates and
// Uninstall. Shared by Desktop and Studio: the host supplies its role, how to
// draw a GitHub picture and its GitHub sign-in.
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { can, type RoleView } from '../../../shared/properties/projectRoles';
import { appAuthorLogin, type AppStaged, type AppSummary, type AppsResult } from '../../../shared/properties/apps';
import { appAccessFeature } from '../../../shared/properties/appsRpc';
import { applyAppUpdate, commitApp, discardApp, listInstalledAppList, uninstallApp } from '../../ipc/appsBridge';
import { setAppAutoUpdate } from '../../ipc/appMarketplaceBridge';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { AppsIcon, GitHubIcon, PlusIcon, SparkleIcon, RefreshIcon, WarningTriangleIcon } from '../../ui/Icons';
import { SearchField } from '../../ui/SearchField';
import MoreMenu from '../../ui/MoreMenu';
import { AppTile } from './AppTile';
import { AppRowCount, keepAppBadges } from './appBadges';
import { ConnectGitHub, type ConnectGitHubProps } from './ConnectGitHub';
import { requestBuildApp } from './appPrompt';
import { useAppsPanelRequest } from './appsDirectory';
import { useAppDetailsRequest } from './appDetailsRequests';
import { launchApp, stopApp, useAppsRuntime } from './appsRuntime';
import { appOpeningMode, shownDockedApp } from './appWindowPreferences';
import { AppDockSlot } from './AppWindows';
import { useAppsRefresh } from './appsRefresh';
import { BrokenAppRow } from './AppFolderRows';
import { listBrokenAppFolders } from '../../ipc/appFoldersBridge';
import { joinBrokenRows, type AppFolderBroken } from '../../../shared/properties/appFolders';
import { appUpdateStatus, noteInstalledApps, updateStatusLabel } from './appUpdates';
import { AppDetails, appMenuItems, type AppDetailsSectionId, type AppItemActions } from './AppDetails';
import { AppPlacePills, NO_APP_PLACE_FACTS, useAppPlaces, type AppPlaceFacts } from './appPlaces';
import { AppsViewTabs, MarketplaceView, type AppsView } from './marketplace/MarketplaceView';
import { PublishMarketplace, type PublishMarketplaceProps } from './PublishMarketplace';
import { ShareApp } from './ShareApp';
import { marketplaceSubmitRoute, uploadedApps } from './publishFlow';
import type { AppRepositoryRef } from '../../../shared/properties/appPublish';
import './apps.css';
import { AppNetworkNote } from './AppConnections';
import { installedAppsCache, type KeptInstalledApps } from './installedAppsCache';

export interface AppsPanelProps {
  readonly projectPath: string;
  readonly role: RoleView;
  /** Shows a short notice; the host's toast. */
  readonly notify: (message: string, kind: 'info' | 'success' | 'error') => void;
  /** Draws a GitHub user's picture with a fallback initial; the panel draws an initial alone without it. */
  readonly renderAvatar?: (login: string | undefined, name: string) => ReactNode;
  /** The host's GitHub sign-in (the publish flow's), for the connect popup. */
  readonly renderSignIn?: ConnectGitHubProps['renderSignIn'];
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string; readonly messageRef?: MessageRef | undefined }
  | { readonly kind: 'ready'; readonly apps: readonly AppSummary[] };

function keptInstalledApps(projectPath: string): KeptInstalledApps | undefined {
  const kept = installedAppsCache.get(projectPath);
  return kept?.kind === 'ready' ? kept.value : undefined;
}

export default function AppsPanel(props: AppsPanelProps) {
  const { projectPath } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  // The kept list (installedAppsCache.ts) draws in the first frame; reload refreshes it in place.
  const [kept] = useState(() => keptInstalledApps(projectPath));
  const [load, setLoad] = useState<Load>(() => (kept === undefined ? { kind: 'loading' } : { kind: 'ready', apps: kept.list.apps }));
  // Folders in .stacki/apps that do not read as an app: rows of the same Installed list (AppFolderRows.tsx).
  const [brokenFolders, setBrokenFolders] = useState<readonly AppFolderBroken[]>(() => kept?.brokenFolders ?? []);
  // Apps the host listed that this editor cannot read: broken rows too, so one bad app never hides the rest.
  const [unreadable, setUnreadable] = useState<readonly AppFolderBroken[]>(() => kept?.list.broken ?? []);
  const broken = useMemo(() => joinBrokenRows(brokenFolders, unreadable), [brokenFolders, unreadable]);
  const [query, setQuery] = useState('');
  const [details, setDetails] = useState<string | undefined>(undefined);
  const [staged, setStaged] = useState<AppStaged | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
  // Share app (an uploaded app) and Publish to marketplace (a repository to start on, or an installed app's own).
  const [sharing, setSharing] = useState<{ readonly app: AppSummary | undefined } | undefined>(undefined);
  const [publishing, setPublishing] = useState<
    { readonly initial: AppRepositoryRef | undefined; readonly preselect: PublishMarketplaceProps['preselect'] } | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<AppsView>('installed');
  const runtime = useAppsRuntime();
  const refreshTick = useAppsRefresh();
  const avatar = (login: string | undefined, name: string) => avatarOf(props, login, name);

  const reload = useCallback(async () => {
    const folders = listBrokenAppFolders(projectPath).then(
      (answer) => (answer.ok ? answer.value : []),
      () => [], // A host without folder apps lists the apps alone.
    );
    void folders.then(setBrokenFolders);
    try {
      const answer = await listInstalledAppList(projectPath);
      if (answer.ok) {
        noteInstalledApps(answer.value.apps);
        keepAppBadges(answer.value.apps.map((app) => app.manifest.id));
        setUnreadable(answer.value.broken);
        const list = answer.value;
        void folders.then((brokenFolders) => installedAppsCache.set(projectPath, { list, brokenFolders }));
      }
      setLoad(answer.ok ? { kind: 'ready', apps: answer.value.apps } : { kind: 'failed', message: answer.message, messageRef: answer.messageRef });
    } catch (error: unknown) {
      setLoad({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, [projectPath]);
  useEffect(() => {
    void reload();
  }, [reload, refreshTick]);

  const run = async <T,>(action: () => Promise<AppsResult<T>>, done: (value: T) => void): Promise<void> => {
    setBusy(true);
    try {
      const answer = await action();
      if (answer.ok) {
        done(answer.value);
      } else {
        props.notify(translateDescribed(answer), 'error');
      }
    } catch (error: unknown) {
      props.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const admin = props.role.isAdmin;
  const marketplaceShown = can(props.role, 'marketplace:view');
  const mayShare = can(props.role, 'apps:share');
  const mayPublish = can(props.role, 'marketplace:publish');
  const install: InstallActions = {
    admin,
    busy,
    marketplace: marketplaceShown ? () => setView('marketplace') : undefined,
    // Connecting and reviewing an upload happen on the Installed tab.
    connect: () => {
      setView('installed');
      setConnecting(true);
    },
    buildApp: () => void requestBuildApp(translate, props.notify),
  };
  usePanelRequests(install);
  // An app asking for its own settings (`app.openSettings`): its details open at that section.
  const [detailsSection, setDetailsSection] = useState<AppDetailsSectionId | undefined>(undefined);
  const { request: detailsRequest, handled: detailsHandled } = useAppDetailsRequest();
  useEffect(() => {
    if (detailsRequest === undefined) {
      return;
    }
    const request = detailsRequest;
    detailsHandled(request);
    setView('installed');
    setDetails(request.appId);
    setDetailsSection(request.section);
  }, [detailsRequest, detailsHandled]);

  const visible = useMemo(
    () => (load.kind === 'ready' ? load.apps.filter((app) => can(props.role, appAccessFeature(app.manifest.id))) : []),
    [load, props.role],
  );
  // Where each app lives (Local, GitHub · Private or Public, Marketplace): the rows' pills and the details' About.
  // The index also tells whether a file or folder app is already listed, so Submit can say "new version" (a role that publishes sees the marketplace).
  const places = useAppPlaces(projectPath, visible, { marketplace: marketplaceShown });
  const panelApp = shownDockedApp(runtime.running, props.role);
  const appActions: AppActions = {
    admin,
    busy,
    projectPath,
    share: mayShare ? (app) => setSharing({ app }) : undefined,
    submit: mayPublish
      ? (app) => {
          const route = marketplaceSubmitRoute(app.lock.source, { mayShare, publication: places.get(app.manifest.id)?.published });
          switch (route.kind) {
            case 'publish':
              return () => setPublishing({ initial: undefined, preselect: { owner: route.owner, repository: route.repository, account: route.account } });
            case 'share-first':
              return () => setSharing({ app });
            case 'none':
              return undefined;
            default: {
              const exhaustive: never = route;
              return exhaustive;
            }
          }
        }
      : undefined,
    open: (app) => launchApp(app, appOpeningMode(projectPath, app)),
    showDetails: (app) => setDetails(app.manifest.id),
    setAutoUpdate: (app, policy) =>
      void run(
        () => setAppAutoUpdate(projectPath, app.manifest.id, policy),
        () => {
          props.notify(
            policy.autoUpdate
              ? translate('apps.panel.autoUpdateOn', { name: app.manifest.name })
              : translate('apps.panel.autoUpdateOff', { name: app.manifest.name }),
            'info',
          );
          void reload();
        },
      ),
    update: (app) =>
      void run(
        () => applyAppUpdate(projectPath, app.manifest.id),
        (summary) => {
          stopApp(app.manifest.id);
          props.notify(translate('apps.panel.updated', { name: summary.manifest.name, version: summary.manifest.version }), 'success');
          void reload();
        },
      ),
    uninstall: (app) =>
      void run(
        () => uninstallApp(projectPath, app.manifest.id),
        () => {
          stopApp(app.manifest.id);
          props.notify(translate('apps.panel.removed', { name: app.manifest.name }), 'info');
          void reload();
        },
      ),
  };

  // The docked app's window (AppsHost) covers this slot; its frame never moves into the panel.
  const shownDetails = visible.find((app) => app.manifest.id === details);
  // The details of an app no longer listed (removed, or out of the role's reach) close with it.
  const detailsPopup = shownDetails !== undefined && (
    <AppDetails
      app={shownDetails}
      avatar={avatar(appAuthorLogin(shownDetails), shownDetails.manifest.name)}
      place={places.get(shownDetails.manifest.id) ?? NO_APP_PLACE_FACTS}
      actions={appActions}
      section={detailsSection}
      onClose={() => {
        setDetails(undefined);
        setDetailsSection(undefined);
      }}
    />
  );
  if (panelApp !== undefined) {
    // A docked app that opens its own settings sees its details over its window.
    return (
      <>
        <AppDockSlot />
        {detailsPopup}
      </>
    );
  }
  const hasApps = load.kind === 'ready' && visible.length + broken.length > 0;
  return (
    <div className="apps-panel">
      <div className="panel-header apps-header">
        <h2>{translate('apps.panel.title')}</h2>
        <span className="apps-header-actions">
          <InstallMenu install={install} />
        </span>
      </div>
      {sharing !== undefined && (
        <ShareApp
          projectPath={projectPath}
          app={sharing.app}
          uploaded={load.kind === 'ready' ? uploadedApps(load.apps, { published: (app) => places.get(app.manifest.id)?.published !== undefined }) : []}
          renderSignIn={props.renderSignIn}
          renderAvatar={avatar}
          notify={props.notify}
          onClose={() => setSharing(undefined)}
          onSwitched={(summary) => {
            props.notify(translate('apps.panel.switchedToRelease', { name: summary.manifest.name }), 'success');
            void reload();
          }}
          onSubmitToMarketplace={
            mayPublish
              ? (shared, account) => {
                  setSharing(undefined);
                  setPublishing({ initial: { owner: shared.owner, repository: shared.repository, account }, preselect: undefined });
                }
              : undefined
          }
        />
      )}
      {publishing !== undefined && (
        <PublishMarketplace
          projectPath={projectPath}
          installed={load.kind === 'ready' ? load.apps : []}
          isPublished={(app) => places.get(app.manifest.id)?.published !== undefined}
          initial={publishing.initial}
          preselect={publishing.preselect}
          renderSignIn={props.renderSignIn}
          renderAvatar={avatar}
          onClose={() => setPublishing(undefined)}
          onShareUploaded={(app) => {
            setPublishing(undefined);
            setSharing(mayShare ? { app } : undefined);
            if (!mayShare) {
              props.notify(translate('apps.panel.roleCannotShare'), 'info');
            }
          }}
        />
      )}
      {marketplaceShown && <AppsViewTabs view={view} onPick={setView} />}
      {marketplaceShown && view === 'marketplace' ? (
        <MarketplaceView
          projectPath={projectPath}
          role={props.role}
          installed={load.kind === 'ready' ? load.apps : []}
          notify={props.notify}
          avatar={avatar}
          onInstalled={() => void reload()}
        />
      ) : (
        <>
          {staged !== undefined && (
            <InstallReview
              staged={staged}
              avatar={avatar(staged.manifest.authorGitHub ?? (staged.source.kind === 'github' ? staged.source.owner : undefined), staged.manifest.name)}
              busy={busy}
              onCancel={() => {
                void discardApp(projectPath, staged.token);
                setStaged(undefined);
              }}
              onInstall={() =>
                void run(
                  () => commitApp(projectPath, staged.token),
                  (summary) => {
                    setStaged(undefined);
                    props.notify(translate('apps.panel.installed', { name: summary.manifest.name, version: summary.manifest.version }), 'success');
                    void reload();
                  },
                )
              }
            />
          )}
          {connecting && (
            <ConnectGitHub
              projectPath={projectPath}
              renderSignIn={props.renderSignIn}
              renderAvatar={avatar}
              onClose={() => setConnecting(false)}
              onStaged={(value) => {
                setConnecting(false);
                setStaged(value);
              }}
            />
          )}
          {hasApps && <SearchField className="apps-search" label={translate('apps.panel.search')} value={query} onChange={setQuery} />}
          <AppsBody load={load} apps={visible} broken={broken} query={query} install={install} actions={appActions} avatar={avatar} places={places} />
          {/* The details of an app no longer listed (removed, or out of the role's reach) close with it. */}
          {detailsPopup}
        </>
      )}
    </div>
  );
}

// A request from elsewhere (the command palette) runs here once, as the button would.
function usePanelRequests(install: InstallActions): void {
  const { request, handled } = useAppsPanelRequest();
  const latest = useLatest(install);
  useEffect(() => {
    if (request === undefined) {
      return;
    }
    handled();
    const actions = latest();
    // Browsing the marketplace is the role's `marketplace:view`, not admin's alone.
    if (request === 'marketplace') {
      actions.marketplace?.();
      return;
    }
    if (!actions.admin) {
      return;
    }
    actions.connect();
  }, [request, handled, latest]);
}

function useLatest<T>(value: T): () => T {
  const [box] = useState<{ current: T }>(() => ({ current: value }));
  box.current = value;
  return useCallback(() => box.current, [box]);
}

export interface InstallActions {
  readonly admin: boolean;
  readonly busy: boolean;
  /** Shows the Marketplace tab; absent for a role without `marketplace:view`. */
  readonly marketplace?: (() => void) | undefined;
  readonly connect: () => void;
  /** Opens the AI chat with the build prompt in its message box, unsent (appPrompt.ts). */
  readonly buildApp: () => void;
}

interface AppActions extends AppItemActions {
  /** Opens the app's details popup. */
  readonly showDetails: (app: AppSummary) => void;
}

/**
 * The header's + menu: every way to add an app, in the order every surface
 * uses (Load App From GitHub, Build an app), whether or not apps are installed.
 * A role that cannot install gets Build an app alone, which needs no install
 * rights. Submitting an app to the marketplace is not here: it is in the app's
 * own ⋯ menu (Share to GitHub, Submit to marketplace); browsing the marketplace
 * is the panel's Marketplace tab.
 */
export function InstallMenu({ install }: { readonly install: InstallActions }) {
  const translate = useTranslate();
  return (
    <MoreMenu
      className="ghost"
      title={translate('apps.panel.add')}
      icon={<PlusIcon size={13} />}
      width={240}
      items={[
        // The same sparkle as the AI chat's rail button: the item opens that chat. First, because building is the common start.
        { label: translate('apps.build.label'), icon: <SparkleIcon size={14} />, onSelect: install.buildApp },
        install.admin && { label: translate('apps.loadFromGitHub'), icon: <GitHubIcon size={14} />, disabled: install.busy, onSelect: install.connect },
      ]}
    />
  );
}

function AppsBody({
  load,
  apps,
  broken,
  query,
  install,
  actions,
  avatar,
  places,
}: {
  readonly load: Load;
  readonly apps: readonly AppSummary[];
  readonly broken: readonly AppFolderBroken[];
  readonly query: string;
  readonly install: InstallActions;
  readonly actions: AppActions;
  readonly avatar: (login: string | undefined, name: string) => ReactNode;
  readonly places: ReadonlyMap<string, AppPlaceFacts>;
}) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  if (load.kind === 'loading') {
    return (
      <div className="panel-body apps-body" role="status" aria-label={translate('apps.panel.loading')}>
        {[0, 1, 2].map((index) => (
          <div key={index} className="apps-skeleton">
            <span className="apps-skeleton-tile" />
            <span className="apps-skeleton-lines">
              <span />
              <span />
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (load.kind === 'failed') {
    return (
      <div className="panel-body apps-body">
        <div className="apps-message" role="alert">
          <WarningTriangleIcon size={20} />
          <p>{translateDescribed(load)}</p>
        </div>
      </div>
    );
  }
  if (apps.length + broken.length === 0) {
    return (
      <div className="panel-body apps-body">
        <EmptyApps install={install} />
      </div>
    );
  }
  const needle = query.trim().toLowerCase();
  const shown =
    needle === '' ? apps : apps.filter((app) => `${app.manifest.name} ${app.manifest.description} ${app.manifest.id}`.toLowerCase().includes(needle));
  // One list in folder-name order: an app's id is its folder's name, so broken folders sort among the apps.
  const rows = [
    ...shown.map((app) => ({ key: app.manifest.id, app, broken: undefined })),
    ...broken
      .filter((folder) => `${folder.folder} ${folder.message} ${translateDescribed(folder)}`.toLowerCase().includes(needle))
      .map((folder) => ({ key: folder.folder, app: undefined, broken: folder })),
  ].sort((left, right) => (left.key < right.key ? -1 : 1));
  return (
    <div className="panel-body apps-body">
      <div className="apps-section-title">{translate('apps.panel.installedHeading')}</div>
      {rows.length === 0 && (
        <div className="apps-message">
          <p>{translate('apps.panel.noMatch', { query: query.trim() })}</p>
        </div>
      )}
      <ul className="apps-list">
        {rows.map((row) =>
          row.app !== undefined ? (
            <AppRow
              key={row.key}
              app={row.app}
              avatar={avatar(appAuthorLogin(row.app), row.app.manifest.name)}
              actions={actions}
              place={places.get(row.key) ?? NO_APP_PLACE_FACTS}
            />
          ) : (
            row.broken !== undefined && <BrokenAppRow key={row.key} broken={row.broken} projectPath={actions.projectPath} />
          ),
        )}
      </ul>
    </div>
  );
}

export function EmptyApps({ install }: { readonly install: InstallActions }) {
  const translate = useTranslate();
  return (
    <div className="apps-empty">
      <span className="apps-empty-icon" aria-hidden="true">
        <AppsIcon size={24} />
      </span>
      <p>{translate('apps.panel.emptyTitle')}</p>
      <p className="apps-note">
        {install.admin ? translate('apps.panel.emptyAdmin') : translate('apps.panel.emptyMember', { action: translate('apps.build.label') })}
      </p>
    </div>
  );
}

/**
 * One installed app. The row is a grid (apps.css): tile, a text column that
 * takes the remaining space, and one slot shared by the meta (version, avatar)
 * and the actions (Update, Open, ⋯). Hover or focus swaps the meta for the
 * actions in that slot, so state-specific actions belong in `.apps-row-actions`
 * and state-specific labels in the text column. A click anywhere on the row (or
 * Enter or Space on the focused row) opens the app, the same as Open; the actions
 * are siblings of the select button, so their clicks never reach it. Details opens
 * from the ⋯ menu only. Exported for the layout test.
 */
export function AppRow({
  app,
  avatar,
  actions,
  place,
}: {
  readonly app: AppSummary;
  readonly avatar: ReactNode;
  readonly actions: AppActions;
  /** What the host said about where the app lives; absent shows what the lockfile alone tells. */
  readonly place?: AppPlaceFacts | undefined;
}) {
  const translate = useTranslate();
  const { manifest, lock } = app;
  // No author, no picture: an initial made up from the app's name says nothing (the details' rule too).
  const author = appAuthorLogin(app);
  const updating = appUpdateStatus(lock);
  // Open means running in the host's store, docked or popped out: launching an open app keeps its one window (launchApp).
  const open = useAppsRuntime().running.some((running) => running.app.manifest.id === manifest.id);
  return (
    <li className="apps-row">
      <div className="apps-row-main" data-open={open}>
        <button
          type="button"
          className="apps-row-select"
          aria-label={translate('apps.panel.openNamed', { name: manifest.name })}
          aria-current={open ? 'true' : undefined}
          onClick={() => actions.open(app)}
        >
          <AppTile manifest={manifest} size={40} />
          <span className="apps-row-text">
            <span className="apps-row-name">
              <span className="apps-row-title">{manifest.name}</span>
              {open && <span className="apps-row-open-dot" aria-hidden="true" />}
              <AppRowCount appId={manifest.id} name={manifest.name} />
            </span>
            {/* Who made it, as their GitHub picture, leads the description line. */}
            <span className="apps-row-byline">
              {author !== undefined && <span className="apps-row-avatar">{avatar}</span>}
              {updating.kind !== 'none' ? (
                <span className="apps-row-description apps-row-update" data-needs-ok={updating.kind === 'needs-approval'}>
                  {updateStatusLabel(updating, translate)}
                </span>
              ) : (
                <span className="apps-row-description">{manifest.description || translate('apps.details.versionNamed', { version: manifest.version })}</span>
              )}
            </span>
          </span>
          <span className="apps-row-meta">
            <AppPlacePills app={app} facts={place ?? NO_APP_PLACE_FACTS} />
          </span>
        </button>
        <span className="apps-row-actions">
          {updating.kind !== 'none' && actions.admin && (
            <button
              type="button"
              className="apps-icon-button"
              title={translate('apps.menu.updateTo', { version: updating.update.version })}
              aria-label={translate('apps.panel.updateNamed', { name: manifest.name })}
              disabled={actions.busy}
              onClick={() => actions.update(app)}
            >
              <RefreshIcon size={14} />
            </button>
          )}
          <button type="button" className="apps-open primary" onClick={() => actions.open(app)}>
            {translate('ui.open')}
          </button>
          <MoreMenu
            title={translate('apps.details.options', { name: manifest.name })}
            width={200}
            items={appMenuItems(
              app,
              actions,
              { details: () => actions.showDetails(app), finish: (action) => action(), place: place ?? NO_APP_PLACE_FACTS },
              translate,
            )}
          />
        </span>
      </div>
    </li>
  );
}

function InstallReview({
  staged,
  avatar,
  busy,
  onCancel,
  onInstall,
}: {
  readonly staged: AppStaged;
  readonly avatar: ReactNode;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onInstall: () => void;
}) {
  const translate = useTranslate();
  const { manifest } = staged;
  return (
    <div className="apps-card" role="dialog" aria-label={translate('apps.panel.installNamed', { name: manifest.name })}>
      <div className="apps-card-head">
        <AppTile manifest={manifest} size={40} />
        <span className="apps-card-title">
          <strong>{manifest.name}</strong>
          <span>
            {manifest.version}
            {staged.replaces !== undefined ? ` · ${translate('apps.panel.replaces', { name: staged.replaces })}` : ''}
          </span>
        </span>
        <span className="apps-row-avatar">{avatar}</span>
      </div>
      {manifest.description !== '' && <p>{manifest.description}</p>}
      <AppNetworkNote network={manifest.network} />
      <p className="apps-note">SHA-256 {staged.sha256.slice(0, 16)}…</p>
      <div className="apps-actions">
        <button type="button" className="apps-button primary" disabled={busy} onClick={onInstall}>
          {translate('apps.panel.install')}
        </button>
        <button type="button" className="apps-button" disabled={busy} onClick={onCancel}>
          {translate('ui.cancel')}
        </button>
      </div>
    </div>
  );
}

function avatarOf(props: AppsPanelProps, login: string | undefined, name: string): ReactNode {
  if (props.renderAvatar !== undefined) {
    return props.renderAvatar(login, name);
  }
  return (
    <span className="apps-initial" aria-hidden="true">
      {(login ?? name).slice(0, 1).toUpperCase()}
    </span>
  );
}
