// OAuth sign-ins for apps, run by the host and never by the app (shared/properties/
// appAuth.ts holds the contract; docs/apps.md "Signing in"). One module for
// Desktop's main process (electron/handlers/appAuthHandlers.ts, a loopback
// callback per RFC 8252) and the Studio server (studio/src/features/apps/
// appsServer.ts, its own callback route), so both run the same flow:
//
// 1. `begin` makes a PKCE verifier and a random state, and the authorize URL
//    with the installer's own client id (an App setting) and the host's
//    redirect URI. One flow per app at a time; it lapses after
//    APP_AUTH_LIMITS.flowTimeoutMs.
// 2. The browser comes back to the redirect URI; `complete` finds the flow by
//    its state (compared in constant time), and exchanges the code at the token
//    endpoint with the verifier, and the client secret when the provider
//    declares one, read from the secret vault.
// 3. The tokens are sealed in the same vault as secret settings, per project and
//    app, in their own file beside the settings' file: never under the project.
// 4. `token` hands the app its access token only, refreshing it here first when
//    it is about to lapse. The refresh token and the client secret never leave.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { record, text } from '../../shared/core/boundary';
import { parseAppId, type AppManifest } from '../../shared/properties/apps';
import { APP_AUTH_LIMITS, parseAuthProviderId, type AppAccessToken, type AppAuthProvider, type AppAuthStatus } from '../../shared/properties/appAuth';
import { readAppSettings, secretVaultFile, type SecretVault } from './appSettingsStore';
import { brokerRoutes, type StackiConnectionProviderId } from '../../shared/properties/appConnections';
import { readBounded } from './appGitHub';

export type TokenFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface AppSignInDependencies {
  readonly fetch: TokenFetch;
  readonly now: () => number;
  readonly vault: SecretVault;
  /** The Stacki connections broker's origin (appConnections.ts STACKI_BROKER_ORIGIN, or a local `wrangler dev`). */
  readonly broker: string;
}

/**
 * How a provider signs in: through Stacki's broker with Stacki's registered app, or straight with the
 * installer's own client. A Stacki connection whose client id setting the installer filled in uses
 * their client: the advanced fallback (docs/apps.md, "Connections").
 */
type SignInRoute = 'broker' | 'custom';

/** A flow `begin` started: where to send the person, and the outcome once the callback arrives or the flow lapses. */
export interface AppSignInFlow {
  readonly authorizeURL: string;
  readonly done: Promise<FlowOutcome>;
}

export type FlowOutcome = { readonly ok: true; readonly value: AppAuthStatus } | { readonly ok: false; readonly message: string };

/** What a callback request carried, as the host's route read it. */
export interface SignInCallback {
  readonly state: string | undefined;
  readonly code: string | undefined;
  readonly error: string | undefined;
  /** The broker's signed handoff, which a broker sign-in sends back with the code. */
  readonly handoff?: string | undefined;
}

/** A token record as sealed in the vault: never sent to an app whole. */
interface StoredToken {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly tokenType: string;
  readonly expiresAtMs: number | undefined;
  readonly account: string | undefined;
  /** Where it refreshes: the broker, or the provider with the installer's client. */
  readonly route: SignInRoute;
}

interface PendingFlow {
  readonly key: string;
  readonly projectRoot: string;
  readonly manifest: AppManifest;
  readonly provider: AppAuthProvider;
  readonly state: string;
  readonly verifier: string;
  readonly redirectURI: string;
  readonly route: SignInRoute;
  /** Who waits for the outcome: `begin`'s caller, and a later `waiting` call (Studio's second request). At most two. */
  readonly listeners: ((outcome: FlowOutcome) => void)[];
  readonly timer: ReturnType<typeof setTimeout>;
}

const BROKER_CHECK_LIMITS = {
  /** How long a broker's answer to "is this provider set up" holds. */
  cacheMs: 60_000,
  timeoutMs: 5_000,
  /** `{"configured":true}` with room. */
  replyBytesMax: 4 * 1024,
} as const satisfies Record<string, number>;

const STORE_LIMITS = {
  /** One project's sealed token file: 50 apps of 4 providers, with room. */
  fileBytesMax: 1024 * 1024,
  /** Flows waiting at once across projects: one per installed app. */
  flowsMax: 50,
} as const satisfies Record<string, number>;

export function createAppSignIns(dependencies: AppSignInDependencies) {
  const pending = new Map<string, PendingFlow>();
  const refreshing = new Map<string, Promise<StoredToken>>();
  // The broker's last answer per provider: at most one entry per registered provider.
  const brokerChecks = new Map<StackiConnectionProviderId, { readonly atMs: number; readonly problem: string | undefined }>();

  const finish = (flow: PendingFlow, outcome: FlowOutcome): void => {
    if (pending.get(flow.key) !== flow) {
      return;
    }
    pending.delete(flow.key);
    clearTimeout(flow.timer);
    for (const listener of flow.listeners) {
      listener(outcome);
    }
  };

  return {
    /** Starts a sign-in for one provider of an installed app; refused while another of the app's flows waits. */
    begin(projectRoot: string, manifest: AppManifest, providerId: string, redirectURI: string): AppSignInFlow {
      const provider = providerOf(manifest, providerId);
      const refusal = dependencies.vault.seal.refusal();
      if (refusal !== undefined) {
        throw new Error(refusal.replace('secret settings', 'sign-ins'));
      }
      const key = flowKey(projectRoot, manifest.id);
      if (pending.has(key)) {
        throw new Error(`${manifest.name} is already waiting for a sign-in; finish it in the browser or wait for it to time out.`);
      }
      if (pending.size >= STORE_LIMITS.flowsMax) {
        throw new Error('Too many sign-ins are waiting; try again shortly.');
      }
      const route = routeOf(projectRoot, dependencies.vault, manifest, provider);
      const { verifier, challenge } = pkcePair();
      const state = base64URL(randomBytes(32));
      const url =
        route.kind === 'broker'
          ? brokerStartURL(dependencies.broker, route.connection, provider, { challenge, state, redirectURI })
          : customAuthorizeURL(provider, route.clientId, { challenge, state, redirectURI });
      const listeners: ((outcome: FlowOutcome) => void)[] = [];
      const done = new Promise<FlowOutcome>((resolve) => {
        listeners.push(resolve);
      });
      const timer = setTimeout(() => {
        const flow = pending.get(key);
        if (flow !== undefined) {
          finish(flow, { ok: false, message: 'The sign-in timed out; connect again to retry.' });
        }
      }, APP_AUTH_LIMITS.flowTimeoutMs);
      // The timeout only expires a waiting flow; it must not hold the process open, so Desktop
      // and Studio quit, and a test that begins a flow exits, without waiting out the five minutes.
      timer.unref();
      const flow: PendingFlow = { key, projectRoot, manifest, provider, state, verifier, redirectURI, route: route.kind, listeners, timer };
      pending.set(key, flow);
      assert(pending.size <= STORE_LIMITS.flowsMax, 'Waiting flows are bounded');
      return { authorizeURL: url.toString(), done };
    },

    /** The flow a callback's state names, settled with the token exchange; a state no flow holds is refused. */
    async complete(callback: SignInCallback): Promise<FlowOutcome> {
      const flow = callback.state === undefined ? undefined : flowWithState(pending, callback.state);
      if (flow === undefined) {
        return { ok: false, message: 'This sign-in is not one Stacki started, or it has expired.' };
      }
      if (callback.error !== undefined) {
        const outcome: FlowOutcome = { ok: false, message: `${flow.provider.label} refused the sign-in: ${callback.error.slice(0, 200)}` };
        finish(flow, outcome);
        return outcome;
      }
      if (callback.code === undefined || callback.code.length === 0 || callback.code.length > APP_AUTH_LIMITS.tokenCharsMax) {
        const outcome: FlowOutcome = { ok: false, message: `${flow.provider.label} sent no authorization code.` };
        finish(flow, outcome);
        return outcome;
      }
      let outcome: FlowOutcome;
      try {
        const request = exchangeRequest(dependencies, flow, callback, callback.code);
        const token = await requestToken(dependencies, flow.projectRoot, flow.manifest, flow.provider, request, undefined);
        writeToken(dependencies.vault, flow.projectRoot, flow.manifest.id, flow.provider.id, token);
        outcome = { ok: true, value: statusOf(flow.provider.id, token) };
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith('Assertion failed')) {
          throw error;
        }
        outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      finish(flow, outcome);
      return outcome;
    },

    /** The outcome of the app's waiting flow, or undefined when none waits. */
    waiting(projectRoot: string, appId: string): Promise<FlowOutcome> | undefined {
      const flow = pending.get(flowKey(projectRoot, appId));
      if (flow === undefined) {
        return undefined;
      }
      if (flow.listeners.length >= 2) {
        throw new Error('Someone is already waiting for this sign-in.');
      }
      return new Promise((resolve) => {
        flow.listeners.push(resolve);
      });
    },

    /** Stops the app's waiting flow: its window closed, or the project did. */
    cancel(projectRoot: string, appId: string): void {
      const flow = pending.get(flowKey(projectRoot, appId));
      if (flow !== undefined) {
        finish(flow, { ok: false, message: 'The sign-in was cancelled.' });
      }
    },

    /** Each declared provider, connected or not. */
    status(projectRoot: string, manifest: AppManifest): readonly AppAuthStatus[] {
      const stored = readTokens(dependencies.vault, projectRoot)[manifest.id] ?? {};
      return manifest.auth.map((provider) => {
        const token = stored[provider.id];
        return token === undefined ? { provider: provider.id, connected: false } : statusOf(provider.id, token);
      });
    },

    /**
     * Each declared provider, as `status`, with a Stacki connection that cannot sign in now (its broker
     * unreachable or not set up) answered as `unconfigured` rather than plain not connected.
     */
    async checkedStatus(projectRoot: string, manifest: AppManifest): Promise<readonly AppAuthStatus[]> {
      const statuses = this.status(projectRoot, manifest);
      const checked: AppAuthStatus[] = [];
      for (const status of statuses) {
        checked.push(status.connected ? status : ((await this.unconfigured(projectRoot, manifest, status.provider)) ?? status));
      }
      assert(checked.length === statuses.length, 'Every provider is checked once');
      return checked;
    },

    /**
     * Why a provider cannot sign in now, as an `unconfigured` status, or undefined when it can: checked
     * before the browser opens, so an unconfigured broker fails at once instead of after the flow's timeout.
     */
    async unconfigured(projectRoot: string, manifest: AppManifest, providerId: string): Promise<AppAuthStatus | undefined> {
      const provider = providerOf(manifest, providerId);
      let route: ReturnType<typeof routeOf>;
      try {
        route = routeOf(projectRoot, dependencies.vault, manifest, provider);
      } catch {
        return undefined; // A custom client not filled in: `begin` says so in its own words.
      }
      if (route.kind === 'custom') {
        return undefined;
      }
      const message = await brokerProblem(route.connection, provider.label);
      return message === undefined ? undefined : { provider: provider.id, connected: false, code: 'unconfigured', message };
    },

    /** The access token for the app: refreshed first when it is about to lapse. Not connected is an expected failure. */
    async token(projectRoot: string, manifest: AppManifest, providerId: string): Promise<AppAccessToken> {
      const provider = providerOf(manifest, providerId);
      const stored = (readTokens(dependencies.vault, projectRoot)[manifest.id] ?? {})[provider.id];
      if (stored === undefined) {
        throw new Error(`Not connected to ${provider.label}; connect it in the app's details or with stacki.auth.connect.`);
      }
      const fresh = stored.expiresAtMs === undefined || dependencies.now() < stored.expiresAtMs - APP_AUTH_LIMITS.refreshSkewMs;
      const token = fresh ? stored : await refreshOnce(projectRoot, manifest, provider, stored);
      assert(token.accessToken.length > 0, 'A handed-out token is never empty');
      return { accessToken: token.accessToken, tokenType: token.tokenType, expiresAtMs: token.expiresAtMs };
    },

    /** Forgets one provider's tokens. */
    disconnect(projectRoot: string, appId: string, providerId: string): void {
      const tokens = readTokens(dependencies.vault, projectRoot);
      const app = { ...(tokens[appId] ?? {}) };
      delete app[parseAuthProviderId(providerId)];
      writeTokens(dependencies.vault, projectRoot, { ...tokens, [appId]: app });
    },

    /** Forgets every token of an app, as its removal does. */
    forget(projectRoot: string, appId: string): void {
      const tokens = { ...readTokens(dependencies.vault, projectRoot) };
      if (tokens[appId] !== undefined) {
        delete tokens[appId];
        writeTokens(dependencies.vault, projectRoot, tokens);
      }
    },
  };

  // Whether the broker can sign in with this provider now, or why not; one check a minute per provider.
  async function brokerProblem(connection: StackiConnectionProviderId, label: string): Promise<string | undefined> {
    const nowMs = dependencies.now();
    const cached = brokerChecks.get(connection);
    if (cached !== undefined && nowMs - cached.atMs < BROKER_CHECK_LIMITS.cacheMs) {
      return cached.problem;
    }
    let problem: string | undefined;
    try {
      const response = await dependencies.fetch(brokerRoutes(dependencies.broker, connection).status, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(BROKER_CHECK_LIMITS.timeoutMs),
      });
      const parsed: unknown = JSON.parse(new TextDecoder().decode(await readBounded(response, BROKER_CHECK_LIMITS.replyBytesMax)));
      problem = response.ok && record(parsed)['configured'] === true ? undefined : `Stacki's ${label} connection is not set up yet.`;
    } catch {
      problem = "Stacki's connections service could not be reached; check the internet connection and try again.";
    }
    brokerChecks.set(connection, { atMs: nowMs, problem });
    return problem;
  }

  // One refresh per provider at a time: two token calls at once share it.
  function refreshOnce(projectRoot: string, manifest: AppManifest, provider: AppAuthProvider, stored: StoredToken): Promise<StoredToken> {
    const key = `${flowKey(projectRoot, manifest.id)}\n${provider.id}`;
    const running = refreshing.get(key);
    if (running !== undefined) {
      return running;
    }
    const refresh = (async (): Promise<StoredToken> => {
      if (stored.refreshToken === undefined) {
        throw new Error(`The ${provider.label} sign-in expired; connect again.`);
      }
      const request: TokenRequest =
        stored.route === 'broker'
          ? { route: 'broker', url: brokerRoutes(dependencies.broker, brokerConnection(provider)).refresh, json: { refresh_token: stored.refreshToken } }
          : { route: 'custom', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }) };
      let token: StoredToken;
      try {
        token = await requestToken(dependencies, projectRoot, manifest, provider, request, stored);
      } catch (error: unknown) {
        if (error instanceof RevokedError) {
          // The provider no longer honours the refresh token: the person signs in again.
          const tokens = readTokens(dependencies.vault, projectRoot);
          const app = { ...(tokens[manifest.id] ?? {}) };
          delete app[provider.id];
          writeTokens(dependencies.vault, projectRoot, { ...tokens, [manifest.id]: app });
        }
        throw error;
      }
      writeToken(dependencies.vault, projectRoot, manifest.id, provider.id, token);
      return token;
    })();
    refreshing.set(key, refresh);
    void refresh.then(
      () => refreshing.delete(key),
      () => refreshing.delete(key),
    );
    return refresh;
  }
}

export type AppSignIns = ReturnType<typeof createAppSignIns>;

/** A PKCE verifier and its S256 challenge (RFC 7636): 32 random bytes, base64url. */
export function pkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = base64URL(randomBytes(32));
  const challenge = base64URL(createHash('sha256').update(verifier).digest());
  assert(verifier.length === 43, 'A verifier is 43 characters');
  assert(challenge !== verifier, 'A challenge never repeats its verifier');
  return { verifier, challenge };
}

/** The sealed token file of a project: beside its secret settings' file in the vault, never inside the project. */
export function appTokenFile(vault: Pick<SecretVault, 'directory'>, projectRoot: string): string {
  const settingsFile = secretVaultFile(vault, projectRoot);
  assert(settingsFile.endsWith('.json'), 'A vault file is JSON');
  return settingsFile.replace(/\.json$/, '.auth.json');
}

/** A token endpoint refused a refresh for good (`invalid_grant`): the stored sign-in is gone. */
class RevokedError extends Error {}

/** One token request: a form to the provider with the installer's client, or JSON to the broker, which adds Stacki's. */
type TokenRequest =
  | { readonly route: 'custom'; readonly body: URLSearchParams }
  | { readonly route: 'broker'; readonly url: string; readonly json: Readonly<Record<string, string>> };

/** One token request, its answer bounded and parsed; `previous` keeps a refresh token the answer does not repeat. */
async function requestToken(
  dependencies: AppSignInDependencies,
  projectRoot: string,
  manifest: AppManifest,
  provider: AppAuthProvider,
  request: TokenRequest,
  previous: StoredToken | undefined,
): Promise<StoredToken> {
  let url: string;
  let init: RequestInit;
  if (request.route === 'custom') {
    const body = new URLSearchParams(request.body);
    body.set('client_id', customClientId(projectRoot, dependencies.vault, manifest, provider));
    if (provider.clientSecretSetting !== undefined) {
      const secret = readAppSettings(projectRoot, dependencies.vault, manifest)[provider.clientSecretSetting];
      if (secret === undefined || secret === '') {
        throw new Error(`Fill in the ${provider.label} client secret in the app's settings first.`);
      }
      body.set('client_secret', secret);
    }
    url = provider.tokenURL;
    init = { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() };
  } else {
    url = request.url;
    init = { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(request.json) };
  }
  let response: Response;
  try {
    response = await dependencies.fetch(url, {
      ...init,
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(APP_AUTH_LIMITS.tokenRequestTimeoutMs),
    });
  } catch (error: unknown) {
    throw new Error(`${provider.label} did not answer the token request: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
  }
  const source = new TextDecoder().decode(await readBounded(response, APP_AUTH_LIMITS.tokenResponseBytesMax));
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${provider.label} answered the token request with something other than JSON (status ${response.status}).`);
  }
  return { ...parseTokenResponse(parsed, { ok: response.ok }, provider, dependencies.now(), previous), route: request.route };
}

// The code exchange for a flow: the provider's own, or the broker's, which checks the verifier against the challenge it signed.
function exchangeRequest(dependencies: AppSignInDependencies, flow: PendingFlow, callback: SignInCallback, code: string): TokenRequest {
  if (flow.route === 'custom') {
    return {
      route: 'custom',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: flow.redirectURI, code_verifier: flow.verifier }),
    };
  }
  const handoff = callback.handoff;
  if (handoff === undefined || handoff.length === 0 || handoff.length > APP_AUTH_LIMITS.tokenCharsMax) {
    throw new Error(`The ${flow.provider.label} sign-in came back without Stacki's handoff; connect again.`);
  }
  return { route: 'broker', url: brokerRoutes(dependencies.broker, brokerConnection(flow.provider)).token, json: { code, handoff, verifier: flow.verifier } };
}

// The provider's own authorize address, with the installer's client, PKCE and the loopback redirect.
function customAuthorizeURL(
  provider: AppAuthProvider,
  clientId: string,
  flow: { readonly challenge: string; readonly state: string; readonly redirectURI: string },
): URL {
  const url = new URL(provider.authorizeURL);
  for (const [name, value] of Object.entries(provider.authorizeParams)) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', flow.redirectURI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('state', flow.state);
  url.searchParams.set('code_challenge', flow.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

// The broker's start address: the scopes, the PKCE challenge, the editor's state and where the browser comes back to.
function brokerStartURL(
  broker: string,
  connection: StackiConnectionProviderId,
  provider: AppAuthProvider,
  flow: { readonly challenge: string; readonly state: string; readonly redirectURI: string },
): URL {
  const url = new URL(brokerRoutes(broker, connection).start);
  url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('challenge', flow.challenge);
  url.searchParams.set('state', flow.state);
  url.searchParams.set('return', flow.redirectURI);
  return url;
}

function brokerConnection(provider: AppAuthProvider): StackiConnectionProviderId {
  const connection = provider.connection;
  assert(connection !== undefined, 'Only a Stacki connection signs in through the broker');
  return connection;
}

/**
 * Which way a provider signs in now: the installer's own client when the provider is custom, or when
 * they filled in the client id of a Stacki connection; otherwise the broker.
 */
function routeOf(
  projectRoot: string,
  vault: SecretVault,
  manifest: AppManifest,
  provider: AppAuthProvider,
): { readonly kind: 'custom'; readonly clientId: string } | { readonly kind: 'broker'; readonly connection: StackiConnectionProviderId } {
  const setting = provider.clientIdSetting;
  const clientId = setting === undefined ? undefined : readAppSettings(projectRoot, vault, manifest)[setting];
  if (clientId !== undefined && clientId !== '') {
    return { kind: 'custom', clientId };
  }
  if (provider.connection !== undefined) {
    return { kind: 'broker', connection: provider.connection };
  }
  throw new Error(`Fill in your own ${provider.label} client id in the app's settings first.`);
}

/** A token endpoint's JSON answer (RFC 6749 §5.1, §5.2). Exported for the tests that drive it directly. */
export function parseTokenResponse(
  input: unknown,
  answer: { readonly ok: boolean },
  provider: AppAuthProvider,
  nowMs: number,
  previous: StoredToken | undefined,
): Omit<StoredToken, 'route'> {
  const value = record(input);
  const error = value['error'];
  if (!answer.ok || error !== undefined) {
    const code = typeof error === 'string' ? error.slice(0, 80) : 'error';
    const description = typeof value['error_description'] === 'string' ? `: ${value['error_description'].slice(0, 200)}` : '';
    const message = `${provider.label} refused the token request (${code})${description}`;
    throw code === 'invalid_grant' ? new RevokedError(message) : new Error(message);
  }
  const accessToken = boundedToken(value['access_token'], 'access_token');
  const refreshInput = value['refresh_token'];
  const refreshToken = refreshInput === undefined ? previous?.refreshToken : boundedToken(refreshInput, 'refresh_token');
  const expiresIn = value['expires_in'];
  let expiresAtMs: number | undefined;
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    expiresAtMs = nowMs + Math.floor(Math.min(expiresIn, 365 * 24 * 3600) * 1000);
  } else if (typeof expiresIn === 'string' && /^\d{1,9}$/.test(expiresIn)) {
    expiresAtMs = nowMs + Number(expiresIn) * 1000;
  }
  const tokenType = typeof value['token_type'] === 'string' && /^[A-Za-z]{1,40}$/.test(value['token_type']) ? value['token_type'] : 'Bearer';
  const account = accountOf(value) ?? previous?.account;
  return { accessToken, refreshToken, tokenType, expiresAtMs, account };
}

// Who signed in, when the answer says: an id token's email or name (read for display only; it came
// straight from the token endpoint over TLS), or a top-level email. Undefined otherwise.
function accountOf(value: Readonly<Record<string, unknown>>): string | undefined {
  const direct = value['email'];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct.slice(0, APP_AUTH_LIMITS.accountCharsMax);
  }
  const idToken = value['id_token'];
  if (typeof idToken !== 'string' || idToken.length > APP_AUTH_LIMITS.tokenCharsMax) {
    return undefined;
  }
  const payload = idToken.split('.')[1];
  if (payload === undefined) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const fields = record(claims);
    const name = fields['email'] ?? fields['name'];
    return typeof name === 'string' && name.length > 0 ? name.slice(0, APP_AUTH_LIMITS.accountCharsMax) : undefined;
  } catch {
    return undefined;
  }
}

function boundedToken(input: unknown, what: string): string {
  const value = text(input);
  if (value.length === 0 || value.length > APP_AUTH_LIMITS.tokenCharsMax) {
    throw new Error(`The token answer's ${what} is 1 to ${APP_AUTH_LIMITS.tokenCharsMax} characters`);
  }
  return value;
}

function statusOf(provider: string, token: StoredToken): AppAuthStatus {
  return { provider, connected: true, account: token.account, expiresAtMs: token.expiresAtMs };
}

function providerOf(manifest: AppManifest, providerId: string): AppAuthProvider {
  const provider = manifest.auth.find((entry) => entry.id === providerId);
  if (provider === undefined) {
    throw new Error(`${manifest.name} declares no auth provider "${providerId.slice(0, 32)}".`);
  }
  return provider;
}

function customClientId(projectRoot: string, vault: SecretVault, manifest: AppManifest, provider: AppAuthProvider): string {
  const route = routeOf(projectRoot, vault, manifest, provider);
  if (route.kind !== 'custom') {
    throw new Error(`The ${provider.label} client id was cleared; connect again.`);
  }
  return route.clientId;
}

function flowKey(projectRoot: string, appId: string): string {
  return `${path.resolve(projectRoot)}\n${parseAppId(appId)}`;
}

// The flow whose state equals `state`, compared in constant time so the comparison does not leak it.
function flowWithState(pending: ReadonlyMap<string, PendingFlow>, state: string): PendingFlow | undefined {
  const given = Buffer.from(state);
  for (const flow of pending.values()) {
    const expected = Buffer.from(flow.state);
    if (expected.byteLength === given.byteLength && timingSafeEqual(expected, given)) {
      return flow;
    }
  }
  return undefined;
}

function base64URL(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------
// The sealed token file
// ---------------------------------------------------------------------------

type TokenFile = Readonly<Record<string, Readonly<Record<string, StoredToken>>>>;

function readTokens(vault: SecretVault, projectRoot: string): TokenFile {
  const file = appTokenFile(vault, projectRoot);
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  if (source.length > STORE_LIMITS.fileBytesMax) {
    throw new Error('The sign-in file exceeds its limit.');
  }
  const parsed: unknown = JSON.parse(source);
  const value = record(parsed);
  if (value['version'] !== 1) {
    throw new Error('The sign-in file version must be 1');
  }
  const result: Record<string, Record<string, StoredToken>> = {};
  for (const [appId, providers] of Object.entries(record(value['apps']))) {
    const tokens: Record<string, StoredToken> = {};
    for (const [providerId, sealed] of Object.entries(record(providers))) {
      try {
        const opened: unknown = JSON.parse(vault.seal.open(text(sealed)));
        tokens[parseAuthProviderId(providerId)] = parseStoredToken(opened);
      } catch {
        // A token sealed by another computer's keychain no longer opens: it reads as not connected.
      }
    }
    result[parseAppId(appId)] = tokens;
  }
  return result;
}

function parseStoredToken(input: unknown): StoredToken {
  const value = record(input);
  const optionalText = (field: string): string | undefined => (value[field] === undefined ? undefined : boundedToken(value[field], field));
  const expires = value['expiresAtMs'];
  return {
    accessToken: boundedToken(value['accessToken'], 'accessToken'),
    refreshToken: optionalText('refreshToken'),
    tokenType: boundedToken(value['tokenType'], 'tokenType'),
    expiresAtMs: typeof expires === 'number' && Number.isSafeInteger(expires) ? expires : undefined,
    account: optionalText('account'),
    // A sign-in stored before connections existed was the installer's own client.
    route: value['route'] === 'broker' ? 'broker' : 'custom',
  };
}

function writeToken(vault: SecretVault, projectRoot: string, appId: string, providerId: string, token: StoredToken): void {
  const tokens = readTokens(vault, projectRoot);
  writeTokens(vault, projectRoot, { ...tokens, [appId]: { ...(tokens[appId] ?? {}), [providerId]: token } });
  const written = readTokens(vault, projectRoot)[appId]?.[providerId];
  assert(written?.accessToken === token.accessToken, 'A token reads back as written');
}

function writeTokens(vault: SecretVault, projectRoot: string, tokens: TokenFile): void {
  const apps: Record<string, Record<string, string>> = {};
  for (const [appId, providers] of Object.entries(tokens)) {
    const sealed: Record<string, string> = {};
    for (const [providerId, token] of Object.entries(providers)) {
      const plain = JSON.stringify(token);
      sealed[providerId] = vault.seal.seal(plain);
      assert(sealed[providerId] !== plain, 'A token is never kept as received');
    }
    if (Object.keys(sealed).length > 0) {
      apps[appId] = sealed;
    }
  }
  const file = appTokenFile(vault, projectRoot);
  const source = `${JSON.stringify({ version: 1, apps })}\n`;
  if (source.length > STORE_LIMITS.fileBytesMax) {
    throw new Error('The sign-ins exceed their limit; nothing was saved.');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, source, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  const real = fs.realpathSync(projectRoot);
  const relative = path.relative(real, fs.realpathSync(file));
  assert(relative.startsWith('..') || path.isAbsolute(relative), 'Tokens are never written inside the project');
}
