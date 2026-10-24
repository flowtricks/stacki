import { prepareStudioBranch } from '../updates/githubUpdate';
import type { StudioRelease } from '../updates/release';
import { GitHubRequestError } from './githubErrors';
import type { PublishSource, PublishReceipt } from '../../shared/publishSource';
import type { Result } from '../../../vendor/stacki/shared/core/result';
import type { ReviewReceipt } from '../../../vendor/stacki/shared/properties/publishReview';
import { parsePublishConnection } from '../../shared/publishConnection';
import { publishedAssetTree } from '../storage/publishedAssetTree';
import { treeChanges } from './treeChanges';
import { independentlyDeployed } from './syncPaths';
import { createSign } from 'node:crypto';
import { record, string } from '../../shared/validation';

export interface GitHubConfig {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKey: string;
  readonly repository: string;
  readonly branch: string;
}
export interface RepositoryAccess {
  review?(source: PublishSource, expectedHead: string): Promise<Result<ReviewReceipt>>;
  commit(source: PublishSource, expectedHead: string): Promise<Result<PublishReceipt>>;
  incoming(base: string): Promise<IncomingChanges>;
  acceptBase(sha: string): Promise<void>;
}
export interface IncomingFile {
  readonly file: string;
  readonly before: string | null;
  readonly after: string | null;
}
export interface IncomingChanges {
  readonly sha: string;
  readonly files: readonly IncomingFile[];
}
export class GitHubRepository {
  constructor(
    readonly config: GitHubConfig,
    private readonly transport: typeof fetch = (...args) => fetch(...args),
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository)) {
      throw new Error('Expected owner/repository');
    }
    if (!/^[\w./-]+$/.test(config.branch)) {
      throw new Error('Invalid branch');
    }
  }
  async prepareStudioUpdate(release: StudioRelease) {
    const token = await this.installationToken();
    const head = await this.head(token);
    return prepareStudioBranch(
      this.config.repository,
      head,
      release,
      (endpoint, method, body) => this.call(endpoint, token, method, body),
      this.config.branch,
    );
  }
  async installationToken(workflow: 'direct' | 'pull-request' = 'direct'): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.config.appId }),
    ).toString('base64url');
    const payload = `${header}.${body}`;
    const signer = createSign('RSA-SHA256');
    signer.update(payload);
    const jwt = `${payload}.${signer.sign(this.config.privateKey.replaceAll('\\n', '\n'), 'base64url')}`;
    const result = record(
      await this.call(
        `/app/installations/${encodeURIComponent(this.config.installationId)}/access_tokens`,
        jwt,
        'POST',
        {
          repositories: [this.config.repository.split('/')[1]],
          permissions: {
            contents: 'write',
            ...(workflow === 'pull-request' ? { pull_requests: 'write' } : {}),
          },
        },
      ),
    );
    return string(result['token'], 500);
  }
  async head(token: string) {
    const result = record(
      await this.call(
        `/repos/${this.config.repository}/git/ref/heads/${this.config.branch}`,
        token,
      ),
    );
    return string(record(result['object'])['sha'], 64);
  }
  async read(file: string, ref: string, token: string) {
    const result = record(
      await this.call(
        `/repos/${this.config.repository}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
        token,
      ),
    );
    if (result['encoding'] !== 'base64') {
      throw new Error('Unsupported GitHub content encoding');
    }
    return Buffer.from(string(result['content'], 2_000_000), 'base64').toString('utf8');
  }
  async publishedAssets(sha: string) {
    if (!/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error('Invalid published revision');
    }
    const token = await this.installationToken();
    return publishedAssetTree(
      await this.call(`/repos/${this.config.repository}/git/trees/${sha}?recursive=1`, token),
    );
  }
  async acceptBase(_sha: string): Promise<void> {
    /* Local baseline is written by the caller. */
  }
  async incoming(base: string): Promise<IncomingChanges> {
    const token = await this.installationToken();
    const sha = await this.head(token);
    if (sha === base) {
      return { sha, files: [] };
    }
    const comparison = record(
      await this.call(`/repos/${this.config.repository}/compare/${base}...${sha}`, token),
    );
    if (comparison['status'] !== 'ahead') {
      throw new Error('GitHub history diverged. Restore a shared ancestor before syncing.');
    }
    const rawChanges = comparison['files'];
    if (!Array.isArray(rawChanges)) {
      throw new Error('Invalid GitHub comparison');
    }
    let changes: readonly unknown[] = rawChanges;
    if (changes.length >= 300) {
      const trees = await Promise.all(
        [base, sha].map((ref) =>
          this.call(`/repos/${this.config.repository}/git/trees/${ref}?recursive=1`, token),
        ),
      );
      changes = treeChanges(trees[0], trees[1]);
    }
    const files: IncomingFile[] = [];
    for (const value of changes) {
      const change = record(value);
      files.push(...(await this.incomingFile(change, base, sha, token)));
    }
    return { sha, files };
  }
  private async incomingFile(
    change: Record<string, unknown>,
    base: string,
    sha: string,
    token: string,
  ): Promise<IncomingFile[]> {
    const file = string(change['filename'], 500);
    const status = change['status'];
    // Treat each side of a rename separately so moving into/out of Studio or
    // deployment configuration cannot hide a site deletion or addition.
    const paths =
      status === 'renamed'
        ? [
            { file: string(change['previous_filename'], 500), status: 'removed' },
            { file, status: 'added' },
          ]
        : [{ file, status }];
    const files: IncomingFile[] = [];
    for (const { file, status } of paths) {
      if (independentlyDeployed(file)) {
        continue;
      }
      // Runtime/config changes need a fresh container with dependencies installed.
      if (
        !/^src\/.+\.(astro|json|md|mdx|css|ts|js)$/.test(file) &&
        ![
          '.stacki/components.json',
          '.stacki/component-sources.json',
          '.stacki/guide.json',
          '.stacki/publish.json',
          '.stacki/pages.json',
        ].includes(file)
      ) {
        throw new Error(
          `GitHub changed ${file}. Restart from a fresh repository revision before syncing runtime or binary changes.`,
        );
      }
      files.push({
        file,
        before: status === 'added' ? null : await this.read(file, base, token),
        after: status === 'removed' ? null : await this.read(file, sha, token),
      });
    }
    return files;
  }
  async publishConnection() {
    return parsePublishConnection({
      repository: this.config.repository,
      branch: this.config.branch,
      token: await this.installationToken(),
    });
  }
  async reviewConnection() {
    return parsePublishConnection({
      repository: this.config.repository,
      branch: this.config.branch,
      token: await this.installationToken('pull-request'),
    });
  }
  private async call(
    endpoint: string,
    token: string,
    method = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.transport(`https://api.github.com${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Astro-Studio',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new GitHubRequestError(response.status);
    }
    const result: unknown = await response.json();
    return result;
  }
}
