// GitHub sign-in as a function of its configuration: the built-in provider (githubProvider.ts) run through core's
// sign-in flow (authRoutes.ts). Kept as its own entry point because the flow's tests, and the GitHub-only callers,
// name GitHub sign-in directly; the Worker itself depends on the provider interface (activeAuthRuntime.ts).
import { authRoutes, logout as coreLogout } from './authRoutes';
import { createAuthRuntime } from './authRuntime';
import { createGitHubProvider, type AuthConfig, type AuthorizeProfile } from './githubProvider';
import type { LoginAttempts } from './loginAttempts';

export { loginPage } from './loginPage';
export type { AuthConfig, AuthorizeProfile } from './githubProvider';

export function githubLogin(request: Request, config: AuthConfig, attempts: LoginAttempts, authorize: AuthorizeProfile): Promise<Response | undefined> {
  const provider = createGitHubProvider({ ...config, ...accessDefaults }, authorize);
  const runtime = createAuthRuntime({ provider, installed: 'built-in', origin: config.STUDIO_ORIGIN, secret: config.SESSION_SECRET, editorAccess: undefined });
  return authRoutes(request, runtime, attempts);
}

export function logout(request: Request, config: AuthConfig): Response {
  return coreLogout(request, config.STUDIO_ORIGIN);
}

// The repository settings only matter to the default `authorize`, which callers of this entry point replace.
const accessDefaults = {
  GITHUB_APP_ID: '',
  GITHUB_INSTALLATION_ID: '',
  GITHUB_PRIVATE_KEY: '',
  GITHUB_REPOSITORY: '',
  GITHUB_BRANCH: '',
};
