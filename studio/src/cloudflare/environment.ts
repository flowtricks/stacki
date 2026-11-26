import type { AuthConfig } from '../features/auth/githubLogin';
import type { PreviewContainer } from './worker';

export interface Environment extends AuthConfig {
  readonly EDITOR_ACCESS?: string;
  /** `github` (default), `access`, `google`, `oidc` or `passkey`; the provider's own variables follow (docs/auth-providers.md). */
  readonly AUTH_PROVIDER?: string;
  readonly SITE_DEPLOYMENT_URL?: string;
  readonly GITHUB_DEPLOY_WORKER?: string;
  readonly GITHUB_DEPLOY_ACCOUNT?: string;
  readonly PUBLISH_CLOUDFLARE_API_TOKEN?: string;
  readonly PUBLISH_VERCEL_TOKEN?: string;
  readonly PUBLISH_NETLIFY_TOKEN?: string;
  readonly AI_BASE_URL?: string;
  readonly AI_MODEL?: string;
  readonly AI_MODELS?: string;
  readonly AI_API_KEY?: string;
  readonly PREVIEW: DurableObjectNamespace<PreviewContainer>;
  readonly DRAFTS: R2Bucket;
  readonly ASSETS: Fetcher;
  readonly PREVIEW_ORIGIN: string;
  readonly CONTAINER_TOKEN: string;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_INSTALLATION_ID: string;
  readonly GITHUB_PRIVATE_KEY: string;
  readonly GITHUB_REPOSITORY: string;
  readonly GITHUB_BRANCH: string;
}
