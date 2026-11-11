// The Apps panel's Marketplace tab: community apps, MIT licensed and not vetted
// by Stacki, as a short muted line at the top says (shared/properties/appMarketplace.ts),
// searchable across the whole index, each with its icon, name,
// author picture and description. The list renders a page of rows at a time and
// loads the next as its end scrolls into view. An app already in the project is marked
// Installed; any other offers Install to a role with `marketplace:install`.
// Install downloads the newest approved version on the host, which installs it
// only when its SHA-256 matches the index (electron/project/appService.ts).
// When the index cannot be read (the site is down, the network is, or the
// reply is not a valid index) the tab says so calmly with a Retry button and
// keeps the technical reason to one small muted line; an index with no apps
// invites a submission instead. Shared by Desktop and Studio, like the panel
// around it.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { assert } from '../../../../shared/core/assert';
import { can, type RoleView } from '../../../../shared/properties/projectRoles';
import { appsFailureMessage, stackiVersionProblem, type AppSummary } from '../../../../shared/properties/apps';
import {
  latestApprovedVersion,
  MARKETPLACE_DISCLAIMER,
  MARKETPLACE_LICENSE,
  MARKETPLACE_LIMITS,
  MARKETPLACE_SUBMIT_URL,
  type MarketplaceApp,
  type MarketplaceIndex,
} from '../../../../shared/properties/appMarketplace';
import { installMarketplaceApp, loadMarketplace, readStackiVersion } from '../../../ipc/appMarketplaceBridge';
import { rankInsertItems } from '../../../lib/insertRank';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { SegmentedTabs } from '../../../ui/SegmentedTabs';
import { SearchField } from '../../../ui/SearchField';
import { AppsIcon, ExternalIcon, RefreshIcon } from '../../../ui/Icons';
import { appTileColor, appTileInitial } from '../AppTile';
import { MarketplaceIcon, MarketplaceInstallIcon } from './MarketplaceIcons';
import { useMarketplaceFocus } from './marketplaceRequests';
import './marketplace.css';
import { AppNetworkNote } from '../AppConnections';

type IndexLoad =
  { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'ready'; readonly index: MarketplaceIndex };

/** A marketplace app as a row the palette's ranking reads: the name first, then its description, author, id and categories. */
interface MarketplaceSearchItem {
  readonly app: MarketplaceApp;
  readonly name: string;
  readonly label: string;
  readonly sub: string;
}

/** The most pages the list can show: the whole index, a page at a time. */
const MARKETPLACE_PAGES_MAX = Math.ceil(MARKETPLACE_LIMITS.appsMax / MARKETPLACE_LIMITS.pageSize);

/** Which list the Apps panel shows: the project's apps, or the marketplace. */
export type AppsView = 'installed' | 'marketplace';

const APPS_VIEWS = [
  { view: 'installed', label: 'Installed', icon: <AppsIcon size={13} /> },
  { view: 'marketplace', label: 'Marketplace', icon: <MarketplaceIcon size={13} /> },
] as const satisfies ReadonlyArray<{ readonly view: AppsView; readonly label: string; readonly icon: ReactNode }>;

/**
 * The Installed / Marketplace switch at the top of the panel, for a role that may
 * see the marketplace: the shared segmented tabs (src/ui/SegmentedTabs.tsx), whose
 * one pill slides behind the active tab, so a tab never paints its own background
 * and hovering one changes its text alone. It fills the panel's row in equal
 * halves (`layout="equal"`); other tab rows size each tab to its label.
 */
export function AppsViewTabs({ view, onPick }: { readonly view: AppsView; readonly onPick: (view: AppsView) => void }) {
  assert(
    APPS_VIEWS.some((entry) => entry.view === view),
    'AppsViewTabs: the view is one of the tabs',
  );
  return (
    <SegmentedTabs
      tabs={APPS_VIEWS.map((entry) => ({ value: entry.view, label: entry.label, icon: entry.icon }))}
      value={view}
      label="Apps"
      // The panel's two views, across the panel's width: equal halves, not two labels at the left.
      layout="equal"
      className={{ track: 'apps-view-tabs', indicator: 'apps-view-tab-indicator', tab: 'apps-view-tab' }}
      onPick={onPick}
    />
  );
}

export function MarketplaceView({
  projectPath,
  role,
  installed,
  notify,
  avatar,
  onInstalled,
}: {
  readonly projectPath: string;
  readonly role: RoleView;
  /** Every installed app, whatever the role may open, so an installed one is never offered again. */
  readonly installed: readonly AppSummary[];
  readonly notify: (message: string, kind: 'info' | 'success' | 'error') => void;
  readonly avatar: (login: string | undefined, name: string) => ReactNode;
  readonly onInstalled: (summary: AppSummary) => void;
}) {
  assert(can(role, 'marketplace:view'), 'MarketplaceView: only a role that may see the marketplace gets the tab');
  const [load, setLoad] = useState<IndexLoad>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  // How many pages of the results are rendered; a new search or a new read starts again at one.
  const [pageCount, setPageCount] = useState(1);
  const [installing, setInstalling] = useState<string | undefined>(undefined);
  // This Stacki's version, so a row can say an app needs a newer one; `unknown` until read, which judges nothing.
  const [stackiVersion, setStackiVersion] = useState('unknown');
  useEffect(() => {
    let live = true;
    void readStackiVersion().then((version: string) => {
      if (live) {
        setStackiVersion(version);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const focus = useMarketplaceFocus();
  const bodyRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);

  const read = useCallback(
    async (freshness: { readonly refresh: boolean }) => {
      setLoad({ kind: 'loading' });
      setPageCount(1);
      try {
        const answer = await loadMarketplace(projectPath, freshness);
        setLoad(answer.ok ? { kind: 'ready', index: answer.value } : { kind: 'failed', message: answer.message });
      } catch (error: unknown) {
        setLoad({ kind: 'failed', message: appsFailureMessage(error) });
      }
    },
    [projectPath],
  );
  useEffect(() => {
    void read({ refresh: false });
  }, [read]);

  const installedIds = useMemo(() => new Set(installed.map((app) => app.manifest.id)), [installed]);
  const searchItems = useMemo(() => (load.kind === 'ready' ? marketplaceSearchItems(load.index.apps) : []), [load]);
  const results = useMemo(() => rankMarketplace(searchItems, query), [searchItems, query]);
  const shownCount = Math.min(results.length, pageCount * MARKETPLACE_LIMITS.pageSize);
  const shown = useMemo(() => results.slice(0, shownCount), [results, shownCount]);
  useNextPage({ bodyRef, sentinelRef, pageCount, more: shownCount < results.length, onNext: setPageCount });

  // The app the palette asked for may sit past the rendered pages: render enough of them to reach it.
  const focusId = focus.appId;
  useEffect(() => {
    if (focusId === undefined) {
      return;
    }
    const at = results.findIndex((app) => app.id === focusId);
    if (at >= 0) {
      const needed = Math.floor(at / MARKETPLACE_LIMITS.pageSize) + 1;
      assert(needed <= MARKETPLACE_PAGES_MAX, 'MarketplaceView: a focused app lies within the index');
      setPageCount((count) => Math.max(count, needed));
    }
  }, [focusId, results]);
  const mayInstall = can(role, 'marketplace:install');

  const install = async (app: MarketplaceApp): Promise<void> => {
    const approved = latestApprovedVersion(app);
    const answer = await confirmDialog({
      title: `Install ${app.name} ${approved.version}?`,
      body: `By ${app.author}. ${MARKETPLACE_DISCLAIMER}`,
      confirmLabel: 'Install',
    });
    if (answer !== true) {
      return;
    }
    setInstalling(app.id);
    void installMarketplaceApp(projectPath, app.id, approved.version)
      .then(
        (answer) => {
          if (answer.ok) {
            notify(`${answer.value.manifest.name} ${answer.value.manifest.version} is installed.`, 'success');
            onInstalled(answer.value);
          } else {
            notify(answer.message, 'error');
          }
        },
        (error: unknown) => notify(appsFailureMessage(error), 'error'),
      )
      .finally(() => setInstalling(undefined));
  };

  return (
    <>
      <SearchField
        className="apps-search"
        label="Search the marketplace"
        value={query}
        onChange={(next) => {
          // A new search, or a cleared one, starts again at the top of its first page.
          setQuery(next);
          setPageCount(1);
          const body = bodyRef.current;
          if (body) {
            body.scrollTop = 0;
          }
        }}
      />
      <div ref={bodyRef} className="panel-body apps-body">
        <p className="apps-market-disclaimer">{MARKETPLACE_DISCLAIMER}</p>
        <MarketplaceBody
          load={load}
          shown={shown}
          more={shownCount < results.length}
          sentinelRef={sentinelRef}
          query={query}
          installedIds={installedIds}
          mayInstall={mayInstall}
          stackiVersion={stackiVersion}
          installing={installing}
          focusId={focus.appId}
          onFocusShown={focus.shown}
          avatar={avatar}
          onInstall={(app) => void install(app)}
          onRetry={() => void read({ refresh: true })}
        />
      </div>
    </>
  );
}

function MarketplaceBody(props: {
  readonly load: IndexLoad;
  readonly shown: readonly MarketplaceApp[];
  /** Whether results remain past the rendered pages: the list then ends in the loading row the observer watches. */
  readonly more: boolean;
  readonly sentinelRef: RefObject<HTMLLIElement>;
  readonly query: string;
  readonly installedIds: ReadonlySet<string>;
  readonly mayInstall: boolean;
  readonly stackiVersion: string;
  readonly installing: string | undefined;
  readonly focusId: string | undefined;
  readonly onFocusShown: () => void;
  readonly avatar: (login: string | undefined, name: string) => ReactNode;
  readonly onInstall: (app: MarketplaceApp) => void;
  readonly onRetry: () => void;
}) {
  const { load } = props;
  switch (load.kind) {
    case 'loading':
      return (
        <div className="apps-message" role="status">
          <p>Reading the marketplace…</p>
        </div>
      );
    case 'failed':
      return <MarketplaceUnavailable detail={load.message} onRetry={props.onRetry} />;
    case 'ready':
      if (props.shown.length === 0) {
        if (props.query.trim() === '') {
          return <MarketplaceEmpty />;
        }
        return (
          <div className="apps-message">
            <p>No marketplace app matches “{props.query.trim()}”.</p>
          </div>
        );
      }
      return (
        <ul className="apps-list" aria-label="Marketplace apps">
          {props.shown.map((app) => (
            <MarketplaceRow
              key={app.id}
              app={app}
              installed={props.installedIds.has(app.id)}
              mayInstall={props.mayInstall}
              stackiVersion={props.stackiVersion}
              installing={props.installing}
              focused={props.focusId === app.id}
              onFocusShown={props.onFocusShown}
              avatar={props.avatar(app.author, app.name)}
              onInstall={props.onInstall}
            />
          ))}
          {props.more && (
            <li ref={props.sentinelRef} className="apps-market-more" role="status">
              Loading more apps…
            </li>
          )}
        </ul>
      );
    default: {
      const exhaustive: never = load;
      return exhaustive;
    }
  }
}

/** The search rows for the whole index, built once per read. */
function marketplaceSearchItems(apps: readonly MarketplaceApp[]): readonly MarketplaceSearchItem[] {
  assert(apps.length <= MARKETPLACE_LIMITS.appsMax, 'marketplaceSearchItems: the index is bounded');
  const items = apps.map((app) => ({
    app,
    name: app.name,
    label: app.name,
    sub: `${app.description} ${app.author} ${app.id} ${app.categories.join(' ')}`,
  }));
  assert(items.length === apps.length, 'marketplaceSearchItems: one row per app');
  return items;
}

/**
 * The apps that match `query` across the whole index, ranked the way the insert
 * palette ranks its app rows (src/lib/insertRank.ts): a hit on the
 * name beats one on the description, author or id. An empty query keeps the
 * index's own order. The index is at most 500 apps, so searching it all here is
 * cheap. Should the site one day split the index into pages, this is where a
 * search would move to the site's own query endpoint, and the paging below
 * would ask it for the next page instead of slicing these results.
 */
function rankMarketplace(items: readonly MarketplaceSearchItem[], query: string): readonly MarketplaceApp[] {
  assert(items.length <= MARKETPLACE_LIMITS.appsMax, 'rankMarketplace: the index is bounded');
  const ranked = rankInsertItems(items, query.slice(0, MARKETPLACE_LIMITS.queryCharsMax)).map((item) => item.app);
  assert(ranked.length <= items.length, 'rankMarketplace: a search never adds apps');
  return ranked;
}

/**
 * Renders the next page when the loading row at the end of the list comes within
 * reach of the panel's scroll container (not the window: the panel scrolls, the
 * page does not). The observer is made again for each page, so a row still in
 * view after a page renders asks for the one after it. Rows only ever append
 * below the rendered ones, so the scroll position holds. Without an
 * IntersectionObserver every page renders at once; the index is small enough.
 */
function useNextPage(options: {
  readonly bodyRef: RefObject<HTMLDivElement>;
  readonly sentinelRef: RefObject<HTMLLIElement>;
  readonly pageCount: number;
  readonly more: boolean;
  readonly onNext: Dispatch<SetStateAction<number>>;
}): void {
  const { bodyRef, sentinelRef, pageCount, more, onNext } = options;
  assert(pageCount >= 1, 'useNextPage: at least one page is rendered');
  assert(pageCount <= MARKETPLACE_PAGES_MAX, 'useNextPage: pages are bounded by the index');
  useEffect(() => {
    if (!more) {
      return;
    }
    // Moving from this page only, so a second callback for the same row cannot skip a page.
    const next = (count: number): number => (count === pageCount ? Math.min(count + 1, MARKETPLACE_PAGES_MAX) : count);
    if (typeof IntersectionObserver !== 'function') {
      onNext(MARKETPLACE_PAGES_MAX);
      return;
    }
    const sentinel = sentinelRef.current;
    if (!sentinel) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onNext(next);
        }
      },
      { root: bodyRef.current, rootMargin: '0px 0px 240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [bodyRef, sentinelRef, pageCount, more, onNext]);
}

/**
 * The index could not be read: a 404, no network, or a reply that is not a valid
 * index. All read the same to the person, who can only wait or retry; the reason
 * stays in one small muted line for whoever needs to report it.
 */
function MarketplaceUnavailable({ detail, onRetry }: { readonly detail: string; readonly onRetry: () => void }) {
  assert(detail.length > 0, 'MarketplaceUnavailable: a failed read has a reason');
  return (
    <div className="apps-market-state" role="status" aria-label="Marketplace unavailable">
      <span className="apps-market-state-icon" aria-hidden="true">
        <MarketplaceIcon size={18} />
      </span>
      <p className="apps-market-state-title">Marketplace isn’t available right now</p>
      <p className="apps-market-state-text">Your installed apps keep working. Try again in a moment.</p>
      <button type="button" className="apps-button apps-market-retry" onClick={onRetry}>
        <RefreshIcon size={12} />
        Retry
      </button>
      <p className="apps-market-state-detail">{detail}</p>
    </div>
  );
}

/** The index loaded and lists nothing yet: invite the first submission. */
function MarketplaceEmpty() {
  return (
    <div className="apps-market-state" role="status" aria-label="Marketplace empty">
      <span className="apps-market-state-icon" aria-hidden="true">
        <MarketplaceIcon size={18} />
      </span>
      <p className="apps-market-state-title">No apps in the marketplace yet</p>
      <p className="apps-market-state-text">Built an app? Send it for review and it can be listed here.</p>
      <a className="apps-market-submit" href={MARKETPLACE_SUBMIT_URL} target="_blank" rel="noopener noreferrer">
        Submit an app
        <ExternalIcon size={11} />
      </a>
    </div>
  );
}

function MarketplaceRow(props: {
  readonly app: MarketplaceApp;
  readonly installed: boolean;
  readonly mayInstall: boolean;
  readonly stackiVersion: string;
  readonly installing: string | undefined;
  readonly focused: boolean;
  readonly onFocusShown: () => void;
  readonly avatar: ReactNode;
  readonly onInstall: (app: MarketplaceApp) => void;
}) {
  const { app, focused, onFocusShown } = props;
  const latest = latestApprovedVersion(app);
  const row = useRef<HTMLLIElement>(null);
  // The app the palette asked for is scrolled into view once, then the request is spent.
  useEffect(() => {
    if (focused) {
      row.current?.scrollIntoView({ block: 'nearest' });
      onFocusShown();
    }
  }, [focused, onFocusShown]);
  return (
    <li ref={row} className={`apps-market-row${focused ? ' focused' : ''}`}>
      <MarketplaceAppIcon app={app} />
      <span className="apps-row-text">
        <span className="apps-row-name">
          <span className="apps-row-title">{app.name}</span>
          {app.license === MARKETPLACE_LICENSE && <span className="apps-badge muted">{MARKETPLACE_LICENSE}</span>}
          {latest.stackiVersionMin !== undefined && (
            <span className="apps-badge muted" title={`Needs Stacki ${latest.stackiVersionMin} or later`}>
              Stacki {latest.stackiVersionMin}+
            </span>
          )}
        </span>
        <span className="apps-market-byline">
          <span className="apps-row-avatar">{props.avatar}</span>
          <span>by {app.author}</span>
        </span>
        <span className="apps-market-description">{app.description}</span>
        {app.network !== undefined && <AppNetworkNote network={app.network} />}
      </span>
      <span className="apps-market-side">
        <MarketplaceAction {...props} />
        <span className="apps-row-version">v{latest.version}</span>
      </span>
    </li>
  );
}

function MarketplaceAction(props: {
  readonly app: MarketplaceApp;
  readonly installed: boolean;
  readonly mayInstall: boolean;
  readonly stackiVersion: string;
  readonly installing: string | undefined;
  readonly onInstall: (app: MarketplaceApp) => void;
}) {
  if (props.installed) {
    return <span className="apps-badge muted">Installed</span>;
  }
  if (!props.mayInstall) {
    return undefined;
  }
  const latest = latestApprovedVersion(props.app);
  // The host refuses it too (appService.ts); the row says so first, so Install is never a dead end.
  const tooOld = stackiVersionProblem(latest.stackiVersionMin, props.stackiVersion);
  return (
    <button
      type="button"
      className="apps-button primary"
      title={tooOld ?? `Install ${props.app.name} ${latest.version}, approved with SHA-256 ${latest.sha256.slice(0, 12)}…`}
      disabled={props.installing !== undefined || tooOld !== undefined}
      onClick={() => props.onInstall(props.app)}
    >
      <span className="apps-header-actions">
        <MarketplaceInstallIcon size={12} />
        {props.installing === props.app.id ? 'Installing…' : 'Install'}
      </span>
    </button>
  );
}

/** The reviewed icon stacki.build serves, or the app's lettered tile when it does not load. */
export function MarketplaceAppIcon({ app }: { readonly app: Pick<MarketplaceApp, 'id' | 'name' | 'iconURL'> }) {
  const [failed, setFailed] = useState(false);
  if (!failed) {
    return <img className="apps-market-icon" src={app.iconURL} alt="" width={32} height={32} onError={() => setFailed(true)} />;
  }
  return (
    <span className="apps-tile lettered apps-market-icon" aria-hidden="true" style={{ background: appTileColor(app.id), fontSize: 14 }}>
      {appTileInitial(app.name)}
    </span>
  );
}
