// "Share app": puts an app installed from a file on GitHub, so others can load
// it (docs/apps.md, "Sharing an app privately with your org"). Private is the
// default: people in the organization install it with Load App From GitHub. A
// public share adds the MIT license, and can go on to the marketplace.
//
// The popup has the Load popup's frame, with the app as the header's subject.
// One owner/repository field, like GitHub's: the owner chip (each signed-in
// account and its organizations, grouped by account when there are several, so
// the account needs no control of its own), "/", then the name, prefilled from
// the app id and checked as it is typed (GitHub's rules, then whether the
// account's listing already has it). The visibility is a segmented control with
// one line saying what it means, and the secret scan a status row that must be
// clean before Share is enabled (main scans again). Cancel and Share sit at the
// footer's right. Then the four steps with their progress; a failure lists
// exactly what was created. Afterwards the app can switch from its uploaded
// file to the release (a switch, on by default), so the project hears of new
// releases; auto-update stays off.
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AppManifest, AppRepositoryListing, AppSummary } from '../../../shared/properties/apps';
import {
  APP_SHARE_STEPS,
  DEFAULT_APP_SHARE_VISIBILITY,
  repositoryAccessURL,
  repositoryURL,
  shareStepRef,
  shareStepStates,
  suggestedRepositoryName,
  type AppRepositoryOwnerKind,
  type AppShareOutcome,
  type AppShareStep,
  type AppShareVisibility,
  type AppShared,
} from '../../../shared/properties/appPublish';
import { scanAppSecrets, shareApp, switchAppSource } from '../../ipc/appPublishBridge';
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import { useTranslate, useTranslateDescribed, useTranslateRef } from '../../lib/i18n/useTranslate';
import { listAppRepositories } from '../../ipc/appsBridge';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown from '../../ui/Dropdown';
import { CheckIcon, CopyIcon, ExternalIcon, GitHubIcon, WarningTriangleIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { SegmentedTabs } from '../../ui/SegmentedTabs';
import { Switch } from '../../ui/Switch';
import { ChooserEmpty, ConnectFrame, usePublishAccounts, type ConnectGitHubProps, type Load } from './ConnectGitHub';
import { AppTile } from './AppTile';
import { SecretScanStatus, scanPassed, type ScanLoad } from './SecretScanReport';
import {
  SHARE_ACCOUNTS_MAX,
  publicShareConfirmation,
  repositoryNameStatus,
  repositoryNameUsable,
  shareOwnerChoices,
  visibilityChoices,
  type RepositoryNameStatus,
  type ShareListing,
  type ShareOwnerChoice,
} from './publishFlow';
import './publish.css';

export interface ShareAppProps {
  readonly projectPath: string;
  /** The app to share; undefined asks which of `uploaded` first (the header's "Share an app to GitHub…"). */
  readonly app: AppSummary | undefined;
  /** Apps installed from a file: the ones that can be shared. */
  readonly uploaded: readonly AppSummary[];
  readonly renderSignIn: ConnectGitHubProps['renderSignIn'];
  readonly renderAvatar: ConnectGitHubProps['renderAvatar'];
  readonly notify: (message: string, kind: 'info' | 'success' | 'error') => void;
  readonly onClose: () => void;
  /** The app now comes from its release; the panel reads the apps again. */
  readonly onSwitched: (summary: AppSummary) => void;
  /** Goes on to the marketplace with the repository just shared; absent for a role without `marketplace:publish`. */
  readonly onSubmitToMarketplace?: ((shared: AppShared, account: string) => void) | undefined;
}

/** What Share sends: the owner, with the signed-in account that creates the repository, the name and the visibility. */
export interface ShareRequest {
  readonly account: string;
  readonly owner: string;
  readonly ownerKind: AppRepositoryOwnerKind;
  readonly name: string;
  readonly visibility: AppShareVisibility;
}

type Phase =
  | { readonly kind: 'form' }
  | { readonly kind: 'running'; readonly step: AppShareStep }
  | { readonly kind: 'failed'; readonly outcome: Extract<AppShareOutcome, { readonly kind: 'failed' }> }
  | { readonly kind: 'error'; readonly message: string; readonly messageRef?: MessageRef | undefined }
  | { readonly kind: 'shared'; readonly shared: AppShared; readonly account: string };

export function ShareApp(props: ShareAppProps) {
  const translate = useTranslate();
  const shareLabel = translate('apps.share.title');
  const [signingIn, setSigningIn] = useState(false);
  const [discovery, setDiscovery] = useState(0);
  const { accounts, account } = usePublishAccounts(props.projectPath, discovery);
  // A host without the publish sign-in (Studio) cannot list an account's repositories either.
  const listed = props.renderSignIn === undefined || accounts.kind !== 'ready' ? [] : accounts.value;
  const listings = useShareListings(props.projectPath, listed);
  const owners = useMemo(() => {
    if (account === undefined) {
      return [];
    }
    const signedIn = accounts.kind === 'ready' ? accounts.value : [account];
    return shareOwnerChoices(signedIn, (login) => {
      const load = listings.get(login);
      return load?.kind === 'ready' && load.value.kind === 'ready' ? load.value.repositories : [];
    });
  }, [account, accounts, listings]);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [chosen, setChosen] = useState<AppSummary | undefined>(props.app);
  const scan = useInstalledScan(props.projectPath, chosen?.manifest.id);
  if (signingIn && props.renderSignIn !== undefined) {
    return props.renderSignIn(
      () => {
        setSigningIn(false);
        setDiscovery((count) => count + 1);
      },
      () => setSigningIn(false),
    );
  }
  const start = (request: ShareRequest) => {
    assert(request.account.length > 0, 'A share starts with an account');
    assert(chosen !== undefined, 'A share starts with an app');
    setPhase({ kind: 'running', step: 'create-repository' });
    const { account: shareAccount, ...rest } = request;
    void shareApp(props.projectPath, { id: chosen.manifest.id, account: shareAccount, ...rest }, (step) => setPhase({ kind: 'running', step })).then(
      (answer) => {
        if (!answer.ok) {
          setPhase({ kind: 'error', message: answer.message, messageRef: answer.messageRef });
          return;
        }
        const outcome = answer.value;
        setPhase(outcome.kind === 'shared' ? { kind: 'shared', shared: outcome.shared, account: shareAccount } : { kind: 'failed', outcome });
      },
      (error: unknown) => setPhase({ kind: 'error', message: String(error) }),
    );
  };
  return (
    <Popup className="modal apps-connect apps-share" label={shareLabel} onClose={props.onClose} dismissible={phase.kind !== 'running'}>
      {({ close }) =>
        chosen === undefined ? (
          <ConnectFrame onCancel={close} title={shareLabel}>
            <UploadedPicker uploaded={props.uploaded} onPick={setChosen} />
          </ConnectFrame>
        ) : (
          <SharePhase
            {...props}
            app={chosen}
            phase={phase}
            accounts={accounts.kind === 'ready' ? accounts.value : undefined}
            account={account}
            owners={owners}
            listingOf={(login) => shareListing(props.renderSignIn === undefined ? undefined : listings.get(login))}
            scan={scan.load}
            onRescan={scan.rescan}
            onSignIn={props.renderSignIn === undefined ? undefined : () => setSigningIn(true)}
            onStart={start}
            onRetry={() => setPhase({ kind: 'form' })}
            onDone={close}
          />
        )
      }
    </Popup>
  );
}

/** Each signed-in account's repositories, read once per account set: the owner menu's organizations and the name check come from them. */
function useShareListings(projectPath: string, accounts: readonly string[]): ReadonlyMap<string, Load<AppRepositoryListing>> {
  const [listings, setListings] = useState<ReadonlyMap<string, Load<AppRepositoryListing>>>(() => new Map());
  const key = accounts.slice(0, SHARE_ACCOUNTS_MAX).join('\n');
  useEffect(() => {
    const names = key === '' ? [] : key.split('\n');
    assert(names.length <= SHARE_ACCOUNTS_MAX, 'The accounts listed are bounded');
    let active = true;
    setListings(new Map(names.map((name): [string, Load<AppRepositoryListing>] => [name, { kind: 'loading' }])));
    const settle = (name: string, value: AppRepositoryListing) => {
      if (active) {
        setListings((current) => new Map(current).set(name, { kind: 'ready', value }));
      }
    };
    for (const name of names) {
      void listAppRepositories(projectPath, name).then(
        (listing) => settle(name, listing),
        (error: unknown) => settle(name, { kind: 'failed', message: String(error) }),
      );
    }
    return () => {
      active = false;
    };
  }, [projectPath, key]);
  return listings;
}

/** An account's listing as the name check reads it: no listing at all (Studio, a failure) tells nothing. */
function shareListing(load: Load<AppRepositoryListing> | undefined): ShareListing {
  if (load === undefined) {
    return { kind: 'unknown' };
  }
  switch (load.kind) {
    case 'idle':
    case 'loading':
      return { kind: 'loading' };
    case 'failed':
      return { kind: 'unknown' };
    case 'ready':
      return load.value.kind === 'ready' ? { kind: 'ready', repositories: load.value.repositories } : { kind: 'unknown' };
    default: {
      const exhaustive: never = load;
      return exhaustive;
    }
  }
}

/** The installed app's scan, run when the popup opens and again on "rescan". */
export function useInstalledScan(projectPath: string, id: string | undefined): { readonly load: ScanLoad; readonly rescan: () => void } {
  const [load, setLoad] = useState<ScanLoad>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (id === undefined) {
      return undefined;
    }
    let active = true;
    setLoad({ kind: 'loading' });
    void scanAppSecrets(projectPath, { kind: 'installed', id }).then(
      (answer) =>
        active && setLoad(answer.ok ? { kind: 'ready', scan: answer.value } : { kind: 'failed', message: answer.message, messageRef: answer.messageRef }),
      (error: unknown) => active && setLoad({ kind: 'failed', message: String(error) }),
    );
    return () => {
      active = false;
    };
  }, [projectPath, id, tick]);
  return { load, rescan: useCallback(() => setTick((count) => count + 1), []) };
}

/** Which app to share (uploaded, or added to the project folder), when the popup was opened without one. */
function UploadedPicker(props: { readonly uploaded: readonly AppSummary[]; readonly onPick: (app: AppSummary) => void }) {
  const translate = useTranslate();
  if (props.uploaded.length === 0) {
    return (
      <ChooserEmpty icon={<GitHubIcon size={20} />} title={translate('apps.share.noneTitle')}>
        {translate('apps.share.noneDetail')}
      </ChooserEmpty>
    );
  }
  return (
    <ul className="apps-choice-list" aria-label={translate('apps.share.appsToShare')}>
      {props.uploaded.map((app) => (
        <li key={app.manifest.id}>
          <button type="button" className="apps-choice" onClick={() => props.onPick(app)}>
            <span className="apps-choice-avatar">
              <AppTile manifest={app.manifest} size={24} />
            </span>
            <span className="apps-choice-text">
              <span className="apps-choice-title">{app.manifest.name}</span>
              <span className="apps-choice-meta">{translate('apps.details.versionNamed', { version: app.manifest.version })}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The share popup's chrome: the app itself is the subject of the header (its
 * icon with a small GitHub mark, "Share <name>" and its version), and each step
 * puts its own action at the footer's right, after Cancel. Exported for the
 * layout test, which renders it in Chromium.
 */
export function ShareFrame(props: {
  readonly app: Pick<AppManifest, 'id' | 'name' | 'icon' | 'version'>;
  readonly onCancel: () => void;
  readonly actions?: ReactNode;
  readonly cancel?: 'enabled' | 'disabled' | 'hidden';
  readonly children: ReactNode;
}) {
  assert(props.app.name.length > 0, 'A shared app has a name');
  const translate = useTranslate();
  return (
    <ConnectFrame
      onCancel={props.onCancel}
      icon={
        <span className="apps-share-subject-icon">
          <AppTile manifest={props.app} size={28} />
          <span className="apps-share-subject-badge" aria-hidden="true">
            <GitHubIcon size={10} />
          </span>
        </span>
      }
      title={
        <span className="apps-share-subject">
          <span className="apps-share-subject-name">{translate('apps.share.subject', { name: props.app.name })}</span>
          <span className="apps-share-subject-meta">{translate('apps.share.subjectMeta', { version: props.app.version })}</span>
        </span>
      }
      actions={props.actions}
      cancel={props.cancel ?? 'enabled'}
    >
      {props.children}
    </ConnectFrame>
  );
}

function SharePhase(
  props: Omit<ShareAppProps, 'app'> & {
    readonly app: AppSummary;
    readonly phase: Phase;
    readonly accounts: readonly string[] | undefined;
    readonly account: string | undefined;
    readonly owners: readonly ShareOwnerChoice[];
    readonly listingOf: (account: string) => ShareListing;
    readonly scan: ScanLoad;
    readonly onRescan: () => void;
    readonly onSignIn: (() => void) | undefined;
    readonly onStart: (request: ShareRequest) => void;
    readonly onRetry: () => void;
    readonly onDone: () => void;
  },
) {
  const { phase, app } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const back = (
    <button type="button" className="primary" onClick={props.onRetry}>
      {translate('apps.share.back')}
    </button>
  );
  switch (phase.kind) {
    case 'form':
      if (props.accounts === undefined) {
        return (
          <ShareFrame app={app.manifest} onCancel={props.onDone}>
            <p className="apps-share-detail" role="status">
              {translate('apps.share.reading')}
            </p>
          </ShareFrame>
        );
      }
      if (props.account === undefined) {
        return (
          <ShareFrame app={app.manifest} onCancel={props.onDone}>
            <SignedOut onSignIn={props.onSignIn} />
          </ShareFrame>
        );
      }
      return (
        <ShareForm
          app={app.manifest}
          owners={props.owners}
          accountCount={props.accounts.length}
          listingOf={props.listingOf}
          scan={props.scan}
          renderAvatar={props.renderAvatar}
          onRescan={props.onRescan}
          onStart={props.onStart}
          onCancel={props.onDone}
        />
      );
    case 'running':
      return (
        <ShareFrame
          app={app.manifest}
          onCancel={props.onDone}
          cancel="disabled"
          actions={
            <button type="button" className="primary" disabled>
              {translate('apps.share.sharing')}
            </button>
          }
        >
          <StepList states={shareStepStates(phase.step, { failed: false })} visibility={undefined} />
        </ShareFrame>
      );
    case 'failed':
      return (
        <ShareFrame app={app.manifest} onCancel={props.onDone} actions={back}>
          <div className="apps-share-result" role="alert">
            <StepList states={shareStepStates(phase.outcome.step, { failed: true })} visibility={undefined} />
            <p className="apps-error">{translateDescribed(phase.outcome)}</p>
            <CreatedReport created={phase.outcome.created} createdRefs={phase.outcome.createdRefs} />
          </div>
        </ShareFrame>
      );
    case 'error':
      return (
        <ShareFrame app={app.manifest} onCancel={props.onDone} actions={back}>
          <div className="apps-share-result" role="alert">
            <p className="apps-error">{translateDescribed(phase)}</p>
            <p className="apps-share-detail">{translate('apps.share.nothingCreated')}</p>
          </div>
        </ShareFrame>
      );
    case 'shared':
      return <SharedState {...props} shared={phase.shared} account={phase.account} />;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

/** No account to share with: the publish sign-in where the host has one; Studio has none and says where sharing works. */
function SignedOut(props: { readonly onSignIn: (() => void) | undefined }) {
  const translate = useTranslate();
  return (
    <ChooserEmpty
      icon={<GitHubIcon size={20} />}
      title={props.onSignIn === undefined ? translate('apps.share.needsDesktop') : translate('apps.share.signInTitle')}
      action={
        props.onSignIn === undefined ? undefined : (
          <button type="button" className="apps-button primary" onClick={props.onSignIn}>
            <GitHubIcon size={14} /> {translate('apps.connect.signIn')}
          </button>
        )
      }
    >
      {props.onSignIn === undefined ? translate('apps.share.studioDetail') : translate('apps.share.signInDetail')}
    </ChooserEmpty>
  );
}

export interface ShareFormProps {
  readonly app: Pick<AppManifest, 'id' | 'name' | 'icon' | 'version'>;
  /** Every owner, grouped by signed-in account in order (shareOwnerChoices); never empty. */
  readonly owners: readonly ShareOwnerChoice[];
  readonly accountCount: number;
  readonly listingOf: (account: string) => ShareListing;
  readonly scan: ScanLoad;
  readonly renderAvatar: ShareAppProps['renderAvatar'];
  readonly onRescan: () => void;
  readonly onStart: (request: ShareRequest) => void;
  readonly onCancel: () => void;
  /** What the form starts with; the layout test renders the public state with it. */
  readonly initialVisibility?: AppShareVisibility;
  readonly initialName?: string;
}

/**
 * The form: one owner/name field (the owner chip, "/", the name, checked as it
 * is typed), the visibility as a segmented control with one line saying what
 * it means, and the scan as a status row. Share sits at the footer's right.
 * Exported for the layout test.
 */
export function ShareForm(props: ShareFormProps) {
  const translate = useTranslate();
  const formId = useId();
  const [ownerKey, setOwnerKey] = useState<string | undefined>(undefined);
  const [name, setName] = useState(() => props.initialName ?? suggestedRepositoryName(props.app.id));
  const [visibility, setVisibility] = useState<AppShareVisibility>(props.initialVisibility ?? DEFAULT_APP_SHARE_VISIBILITY);
  const owner = props.owners.find((entry) => entry.key === ownerKey) ?? props.owners[0];
  assert(owner !== undefined, 'The account itself is always an owner');
  const grouped = props.accountCount > 1;
  const options = props.owners.map((entry) => ({
    value: entry.key,
    label: entry.login,
    hint: entry.kind === 'organization' ? translate('apps.share.organization') : translate('apps.share.personal'),
    icon: props.renderAvatar(entry.login, entry.login),
    ...(grouped ? { group: translate('apps.share.signedInAs', { account: entry.account }) } : {}),
  }));
  const status = repositoryNameStatus({ owner: owner.login, ownerKind: owner.kind, name, listing: props.listingOf(owner.account) });
  const ready = repositoryNameUsable(status) && scanPassed(props.scan);
  const choices = visibilityChoices(owner.login, owner.kind, translate);
  const choice = choices.find((entry) => entry.visibility === visibility);
  assert(choice !== undefined, 'The chosen visibility is offered');
  const share = async () => {
    if (!ready) {
      return;
    }
    if (visibility === 'public') {
      const confirmation = publicShareConfirmation(owner.login, name, translate);
      const answer = await confirmDialog({ title: confirmation.title, body: confirmation.body, confirmLabel: confirmation.confirmLabel });
      if (answer !== true) {
        return;
      }
    }
    props.onStart({ account: owner.account, owner: owner.login, ownerKind: owner.kind, name, visibility });
  };
  return (
    <ShareFrame
      app={props.app}
      onCancel={props.onCancel}
      actions={
        <button type="submit" form={formId} className="primary apps-share-submit" disabled={!ready}>
          {visibility === 'public' ? translate('apps.share.sharePublicly') : translate('apps.share.sharePrivately')}
        </button>
      }
    >
      <form
        id={formId}
        className="apps-share-form"
        onSubmit={(event) => {
          event.preventDefault();
          void share();
        }}
      >
        <div className="apps-share-section">
          <span className="apps-share-label">{translate('apps.share.repository')}</span>
          <div className="apps-share-destination" data-status={status.kind}>
            <Dropdown
              ariaLabel={translate('apps.share.ownerLabel')}
              className="apps-share-owner"
              value={owner.key}
              options={options}
              menuWidthMin={220}
              onChange={setOwnerKey}
            />
            <span className="apps-share-slash" aria-hidden="true">
              /
            </span>
            <input
              className="apps-share-name"
              aria-label={translate('apps.share.nameLabel')}
              aria-invalid={!repositoryNameUsable(status)}
              aria-describedby={`${formId}-status`}
              value={name}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setName(event.target.value.trim())}
            />
          </div>
          <NameStatus id={`${formId}-status`} status={status} owner={owner.login} name={name} />
        </div>
        <div className="apps-share-section">
          <div className="apps-share-row">
            <span className="apps-share-label">{translate('apps.share.visibility')}</span>
            <SegmentedTabs
              label={translate('apps.share.visibility')}
              // Two choices filling a fixed-width slot: equal halves read as one switch.
              layout="equal"
              className={{ track: 'apps-share-visibility' }}
              tabs={choices.map((entry) => ({ value: entry.visibility, label: entry.title }))}
              value={visibility}
              onPick={setVisibility}
            />
          </div>
          <p className="apps-share-detail">{choice.detail}</p>
        </div>
        <SecretScanStatus load={props.scan} onRescan={props.onRescan} />
      </form>
    </ShareFrame>
  );
}

/** The line under the destination: what GitHub would say about the name, as it is typed. */
function NameStatus(props: { readonly id: string; readonly status: RepositoryNameStatus; readonly owner: string; readonly name: string }) {
  const { status } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  switch (status.kind) {
    case 'invalid':
      return (
        <p id={props.id} className="apps-share-status invalid" role="alert">
          <WarningTriangleIcon size={11} /> {translateDescribed(status)}
        </p>
      );
    case 'exists':
      return (
        <p id={props.id} className="apps-share-status invalid" role="alert">
          <WarningTriangleIcon size={11} /> {translate('apps.share.exists', { name: `${props.owner}/${props.name}` })}
        </p>
      );
    case 'available':
      return (
        <p id={props.id} className="apps-share-status available">
          <CheckIcon size={11} /> {translate('apps.share.available')}
        </p>
      );
    case 'checking':
      return (
        <p id={props.id} className="apps-share-status">
          {translate('apps.share.checking', { owner: props.owner })}
        </p>
      );
    case 'unchecked':
      return (
        <p id={props.id} className="apps-share-status">
          {translate('apps.share.creates', { address: `github.com/${props.owner}/${props.name}` })}
        </p>
      );
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Each step with its state: done, running, failed or still to come. */
export function StepList<S extends string>(props: {
  readonly states: readonly { readonly step: S; readonly status: 'pending' | 'running' | 'done' | 'failed' }[];
  readonly visibility: AppShareVisibility | undefined;
  readonly label?: (step: S) => string;
}) {
  const translate = useTranslate();
  const translateRef = useTranslateRef();
  return (
    <ol className="apps-steps" aria-label={translate('apps.share.progress')}>
      {props.states.map((state) => (
        <li key={state.step} className={`apps-step ${state.status}`} aria-current={state.status === 'running' ? 'step' : undefined}>
          <span className="apps-step-mark" aria-hidden="true">
            {state.status === 'done' ? <CheckIcon size={11} /> : state.status === 'failed' ? <WarningTriangleIcon size={11} /> : undefined}
          </span>
          <span>{props.label?.(state.step) ?? translateRef(defaultStepRef(state.step, props.visibility))}</span>
          <span className="apps-note">
            {state.status === 'running' ? translate('apps.share.working') : state.status === 'failed' ? translate('apps.share.failed') : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

function defaultStepRef(step: string, visibility: AppShareVisibility | undefined) {
  const shareStep = APP_SHARE_STEPS.find((known) => known === step);
  assert(shareStep !== undefined, 'A step without its own label is a share step');
  return shareStepRef(shareStep, visibility ?? DEFAULT_APP_SHARE_VISIBILITY);
}

/** Exactly what a failed share left on GitHub, so nothing is unaccounted for. */
function CreatedReport({ created, createdRefs }: { readonly created: readonly string[]; readonly createdRefs: readonly MessageRef[] | undefined }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  if (created.length === 0) {
    return <p className="apps-note">{translate('apps.share.nothingCreated')}</p>;
  }
  return (
    <div className="apps-share-created">
      <p className="apps-note">{translate('apps.share.createdBefore')}</p>
      <ul>
        {created.map((entry, index) => (
          <li key={entry}>{translateDescribed({ message: entry, messageRef: createdRefs?.[index] })}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Done: the repository's link with Copy link and Invite people, the finished
 * steps, and whether the app now installs its updates from the new release
 * (on by default). Done applies that choice; so does going on to the
 * marketplace. Exported for the layout test.
 */
export function SharedState(
  props: Pick<ShareAppProps, 'projectPath' | 'notify' | 'onSwitched' | 'onSubmitToMarketplace'> & {
    readonly app: AppSummary;
    readonly shared: AppShared;
    readonly account: string;
    readonly onDone: () => void;
  },
): ReactNode {
  const { shared } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const switchId = useId();
  const [switchSource, setSwitchSource] = useState(true);
  const [busy, setBusy] = useState(false);
  const url = repositoryURL(shared.owner, shared.repository);
  const finish = async (next: (() => void) | undefined) => {
    if (switchSource) {
      setBusy(true);
      const source = { kind: 'github' as const, owner: shared.owner, repository: shared.repository, asset: shared.asset, tag: shared.tag };
      // A private repository is read with the account that shared it; a public one is read as public.
      const answer = await switchAppSource(
        props.projectPath,
        props.app.manifest.id,
        shared.visibility === 'private' ? { ...source, account: props.account } : source,
      );
      setBusy(false);
      if (answer.ok) {
        props.onSwitched(answer.value);
      } else {
        props.notify(translateDescribed(answer), 'error');
        return;
      }
    }
    (next ?? props.onDone)();
  };
  const submit = shared.visibility === 'public' ? props.onSubmitToMarketplace : undefined;
  return (
    <ShareFrame
      app={props.app.manifest}
      onCancel={props.onDone}
      cancel="hidden"
      actions={
        <>
          {submit !== undefined && (
            <button type="button" disabled={busy} onClick={() => void finish(() => submit(shared, props.account))}>
              {translate('apps.share.alsoSubmit')}
            </button>
          )}
          <button type="button" className="primary" disabled={busy} onClick={() => void finish(undefined)}>
            {busy ? translate('apps.share.switching') : translate('apps.share.done')}
          </button>
        </>
      }
    >
      <div className="apps-share-result" role="status">
        <div className="apps-share-done">
          <span className="apps-share-done-mark" aria-hidden="true">
            <CheckIcon size={12} />
          </span>
          <span className="apps-share-done-text">
            <strong>{shared.visibility === 'public' ? translate('apps.share.sharedPublicly') : translate('apps.share.sharedPrivately')}</strong>
            <span className="apps-share-detail">{translate('apps.share.releaseOnGitHub', { tag: shared.tag })}</span>
          </span>
        </div>
        <div className="apps-share-link-row">
          <a className="apps-share-link" href={url} target="_blank" rel="noopener noreferrer" title={url}>
            <GitHubIcon size={12} />
            <span>
              {shared.owner}/{shared.repository}
            </span>
          </a>
          <button
            type="button"
            className="apps-share-link-action"
            onClick={() =>
              void navigator.clipboard.writeText(url).then(
                () => props.notify(translate('apps.share.copied'), 'success'),
                () => props.notify(translate('apps.share.clipboardFailed'), 'error'),
              )
            }
          >
            <CopyIcon size={11} /> {translate('apps.share.copyLink')}
          </button>
          <a className="apps-share-link-action" href={repositoryAccessURL(shared.owner, shared.repository)} target="_blank" rel="noopener noreferrer">
            <ExternalIcon size={11} /> {translate('apps.share.invite')}
          </a>
        </div>
        <StepList states={shareStepStates('finished', { failed: false })} visibility={shared.visibility} />
        <div className="apps-share-update">
          <span className="apps-share-update-text">
            <span>{translate('apps.share.installUpdates')}</span>
            <span id={switchId} className="apps-share-detail">
              {translate('apps.share.updateNotice', { name: `${shared.owner}/${shared.repository}` })}
            </span>
          </span>
          <Switch
            label={translate('apps.share.installUpdates')}
            checked={switchSource}
            describedBy={switchId}
            onToggle={() => setSwitchSource((value) => !value)}
          />
        </div>
      </div>
    </ShareFrame>
  );
}
