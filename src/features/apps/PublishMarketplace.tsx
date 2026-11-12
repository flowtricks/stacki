// "Publish to marketplace": the Apps panel's way to offer an app for the
// marketplace (docs/apps.md, "Publishing to the marketplace"), shaped like the
// Load App From GitHub popup: one field with the account chip, a list under a
// fixed header and footer, and proper empty and error states.
//
// The list has two sections. "Your GitHub apps" are the account's `stacki-app`
// repositories, each with its Public or Private pill; a pasted repository works
// as in Load. "Uploaded to this project" are apps installed from a file: choosing
// one leads into Share app, which puts it on GitHub first.
//
// For a repository, the checklist: public, tagged, released, MIT licensed and
// scanned clean. A private one offers "Make public" after a clear confirmation;
// one without the MIT license offers "Add MIT license". Once every check passes,
// a summary with Notes, Contact and the terms checkbox, then Submit. A
// marketplace that cannot take submissions yet gets its own state and the web form.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AppSummary } from '../../../shared/properties/apps';
import { MARKETPLACE_LICENSE, MARKETPLACE_SUBMIT_URL } from '../../../shared/properties/appMarketplace';
import {
  MARKETPLACE_TERMS,
  marketplaceReadiness,
  repositoryURL,
  type AppRepositoryRef,
  type AppRepositoryStatus,
  type AppVisibilityOutcome,
  type MarketplacePrecheck,
  type MarketplaceSubmissionOutcome,
} from '../../../shared/properties/appPublish';
import {
  addAppLicense,
  appRepositoryStatus,
  checkMarketplaceApp,
  makeRepositoryPublic,
  scanAppSecrets,
  submitMarketplaceApp,
} from '../../ipc/appPublishBridge';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown from '../../ui/Dropdown';
import { AppsIcon, CheckIcon, ExternalIcon, GitHubIcon, SearchIcon, UploadCloudIcon, WarningTriangleIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { useScrollEdges } from '../../ui/useScrollEdges';
import { AppTile } from './AppTile';
import {
  ChooserEmpty,
  ChooserListState,
  ChooserRowView,
  ConnectFrame,
  RetryButton,
  chooserList,
  optionId,
  useRepositories,
  usePublishAccounts,
  type ConnectGitHubProps,
} from './ConnectGitHub';
import { moveChooserActive } from './repositoryChooser';
import { SecretScanReport, scanPassed, type ScanLoad } from './SecretScanReport';
import { StepList } from './ShareApp';
import {
  licenseConfirmation,
  makePublicConfirmation,
  marketplaceCheckLabel,
  publishChooserRows,
  publishPickables,
  uploadedApps,
  visibilityRefusal,
  type PublishPickable,
} from './publishFlow';
import './publish.css';

export interface PublishMarketplaceProps {
  readonly projectPath: string;
  readonly installed: readonly AppSummary[];
  readonly renderSignIn: ConnectGitHubProps['renderSignIn'];
  readonly renderAvatar: ConnectGitHubProps['renderAvatar'];
  readonly onClose: () => void;
  /** Whether an installed app is already published to a repository (publishFlow.ts appPublication): it is not listed as "uploaded". */
  readonly isPublished: (app: AppSummary) => boolean;
  /** An uploaded app was chosen: the panel opens Share app for it. */
  readonly onShareUploaded: (app: AppSummary) => void;
  /** A repository to start on, as after a public share's "Also submit to the marketplace". */
  readonly initial?: AppRepositoryRef | undefined;
  /**
   * An installed app's own repository to start on, from its ⋯ menu's "Submit to
   * marketplace". Its install source may name no account (a public repository),
   * so the checklist waits for the account the popup reads with; Back leads to
   * the chooser, not to this repository again.
   */
  readonly preselect?: { readonly owner: string; readonly repository: string; readonly account: string | undefined } | undefined;
}

const TITLE = 'Publish to marketplace';

export function PublishMarketplace(props: PublishMarketplaceProps) {
  const [signingIn, setSigningIn] = useState(false);
  const [discovery, setDiscovery] = useState(0);
  const { accounts, account, setAccount } = usePublishAccounts(props.projectPath, discovery);
  const listAccount = props.renderSignIn === undefined ? undefined : account;
  const [attempt, setAttempt] = useState(0);
  const repositories = useRepositories(props.projectPath, listAccount, attempt);
  const [chosen, setPick] = useState<AppRepositoryRef | undefined>(props.initial);
  const [preselect, setPreselect] = useState(props.preselect);
  // Memoized: the checklist reads the repository again whenever its target changes identity.
  const preselected = useMemo(() => preselectedPick(preselect, listAccount), [preselect, listAccount]);
  const pick = chosen ?? preselected;
  if (signingIn && props.renderSignIn !== undefined) {
    return props.renderSignIn(
      () => {
        setSigningIn(false);
        setDiscovery((count) => count + 1);
      },
      () => setSigningIn(false),
    );
  }
  const list = chooserList({
    accounts,
    account: listAccount,
    repositories,
    signIn: props.renderSignIn === undefined ? undefined : () => setSigningIn(true),
    retry: () => setAttempt((count) => count + 1),
  });
  return (
    <Popup className="modal apps-connect apps-publish" label={TITLE} onClose={props.onClose} dismissible={true}>
      {({ close }) => (
        <ConnectFrame onCancel={close} title={TITLE} icon={<UploadCloudIcon size={16} />}>
          {listAccount === undefined && accounts.kind === 'ready' ? (
            <ChooserEmpty
              icon={<GitHubIcon size={20} />}
              title={props.renderSignIn === undefined ? 'Publishing needs Stacki Desktop' : 'Sign in with GitHub to publish'}
              action={
                props.renderSignIn === undefined ? undefined : (
                  <button type="button" className="apps-button primary" onClick={() => setSigningIn(true)}>
                    <GitHubIcon size={14} /> Sign in with GitHub
                  </button>
                )
              }
            >
              {props.renderSignIn === undefined
                ? 'The marketplace confirms who submits with your GitHub sign-in, which Studio does not hold. Publish from Stacki Desktop, or use the web form.'
                : 'The marketplace confirms who submits with the account you publish with.'}
            </ChooserEmpty>
          ) : pick === undefined || listAccount === undefined ? (
            <PublishChooser
              accounts={accounts.kind === 'ready' ? accounts.value : []}
              account={listAccount}
              list={list}
              uploaded={uploadedApps(props.installed, { published: props.isPublished })}
              renderAvatar={props.renderAvatar}
              onAccount={setAccount}
              onPick={(row) => {
                if (row.kind === 'uploaded') {
                  close();
                  props.onShareUploaded(row.app);
                  return;
                }
                assert(listAccount !== undefined, 'A repository is chosen with an account');
                const owner = row.kind === 'use' ? row.owner : row.repository.owner;
                const repository = row.kind === 'use' ? row.repository : row.repository.name;
                setPick({ owner, repository, account: listAccount });
              }}
            />
          ) : (
            <RepositoryPublish
              projectPath={props.projectPath}
              target={pick}
              onBack={() => {
                setPreselect(undefined);
                setPick(undefined);
              }}
            />
          )}
        </ConnectFrame>
      )}
    </Popup>
  );
}

/** The preselected repository, read with its own account or else the popup's; none until an account is known. */
function preselectedPick(preselect: PublishMarketplaceProps['preselect'], listAccount: string | undefined): AppRepositoryRef | undefined {
  if (preselect === undefined) {
    return undefined;
  }
  const account = preselect.account ?? listAccount;
  if (account === undefined) {
    return undefined;
  }
  assert(preselect.owner.length > 0, 'A preselected repository names its owner');
  return { owner: preselect.owner, repository: preselect.repository, account };
}

function PublishChooser(props: {
  readonly accounts: readonly string[];
  readonly account: string | undefined;
  readonly list: ReturnType<typeof chooserList>;
  readonly uploaded: readonly AppSummary[];
  readonly renderAvatar: ConnectGitHubProps['renderAvatar'];
  readonly onAccount: (account: string) => void;
  readonly onPick: (row: PublishPickable) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const { edges } = useScrollEdges(scroll);
  const rows = publishChooserRows({ query, repositories: props.list.kind === 'ready' ? props.list.repositories : undefined, uploaded: props.uploaded });
  const pickables = publishPickables(rows);
  const highlighted = Math.min(active, Math.max(0, pickables.length - 1));
  const pickableIndex = new Map(pickables.map((row, index) => [row.key, index]));
  const activeKey = pickables[highlighted]?.key;
  const now = Date.now();
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(moveChooserActive(highlighted, event.key === 'ArrowDown' ? 1 : -1, pickables.length));
      return;
    }
    if (event.key === 'Enter') {
      const row = pickables[highlighted];
      if (row !== undefined) {
        event.preventDefault();
        props.onPick(row);
      }
    }
  };
  // With nothing tagged and nothing uploaded, the list state speaks; with uploads, they are the list.
  const listState = props.list.kind === 'ready' && props.uploaded.length > 0 ? undefined : <ChooserListState list={props.list} />;
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
          aria-label="Search your apps or paste a GitHub URL"
          aria-expanded={true}
          aria-controls="apps-publish-sources"
          aria-activedescendant={activeKey === undefined ? undefined : optionId(highlighted)}
          aria-autocomplete="list"
          placeholder="Search your apps or paste a GitHub URL"
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
        <ul className="apps-choice-list" id="apps-publish-sources" role="listbox" aria-label="Apps to publish">
          {rows.map((row) =>
            row.kind === 'uploaded' ? (
              <UploadedRow
                key={row.key}
                app={row.app}
                optionIndex={pickableIndex.get(row.key) ?? 0}
                on={row.key === activeKey}
                onHover={() => setActive(pickableIndex.get(row.key) ?? 0)}
                onChoose={() => props.onPick(row)}
              />
            ) : (
              <ChooserRowView
                key={row.key}
                row={row}
                optionIndex={pickableIndex.get(row.key)}
                on={row.key === activeKey}
                now={now}
                renderAvatar={props.renderAvatar}
                onHover={() => setActive(pickableIndex.get(row.key) ?? 0)}
                onChoose={(chosen) => props.onPick(chosen)}
              />
            ),
          )}
        </ul>
        {listState}
      </div>
    </div>
  );
}

function UploadedRow(props: {
  readonly app: AppSummary;
  readonly optionIndex: number;
  readonly on: boolean;
  readonly onHover: () => void;
  readonly onChoose: () => void;
}) {
  const { manifest } = props.app;
  return (
    <li role="presentation">
      <button
        type="button"
        id={optionId(props.optionIndex)}
        role="option"
        aria-selected={props.on}
        tabIndex={-1}
        className={`apps-choice${props.on ? ' on' : ''}`}
        onMouseMove={props.onHover}
        onClick={props.onChoose}
      >
        <span className="apps-choice-avatar">
          <AppTile manifest={manifest} size={24} />
        </span>
        <span className="apps-choice-text">
          <span className="apps-choice-title">{manifest.name}</span>
          <span className="apps-choice-meta">Version {manifest.version} · Share it to GitHub first</span>
        </span>
        <span className="apps-badge muted">{props.app.lock.source.kind === 'local' ? 'Project folder' : 'Uploaded'}</span>
      </button>
    </li>
  );
}

type StatusLoad =
  { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'ready'; readonly status: AppRepositoryStatus };

type Action =
  | { readonly kind: 'idle' }
  | { readonly kind: 'making-public' }
  | { readonly kind: 'refused'; readonly outcome: Extract<AppVisibilityOutcome, { readonly kind: 'forbidden' }> }
  | { readonly kind: 'licensing' }
  | { readonly kind: 'failed'; readonly message: string };

/** One repository's way to the marketplace: the checklist, its fixes, then the submission. */
export function RepositoryPublish(props: { readonly projectPath: string; readonly target: AppRepositoryRef; readonly onBack: () => void }) {
  const { target } = props;
  const [status, setStatus] = useState<StatusLoad>({ kind: 'loading' });
  const [scan, setScan] = useState<ScanLoad>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  const [action, setAction] = useState<Action>({ kind: 'idle' });
  const reload = useCallback(() => setTick((count) => count + 1), []);
  useEffect(() => {
    let active = true;
    setStatus({ kind: 'loading' });
    setScan({ kind: 'loading' });
    void appRepositoryStatus(props.projectPath, target).then(
      (answer) => active && setStatus(answer.ok ? { kind: 'ready', status: answer.value } : { kind: 'failed', message: answer.message }),
      (error: unknown) => active && setStatus({ kind: 'failed', message: String(error) }),
    );
    void scanAppSecrets(props.projectPath, { kind: 'repository', ...target }).then(
      (answer) => active && setScan(answer.ok ? { kind: 'ready', scan: answer.value } : { kind: 'failed', message: answer.message }),
      (error: unknown) => active && setScan({ kind: 'failed', message: String(error) }),
    );
    return () => {
      active = false;
    };
  }, [props.projectPath, target, tick]);
  const name = `${target.owner}/${target.repository}`;
  const makePublic = async () => {
    const confirmation = makePublicConfirmation(target.owner, target.repository);
    if ((await confirmDialog({ ...confirmation, danger: true })) !== true) {
      return;
    }
    setAction({ kind: 'making-public' });
    const answer = await makeRepositoryPublic(props.projectPath, target);
    if (!answer.ok) {
      setAction({ kind: 'failed', message: answer.message });
      return;
    }
    if (answer.value.kind === 'forbidden') {
      setAction({ kind: 'refused', outcome: answer.value });
      return;
    }
    setAction({ kind: 'idle' });
    reload();
  };
  const addLicense = async (holder: string) => {
    const confirmation = licenseConfirmation(target.owner, target.repository, holder, new Date().getFullYear());
    if ((await confirmDialog(confirmation)) !== true) {
      return;
    }
    setAction({ kind: 'licensing' });
    const answer = await addAppLicense(props.projectPath, target);
    if (!answer.ok) {
      setAction({ kind: 'failed', message: answer.message });
      return;
    }
    setAction({ kind: 'idle' });
    setStatus({ kind: 'ready', status: answer.value });
  };
  return (
    <div className="apps-connect-releases apps-publish-repository">
      <button type="button" className="apps-link" onClick={props.onBack}>
        ← {name}
      </button>
      {status.kind === 'loading' && <p className="apps-note">Reading {name}…</p>}
      {status.kind === 'failed' && (
        <ChooserEmpty icon={<WarningTriangleIcon size={20} />} title={`Couldn’t read ${name}`} action={<RetryButton onRetry={reload} />} alert>
          {status.message}
        </ChooserEmpty>
      )}
      {status.kind === 'ready' && (
        <ReadyChecks
          projectPath={props.projectPath}
          target={target}
          status={status.status}
          scan={scan}
          action={action}
          onRescan={reload}
          onMakePublic={() => void makePublic()}
          onAddLicense={() => void addLicense(status.status.holder)}
        />
      )}
    </div>
  );
}

function ReadyChecks(props: {
  readonly projectPath: string;
  readonly target: AppRepositoryRef;
  readonly status: AppRepositoryStatus;
  readonly scan: ScanLoad;
  readonly action: Action;
  readonly onRescan: () => void;
  readonly onMakePublic: () => void;
  readonly onAddLicense: () => void;
}) {
  const { status, action } = props;
  const clean = scanPassed(props.scan);
  const readiness = marketplaceReadiness(status, { clean });
  return (
    <>
      <ul className="apps-checklist" aria-label="Marketplace requirements">
        {readiness.checks.map((entry) => (
          <li key={entry.check} className={`apps-check${entry.passed ? ' passed' : ''}`}>
            <span className="apps-step-mark" aria-hidden="true">
              {entry.passed ? <CheckIcon size={11} /> : <WarningTriangleIcon size={11} />}
            </span>
            {marketplaceCheckLabel(entry.check)}
          </li>
        ))}
      </ul>
      <SecretScanReport load={props.scan} onRescan={props.onRescan} />
      {status.private && (
        <Requirement title="This repository is private. The marketplace needs it public.">
          {action.kind === 'refused' ? (
            <VisibilityRefused outcome={action.outcome} />
          ) : (
            <button type="button" className="apps-button primary" disabled={!clean || action.kind === 'making-public'} onClick={props.onMakePublic}>
              {action.kind === 'making-public' ? 'Making public…' : 'Make public'}
            </button>
          )}
          {!clean && <p className="apps-note">The secret scan must be clean before the repository is made public.</p>}
        </Requirement>
      )}
      {status.license !== MARKETPLACE_LICENSE && (
        <Requirement title="Marketplace apps must use the MIT license">
          {status.license !== undefined && <p className="apps-note">GitHub reads this repository’s license as {status.license}.</p>}
          {action.kind === 'licensing' ? (
            <StepList states={[{ step: 'commit-license', status: 'running' }]} visibility={undefined} label={() => 'Commit the MIT LICENSE'} />
          ) : (
            <button type="button" className="apps-button primary" disabled={status.license !== undefined} onClick={props.onAddLicense}>
              Add MIT license
            </button>
          )}
          {status.license !== undefined && <p className="apps-note">Replace the LICENSE file with the MIT license on GitHub, then come back.</p>}
        </Requirement>
      )}
      {!status.topic && (
        <Requirement title="Add the stacki-app topic">
          <a className="apps-connect-empty-link" href={repositoryURL(status.owner, status.repository)} target="_blank" rel="noopener noreferrer">
            Open the repository <ExternalIcon size={11} />
          </a>
        </Requirement>
      )}
      {status.release === undefined && (
        <Requirement title="Release the app first">
          <p className="apps-note">Attach the app’s .zip to a GitHub release, then come back.</p>
        </Requirement>
      )}
      {action.kind === 'failed' && (
        <p className="apps-error" role="alert">
          {action.message}
        </p>
      )}
      {readiness.ready && status.release !== undefined && <SubmitStep projectPath={props.projectPath} target={props.target} release={status.release} />}
    </>
  );
}

function Requirement(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="apps-requirement">
      <p className="apps-requirement-title">
        <WarningTriangleIcon size={13} /> {props.title}
      </p>
      {props.children}
    </div>
  );
}

function VisibilityRefused({ outcome }: { readonly outcome: Extract<AppVisibilityOutcome, { readonly kind: 'forbidden' }> }) {
  const text = visibilityRefusal(outcome);
  assert(outcome.settingsURL.startsWith('https://github.com/'), 'A refusal links to GitHub');
  return (
    <div className="apps-refused" role="alert">
      <p className="apps-requirement-title">{text.title}</p>
      <p className="apps-note">{text.detail}</p>
      <a className="apps-connect-empty-link" href={outcome.settingsURL} target="_blank" rel="noopener noreferrer">
        Open repository settings <ExternalIcon size={11} />
      </a>
    </div>
  );
}

type Submission =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'done'; readonly outcome: MarketplaceSubmissionOutcome }
  | { readonly kind: 'failed'; readonly message: string };

type Precheck =
  { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'ready'; readonly precheck: MarketplacePrecheck };

/**
 * The summary, the marketplace's own check of the repository, and the terms;
 * then Submit and what it came to. Submit waits for the check to say the app
 * is ready and for the terms to be ticked.
 */
export function SubmitStep(props: {
  readonly projectPath: string;
  readonly target: AppRepositoryRef;
  readonly release: NonNullable<AppRepositoryStatus['release']>;
}) {
  const [accepted, setAccepted] = useState(false);
  const [state, setState] = useState<Submission>({ kind: 'idle' });
  const [check, setCheck] = useState<Precheck>({ kind: 'loading' });
  const { projectPath, target } = props;
  useEffect(() => {
    let active = true;
    void checkMarketplaceApp(projectPath, target).then(
      (answer) => active && setCheck(answer.ok ? { kind: 'ready', precheck: answer.value } : { kind: 'failed', message: answer.message }),
      (error: unknown) => active && setCheck({ kind: 'failed', message: String(error) }),
    );
    return () => {
      active = false;
    };
  }, [projectPath, target]);
  const name = `${target.owner}/${target.repository}`;
  if (state.kind === 'done') {
    return <SubmissionResult outcome={state.outcome} />;
  }
  const ready = check.kind === 'ready' && check.precheck.kind === 'ready';
  const submit = () => {
    if (!accepted || !ready) {
      return;
    }
    setState({ kind: 'sending' });
    void submitMarketplaceApp(projectPath, { ...target, acceptedTerms: true }).then(
      (answer) => setState(answer.ok ? { kind: 'done', outcome: answer.value } : { kind: 'failed', message: answer.message }),
      (error: unknown) => setState({ kind: 'failed', message: String(error) }),
    );
  };
  return (
    <form
      className="apps-submit"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <dl className="apps-submit-summary">
        <dt>Repository</dt>
        <dd>{name}</dd>
        <dt>Release</dt>
        <dd>
          {props.release.tag} · {props.release.asset}
        </dd>
        <dt>License</dt>
        <dd>{MARKETPLACE_LICENSE}</dd>
      </dl>
      <PrecheckLine check={check} />
      <label className="apps-share-switch">
        <input type="checkbox" required checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
        <span>{MARKETPLACE_TERMS}</span>
      </label>
      {state.kind === 'failed' && (
        <p className="apps-error" role="alert">
          {state.message}
        </p>
      )}
      <div className="apps-actions">
        <button type="submit" className="apps-button primary" disabled={!accepted || !ready || state.kind === 'sending'}>
          {state.kind === 'sending' ? 'Submitting…' : 'Submit for review'}
        </button>
      </div>
    </form>
  );
}

/** What the marketplace's check said: "Ready to submit: <name> v<version>", or its message as is. */
function PrecheckLine({ check }: { readonly check: Precheck }) {
  if (check.kind === 'loading') {
    return <p className="apps-note">Asking the marketplace about this release…</p>;
  }
  if (check.kind === 'failed') {
    return (
      <p className="apps-error" role="alert">
        {check.message}
      </p>
    );
  }
  const { precheck } = check;
  switch (precheck.kind) {
    case 'ready':
      return (
        <p className="apps-scan apps-scan-clean" role="status">
          <CheckIcon size={13} /> Ready to submit: {precheck.name} v{precheck.version}
        </p>
      );
    case 'refused':
      return (
        <p className="apps-error" role="alert">
          {precheck.message}
        </p>
      );
    case 'unavailable':
      return <SubmissionResult outcome={{ kind: 'unavailable', message: precheck.message }} />;
    default: {
      const exhaustive: never = precheck;
      return exhaustive;
    }
  }
}

function SubmissionResult({ outcome }: { readonly outcome: MarketplaceSubmissionOutcome }) {
  switch (outcome.kind) {
    case 'submitted':
      return (
        <ChooserEmpty icon={<CheckIcon size={20} />} title={outcome.updated ? 'Updated your submission' : 'Submitted for review'}>
          {outcome.updated ? 'The marketplace already had this app; it now has your latest release.' : 'The app is in the review queue.'}
        </ChooserEmpty>
      );
    case 'refused':
      return (
        <ChooserEmpty icon={<WarningTriangleIcon size={20} />} title="The marketplace refused the submission" alert>
          {outcome.message}
        </ChooserEmpty>
      );
    case 'unavailable':
      return (
        <ChooserEmpty
          icon={<AppsIcon size={20} />}
          title="The marketplace isn’t taking submissions right now"
          action={
            <a className="apps-button" href={MARKETPLACE_SUBMIT_URL} target="_blank" rel="noopener noreferrer">
              Open the web form <ExternalIcon size={11} />
            </a>
          }
          hint={outcome.message}
          alert
        >
          Nothing was sent. Try again later, or submit with the web form.
        </ChooserEmpty>
      );
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
