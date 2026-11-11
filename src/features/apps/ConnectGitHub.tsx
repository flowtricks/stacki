// "Load App From GitHub": a popup that picks an app from GitHub without typing
// paths. One field searches the repositories of the account signed in for
// publishing (the publish flow's own account and sign-in, never a new one) and
// takes a pasted public repository (owner/repo or a github.com address) as well;
// repositories tagged with the `stacki-app` topic are listed first. Then the
// chosen repository's releases (newest first, pre-releases marked), then the app
// bundle among the release's assets: the one `.zip` when there is one, or a
// choice. "Check release" downloads and checks the bundle and shows its icon,
// name and version; "Install" installs exactly those bytes. Studio has no
// sign-in, so there the pasted repository is the whole path.
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  orderReleases,
  releaseAssetChoice,
  type AppGitHubSource,
  type AppRelease,
  type AppRepository,
  type AppRepositoryListing,
  type AppStaged,
} from '../../../shared/properties/apps';
import { assert } from '../../../shared/core/assert';
import { discoverPublishing } from '../../ipc/publishDiscoveryBridge';
import { listAppReleases, listAppRepositories, stageGitHubApp } from '../../ipc/appsBridge';
import Dropdown from '../../ui/Dropdown';
import Popup from '../../ui/Popup';
import { AppsIcon, ClockIcon, GitHubIcon, RefreshIcon, SearchIcon, WarningTriangleIcon } from '../../ui/Icons';
import { CodeInline } from '../../ui/CodeBlock';
import { useScrollEdges } from '../../ui/useScrollEdges';
import { AppTile } from './AppTile';
import {
  LOAD_FROM_GITHUB_LABEL,
  chooserPickables,
  chooserRows,
  hasStackiApps,
  moveChooserActive,
  type ChooserPickable,
  type ChooserRow,
} from './repositoryChooser';

export type Load<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly value: T };

export interface ConnectGitHubProps {
  readonly projectPath: string;
  /** The publish flow's sign-in, drawn by the host; undefined where the host has none (Studio). */
  readonly renderSignIn?: ((done: () => void, cancel: () => void) => ReactNode) | undefined;
  readonly renderAvatar: (login: string | undefined, name: string) => ReactNode;
  readonly onClose: () => void;
  /** A checked bundle, ready to install; the panel confirms and commits it. */
  readonly onStaged: (staged: AppStaged) => void;
}

/** What the chooser has settled: the repository (and the account that reads it), the release and the asset. */
interface Pick {
  readonly owner: string;
  readonly repository: string;
  readonly account: string | undefined;
}

/** Where the docs say how to add the `stacki-app` topic to a repository. */
export const STACKI_APP_TOPIC_HELP_URL = 'https://stacki.build/docs/apps#publishing-through-github-releases';

/** "3 days ago", "today": how long since an ISO time, for the lists. */
export function sinceLabel(iso: string, nowMs: number): string {
  const days = Math.floor((nowMs - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} month${months === 1 ? '' : 's'} ago` : `${Math.floor(months / 12)} year${months < 24 ? '' : 's'} ago`;
}

export function ConnectGitHub(props: ConnectGitHubProps) {
  const [signingIn, setSigningIn] = useState(false);
  const [pick, setPick] = useState<Pick | undefined>(undefined);
  const [discovery, setDiscovery] = useState(0);
  const { accounts, account, setAccount } = usePublishAccounts(props.projectPath, discovery);
  // A host without the publish sign-in (Studio) cannot list an account's
  // repositories either, so there the pasted public repository is the whole path.
  const listAccount = props.renderSignIn === undefined ? undefined : account;
  const [attempt, setAttempt] = useState(0);
  const repositories = useRepositories(props.projectPath, listAccount, attempt);

  if (signingIn && props.renderSignIn !== undefined) {
    return props.renderSignIn(
      () => {
        setSigningIn(false);
        setDiscovery((count) => count + 1);
      },
      () => setSigningIn(false),
    );
  }
  const renderSignIn = props.renderSignIn;
  const list = chooserList({
    accounts,
    account: listAccount,
    repositories,
    signIn: renderSignIn === undefined ? undefined : () => setSigningIn(true),
    retry: () => setAttempt((count) => count + 1),
  });
  return (
    <Popup className="modal apps-connect" label={LOAD_FROM_GITHUB_LABEL} onClose={props.onClose} dismissible={true}>
      {({ close }) => (
        <ConnectFrame onCancel={close}>
          {pick === undefined ? (
            <RepositoryChooser
              accounts={accounts.kind === 'ready' ? accounts.value : []}
              account={listAccount}
              list={list}
              onAccount={setAccount}
              renderAvatar={props.renderAvatar}
              onPick={(chosen) => setPick(chosen)}
            />
          ) : (
            <ReleaseStep projectPath={props.projectPath} pick={pick} onBack={() => setPick(undefined)} onStaged={props.onStaged} />
          )}
        </ConnectFrame>
      )}
    </Popup>
  );
}

/**
 * The GitHub accounts signed in for publishing (the publish flow's own sign-in),
 * and the one chosen, first by default. Read again when `discovery` changes,
 * after a sign-in. Load, Share and Publish all list through this.
 */
export function usePublishAccounts(
  projectPath: string,
  discovery: number,
): { readonly accounts: Load<readonly string[]>; readonly account: string | undefined; readonly setAccount: (account: string) => void } {
  const [accounts, setAccounts] = useState<Load<readonly string[]>>({ kind: 'loading' });
  const [account, setAccount] = useState<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void discoverPublishing(projectPath, { provider: 'github', account: '' }).then(
      (answer) => {
        if (!active) {
          return;
        }
        const names = answer.kind === 'ready' ? answer.accounts.map((entry) => entry.id) : [];
        setAccounts({ kind: 'ready', value: names });
        setAccount((current) => current ?? names[0]);
      },
      () => active && setAccounts({ kind: 'ready', value: [] }),
    );
    return () => {
      active = false;
    };
  }, [projectPath, discovery]);
  return { accounts, account, setAccount };
}

/** The account's repositories, read again when the account changes or on Retry; idle without one. */
export function useRepositories(projectPath: string, account: string | undefined, attempt: number): Load<AppRepositoryListing> {
  const [load, setLoad] = useState<Load<AppRepositoryListing>>({ kind: 'idle' });
  useEffect(() => {
    if (account === undefined) {
      setLoad({ kind: 'idle' });
      return undefined;
    }
    let active = true;
    setLoad({ kind: 'loading' });
    void listAppRepositories(projectPath, account).then(
      (listing) => active && setLoad({ kind: 'ready', value: listing }),
      (error: unknown) => active && setLoad({ kind: 'ready', value: { kind: 'failed', message: String(error) } }),
    );
    return () => {
      active = false;
    };
  }, [projectPath, account, attempt]);
  return load;
}

/** What the list area shows under the field. Every state leaves the field working, so a pasted repository always gets its Use row. */
export type ChooserList =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly account: string; readonly repositories: readonly AppRepository[] }
  | { readonly kind: 'failed'; readonly message: string; readonly retry: () => void }
  | { readonly kind: 'rate-limited'; readonly resetAtMs: number | undefined; readonly retry: () => void }
  /** The main process is older than this renderer: only a restart makes them one version. */
  | { readonly kind: 'restart' }
  /** No account: the publish sign-in where the host has one, else (Studio) the field alone. */
  | { readonly kind: 'signed-out'; readonly signIn: (() => void) | undefined };

export function chooserList(input: {
  readonly accounts: Load<readonly string[]>;
  readonly account: string | undefined;
  readonly repositories: Load<AppRepositoryListing>;
  readonly signIn: (() => void) | undefined;
  readonly retry: () => void;
}): ChooserList {
  if (input.signIn === undefined) {
    return { kind: 'signed-out', signIn: undefined };
  }
  if (input.accounts.kind !== 'ready') {
    return { kind: 'loading' };
  }
  if (input.account === undefined) {
    return { kind: 'signed-out', signIn: input.signIn };
  }
  switch (input.repositories.kind) {
    case 'idle':
    case 'loading':
      return { kind: 'loading' };
    case 'failed':
      return { kind: 'failed', message: input.repositories.message, retry: input.retry };
    case 'ready':
      return listingState(input.repositories.value, input.account, input.retry);
    default: {
      const exhaustive: never = input.repositories;
      return exhaustive;
    }
  }
}

function listingState(listing: AppRepositoryListing, account: string, retry: () => void): ChooserList {
  switch (listing.kind) {
    case 'ready':
      return { kind: 'ready', account, repositories: listing.repositories };
    case 'failed':
      return { kind: 'failed', message: listing.message, retry };
    case 'rate-limited':
      return { kind: 'rate-limited', resetAtMs: listing.resetAtMs, retry };
    case 'restart':
      return { kind: 'restart' };
    default: {
      const exhaustive: never = listing;
      return exhaustive;
    }
  }
}

/** "Try again in 3 minutes.": how long until GitHub's limit lifts, rounded up, never under a minute. */
export function rateLimitWait(resetAtMs: number | undefined, nowMs: number): string {
  if (resetAtMs === undefined) {
    return 'Try again in a few minutes.';
  }
  const minutes = Math.max(1, Math.ceil((resetAtMs - nowMs) / 60_000));
  assert(Number.isSafeInteger(minutes), 'A wait is whole minutes');
  assert(minutes >= 1, 'A wait is at least a minute');
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/**
 * The popup's chrome: the title, the body and the Cancel footer. The popup has a
 * capped height and the body takes what the title and footer leave, so a long
 * repository list scrolls inside its own region (RepositoryChooser) instead of
 * under the title. Exported for the layout test, which renders it in Chromium.
 */
export function ConnectFrame(props: {
  readonly onCancel: () => void;
  /** The popup's title; Load App From GitHub when absent. Publish and Share reuse this frame (Share puts its app there). */
  readonly title?: ReactNode;
  readonly icon?: ReactNode;
  /** The footer's buttons after Cancel, for a step that has its own action; the primary one goes last. */
  readonly actions?: ReactNode;
  readonly cancelLabel?: string;
  /** Cancel is shown and works by default; `disabled` while work runs, `hidden` when the step's own action ends it. */
  readonly cancel?: 'enabled' | 'disabled' | 'hidden';
  readonly children: ReactNode;
}) {
  const cancel = props.cancel ?? 'enabled';
  return (
    <>
      <div className="modal-header apps-connect-header">
        {props.icon ?? <GitHubIcon size={16} />}
        {props.title ?? LOAD_FROM_GITHUB_LABEL}
      </div>
      <div className="modal-body apps-connect-body">{props.children}</div>
      <div className="modal-footer apps-connect-footer">
        {cancel === 'hidden' ? undefined : (
          <button type="button" disabled={cancel === 'disabled'} onClick={props.onCancel}>
            {props.cancelLabel ?? 'Cancel'}
          </button>
        )}
        {props.actions}
      </div>
    </>
  );
}

export interface RepositoryChooserProps {
  readonly accounts: readonly string[];
  readonly account: string | undefined;
  readonly list: ChooserList;
  readonly onAccount: (account: string) => void;
  readonly renderAvatar: ConnectGitHubProps['renderAvatar'];
  readonly onPick: (pick: Pick) => void;
  /** What the field starts with; the layout test fills it. */
  readonly initialQuery?: string;
}

const SKELETON_ROWS = 5;
const LISTBOX_ID = 'apps-connect-repositories';

/**
 * One field (the account chip, then the search that also takes a pasted
 * repository) fixed at the top; below it only the list scrolls, its ends fading
 * while there is more past them, as Settings does (useScrollEdges). The first
 * pickable row is highlighted; the arrows move it and Enter picks it.
 */
export function RepositoryChooser(props: RepositoryChooserProps) {
  const { list } = props;
  const [query, setQuery] = useState(props.initialQuery ?? '');
  const [active, setActive] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const { edges } = useScrollEdges(scroll);
  const rows = chooserRows({ query, repositories: list.kind === 'ready' ? list.repositories : undefined });
  const pickables = chooserPickables(rows);
  const highlighted = Math.min(active, Math.max(0, pickables.length - 1));
  const now = Date.now();
  const choose = (row: ChooserPickable) => {
    if (row.kind === 'use') {
      props.onPick({ owner: row.owner, repository: row.repository, account: undefined });
    } else {
      props.onPick({ owner: row.repository.owner, repository: row.repository.name, account: props.account });
    }
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = moveChooserActive(highlighted, event.key === 'ArrowDown' ? 1 : -1, pickables.length);
      setActive(next);
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      const row = pickables[highlighted];
      if (row !== undefined) {
        event.preventDefault();
        choose(row);
      }
    }
  };
  const activeKey = pickables[highlighted]?.key;
  // Option ids are positions among the pickable rows: unique, and free of the characters names carry.
  const pickableIndex = new Map(pickables.map((row, index) => [row.key, index]));
  return (
    <div className="apps-connect-chooser">
      <div className="apps-connect-field">
        {props.account === undefined ? (
          <SearchIcon size={14} className="apps-connect-field-icon" />
        ) : (
          <Dropdown
            ariaLabel="GitHub account"
            className="apps-connect-account"
            value={props.account}
            options={props.accounts.map((login) => ({ value: login, label: login, icon: props.renderAvatar(login, login) }))}
            onChange={props.onAccount}
          />
        )}
        <input
          type="search"
          role="combobox"
          aria-label="Search repositories or paste a GitHub URL"
          aria-expanded={true}
          aria-controls={LISTBOX_ID}
          aria-activedescendant={activeKey === undefined ? undefined : optionId(highlighted)}
          aria-autocomplete="list"
          placeholder="Search repositories or paste a GitHub URL"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div ref={scroll} className="apps-connect-scroll" data-edge-top={edges.top} data-edge-bottom={edges.bottom}>
        <ul className="apps-choice-list" id={LISTBOX_ID} role="listbox" aria-label="Repositories">
          {rows.map((row) => (
            <ChooserRowView
              key={row.key}
              row={row}
              optionIndex={pickableIndex.get(row.key)}
              on={row.key === activeKey}
              now={now}
              renderAvatar={props.renderAvatar}
              onHover={() => setActive(pickableIndex.get(row.key) ?? 0)}
              onChoose={choose}
            />
          ))}
        </ul>
        <ChooserListState list={list} />
      </div>
    </div>
  );
}

export function ChooserListState(props: { readonly list: ChooserList }) {
  const { list } = props;
  switch (list.kind) {
    case 'ready':
      return hasStackiApps(list.repositories) ? undefined : (
        <ChooserEmpty
          icon={<AppsIcon size={20} />}
          title={`No Stacki apps on ${list.account}`}
          action={
            <a className="apps-connect-empty-link" href={STACKI_APP_TOPIC_HELP_URL} target="_blank" rel="noreferrer">
              How to add it
            </a>
          }
          hint="or paste a repository URL above"
        >
          Add the <CodeInline text="stacki-app" /> topic to a repository that publishes a Stacki app release.
        </ChooserEmpty>
      );
    case 'loading':
      return (
        <div className="apps-connect-skeletons" aria-label="Loading repositories" role="status">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <div key={index} className="apps-skeleton apps-connect-skeleton">
              <span className="apps-skeleton-tile" />
              <span className="apps-skeleton-lines">
                <span />
                <span />
              </span>
            </div>
          ))}
        </div>
      );
    case 'failed':
      return (
        <ChooserEmpty icon={<WarningTriangleIcon size={20} />} title="Couldn’t load your repositories" action={<RetryButton onRetry={list.retry} />} alert>
          {list.message}
        </ChooserEmpty>
      );
    case 'rate-limited':
      return (
        <ChooserEmpty icon={<ClockIcon size={20} />} title="GitHub is limiting requests" action={<RetryButton onRetry={list.retry} />} alert>
          {rateLimitWait(list.resetAtMs, Date.now())}
        </ChooserEmpty>
      );
    case 'restart':
      // No renderer-side restart exists, and a main process this old could not run a new one: the person quits and reopens.
      return (
        <ChooserEmpty icon={<RefreshIcon size={20} />} title="Restart Stacki to finish updating" alert>
          Stacki updated while it was open. Quit it and open it again to list your repositories; pasting a repository above works now.
        </ChooserEmpty>
      );
    case 'signed-out':
      return list.signIn === undefined ? (
        <ChooserEmpty icon={<GitHubIcon size={20} />} title="Paste a public repository">
          Paste a GitHub repository above, as owner/repo or its github.com address, to see its releases.
        </ChooserEmpty>
      ) : (
        <ChooserEmpty
          icon={<GitHubIcon size={20} />}
          title="Sign in with GitHub to see your repositories"
          action={
            <button type="button" className="apps-button primary" onClick={list.signIn}>
              <GitHubIcon size={14} /> Sign in with GitHub
            </button>
          }
        >
          Your repositories and your organizations’ are listed here. A public repository can be pasted above without signing in.
        </ChooserEmpty>
      );
    default: {
      const exhaustive: never = list;
      return exhaustive;
    }
  }
}

/** The Apps panel's empty-state pattern: a muted icon on a soft fill, a one-line title, a muted explanation, an action. */
export function ChooserEmpty(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly action?: ReactNode;
  /** A failure is announced as it appears; a plain empty list is not. */
  readonly alert?: boolean;
  /** A quieter second way forward, under the action. */
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  assert(props.title.length > 0, 'An empty state has a title');
  return (
    <div className="apps-connect-empty" role={props.alert === true ? 'alert' : undefined}>
      <span className="apps-empty-icon" aria-hidden="true">
        {props.icon}
      </span>
      <p className="apps-connect-empty-title">{props.title}</p>
      <p className="apps-connect-empty-detail">{props.children}</p>
      {props.action}
      {props.hint !== undefined && <p className="apps-connect-empty-hint">{props.hint}</p>}
    </div>
  );
}

export function RetryButton(props: { readonly onRetry: () => void }) {
  return (
    <button type="button" className="apps-button" onClick={props.onRetry}>
      Retry
    </button>
  );
}

export function ChooserRowView(props: {
  readonly row: ChooserRow;
  /** Its position among the pickable rows; undefined for a heading or a notice. */
  readonly optionIndex: number | undefined;
  readonly on: boolean;
  readonly now: number;
  readonly renderAvatar: ConnectGitHubProps['renderAvatar'];
  readonly onHover: () => void;
  readonly onChoose: (row: ChooserPickable) => void;
}) {
  const { row } = props;
  switch (row.kind) {
    case 'section':
      return (
        <li className="dp-section apps-connect-section" role="presentation">
          <span className="dp-section-heading">{row.label}</span>
        </li>
      );
    case 'notice':
      return (
        <li className="apps-connect-notice" role="presentation">
          No Stacki apps match.
        </li>
      );
    case 'use':
    case 'repository': {
      const owner = row.kind === 'use' ? row.owner : row.repository.owner;
      const name = row.kind === 'use' ? row.repository : row.repository.name;
      assert(owner.length > 0, 'A chooser row names its owner');
      assert(props.optionIndex !== undefined, 'A pickable row has a position');
      return (
        <li role="presentation">
          <button
            type="button"
            id={optionId(props.optionIndex)}
            role="option"
            aria-selected={props.on}
            tabIndex={-1}
            className={`apps-choice${props.on ? ' on' : ''}${row.kind === 'use' ? ' apps-connect-use' : ''}`}
            onMouseMove={props.onHover}
            onClick={() => props.onChoose(row)}
          >
            <span className="apps-choice-avatar">{props.renderAvatar(owner, owner)}</span>
            <span className="apps-choice-text">
              <span className="apps-choice-title">
                {row.kind === 'use' ? 'Use ' : ''}
                {owner}/{name}
              </span>
              <span className="apps-choice-meta">
                {row.kind === 'use' ? 'Public repository' : `Updated ${sinceLabel(row.repository.updatedAt, props.now)}`}
              </span>
            </span>
            {row.kind === 'repository' && <span className="apps-badge muted">{row.repository.private ? 'Private' : 'Public'}</span>}
          </button>
        </li>
      );
    }
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

export function optionId(index: number): string {
  return `apps-connect-option-${index}`;
}

function ReleaseStep(props: {
  readonly projectPath: string;
  readonly pick: Pick;
  readonly onBack: () => void;
  readonly onStaged: (staged: AppStaged) => void;
}) {
  const { pick } = props;
  const [load, setLoad] = useState<Load<readonly AppRelease[]>>({ kind: 'loading' });
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [chosenAsset, setChosenAsset] = useState<string | undefined>(undefined);
  const [check, setCheck] = useState<Load<AppStaged>>({ kind: 'idle' });
  const lookup = useMemo<AppGitHubSource>(
    () => ({ kind: 'github', owner: pick.owner, repository: pick.repository, asset: 'app.zip', account: pick.account }),
    [pick],
  );
  useEffect(() => {
    let active = true;
    void listAppReleases(props.projectPath, lookup).then(
      (answer) => {
        if (!active) {
          return;
        }
        if (!answer.ok) {
          setLoad({ kind: 'failed', message: answer.message });
          return;
        }
        const ordered = orderReleases(answer.value);
        setLoad({ kind: 'ready', value: ordered });
        setTag(ordered[0]?.tag);
      },
      (error: unknown) => active && setLoad({ kind: 'failed', message: String(error) }),
    );
    return () => {
      active = false;
    };
  }, [props.projectPath, lookup]);
  const releases = load.kind === 'ready' ? load.value : [];
  const release = releases.find((entry) => entry.tag === tag);
  const choice = release === undefined ? undefined : releaseAssetChoice(release);
  const asset = choice?.kind === 'single' ? choice.asset.name : choice?.kind === 'choose' ? (chosenAsset ?? choice.assets[0]?.name) : undefined;
  const now = Date.now();
  const runCheck = () => {
    if (release === undefined || asset === undefined) {
      return;
    }
    setCheck({ kind: 'loading' });
    void stageGitHubApp(props.projectPath, { ...lookup, asset }, release.tag).then(
      (answer) => setCheck(answer.ok ? { kind: 'ready', value: answer.value } : { kind: 'failed', message: answer.message }),
      (error: unknown) => setCheck({ kind: 'failed', message: String(error) }),
    );
  };
  return (
    <div className="apps-connect-releases">
      <button type="button" className="apps-link" onClick={props.onBack}>
        ← {pick.owner}/{pick.repository}
      </button>
      {load.kind === 'loading' && <p className="apps-note">Loading releases…</p>}
      {load.kind === 'failed' && (
        <p className="apps-error" role="alert">
          {load.message}
        </p>
      )}
      {load.kind === 'ready' && releases.length === 0 && <p className="apps-note">This repository has no releases yet.</p>}
      <ul className="apps-choice-list" aria-label="Releases">
        {releases.map((entry) => (
          <li key={entry.tag}>
            <button
              type="button"
              className={`apps-choice${entry.tag === tag ? ' on' : ''}`}
              aria-pressed={entry.tag === tag}
              onClick={() => {
                setTag(entry.tag);
                setChosenAsset(undefined);
                setCheck({ kind: 'idle' });
              }}
            >
              <span className="apps-choice-text">
                <span className="apps-choice-title">{entry.name || entry.tag}</span>
                <span className="apps-choice-meta">
                  {entry.tag} · {sinceLabel(entry.publishedAt, now)}
                </span>
              </span>
              {entry.prerelease && <span className="apps-badge muted">Pre-release</span>}
            </button>
          </li>
        ))}
      </ul>
      {choice?.kind === 'none' && <p className="apps-error">This release has no .zip app bundle.</p>}
      {choice?.kind === 'choose' && (
        <Dropdown
          ariaLabel="App bundle"
          value={asset ?? ''}
          options={choice.assets.map((entry) => ({ value: entry.name, label: entry.name }))}
          onChange={(value) => {
            setChosenAsset(value);
            setCheck({ kind: 'idle' });
          }}
        />
      )}
      {check.kind === 'ready' && (
        <div className="apps-card-head apps-connect-found">
          <AppTile manifest={check.value.manifest} size={32} />
          <span className="apps-card-title">
            <strong>{check.value.manifest.name}</strong>
            <span>
              {check.value.manifest.version} · {asset}
            </span>
          </span>
        </div>
      )}
      {check.kind === 'failed' && (
        <p className="apps-error" role="alert">
          {check.message}
        </p>
      )}
      <div className="apps-actions">
        {check.kind === 'ready' ? (
          <button type="button" className="apps-button primary" onClick={() => props.onStaged(check.value)}>
            Install
          </button>
        ) : (
          <button type="button" className="apps-button primary" disabled={asset === undefined || check.kind === 'loading'} onClick={runCheck}>
            {check.kind === 'loading' ? 'Checking…' : 'Check release'}
          </button>
        )}
      </div>
    </div>
  );
}
