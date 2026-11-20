// The AuthRuntime for a Worker environment: the installed custom provider if the build bundled one, otherwise the
// built-in GitHub provider. Built once per environment object and reused, so a provider's own caches live as long
// as the Worker isolate does. A provider that does not satisfy the interface stops the request loudly (503, logged)
// instead of falling back to GitHub: an instance that chose another provider must never silently sign in with GitHub.
import { createGitHubProvider, type GitHubProviderConfig } from '../features/auth/githubProvider';
import { createAuthRuntime, type AuthRuntime } from '../features/auth/authRuntime';
import { providerEnvironment } from '../features/auth/authProvider';
import { customAuthProvider } from './authProviderSlot';

type AuthEnvironment = GitHubProviderConfig;

const runtimes = new WeakMap<object, AuthRuntime>();

export function activeAuthRuntime(environment: AuthEnvironment): AuthRuntime {
  const known = runtimes.get(environment);
  if (known) {
    return known;
  }
  const base = { origin: environment.STUDIO_ORIGIN, secret: environment.SESSION_SECRET, editorAccess: environment.EDITOR_ACCESS };
  const runtime =
    customAuthProvider === undefined
      ? createAuthRuntime({ ...base, installed: 'built-in', provider: createGitHubProvider(environment) })
      : createAuthRuntime({
          ...base,
          installed: 'custom',
          provider: customAuthProvider({ origin: environment.STUDIO_ORIGIN, environment: providerEnvironment(environment) }),
        });
  runtimes.set(environment, runtime);
  return runtime;
}
