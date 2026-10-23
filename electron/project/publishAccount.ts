import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { assert } from '../../shared/core/assert';
import {
  ACCOUNT_SIGN_IN_TIMEOUT_MS,
  ACCOUNT_INSTALL_TIMEOUT_MS,
  accountSignInPending,
  parseAccountRequest,
  parseCloudflareSignInURL,
  type AccountRequest,
  type AccountState,
} from '../../shared/ipc/publishAccount';
import { packageManagerLabel, type PackageManager } from '../../shared/properties/packageManager';
import { ensureToolPath } from '../lib/nodeTools';
import { detectPackageManager, PNPM_TOLERATE_IGNORED_BUILDS } from './packageManager';
import { projectHasWrangler, resolvePublishExecutable } from './publishExecutable';
import { publishEnvironment, stopPublishProcess } from './publishCommands';

// What a launched process does: install Wrangler with the site's manager, or sign in.
export type LaunchStep =
  | { readonly kind: 'installing'; readonly packageManager: PackageManager }
  | { readonly kind: 'starting' };

interface Session {
  readonly id: string;
  readonly root: string;
  readonly provider: 'github' | 'cloudflare';
  readonly process: ChildProcessWithoutNullStreams;
  readonly step: LaunchStep;
  state: AccountState;
  output: string;
  outputChars: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}
const OUTPUT_CHARS_MAX = 8192;
const INSTALL_OUTPUT_CHARS_MAX = 1_048_576;
type Launch = (
  root: string,
  provider: 'github' | 'cloudflare',
  step: LaunchStep,
) => ChildProcessWithoutNullStreams;

// One login can own the CLI credential store at a time. Raw output never leaves this service.
export class PublishingAccount {
  private session: Session | undefined;

  constructor(
    private readonly launch: Launch = launchAccountSignIn,
    private readonly hasWrangler: (root: string) => boolean = projectHasWrangler,
    private readonly packageManager: (root: string) => PackageManager = detectPackageManager,
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
      return { kind: 'failed', message: 'This sign-in session has ended. Please try again.' };
    }
    const busy = this.busy();
    if (busy !== undefined) {
      return busy;
    }
    const step: LaunchStep =
      provider === 'cloudflare' && !this.hasWrangler(root)
        ? { kind: 'installing', packageManager: this.packageManager(root) }
        : { kind: 'starting' };
    return this.start(root, request.id, provider, step);
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
        message: 'Finish or cancel the account sign-in already in progress.',
      };
    }
    if (session.step.kind === 'installing' && running(session.process)) {
      return {
        kind: 'failed',
        message: 'Wrangler is still installing in the background. Try again in a moment.',
      };
    }
    return undefined;
  }

  private start(
    root: string,
    id: string,
    provider: 'github' | 'cloudflare',
    step: LaunchStep,
  ): AccountState {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.launch(root, provider, step);
    } catch {
      // On Windows a missing tool is found while resolving it, before any process starts.
      return { kind: 'failed', message: launchFailure(provider, step) };
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
      timer: undefined,
    };
    this.session = session;
    session.timer = setTimeout(
      () => this.expire(session),
      step.kind === 'installing' ? ACCOUNT_INSTALL_TIMEOUT_MS : ACCOUNT_SIGN_IN_TIMEOUT_MS,
    );
    session.timer.unref();
    this.watch(session);
    return session.state;
  }

  // A pending session fails at its timeout. A cancelled installation left to finish in
  // the background is stopped at the same timeout, so it stays bounded too.
  private expire(session: Session): void {
    if (accountSignInPending(session.state)) {
      const label = session.provider === 'github' ? 'GitHub' : 'Cloudflare';
      this.finish(session, {
        kind: 'failed',
        message:
          session.step.kind === 'installing'
            ? 'Wrangler installation timed out. Check your connection and try again.'
            : `${label} sign-in expired. Please try again.`,
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
        message: launchFailure(session.provider, session.step),
      }),
    );
    child.on('close', (code) => this.closed(session, code ?? undefined));
    // Piped input keeps gh in its device-code flow without an interactive shell or prompts.
    child.stdin.on('error', () => {});
    child.stdin.end();
  }

  private closed(session: Session, code: number | undefined): void {
    if (this.session !== session) {
      return;
    }
    if (!accountSignInPending(session.state)) {
      // A cancelled installation that finished in the background needs no timeout now.
      clearTimeout(session.timer);
      return;
    }
    if (session.step.kind === 'installing') {
      if (code === 0) {
        clearTimeout(session.timer);
        // Session identity prevents late installer events from completing the subsequent login.
        const login = this.start(session.root, session.id, session.provider, { kind: 'starting' });
        if (this.session === session) {
          // Login could not launch, so no new session replaced this one.
          this.finish(session, login);
        }
      } else {
        this.finish(session, {
          kind: 'failed',
          message:
            'Could not install Wrangler. Check your connection and project access, then retry.',
        });
      }
      return;
    }
    const label = session.provider === 'github' ? 'GitHub' : 'Cloudflare';
    this.finish(
      session,
      code === 0
        ? { kind: 'complete' }
        : {
            kind: 'failed',
            message: `${label} sign-in did not complete. Check CLI authentication and try again.`,
          },
    );
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
    const label = installing
      ? 'Wrangler installation'
      : `${session.provider === 'github' ? 'GitHub' : 'Cloudflare'} sign-in`;
    const limit = installing ? INSTALL_OUTPUT_CHARS_MAX : OUTPUT_CHARS_MAX;
    if (chunk.length > limit - session.outputChars) {
      this.finish(session, {
        kind: 'failed',
        message: `${label} returned too much output.`,
      });
      return;
    }
    session.outputChars += chunk.length;
    // Installation logs can contain registry credentials; count them without retaining them.
    if (installing) {
      return;
    }
    session.output += chunk;
    if (session.provider === 'cloudflare') {
      const url = /https:\/\/dash\.cloudflare\.com\/oauth2\/auth\?[^\s]+(?=\s)/.exec(
        session.output,
      )?.[0];
      if (url && url.length <= 4096 && !url.includes('#')) {
        session.state = { kind: 'browser', url: parseCloudflareSignInURL(url) };
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

function launchFailure(provider: 'github' | 'cloudflare', step: LaunchStep): string {
  if (step.kind === 'installing') {
    const label = packageManagerLabel(step.packageManager);
    return `Could not run ${label} to install Wrangler. Install ${label}, then try again.`;
  }
  return provider === 'github'
    ? 'Could not start GitHub sign-in. Install gh and try again.'
    : 'Could not start Cloudflare sign-in. Install Wrangler and try again.';
}

// Adds the latest Wrangler as a development dependency with the site's manager.
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

function launchAccountSignIn(
  root: string,
  provider: 'github' | 'cloudflare',
  step: LaunchStep,
): ChildProcessWithoutNullStreams {
  if (provider === 'cloudflare') {
    return launchCloudflareSignIn(root, step);
  }
  ensureToolPath();
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' };
  // An inherited automation token would prevent gh from adding a locally stored account.
  delete environment['GH_TOKEN'];
  delete environment['GITHUB_TOKEN'];
  return spawn(
    'gh',
    [
      'auth',
      'login',
      '--hostname',
      'github.com',
      '--web',
      '--git-protocol',
      'https',
      '--skip-ssh-key',
    ],
    {
      cwd: root,
      env: environment,
      stdio: 'pipe',
      shell: false,
      windowsHide: true,
    },
  );
}

function launchCloudflareSignIn(root: string, step: LaunchStep): ChildProcessWithoutNullStreams {
  ensureToolPath();
  const command = resolvePublishExecutable(
    root,
    step.kind === 'installing'
      ? {
          executable: step.packageManager,
          arguments: wranglerInstallArguments(step.packageManager),
          environment: {},
        }
      : { executable: 'wrangler', arguments: ['login', '--browser=false'], environment: {} },
  );
  return spawn(command.executable, [...command.arguments], {
    cwd: root,
    env: { ...publishEnvironment(), NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
    detached: process.platform !== 'win32',
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
  });
}

function stopAccountSignIn(
  child: ChildProcessWithoutNullStreams,
  provider: 'github' | 'cloudflare',
): void {
  if (provider === 'cloudflare') {
    // Wrangler's executable starts a child; closing only the launcher leaves OAuth listening.
    stopPublishProcess(child.pid);
  }
  child.kill('SIGKILL');
}
