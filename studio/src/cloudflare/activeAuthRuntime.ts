// The AuthRuntime for a Worker environment: the installed custom provider if the build bundled one, otherwise the built-in
// provider `AUTH_PROVIDER` names (GitHub when absent). Built once per environment object and reused, so a provider's own
// caches live as long as the Worker isolate does. A provider that does not satisfy the interface, an unknown
// AUTH_PROVIDER, a variable missing for the chosen provider, or a build made for another provider stops the request
// loudly (503, logged) instead of falling back to GitHub: an instance that chose another provider must never silently
// sign in with GitHub.
import { createGitHubProvider, type GitHubProviderConfig } from '../features/auth/githubProvider';
import { createAuthRuntime, type AuthRuntime } from '../features/auth/authRuntime';
import { providerEnvironment } from '../features/auth/authProvider';
import { authConfigProblems, parseAuthProviderId } from '../features/auth/providers/authConfig';
import { platformFetch } from '../features/auth/providers/boundedFetch';
import { createGitHubRolesSource } from '../features/auth/providers/rolesSource';
import { createPasskeyStore, type KeyValueStorage, type PasskeyStore } from '../features/auth/providers/passkeyStore';
import { customAuthProvider } from './authProviderSlot';
import { builtInProviderSlot } from './builtInProviderSlot';

type AuthEnvironment = GitHubProviderConfig & {
  readonly AUTH_PROVIDER?: string;
  /** The Durable Object namespace: the Worker asks it whether a passkey handle is still active (worker.ts `passkeyHandleActive`). */
  readonly PREVIEW?: { readonly getByName: (name: string) => { readonly passkeyHandleActive: (handle: string) => Promise<boolean> } };
};

/** What only the Durable Object has: its storage. Absent in the Worker, where passkey checks call the Durable Object. */
export interface RuntimeAccess {
  readonly storage?: KeyValueStorage | undefined;
}

const runtimes = new WeakMap<object, AuthRuntime>();
const stores = new WeakMap<object, PasskeyStore>();

/** The passkey store of the Durable Object that holds `storage`, created once per environment. */
export function passkeyStoreFor(environment: object, storage: KeyValueStorage): PasskeyStore {
  const known = stores.get(environment);
  if (known) {
    return known;
  }
  const store = createPasskeyStore(storage);
  stores.set(environment, store);
  return store;
}

export function activeAuthRuntime(environment: AuthEnvironment, access: RuntimeAccess = {}): AuthRuntime {
  const known = runtimes.get(environment);
  if (known) {
    return known;
  }
  const base = { origin: environment.STUDIO_ORIGIN, secret: environment.SESSION_SECRET, editorAccess: environment.EDITOR_ACCESS };
  let runtime: AuthRuntime;
  if (customAuthProvider !== undefined) {
    runtime = createAuthRuntime({
      ...base,
      installed: 'custom',
      provider: customAuthProvider({ origin: environment.STUDIO_ORIGIN, environment: providerEnvironment(environment) }),
    });
  } else {
    runtime = createAuthRuntime({ ...base, installed: 'built-in', provider: builtInProvider(environment, access) });
  }
  runtimes.set(environment, runtime);
  return runtime;
}

function builtInProvider(environment: AuthEnvironment, access: RuntimeAccess) {
  const chosen = parseAuthProviderId(environment.AUTH_PROVIDER);
  if (!chosen.ok) {
    throw new Error(chosen.error);
  }
  // The build bundles one provider; a deployment whose variable says another would otherwise fail in a confusing way.
  if (chosen.value !== builtInProviderSlot.id) {
    throw new Error(`AUTH_PROVIDER is "${chosen.value}" but this build bundles "${builtInProviderSlot.id}". Run npm run build again after changing it.`);
  }
  if (builtInProviderSlot.create === undefined) {
    return createGitHubProvider(environment);
  }
  const problems = authConfigProblems(providerEnvironment(environment));
  if (problems.length > 0) {
    throw new Error(`Studio AUTH_PROVIDER=${chosen.value} is misconfigured: ${problems.join(' ')}`);
  }
  const store = access.storage === undefined ? undefined : passkeyStoreFor(environment, access.storage);
  const github = {
    appId: environment.GITHUB_APP_ID,
    installationId: environment.GITHUB_INSTALLATION_ID,
    privateKey: environment.GITHUB_PRIVATE_KEY,
    repository: environment.GITHUB_REPOSITORY,
    branch: environment.GITHUB_BRANCH,
  };
  return builtInProviderSlot.create({
    origin: environment.STUDIO_ORIGIN,
    sessionSecret: environment.SESSION_SECRET,
    // The provider's own variables and secrets, never core's credentials (the GitHub App key is read through `roles`).
    environment: { ...providerEnvironment(environment), EDITOR_ACCESS: environment.EDITOR_ACCESS },
    roles: createGitHubRolesSource(github),
    fetcher: platformFetch,
    now: Date.now,
    passkeys: store,
    passkeyHandleActive: (handle) => passkeyActive(environment, store, handle),
  });
}

async function passkeyActive(environment: AuthEnvironment, store: PasskeyStore | undefined, handle: string): Promise<boolean> {
  if (store !== undefined) {
    return store.handleActive(handle, Date.now());
  }
  // The Worker asks the Durable Object that holds the passkeys. A short answer cache keeps this off the request path.
  const cached = activity.get(handle);
  if (cached !== undefined && cached.until > Date.now()) {
    return cached.active;
  }
  const namespace = environment.PREVIEW;
  if (namespace === undefined) {
    throw new Error('Assertion failed: the passkey provider needs the PREVIEW Durable Object binding');
  }
  const active = await namespace.getByName('project').passkeyHandleActive(handle);
  if (activity.size >= ACTIVITY_ENTRIES_MAX) {
    activity.clear();
  }
  activity.set(handle, { active, until: Date.now() + ACTIVITY_CACHE_MS });
  return active;
}

const ACTIVITY_CACHE_MS = 15_000;
const ACTIVITY_ENTRIES_MAX = 500;
const activity = new Map<string, { active: boolean; until: number }>();
