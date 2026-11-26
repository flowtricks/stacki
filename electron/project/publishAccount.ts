import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { assert } from '../../shared/core/assert';
import {
  ACCOUNT_SIGN_IN_TIMEOUT_MS,
  ACCOUNT_INSTALL_TIMEOUT_MS,
  accountSignInPending,
  parseAccountRequest,
  parseSignInURL,
  type AccountProvider,
  type AccountRequest,
  type AccountState,
} from '../../shared/ipc/publishAccount';
import type { PackageManager } from '../../shared/properties/packageManager';
import { homedir } from 'node:os';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { err, ok, type Result } from '../../shared/core/result';
import { ensureToolPath, toolPathHome } from '../lib/nodeTools';
import { PNPM_TOLERATE_IGNORED_BUILDS } from './packageManager';
import {
  addPublishToolDirectory,
  netlifyAvailableWithoutPATH,
  publishToolInstalled,
  resolvePublishExecutable,
  vercelInstallPrefix,
  wranglerAvailableWithoutPATH,
} from './publishExecutable';
import { publishEnvironment, stopPublishProcess } from './publishCommands';
import { netlifyEnvironment } from './publishEnvironment';
import { netlifySignInCheck, netlifySignInTicket, NETLIFY_SIGN_IN } from './publishNetlifySignIn';
import {
  appToolsDirectory,
  discardWranglerInstall,
  finishToolInstall,
  prepareToolInstall,
  NETLIFY_PIN,
  WRANGLER_PIN,
  type ToolPin,
  type ToolInstallFailure,
} from './publishToolInstall';

/**
 * One installation of a provider's tool, run by npm before sign-in. Wrangler installs, pinned and verified, into a
 * folder Stacki owns (publishToolInstall.ts); the Vercel CLI installs once for this user, without sudo. `finish`
 * runs after npm exits cleanly and decides whether the result is used; `discard` cleans up after any other ending.
 */
export interface ToolInstall {
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly finish: () => Result<void, ToolInstallFailure>;
  readonly discard: () => void;
}

// What a launched process does: install the provider's tool, sign in, or (Netlify only, whose sign-in does not wait
// by itself) ask whether the sign-in page has been approved yet.
export type LaunchStep =
  { readonly kind: 'installing'; readonly install: ToolInstall } | { readonly kind: 'starting' } | { readonly kind: 'checking'; readonly ticket: string };

interface Session {
  readonly id: string;
  readonly root: string;
  readonly provider: AccountProvider;
  process: ChildProcessWithoutNullStreams;
  step: LaunchStep;
  state: AccountState;
  output: string;
  outputChars: number;
  // Whether the installer printed a network failure. Installer output is never kept (it can hold registry
  // credentials); only this one fact is, so an offline failure can say so.
  offline: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  // Netlify's wait between approval checks, or the limit on the check running now.
  checkTimer: ReturnType<typeof setTimeout> | undefined;
  // Approval checks that failed in a row.
  checkFailures: number;
}
const OUTPUT_CHARS_MAX = 8192;
const INSTALL_OUTPUT_CHARS_MAX = 1_048_576;
export interface NetlifySignInTiming {
  readonly intervalMs: number;
  readonly checkTimeoutMs: number;
  readonly failuresMax: number;
}
type Launch = (root: string, provider: AccountProvider, step: LaunchStep) => ChildProcessWithoutNullStreams;

// One login can own the CLI credential store at a time. Raw output never leaves this service.
export class PublishingAccount {
  private session: Session | undefined;
  // How often Netlify approval is asked for; a test shortens it.
  netlifyTiming: NetlifySignInTiming = NETLIFY_SIGN_IN;

  constructor(
    private readonly launch: Launch = launchAccountSignIn,
    private readonly hasTool: (root: string, provider: AccountProvider) => boolean = accountToolInstalled,
    private readonly prepareInstall: (root: string, provider: AccountProvider) => Result<ToolInstall, Described> = prepareAccountTool,
  ) {}

  request(root: string, input: AccountRequest): AccountState {
    const request = parseAccountRequest(input);
    const provider = request.provider ?? 'github';
    const session = this.session;
    if (session?.id === request.id && session.root === root && session.provider === provider) {
      if (request.action === 'cancel' && accountSignInPending(session.state)) {
        this.finish(session, { kind: 'cancelled' });
      }
      return session.state;
    }
    if (request.action !== 'start') {
      return { kind: 'failed', ...described('publish.account.error.sessionEnded') };
    }
    const busy = this.busy();
    if (busy !== undefined) {
      return busy;
    }
    if (this.hasTool(root, provider)) {
      return this.start(root, request.id, provider, { kind: 'starting' });
    }
    const install = this.prepareInstall(root, provider);
    if (!install.ok) {
      return { kind: 'failed', ...install.error };
    }
    return this.start(root, request.id, provider, { kind: 'installing', install: install.value });
  }

  // A pending sign-in owns the CLI credentials, and a cancelled installation still
  // writing the site must finish before another one can start.
  private busy(): AccountState | undefined {
    const session = this.session;
    if (session === undefined) {
      return undefined;
    }
    if (accountSignInPending(session.state)) {
      return {
        kind: 'failed',
        ...described('publish.account.error.inProgress'),
      };
    }
    if (session.step.kind === 'installing' && running(session.process)) {
      return {
        kind: 'failed',
        ...described('publish.account.setup.stillRunning', { provider: providerLabel(session.provider) }),
      };
    }
    return undefined;
  }

  private start(root: string, id: string, provider: AccountProvider, step: Exclude<LaunchStep, { readonly kind: 'checking' }>): AccountState {
    const child = this.spawnStep(root, provider, step);
    if (child === undefined) {
      // On Windows a missing tool is found while resolving it, before any process starts.
      if (step.kind === 'installing') {
        step.install.discard();
      }
      return { kind: 'failed', ...launchFailure(provider, step) };
    }
    const session: Session = {
      id,
      root,
      provider,
      process: child,
      step,
      state: { kind: step.kind },
      output: '',
      outputChars: 0,
      offline: false,
      timer: undefined,
      checkTimer: undefined,
      checkFailures: 0,
    };
    this.session = session;
    session.timer = setTimeout(() => this.expire(session), step.kind === 'installing' ? ACCOUNT_INSTALL_TIMEOUT_MS : ACCOUNT_SIGN_IN_TIMEOUT_MS);
    session.timer.unref();
    this.watch(session);
    return session.state;
  }

  // Starts one process, stopped with this one; undefined when it cannot even be resolved.
  private spawnStep(root: string, provider: AccountProvider, step: LaunchStep): ChildProcessWithoutNullStreams | undefined {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.launch(root, provider, step);
    } catch {
      return undefined;
    }
    const stop = () => {
      stopAccountSignIn(child, provider);
    };
    process.once('exit', stop);
    child.once('close', () => process.removeListener('exit', stop));
    return child;
  }

  // A pending session fails at its timeout. A cancelled installation left to finish in
  // the background is stopped at the same timeout, so it stays bounded too.
  private expire(session: Session): void {
    if (accountSignInPending(session.state)) {
      this.finish(session, {
        kind: 'failed',
        ...(session.step.kind === 'installing'
          ? described('publish.account.setup.timedOut', { provider: providerLabel(session.provider) })
          : described('publish.account.error.providerSignInExpired', { provider: providerLabel(session.provider) })),
      });
      return;
    }
    if (running(session.process)) {
      stopAccountSignIn(session.process, session.provider);
    }
  }

  private watch(session: Session): void {
    const child = session.process;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: unknown) => this.read(session, chunk, 'stdout'));
    child.stderr.on('data', (chunk: unknown) => this.read(session, chunk, 'stderr'));
    child.on('error', () =>
      this.finish(session, {
        kind: 'failed',
        ...launchFailure(session.provider, session.step),
      }),
    );
    child.on('close', (code) => {
      // A Netlify session runs several processes in turn; only the current one may decide anything.
      if (session.process === child) {
        this.closed(session, code ?? undefined);
      }
    });
    // Piped input keeps gh in its device-code flow without an interactive shell or prompts.
    // `vercel login` reads its input until it exits, so its pipe stays open while it waits.
    child.stdin.on('error', () => {});
    if (session.provider !== 'vercel' || session.step.kind === 'installing') {
      child.stdin.end();
    }
  }

  private closed(session: Session, code: number | undefined): void {
    if (this.session !== session) {
      return;
    }
    if (session.step.kind === 'installing') {
      this.installed(session, session.step.install, code);
      return;
    }
    if (!accountSignInPending(session.state)) {
      return;
    }
    if (session.provider === 'netlify') {
      if (session.step.kind === 'checking') {
        this.netlifyChecked(session, session.step.ticket, code);
      } else {
        this.netlifyRequested(session, code);
      }
      return;
    }
    this.finish(
      session,
      code === 0
        ? { kind: 'complete' }
        : {
            kind: 'failed',
            ...described('publish.account.error.signInIncomplete', { provider: providerLabel(session.provider) }),
          },
    );
  }

  // The session an event belongs to, while it is still the one waiting.
  private current(expected: Session): Session | undefined {
    const session = this.session;
    return session === expected && accountSignInPending(session.state) ? session : undefined;
  }

  // `netlify login --request` printed its ticket and exited: show its page, then ask until it is approved.
  private netlifyRequested(expected: Session, code: number | undefined): void {
    const session = this.current(expected);
    if (session === undefined) {
      return;
    }
    const request = code === 0 ? netlifySignInTicket(session.output) : undefined;
    if (request === undefined) {
      this.finish(session, { kind: 'failed', ...netlifySignInProblem(session.offline ? 'offline' : 'incomplete') });
      return;
    }
    session.state = { kind: 'browser', url: request.url };
    this.scheduleNetlifyCheck(session, request.ticket);
  }

  // One check at a time, started only after the last one ended; the session's own timeout bounds how many.
  private scheduleNetlifyCheck(expected: Session, ticket: string): void {
    const session = this.current(expected);
    if (session === undefined) {
      return;
    }
    session.output = '';
    session.outputChars = 0;
    session.checkTimer = setTimeout(() => this.checkNetlify(session, ticket), this.netlifyTiming.intervalMs);
    session.checkTimer.unref();
  }

  private checkNetlify(expected: Session, ticket: string): void {
    const session = this.current(expected);
    if (session === undefined) {
      return;
    }
    const step: LaunchStep = { kind: 'checking', ticket };
    const child = this.spawnStep(session.root, session.provider, step);
    if (child === undefined) {
      this.finish(session, { kind: 'failed', ...launchFailure(session.provider, step) });
      return;
    }
    session.process = child;
    session.step = step;
    session.offline = false;
    session.checkTimer = setTimeout(() => stopAccountSignIn(child, session.provider), this.netlifyTiming.checkTimeoutMs);
    session.checkTimer.unref();
    this.watch(session);
  }

  private netlifyChecked(expected: Session, ticket: string, code: number | undefined): void {
    const session = this.current(expected);
    if (session === undefined) {
      return;
    }
    clearTimeout(session.checkTimer);
    const status = code === 0 ? netlifySignInCheck(session.output) : undefined;
    switch (status) {
      case 'authorized':
        this.finish(session, { kind: 'complete' });
        return;
      case 'denied':
        this.finish(session, { kind: 'failed', ...netlifySignInProblem('incomplete') });
        return;
      case 'pending':
        session.checkFailures = 0;
        this.scheduleNetlifyCheck(session, ticket);
        return;
      case undefined:
        // A passing outage must not end a sign-in the person is in the middle of approving.
        session.checkFailures += 1;
        if (session.checkFailures < this.netlifyTiming.failuresMax) {
          this.scheduleNetlifyCheck(session, ticket);
        } else {
          this.finish(session, { kind: 'failed', ...netlifySignInProblem(session.offline ? 'offline' : 'incomplete') });
        }
        return;
      default: {
        const exhaustive: never = status;
        return exhaustive;
      }
    }
  }

  // An installer exited. A clean exit is verified and kept even after a cancel, so the next attempt starts at once;
  // any other exit discards what it wrote. Only a still-pending session goes on to sign in or reports a failure.
  private installed(session: Session, install: ToolInstall, code: number | undefined): void {
    assert(session.step.kind === 'installing', 'Only an installation session finishes an install');
    clearTimeout(session.timer);
    let outcome: Result<void, ToolInstallFailure | 'failed' | 'offline'>;
    if (code === 0) {
      outcome = install.finish();
    } else {
      install.discard();
      outcome = err(session.offline ? 'offline' : 'failed');
    }
    if (!accountSignInPending(session.state)) {
      return;
    }
    if (outcome.ok) {
      // Session identity prevents late installer events from completing the subsequent login.
      const login = this.start(session.root, session.id, session.provider, { kind: 'starting' });
      if (this.session === session) {
        // Login could not launch, so no new session replaced this one.
        this.finish(session, login);
      }
      return;
    }
    this.finish(session, { kind: 'failed', ...installFailure(session.provider, outcome.error) });
  }

  private read(expectedSession: Session, chunk: unknown, stream: 'stdout' | 'stderr'): void {
    const session = this.session;
    if (session === undefined || session !== expectedSession) {
      return;
    }
    if (!accountSignInPending(session.state)) {
      return;
    }
    assert(typeof chunk === 'string', 'Account sign-in streams use UTF-8 text');
    assert(session.output.length <= OUTPUT_CHARS_MAX, 'Account sign-in output stays bounded');
    const installing = session.step.kind === 'installing';
    const limit = installing ? INSTALL_OUTPUT_CHARS_MAX : OUTPUT_CHARS_MAX;
    if (chunk.length > limit - session.outputChars) {
      this.finish(session, {
        kind: 'failed',
        ...(installing
          ? described('publish.account.setup.failed', { provider: providerLabel(session.provider) })
          : described('publish.account.error.signInOutputLarge', { provider: providerLabel(session.provider) })),
      });
      return;
    }
    session.outputChars += chunk.length;
    // Installation logs can contain registry credentials; count them without retaining them.
    if (installing) {
      if (INSTALL_OFFLINE_PATTERN.test(chunk)) {
        session.offline = true;
      }
      return;
    }
    if (session.provider === 'netlify') {
      // Netlify's answer is one JSON document on standard output, read when the command exits. Its errors are not kept.
      if (stream === 'stdout') {
        session.output += chunk;
      } else if (INSTALL_OFFLINE_PATTERN.test(chunk)) {
        session.offline = true;
      }
      return;
    }
    session.output += chunk;
    if (session.provider === 'cloudflare') {
      const url = /https:\/\/dash\.cloudflare\.com\/oauth2\/auth\?[^\s]+(?=\s)/.exec(session.output)?.[0];
      if (url && url.length <= 4096 && !url.includes('#')) {
        session.state = { kind: 'browser', url: parseSignInURL(url) };
      }
      return;
    }
    if (session.provider === 'vercel') {
      const url = vercelSignInURL(session.output);
      if (url !== undefined) {
        session.state = { kind: 'browser', url };
      }
      return;
    }
    const code = /one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(session.output)?.[1];
    if (code) {
      session.state = { kind: 'waiting', code };
    }
  }

  private finish(expectedSession: Session, state: AccountState): void {
    const session = this.session;
    if (session === undefined || session !== expectedSession) {
      return;
    }
    if (!accountSignInPending(session.state)) {
      return;
    }
    assert(!accountSignInPending(state), 'Sign-in finishes with a terminal state');
    assert(this.session === session, 'Only the current sign-in session can finish');
    session.state = state;
    session.output = '';
    if (session.step.kind === 'installing') {
      if (state.kind === 'cancelled') {
        // Stopping a package manager mid-install can leave node_modules half written, so
        // a cancelled installation finishes in the background, bounded by its timeout.
        return;
      }
    }
    clearTimeout(session.timer);
    session.timer = undefined;
    clearTimeout(session.checkTimer);
    session.checkTimer = undefined;
    if (running(session.process)) {
      stopAccountSignIn(session.process, session.provider);
    }
  }
}

function running(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

// The words npm prints for a registry it could not reach; anything else that fails is reported as a plain failure.
const INSTALL_OFFLINE_PATTERN = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|network request|getaddrinfo/;

function installFailure(provider: AccountProvider, failure: ToolInstallFailure | 'failed' | 'offline'): Described {
  const params = { provider: providerLabel(provider) };
  switch (failure) {
    case 'disk':
      return described('publish.account.setup.disk', params);
    case 'verify':
      return described('publish.account.setup.verifyFailed', params);
    case 'offline':
      return described('publish.account.setup.offline', params);
    case 'failed':
      return described('publish.account.setup.failed', params);
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

function launchFailure(provider: AccountProvider, step: LaunchStep): Described {
  if (step.kind === 'installing') {
    // The installer, `npm`, comes with Node.js, which every site needs too; it is the one thing Stacki cannot install itself.
    return described('publish.account.setup.needsNode', { provider: providerLabel(provider) });
  }
  switch (provider) {
    case 'github':
      return described('publish.account.error.startGitHub');
    case 'cloudflare':
      return described('publish.account.error.startCloudflare');
    case 'vercel':
      return described('publish.account.error.startVercel');
    case 'netlify':
      return described('publish.account.error.startNetlify');
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

function providerLabel(provider: AccountProvider): string {
  switch (provider) {
    case 'github':
      // i18n-ignore: product and tool names (GitHub, Vercel, Cloudflare, Wrangler), shown as written in every language.
      return 'GitHub';
    case 'cloudflare':
      // i18n-ignore: product and tool names (GitHub, Vercel, Cloudflare, Wrangler), shown as written in every language.
      return 'Cloudflare';
    case 'vercel':
      // i18n-ignore: product and tool names (GitHub, Vercel, Cloudflare, Wrangler), shown as written in every language.
      return 'Vercel';
    case 'netlify':
      // i18n-ignore: a product name, shown as written in every language.
      return 'Netlify';
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

// GitHub's gh is never installed by Stacki; sign-in reports a missing gh as a launch failure.
function accountToolInstalled(root: string, provider: AccountProvider): boolean {
  switch (provider) {
    case 'github':
      return true;
    case 'cloudflare':
      // The site's own Wrangler, Stacki's pinned copy, or one shipped beside Desktop or Studio. A Wrangler found only on
      // PATH does not count: its version is unknown, so Stacki installs the pinned one it has tested instead.
      return wranglerAvailableWithoutPATH(root);
    case 'vercel':
      ensureToolPath();
      return publishToolInstalled(root, 'vercel');
    case 'netlify':
      // The same rule as Wrangler: this sign-in needs `login --request`, which an unknown global CLI may not have.
      return netlifyAvailableWithoutPATH(root);
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

// Plans the install a provider's sign-in needs. GitHub's gh is a native program Stacki never installs.
function prepareAccountTool(root: string, provider: AccountProvider): Result<ToolInstall, Described> {
  switch (provider) {
    case 'github':
      return err(described('publish.account.error.startGitHub'));
    case 'cloudflare':
      return pinnedAccountTool(provider, WRANGLER_PIN);
    case 'netlify':
      return pinnedAccountTool(provider, NETLIFY_PIN);
    case 'vercel':
      return ok({
        arguments: vercelInstallArguments(toolPathHome ?? homedir(), process.platform),
        cwd: root,
        finish: () => {
          // The global install wrote a directory this process may not have had on PATH yet.
          addPublishToolDirectory(toolPathHome ?? homedir());
          return ok(undefined);
        },
        discard: () => {},
      });
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

// A tool Stacki installs, pinned and verified, into its own folder (publishToolInstall.ts).
function pinnedAccountTool(provider: AccountProvider, pin: ToolPin): Result<ToolInstall, Described> {
  const plan = prepareToolInstall(appToolsDirectory(), pin);
  if (!plan.ok) {
    return err(installFailure(provider, plan.error));
  }
  return ok({
    arguments: plan.value.arguments,
    cwd: plan.value.staging,
    finish: () => finishToolInstall(plan.value),
    discard: () => discardWranglerInstall(plan.value),
  });
}

// A sign-in that did not finish; an outage says so, with the same words the settings use for one.
function netlifySignInProblem(why: 'offline' | 'incomplete'): Described {
  const params = { provider: providerLabel('netlify') };
  return why === 'offline' ? described('publish.connection.failure.network', params) : described('publish.account.error.signInIncomplete', params);
}

/**
 * The device-authorization page `vercel login` printed. Without a terminal the CLI prints the
 * full address (a terminal would get a shortened hyperlink), and CI=true stops it from opening a
 * browser itself, so Stacki opens only an address it has checked.
 */
export function vercelSignInURL(output: string): string | undefined {
  assert(output.length <= OUTPUT_CHARS_MAX, 'Vercel sign-in output stays bounded');
  const url = /https:\/\/vercel\.com\/oauth\/device\?[^\s'"<>]+/.exec(output)?.[0];
  if (url === undefined) {
    return undefined;
  }
  if (url.length > 4096) {
    return undefined;
  }
  if (url.includes('#')) {
    return undefined;
  }
  return parseSignInURL(url);
}

// Installs the Vercel CLI for this user: npm's global mode under ~/.local needs no sudo. Windows
// npm's own global folder is per-user already.
export function vercelInstallArguments(home: string, platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? ['install', '--global', 'vercel'] : ['install', '--global', '--prefix', vercelInstallPrefix(home), 'vercel'];
}

// Adds the latest Wrangler as a development dependency with the site's manager. Sign-in no longer uses this (it installs
// Stacki's own pinned copy); Worker setup still adds Wrangler to a site that deploys with it.
export function wranglerInstallArguments(manager: PackageManager): readonly string[] {
  switch (manager) {
    case 'npm':
      return ['install', '--save-dev', 'wrangler'];
    case 'pnpm':
      return ['add', '--save-dev', PNPM_TOLERATE_IGNORED_BUILDS, 'wrangler'];
    case 'yarn':
    case 'bun':
      return ['add', '--dev', 'wrangler'];
    default: {
      const exhaustive: never = manager;
      return exhaustive;
    }
  }
}

function launchAccountSignIn(root: string, provider: AccountProvider, step: LaunchStep): ChildProcessWithoutNullStreams {
  if (provider === 'cloudflare') {
    return launchCloudflareSignIn(root, step);
  }
  if (provider === 'vercel') {
    return launchVercelSignIn(root, step);
  }
  if (provider === 'netlify') {
    return launchNetlifySignIn(root, step);
  }
  ensureToolPath();
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' };
  // An inherited automation token would prevent gh from adding a locally stored account.
  delete environment['GH_TOKEN'];
  delete environment['GITHUB_TOKEN'];
  return spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'], {
    cwd: root,
    env: environment,
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
  });
}

function launchCloudflareSignIn(root: string, step: LaunchStep): ChildProcessWithoutNullStreams {
  ensureToolPath();
  const command = resolvePublishExecutable(
    root,
    step.kind === 'installing'
      ? { executable: 'npm', arguments: step.install.arguments, environment: {} }
      : { executable: 'wrangler', arguments: ['login', '--browser=false'], environment: {} },
  );
  return spawn(command.executable, [...command.arguments], {
    cwd: step.kind === 'installing' ? step.install.cwd : root,
    env: { ...publishEnvironment(), NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
    detached: process.platform !== 'win32',
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
  });
}

function launchVercelSignIn(root: string, step: LaunchStep): ChildProcessWithoutNullStreams {
  ensureToolPath();
  const command = resolvePublishExecutable(
    root,
    step.kind === 'installing'
      ? { executable: 'npm', arguments: step.install.arguments, environment: {} }
      : { executable: 'vercel', arguments: ['login'], environment: {} },
  );
  // VERCEL_TOKEN would make the CLI use that token instead of signing this computer in.
  const environment: NodeJS.ProcessEnv = { ...publishEnvironment(), CI: 'true', NO_COLOR: '1', npm_config_yes: 'false' };
  delete environment['VERCEL_TOKEN'];
  return spawn(command.executable, [...command.arguments], {
    cwd: root,
    env: environment,
    detached: process.platform !== 'win32',
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
  });
}

function launchNetlifySignIn(root: string, step: LaunchStep): ChildProcessWithoutNullStreams {
  ensureToolPath();
  const command = resolvePublishExecutable(
    root,
    step.kind === 'installing'
      ? { executable: 'npm', arguments: step.install.arguments, environment: {} }
      : { executable: 'netlify', arguments: netlifySignInArguments(step), environment: {} },
  );
  const environment = netlifyEnvironment();
  // A token or another web address inherited from the shell must not stand in for signing this computer in.
  delete environment['NETLIFY_AUTH_TOKEN'];
  delete environment['NETLIFY_WEB_UI'];
  return spawn(command.executable, [...command.arguments], {
    cwd: step.kind === 'installing' ? step.install.cwd : root,
    env: environment,
    detached: process.platform !== 'win32',
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
  });
}

// The CLI's sign-in for programs without a terminal: ask for a ticket, then check it. The CLI stores the token itself.
export function netlifySignInArguments(step: Exclude<LaunchStep, { readonly kind: 'installing' }>): readonly string[] {
  switch (step.kind) {
    case 'starting':
      return ['login', '--request', 'Stacki', '--json'];
    case 'checking':
      return ['login', '--check', step.ticket, '--json'];
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}

function stopAccountSignIn(child: ChildProcessWithoutNullStreams, provider: AccountProvider): void {
  if (provider !== 'github') {
    // Wrangler's, Vercel's and Netlify's launchers start children; closing only the launcher leaves them waiting.
    stopPublishProcess(child.pid);
  }
  child.kill('SIGKILL');
}
