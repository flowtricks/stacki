// An installed app's details, in a popup (the app's standard modal, as Load App
// From GitHub uses): a fixed header with the app's tile, its name, and one meta
// line under it (version, author, GitHub repository), Open and a ⋯ menu; then a
// body that scrolls under it, one short section after another. No footer: every
// action is in its section or the header. A row's ⋯ → Details opens it; Escape
// or a click outside closes it.
//
// The popup is for scanning, not reading: the description is cut to three lines
// with More, the facts are one-line rows (label left, value right), commands are
// a dense list, and every longer explanation sits behind a ? hint
// (AppDetailsLayout.tsx). Uninstall is one quiet red text button at the foot,
// and asks first.
//
// Sections, in order, come from APP_DETAILS_SECTIONS below. That list is the
// hook for features that add to an app's details: give a section a slot there
// and render it from a component of your own that
//   - returns `undefined` when it has nothing to show for this app (the popup
//     then skips it entirely, heading included), and
//   - wraps its content in <AppDetailsSection>, with an <AppDetailsList> of
//     <AppDetailsItem>s for short facts or <AppDetailsRow>s for form fields, so
//     it lines up with every other section.
// Its renderer receives the AppDetailsContext: the app, whether the person is an
// admin, whether an action is running, the project and the panel's actions. A
// component owns its hooks, which is why a slot renders a component rather than
// computing rows itself. The services slot lists what an app reaches outside
// Stacki and the review slot shows a folder app's secret scan (AppFolderRows.tsx).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { appAuthorLogin, type AppSummary } from '../../../shared/properties/apps';
import { appPlacePills } from '../../../shared/properties/appPlace';
import { repositoryURL } from '../../../shared/properties/appPublish';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { useTranslate, useTranslateRef } from '../../lib/i18n/useTranslate';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { GitHubIcon, HelpCircleIcon, RefreshIcon, TrashIcon } from '../../ui/Icons';
import MoreMenu, { type MenuItem } from '../../ui/MoreMenu';
import Popup from '../../ui/Popup';
import { useScrollEdges } from '../../ui/useScrollEdges';
import { AppCommandSettings } from './AppCommandSettings';
import { AppConnectionsSection } from './AppConnections';
import { AppDetailsItem, AppDetailsList, AppDetailsSection } from './AppDetailsLayout';
import { AppFolderScanSection, AppServicesSection } from './AppFolderRows';
import { AppSettingsSection } from './AppSettings';
import { AppTile } from './AppTile';
import { AppPlacePills, type AppPlaceFacts } from './appPlaces';
import { AutoUpdateSetting, appUpdatable, appUpdateStatus, updateAdditionsNote, updateStatusLabel } from './appUpdates';
import { MarketplaceIcon } from './marketplace/MarketplaceIcons';
import { appNeedsShare } from './publishFlow';
import './appDetails.css';

/** What the Apps panel lets a person do to one installed app, from its row or its details. */
export interface AppItemActions {
  readonly admin: boolean;
  readonly busy: boolean;
  readonly projectPath: string;
  readonly open: (app: AppSummary) => void;
  readonly update: (app: AppSummary) => void;
  readonly uninstall: (app: AppSummary) => void;
  readonly setAutoUpdate: (app: AppSummary, policy: { readonly autoUpdate: boolean }) => void;
  /** Opens Share to GitHub for an uploaded app; absent for a role without `apps:share`. */
  readonly share: ((app: AppSummary) => void) | undefined;
  /** Where Submit to marketplace leads for this app; absent for a role without `marketplace:publish`, `undefined` where it does not apply. */
  readonly submit: ((app: AppSummary) => (() => void) | undefined) | undefined;
}

/** What every details section is given. */
export interface AppDetailsContext {
  readonly app: AppSummary;
  /** The author's picture, drawn by the host; only shown when the app names an author. */
  readonly avatar: ReactNode;
  readonly actions: AppItemActions;
  /** Where the app lives, as its row's pills say (appPlaces.tsx). */
  readonly place: AppPlaceFacts;
}

// About and the services it may reach come first, as what the app is; then what a person sets; Uninstall last.
export const APP_DETAILS_SECTION_IDS = ['about', 'services', 'review', 'settings', 'connections', 'commands', 'updates', 'danger'] as const;
export type AppDetailsSectionId = (typeof APP_DETAILS_SECTION_IDS)[number];

/**
 * The details popup's sections, keyed by slot; the order is APP_DETAILS_SECTION_IDS.
 * A slot that renders `undefined` takes no space. See the file comment for how to fill one.
 */
export const APP_DETAILS_SECTIONS: { readonly [Id in AppDetailsSectionId]: (context: AppDetailsContext) => ReactNode } = {
  about: (context) => <AboutSection {...context} />,
  // External services: the hosts the app reaches over the network and the accounts it signs in to; nothing when it works offline.
  services: ({ app }) => <AppServicesSection app={app} />,
  // An app added to the project folder: a secret scan of its files, as information (AppFolderRows.tsx).
  review: ({ app, actions }) => <AppFolderScanSection projectPath={actions.projectPath} app={app} />,
  settings: ({ app, actions }) => <AppSettingsSection projectPath={actions.projectPath} app={app} />,
  // Connections: the app's OAuth sign-ins, connected and disconnected here (AppConnections.tsx).
  connections: ({ app, actions }) => <AppConnectionsSection projectPath={actions.projectPath} app={app} />,
  commands: ({ app, actions }) => <AppCommandSettings app={app} admin={actions.admin} />,
  updates: (context) => <UpdatesSection {...context} />,
  danger: (context) => <DangerSection {...context} />,
};

export function AppDetails(
  props: AppDetailsContext & {
    readonly onClose: () => void;
    /** The section to scroll to when it opens (an app's `app.openSettings` asks for `settings`). */
    readonly section?: AppDetailsSectionId | undefined;
  },
) {
  const { app, actions, section } = props;
  const translate = useTranslate();
  const { manifest } = app;
  assert(manifest.name.length > 0, 'An installed app has a name');
  const body = useRef<HTMLDivElement>(null);
  const { edges } = useScrollEdges(body);
  useEffect(() => {
    if (section === undefined) {
      return;
    }
    // A section may load its rows after the popup opens (App settings reads them), so look on the next frame too.
    const scroll = (): void => {
      const slot = body.current?.querySelector(`[data-app-details-section="${section}"]`);
      const shown = slot?.firstElementChild ?? undefined;
      shown?.scrollIntoView({ block: 'start' });
    };
    scroll();
    const frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [section]);
  return (
    <Popup
      className="modal apps-details-popup"
      label={translate('apps.details.popupLabel', { name: manifest.name })}
      onClose={props.onClose}
      dismissible={true}
    >
      {({ finish }) => {
        // `finish` runs its action after the exit motion but does not close; the panel forgets the popup first.
        const leave = (action: () => void) =>
          finish(() => {
            props.onClose();
            action();
          });
        return (
          <>
            <div className="modal-header apps-details-header">
              <AppTile manifest={manifest} size={40} />
              <span className="apps-details-heading">
                <span className="apps-details-name">{manifest.name}</span>
                <AppMeta app={app} avatar={props.avatar} place={props.place} />
              </span>
              <span className="apps-details-header-actions">
                <button type="button" className="apps-open primary" onClick={() => leave(() => actions.open(app))}>
                  {translate('ui.open')}
                </button>
                <MoreMenu
                  title={translate('apps.details.options', { name: manifest.name })}
                  width={200}
                  items={appMenuItems(app, actions, { details: undefined, finish: leave, place: props.place }, translate)}
                />
              </span>
            </div>
            <div ref={body} className="modal-body apps-details-body" data-edge-top={edges.top} data-edge-bottom={edges.bottom}>
              {APP_DETAILS_SECTION_IDS.map((id) => (
                // A slot draws no box of its own (`display: contents`): it only marks where its section is.
                <div key={id} className="apps-details-slot" data-app-details-section={id}>
                  {APP_DETAILS_SECTIONS[id]({ app, avatar: props.avatar, actions: wrapActions(actions, leave), place: props.place })}
                </div>
              ))}
            </div>
          </>
        );
      }}
    </Popup>
  );
}

/**
 * The ⋯ menu of an app, on its row and in its details' header alike: Details
 * (the row's only), Update when one waits, Share to GitHub…, Submit to
 * marketplace, Remove app. Each appears only where it applies. `finish` closes
 * the details popup first, for the items that open another popup or remove the app.
 */
export function appMenuItems(
  app: AppSummary,
  actions: AppItemActions,
  options: {
    readonly details: (() => void) | undefined;
    readonly finish: (action: () => void) => void;
    /** Where the app lives (appPlaces.tsx): whether it is already published decides Share, and whether it is listed decides the submit item. */
    readonly place: AppPlaceFacts;
  },
  translate: Translator,
): readonly (MenuItem | false)[] {
  const { lock } = app;
  const updating = appUpdateStatus(lock);
  const submit = actions.submit?.(app);
  const share = actions.share;
  const { published } = options.place;
  // Not yet on GitHub: Share comes first, and Submit waits. Already published (even if installed from a file), it is the other way round.
  const needsShare = appNeedsShare(lock.source, published);
  // The menu item for a first listing; a listed app has none (the marketplace follows its repository's releases).
  const submitLabel = translate('apps.menu.submit');
  return [
    options.details !== undefined && { label: translate('apps.menu.details'), icon: <HelpCircleIcon size={14} />, onSelect: options.details },
    options.details === undefined &&
      updating.kind !== 'none' &&
      actions.admin && {
        label: translate('apps.menu.updateTo', { version: updating.update.version }),
        icon: <RefreshIcon size={14} />,
        disabled: actions.busy,
        onSelect: () => actions.update(app),
      },
    needsShare &&
      share !== undefined && { label: translate('apps.menu.share'), icon: <GitHubIcon size={14} />, onSelect: () => options.finish(() => share(app)) },
    // The marketplace lists GitHub repositories, so until the app is shared there it is
    // greyed: Share to GitHub, just above, is the step that comes first.
    actions.submit !== undefined && needsShare && { label: submitLabel, icon: <MarketplaceIcon size={14} />, disabled: true },
    submit !== undefined && !needsShare && { label: submitLabel, icon: <MarketplaceIcon size={14} />, onSelect: () => options.finish(submit) },
    actions.admin && {
      label: translate('apps.menu.remove'),
      icon: <TrashIcon size={14} />,
      danger: true,
      disabled: actions.busy,
      // Asks first, as Uninstall app at the foot of the details does: it removes the app for everyone.
      onSelect: () =>
        void confirmUninstall(app, translate).then((confirmed) => {
          if (confirmed) {
            options.finish(() => actions.uninstall(app));
          }
        }),
    },
  ];
}

/** The one question before an app is removed, from a ⋯ menu or the details' foot: danger, with Cancel focused. */
export async function confirmUninstall(app: AppSummary, translate: Translator): Promise<boolean> {
  const { name } = app.manifest;
  assert(name.length > 0, 'An installed app has a name');
  const answer = await confirmDialog({
    title: translate('apps.uninstall.title', { name }),
    body: translate('apps.uninstall.body'),
    confirmLabel: translate('apps.uninstall.confirm'),
    danger: true,
  });
  return answer === true;
}

/** Inside the popup, removing the app closes it first, so the popup never outlives its app. */
function wrapActions(actions: AppItemActions, finish: (action: () => void) => void): AppItemActions {
  return { ...actions, uninstall: (app) => finish(() => actions.uninstall(app)) };
}

/**
 * The GitHub repository an app belongs to: a GitHub install names its own, a marketplace install's comes
 * from the host's lookup, and a local or uploaded app may still name the repository it updates from.
 */
function appRepository(app: AppSummary, place: AppPlaceFacts): { readonly owner: string; readonly repository: string } | undefined {
  const { manifest, lock } = app;
  return place.place ?? (lock.source.kind === 'github' ? lock.source : undefined) ?? place.published ?? manifest.source;
}

/** The line under the name: the version, the author with their picture, and the GitHub repository, each only when known. */
function AppMeta({ app, avatar, place }: Pick<AppDetailsContext, 'app' | 'avatar' | 'place'>) {
  const translate = useTranslate();
  const { manifest } = app;
  assert(manifest.version.length > 0, 'An installed app has a version');
  const author = appAuthorLogin(app);
  // A GitHub install names its repository itself; a marketplace install's comes from the host's lookup;
  // a local or uploaded app may still name the repository it updates from in its manifest.
  const repository = appRepository(app, place);
  return (
    <span className="apps-details-meta">
      <span className="apps-details-version" title={translate('apps.details.versionNamed', { version: manifest.version })}>
        v{manifest.version}
      </span>
      {/* No author, nothing: "Unknown" beside a made-up picture says nothing. */}
      {author !== undefined && (
        <span className="apps-details-author">
          {avatar}
          <span>{author}</span>
        </span>
      )}
      {repository !== undefined && (
        <a
          className="apps-details-link apps-details-repository"
          href={repositoryURL(repository.owner, repository.repository)}
          target="_blank"
          rel="noopener noreferrer"
          title={translate('apps.details.openOnGitHub', { repository: `${repository.owner}/${repository.repository}` })}
        >
          <GitHubIcon size={12} />
          <span>
            {repository.owner}/{repository.repository}
          </span>
        </a>
      )}
    </span>
  );
}

/** The description, cut to three lines, and the facts: where the app came from, where it is kept, and whether it goes online. */
function AboutSection({ app, place }: AppDetailsContext) {
  const translate = useTranslate();
  const translateRef = useTranslateRef();
  const { manifest, lock } = app;
  const pills = appPlacePills(lock.source, place);
  assert(pills.length > 0, 'Every app says where it lives');
  const explained = pills.map((pill) => `${translateRef(pill.tooltipRef)}.`).join(' ');
  const reaches = manifest.network.length + manifest.auth.length;
  return (
    <AppDetailsSection label={translate('apps.about.title')}>
      {manifest.description !== '' && <AboutText text={manifest.description} />}
      <AppDetailsList label={translate('apps.details.aboutNamed', { name: manifest.name })}>
        <AppDetailsItem label={translate('apps.about.installedFrom')}>
          <span title={installSourceLabel(lock.source, translate)}>{installSourceShortLabel(lock.source, translate)}</span>
        </AppDetailsItem>
        {place.listedVersion !== undefined && (
          <AppDetailsItem label={translate('apps.about.listed')} hint={translate('apps.about.listedHint')}>
            <ListedLatest version={place.listedVersion} repository={appRepository(app, place)} />
          </AppDetailsItem>
        )}
        {manifest.stackiVersionMin !== undefined && (
          <AppDetailsItem label={translate('apps.about.needs')} hint={translate('apps.about.needsHint')}>
            {translate('apps.about.needsVersion', { version: manifest.stackiVersionMin })}
          </AppDetailsItem>
        )}
        <AppDetailsItem label={translate('apps.about.storedIn')} hint={explained}>
          <span className="apps-details-place">
            <span>{translate('apps.about.thisProject')}</span>
            <AppPlacePills app={app} facts={place} />
          </span>
        </AppDetailsItem>
        {reaches === 0 ? (
          <AppDetailsItem label={translate('apps.about.network')}>
            <span className="apps-details-muted">{translate('apps.about.worksOffline')}</span>
          </AppDetailsItem>
        ) : (
          <AppDetailsItem label={translate('apps.about.network')} tone="warning" hint={translate('apps.about.networkHint')}>
            {translate('apps.about.reaches', { count: reaches })}
          </AppDetailsItem>
        )}
      </AppDetailsList>
    </AppDetailsSection>
  );
}

/** The listed latest version, and the repository whose releases the marketplace follows. */
function ListedLatest({
  version,
  repository,
}: {
  readonly version: string;
  readonly repository: { readonly owner: string; readonly repository: string } | undefined;
}) {
  assert(version.length > 0, 'A listing names its version');
  const translate = useTranslate();
  return (
    <span className="apps-details-listed">
      <span>v{version}</span>
      {repository !== undefined && (
        <a
          className="apps-details-link"
          href={repositoryURL(repository.owner, repository.repository)}
          target="_blank"
          rel="noopener noreferrer"
          title={translate('apps.details.openOnGitHub', { repository: `${repository.owner}/${repository.repository}` })}
        >
          {repository.owner}/{repository.repository}
        </a>
      )}
    </span>
  );
}

/** The app's description, cut to three lines (appDetails.css); More shows the rest, only when there is a rest to show. */
export function AboutText({ text }: { readonly text: string }) {
  assert(text.length > 0, 'An empty description draws nothing');
  const translate = useTranslate();
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const shown = paragraph.current;
    if (shown === null) {
      return;
    }
    if (expanded) {
      return; // Open, it shows everything; whether it overflowed closed is already known.
    }
    // One pixel of slack: a rounded line height must not read as an extra line.
    const measure = (): void => setOverflows(shown.scrollHeight > shown.clientHeight + 1);
    measure();
    // The popup lays its body out after it opens (and the width may change), so measure again whenever the text resizes.
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(shown);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <div className="apps-details-about">
      <p ref={paragraph} className="apps-details-about-text" data-expanded={expanded}>
        {text}
      </p>
      {(overflows || expanded) && (
        <button type="button" className="apps-details-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? translate('apps.about.less') : translate('apps.about.more')}
        </button>
      )}
    </div>
  );
}

function UpdatesSection({ app, actions }: AppDetailsContext) {
  const translate = useTranslate();
  const { lock } = app;
  if (!appUpdatable(lock.source)) {
    return undefined;
  }
  const status = appUpdateStatus(lock);
  // An admin installs; the hint says what the version adds when it asks for more, so the OK is an informed one.
  const hint =
    status.kind === 'none'
      ? undefined
      : (updateAdditionsNote(status.update, translate) ?? (actions.admin ? undefined : translate('apps.updates.adminCanInstall')));
  return (
    <AppDetailsSection title={translate('apps.updates.title')}>
      <AppDetailsList label={translate('apps.updates.listLabel', { name: app.manifest.name })}>
        {status.kind !== 'none' && (
          <AppDetailsItem
            label={updateStatusLabel(status, translate)}
            {...(hint === undefined ? {} : { hint })}
            {...(status.kind === 'needs-approval' ? { tone: 'warning' as const } : {})}
          >
            {actions.admin ? (
              <button type="button" className="apps-button primary apps-update-button" disabled={actions.busy} onClick={() => actions.update(app)}>
                <RefreshIcon size={12} />
                {translate('apps.updates.update')}
              </button>
            ) : (
              <span className="apps-details-muted">{translate('apps.updates.adminOnly')}</span>
            )}
          </AppDetailsItem>
        )}
        <AutoUpdateSetting app={app} admin={actions.admin} busy={actions.busy} onChange={(policy) => actions.setAutoUpdate(app, policy)} />
      </AppDetailsList>
    </AppDetailsSection>
  );
}

/**
 * Uninstall, as one quiet red text button at the foot of the popup. It removes the app for everyone in the
 * project, so it asks first, in the app's own confirmation with Cancel focused.
 */
function DangerSection({ app, actions }: AppDetailsContext) {
  const translate = useTranslate();
  if (!actions.admin) {
    return undefined;
  }
  const ask = async (): Promise<void> => {
    if (await confirmUninstall(app, translate)) {
      actions.uninstall(app);
    }
  };
  return (
    <section className="apps-details-danger" aria-label={translate('apps.danger.zone')}>
      <button type="button" className="apps-details-uninstall" disabled={actions.busy} onClick={() => void ask()}>
        <TrashIcon size={13} />
        <span>{translate('apps.danger.uninstall')}</span>
      </button>
    </section>
  );
}

/** Where an installed app came from, in full: the hover text of its "Installed from" fact. */
export function installSourceLabel(source: AppSummary['lock']['source'], translate: Translator): string {
  switch (source.kind) {
    case 'github':
      return `${source.owner}/${source.repository} · ${source.tag}`;
    case 'marketplace':
      return translate('apps.source.marketplaceVersion', { version: source.version });
    case 'file':
      return translate('apps.source.fileNamed', { fileName: source.fileName });
    case 'local':
      return translate('apps.source.localLong');
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** Where an installed app came from, in a word or two: its "Installed from" fact. */
export function installSourceShortLabel(source: AppSummary['lock']['source'], translate: Translator): string {
  switch (source.kind) {
    case 'github':
      return translate('apps.source.githubTag', { tag: source.tag });
    case 'marketplace':
      return translate('apps.source.marketplace');
    case 'file':
      return translate('apps.source.file');
    case 'local':
      return translate('apps.source.local');
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}
