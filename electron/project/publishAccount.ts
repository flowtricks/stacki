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
  publishToolInstalled,
  resolvePublishExecutable,
  vercelInstallPrefix,
  wranglerAvailableWithoutPATH,
} from './publishExecutable';
import { publishEnvironment, stopPublishProcess } from './publishCommands';
import { appToolsDirectory, discardWranglerInstall, finishWranglerInstall, prepareWranglerInstall, type ToolInstallFailure } from './publishToolInstall';

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

// What a launched process does: install the provider's tool, or sign in.
export type LaunchStep = { readonly kind: 'installing'; readonly install: ToolInstall } | { readonly kind: 'starting' };

interface Session {
  readonly id: string;
  readonly root: string;
  readonly provider: AccountProvider;
  readonly process: ChildProcessWithoutNullStreams;
  readonly step: LaunchStep;
  state: AccountState;
  output: string;
  outputChars: number;
  // Whether the installer printed a network failure. Installer output is never kept (it can hold registry
  // credentials); only this one fact is, so an offline failure can say so.
  offline: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}
const OUTPUT_CHARS_MAX = 8192;
const INSTALL_OUTPUT_CHARS_MAX = 1_048_576;
type Launch = (root: string, provider: AccountProvider, step: LaunchStep) => ChildProcessWithoutNullStreams;

// One login can own the CLI credential store at a time. Raw output never leaves this service.
export class PublishingAccount {
  private session: Session | undefined;

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

  private start(root: string, id: string, provider: AccountProvider, step: LaunchStep): AccountState {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.launch(root, provider, step);
    } catch {
      // On Windows a missing tool is found while resolving it, before any process starts.
      if (step.kind === 'installing') {
        step.install.discard();
      }
      return { kind: 'failed', ...launchFailure(provider, step) };
    }
    const stop = () => {
      stopAccountSignIn(child, provider);
    };
    process.once('exit', stop);
    child.once('close', () => process.removeListener('exit', stop));
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
    };
    this.session = session;
    session.timer = setTimeout(() => this.expire(session), step.kind === 'installing' ? ACCOUNT_INSTALL_TIMEOUT_MS : ACCOUNT_SIGN_IN_TIMEOUT_MS);
    session.timer.unref();
    this.watch(session);
    return session.state;
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
    child.stdout.on('data', (chunk: unknown) => this.read(session, chunk));
    child.stderr.on('data', (chunk: unknown) => this.read(session, chunk));
    child.on('error', () =>
      this.finish(session, {
        kind: 'failed',
        ...launchFailure(session.provider, session.step),
      }),
    );
    child.on('close', (code) => this.closed(session, code ?? undefined));
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

  private read(expectedSession: Session, chunk: unknown): void {
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
    case 'cloudflare': {
      const plan = prepareWranglerInstall(appToolsDirectory());
      if (!plan.ok) {
        return err(installFailure(provider, plan.error));
      }
      return ok({
        arguments: plan.value.arguments,
        cwd: plan.value.staging,
        finish: () => finishWranglerInstall(plan.value),
        discard: () => discardWranglerInstall(plan.value),
      });
    }
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

function stopAccountSignIn(child: ChildProcessWithoutNullStreams, provider: AccountProvider): void {
  if (provider !== 'github') {
    // Wrangler's and Vercel's launchers start children; closing only the launcher leaves them waiting.
    stopPublishProcess(child.pid);
  }
  child.kill('SIGKILL');
}
