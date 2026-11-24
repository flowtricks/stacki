// The built-in authentication provider: GitHub OAuth, exactly as Studio has always signed people in.
// It implements the same interface a custom provider does (authProvider.ts) and has no special access to
// core: it returns who GitHub says the person is, and core signs the session, checks `state`, and decides
// what the person may do. Only this provider may produce `github:` identities.
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';
import { record, string } from '../../shared/validation';
import { parseProfile, type GitHubProfile } from './profile';
import { SignInFailure, signInStep } from './signInFailure';
import { isRateLimited, limitSignal, retryAt } from './githubRateLimit';
import { canEdit as repositoryCanEdit, type AccessConfig } from './repositoryAccess';
import type { AuthProvider, Principal, ProviderPerson, SignInFlow, SignInRefusal } from './authProvider';

export interface AuthConfig {
  readonly GITHUB_CLIENT_ID: string;
  readonly GITHUB_CLIENT_SECRET: string;
  readonly SESSION_SECRET: string;
  readonly EDITOR_GITHUB_IDS: string;
  readonly STUDIO_ORIGIN: string;
}
// `fresh` asks for a live repository lookup; false accepts a recent cached answer to spare GitHub.
export type AuthorizeProfile = (profile: GitHubProfile, fresh: boolean) => Promise<boolean>;

export type GitHubProviderConfig = AuthConfig & AccessConfig;

/** `authorize` is injectable so tests can count repository lookups; the default is the repository check. */
export function createGitHubProvider(
  config: GitHubProviderConfig,
  authorize: AuthorizeProfile = (profile, fresh) => repositoryCanEdit(profile, config, fresh),
): AuthProvider {
  return {
    id: 'github',
    displayName: 'GitHub',
    begin: (_request, flow) => Promise.resolve(beginLogin(config, flow)),
    identify: (request, flow) => identifyPerson(request, config, flow),
    canEdit: (principal, freshness) => authorize(githubProfile(principal), freshness === 'fresh'),
    // Managing connections and updates needs repository Write or Admin, whatever EDITOR_ACCESS admits for editing.
    canManage: (principal) => repositoryCanEdit(githubProfile(principal), { ...config, EDITOR_ACCESS: 'repository' }, true),
  };
}

function githubProfile(principal: Principal): GitHubProfile {
  if (principal.github === undefined) {
    throw new Error('Assertion failed: a github identity carries its GitHub profile');
  }
  return principal.github;
}

async function identifyPerson(request: Request, config: GitHubProviderConfig, flow: SignInFlow): Promise<Result<ProviderPerson, SignInRefusal>> {
  const url = new URL(request.url);
  if (url.searchParams.has('error')) {
    return err({ problem: 'cancelled' });
  }
  const code = url.searchParams.get('code');
  if (!code || code.length > 1000) {
    return err({ problem: 'expired' });
  }
  try {
    const token = await signInStep('token', () => exchangeCode(code, config, flow));
    const profile = await signInStep('profile', () => fetchProfile(token));
    return ok({ identity: `github:${profile.login}`, name: profile.login, github: profile });
  } catch (error) {
    const failure = error instanceof SignInFailure ? error : new SignInFailure('unavailable');
    return err({
      problem: failure.problem,
      reference: `${failure.stage}-${failure.status}-${failure.code}`,
      ...(failure.retryAt > 0 ? { retryAtMs: failure.retryAt } : {}),
    });
  }
}

function beginLogin(config: GitHubProviderConfig, flow: SignInFlow): Response {
  const destination = new URL('https://github.com/login/oauth/authorize');
  destination.searchParams.set('client_id', config.GITHUB_CLIENT_ID);
  destination.searchParams.set('redirect_uri', flow.callbackUrl);
  destination.searchParams.set('state', flow.state);
  return new Response(null, { status: 302, headers: { Location: destination.href } });
}

async function fetchProfile(token: string) {
  const profileResponse = await fetch('https://api.github.com/user', {
    headers: {
      // i18n-ignore: an HTTP header value sent to GitHub.
      Authorization: `Bearer ${token}`,
      // i18n-ignore: an HTTP header value sent to GitHub.
      'User-Agent': 'Astro-Studio',
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!profileResponse.ok) {
    if (isRateLimited(profileResponse.status, profileResponse.headers)) {
      throw new SignInFailure('rate-limit', 'profile', profileResponse.status, limitSignal(profileResponse.headers), retryAt(profileResponse.headers));
    }
    throw new SignInFailure('unavailable', 'profile', profileResponse.status, 'http');
  }
  return parseProfile(await profileResponse.json());
}

async function exchangeCode(code: string, config: AuthConfig, flow: SignInFlow) {
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      // i18n-ignore: an HTTP header value sent to GitHub.
      'User-Agent': 'Stacki-Studio',
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      client_id: config.GITHUB_CLIENT_ID,
      client_secret: config.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: flow.callbackUrl,
    }),
  });
  if (!tokenResponse.ok) {
    if (isRateLimited(tokenResponse.status, tokenResponse.headers)) {
      reportTokenLimit(tokenResponse);
      throw new SignInFailure('rate-limit', 'token', tokenResponse.status, limitSignal(tokenResponse.headers), retryAt(tokenResponse.headers));
    }
    throw new SignInFailure('unavailable', 'token', tokenResponse.status, 'http');
  }
  const data = record(await tokenResponse.json());
  if (data['error'] === 'bad_verification_code') {
    throw new SignInFailure('expired', 'token', tokenResponse.status, 'bad_verification_code');
  }
  if (['incorrect_client_credentials', 'redirect_uri_mismatch'].includes(String(data['error']))) {
    throw new SignInFailure('configuration', 'token', tokenResponse.status, 'credentials_or_callback');
  }
  if (data['error'] === 'unverified_user_email') {
    throw new SignInFailure('email', 'token', tokenResponse.status, 'unverified_user_email');
  }
  if (data['error'] || typeof data['access_token'] !== 'string' || !data['access_token']) {
    throw new SignInFailure('unavailable', 'token', tokenResponse.status, data['error'] ? 'provider_error' : 'missing_token');
  }
  return string(data['access_token'], 1000);
}

function reportTokenLimit(response: Response): void {
  // Only fixed, bounded diagnostic headers; never log credentials or provider bodies.
  const names = [
    'x-github-request-id',
    'retry-after',
    'x-ratelimit-resource',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'server',
    'content-type',
  ];
  console.error(
    'GitHub token limit',
    Object.fromEntries(names.map((name) => [name, (response.headers.get(name) ?? '').replace(/[^a-zA-Z0-9:;=., /_-]/g, '').slice(0, 120)])),
  );
}
