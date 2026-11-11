// GitHub writes for sharing and publishing apps (docs/apps.md, "Sharing an app
// privately with your org" and "Publishing to the marketplace"): create a
// repository, tag it, commit files, release a bundle, add a license and make a
// repository public. Runs in Desktop's main process with the token of the
// account signed in for publishing, which goes to GitHub's API and upload hosts
// only, never to an app or a renderer.
//
// Every operation is a fixed, bounded sequence of requests: a commit is one blob
// per file (at most APP_LIMITS.filesMax plus the license), one tree, one commit
// and one ref update; making a repository public is a single request. Each
// request has a deadline and refuses redirects. A share reports which step
// failed and exactly what it had created by then, so nothing is left behind
// unaccounted for.
import { assert } from '../../shared/core/assert';
import { record, text } from '../../shared/core/boundary';
import { toArray } from '../../shared/core/record';
import { APP_LIMITS } from '../../shared/properties/apps';
import type { BundleFile } from '../../shared/properties/appBundle';
import {
  APP_PUBLISH_LIMITS,
  mitLicenseText,
  repositorySettingsURL,
  type AppRepositoryOwnerKind,
  type AppRepositoryStatus,
  type AppShareOutcome,
  type AppShareStep,
  type AppShareVisibility,
  type AppVisibilityOutcome,
} from '../../shared/properties/appPublish';
import { APP_GITHUB_LIMITS, STACKI_APP_TOPIC, readBounded, type GitHubFetch } from './appGitHub';

const API_ORIGIN = 'https://api.github.com';
const UPLOADS_ORIGIN = 'https://uploads.github.com';

export const APP_GITHUB_WRITE_LIMITS = {
  /** Blobs one commit writes: every bundle file plus a LICENSE. */
  blobsMax: APP_LIMITS.filesMax + 1,
  /** A write reply; GitHub's are small. */
  replyBytesMax: 1024 * 1024,
} as const satisfies Record<string, number>;

/** A file to commit: its repository path and bytes. */
export type CommitFile = BundleFile;

/** What a share does, decided before the first request. */
export interface SharePlan {
  readonly owner: string;
  readonly ownerKind: AppRepositoryOwnerKind;
  readonly name: string;
  readonly visibility: AppShareVisibility;
  readonly description: string;
  readonly files: readonly CommitFile[];
  readonly tag: string;
  readonly releaseName: string;
  /** The bundle zip, with its SHA-256: what the lockfile records if the app switches to this release. */
  readonly asset: { readonly name: string; readonly bytes: Uint8Array; readonly sha256: string };
  /** The copyright holder for the MIT `LICENSE` a public share adds; undefined for a private share. */
  readonly licenseHolder: string | undefined;
  readonly year: number;
}

/**
 * Creates the repository, adds the `stacki-app` topic, commits the files (and
 * the MIT license when public) and releases the zip. `onStep` hears each step
 * as it starts. A failure stops at its step and names what exists.
 */
export async function shareToGitHub(fetcher: GitHubFetch, token: string, plan: SharePlan, onStep: (step: AppShareStep) => void): Promise<AppShareOutcome> {
  assert(plan.files.length > 0, 'A share commits the bundle’s files');
  assert(plan.files.length <= APP_LIMITS.filesMax, 'A share commits a bounded bundle');
  assert((plan.visibility === 'public') === (plan.licenseHolder !== undefined), 'Only a public share adds the MIT license');
  const created: string[] = [];
  const full = `${plan.owner}/${plan.name}`;
  let step: AppShareStep = 'create-repository';
  try {
    onStep(step);
    const repository = await createRepository(fetcher, token, plan);
    created.push(`The ${plan.visibility} repository ${full}, with a README on ${repository.branch}`);
    step = 'add-topic';
    onStep(step);
    await addStackiAppTopic(fetcher, token, plan.owner, plan.name);
    created.push(`The ${STACKI_APP_TOPIC} topic on ${full}`);
    step = 'commit-files';
    onStep(step);
    const license =
      plan.licenseHolder === undefined ? [] : [{ path: 'LICENSE', bytes: new TextEncoder().encode(mitLicenseText(plan.year, plan.licenseHolder)) }];
    const files = [...plan.files, ...license];
    await commitFiles(fetcher, token, { owner: plan.owner, repository: plan.name, branch: repository.branch }, files, `Add ${plan.releaseName} ${plan.tag}`);
    created.push(`A commit of ${files.length} files on ${repository.branch}`);
    step = 'create-release';
    onStep(step);
    const release = await createRelease(fetcher, token, {
      owner: plan.owner,
      repository: plan.name,
      branch: repository.branch,
      tag: plan.tag,
      name: `${plan.releaseName} ${plan.tag}`,
    });
    created.push(`The release ${plan.tag}, without its asset yet`);
    await uploadReleaseAsset(fetcher, token, { owner: plan.owner, repository: plan.name, releaseId: release.id }, plan.asset);
    created[created.length - 1] = `The release ${plan.tag} with ${plan.asset.name}`;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error;
    }
    assert(created.length <= APP_PUBLISH_LIMITS.createdMax, 'A share creates a bounded number of things');
    return { kind: 'failed', step, message: describe(error), created };
  }
  assert(created.length === 4, 'A finished share created its four things');
  return {
    kind: 'shared',
    shared: { owner: plan.owner, repository: plan.name, visibility: plan.visibility, tag: plan.tag, asset: plan.asset.name, sha256: plan.asset.sha256 },
  };
}

/** Creates an empty repository with a README, so it has a branch to commit to. Returns that branch. */
export async function createRepository(
  fetcher: GitHubFetch,
  token: string,
  plan: Pick<SharePlan, 'owner' | 'ownerKind' | 'name' | 'visibility' | 'description'>,
): Promise<{ readonly branch: string }> {
  const url = plan.ownerKind === 'user' ? `${API_ORIGIN}/user/repos` : `${API_ORIGIN}/orgs/${encodeURIComponent(plan.owner)}/repos`;
  const response = await send(fetcher, token, 'POST', url, {
    name: plan.name,
    description: plan.description.slice(0, 350),
    private: plan.visibility === 'private',
    auto_init: true,
  });
  if (response.status === 422) {
    throw new Error(`${plan.owner}/${plan.name} already exists, or GitHub refused the name. Choose another name.`);
  }
  if (response.status === 403 || response.status === 404) {
    throw new Error(
      `This account cannot create repositories under ${plan.owner}. Ask an owner of ${plan.owner} for that permission, or choose your own account.`,
    );
  }
  const body = record(await expectJSON(response, 'create the repository'));
  const branch = text(body['default_branch']);
  if (branch.length === 0 || branch.length > 255) {
    throw new Error('GitHub created the repository without a branch.');
  }
  return { branch };
}

/** Adds the `stacki-app` topic, keeping any the repository has. Two requests. */
export async function addStackiAppTopic(fetcher: GitHubFetch, token: string, owner: string, repository: string): Promise<void> {
  const base = repositoryAPI(owner, repository);
  const current = record(await expectJSON(await send(fetcher, token, 'GET', `${base}/topics`, undefined), 'read the topics'));
  const names = (toArray(current['names']) ?? []).slice(0, APP_GITHUB_LIMITS.topicsMax).filter((name): name is string => typeof name === 'string');
  if (names.includes(STACKI_APP_TOPIC)) {
    return;
  }
  if (names.length >= APP_GITHUB_LIMITS.topicsMax) {
    throw new Error(`${owner}/${repository} already has ${APP_GITHUB_LIMITS.topicsMax} topics; remove one to add ${STACKI_APP_TOPIC}.`);
  }
  await expectJSON(await send(fetcher, token, 'PUT', `${base}/topics`, { names: [...names, STACKI_APP_TOPIC] }), 'add the topic');
}

/** One commit of `files` on `branch`, over what is there: a blob per file, a tree, the commit, the ref. */
export async function commitFiles(
  fetcher: GitHubFetch,
  token: string,
  target: { readonly owner: string; readonly repository: string; readonly branch: string },
  files: readonly CommitFile[],
  message: string,
): Promise<{ readonly sha: string }> {
  assert(files.length > 0, 'A commit writes at least one file');
  assert(files.length <= APP_GITHUB_WRITE_LIMITS.blobsMax, 'A commit writes a bounded number of files');
  const base = repositoryAPI(target.owner, target.repository);
  const ref = `${base}/git/ref/heads/${encodeURIComponent(target.branch)}`;
  const head = text(record(record(await expectJSON(await send(fetcher, token, 'GET', ref, undefined), 'read the branch'))['object'])['sha']);
  const parent = record(await expectJSON(await send(fetcher, token, 'GET', `${base}/git/commits/${head}`, undefined), 'read the last commit'));
  const baseTree = text(record(parent['tree'])['sha']);
  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const file of files) {
    const blob = record(
      await expectJSON(
        await send(fetcher, token, 'POST', `${base}/git/blobs`, { content: Buffer.from(file.bytes).toString('base64'), encoding: 'base64' }),
        'upload a file',
      ),
    );
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: text(blob['sha']) });
  }
  assert(tree.length === files.length, 'Every file has a blob');
  const made = record(await expectJSON(await send(fetcher, token, 'POST', `${base}/git/trees`, { base_tree: baseTree, tree }), 'write the tree'));
  const commit = record(
    await expectJSON(await send(fetcher, token, 'POST', `${base}/git/commits`, { message, tree: text(made['sha']), parents: [head] }), 'write the commit'),
  );
  const sha = text(commit['sha']);
  await expectJSON(await send(fetcher, token, 'PATCH', `${base}/git/refs/heads/${encodeURIComponent(target.branch)}`, { sha }), 'move the branch');
  return { sha };
}

/** Creates a published release on `branch`'s head. */
export async function createRelease(
  fetcher: GitHubFetch,
  token: string,
  release: { readonly owner: string; readonly repository: string; readonly branch: string; readonly tag: string; readonly name: string },
): Promise<{ readonly id: number }> {
  const response = await send(fetcher, token, 'POST', `${repositoryAPI(release.owner, release.repository)}/releases`, {
    tag_name: release.tag,
    target_commitish: release.branch,
    name: release.name,
    body: 'A Stacki app. Install it with Load App From GitHub in the Apps panel.',
    draft: false,
    prerelease: false,
  });
  if (response.status === 422) {
    throw new Error(`The release ${release.tag} already exists.`);
  }
  const id = record(await expectJSON(response, 'create the release'))['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
    throw new Error('GitHub created the release without an id.');
  }
  return { id };
}

/** Uploads the bundle zip to a release, to GitHub's upload host. */
export async function uploadReleaseAsset(
  fetcher: GitHubFetch,
  token: string,
  release: { readonly owner: string; readonly repository: string; readonly releaseId: number },
  asset: { readonly name: string; readonly bytes: Uint8Array },
): Promise<void> {
  assert(asset.bytes.byteLength <= APP_LIMITS.archiveBytesMax, 'A released bundle is within the archive bound');
  const url = `${UPLOADS_ORIGIN}/repos/${encodeURIComponent(release.owner)}/${encodeURIComponent(release.repository)}/releases/${release.releaseId}/assets?name=${encodeURIComponent(asset.name)}`;
  const response = await send(fetcher, token, 'POST', url, asset.bytes);
  await expectJSON(response, 'upload the app bundle');
}

/**
 * Asks GitHub to make a repository public: one request. A refusal is a value:
 * a token without the `repo` scope, an account that is not an admin of the
 * repository, or an organization that forbids public repositories.
 */
export async function makeRepositoryPublic(fetcher: GitHubFetch, token: string, owner: string, repository: string): Promise<AppVisibilityOutcome> {
  const response = await send(fetcher, token, 'PATCH', repositoryAPI(owner, repository), { private: false });
  const settingsURL = repositorySettingsURL(owner, repository);
  if (response.ok) {
    return { kind: 'public' };
  }
  if (response.status === 403 || response.status === 404) {
    // A classic token names its scopes; one without `repo` cannot change a repository's visibility.
    const scopes = response.headers.get('x-oauth-scopes') ?? undefined;
    if (scopes !== undefined && !scopes.split(',').some((scope) => scope.trim() === 'repo')) {
      return { kind: 'forbidden', reason: 'scope', settingsURL };
    }
    return { kind: 'forbidden', reason: 'admin', settingsURL };
  }
  if (response.status === 422) {
    return { kind: 'forbidden', reason: 'policy', settingsURL };
  }
  throw new Error(`GitHub answered ${response.status} when making ${owner}/${repository} public.`);
}

/** What the marketplace checklist needs: visibility, topic, license, latest release and the copyright holder. Three requests. */
export async function repositoryStatus(
  fetcher: GitHubFetch,
  token: string | undefined,
  owner: string,
  repository: string,
): Promise<AppRepositoryStatus & { readonly branch: string }> {
  const base = repositoryAPI(owner, repository);
  const repoResponse = await send(fetcher, token, 'GET', base, undefined);
  if (repoResponse.status === 404) {
    throw new Error(`${owner}/${repository} was not found, or this account cannot read it.`);
  }
  const repo = record(await expectJSON(repoResponse, 'read the repository'));
  const topics = (toArray(repo['topics']) ?? []).slice(0, APP_GITHUB_LIMITS.topicsMax);
  const spdx = fieldOf(repo['license'], 'spdx_id');
  const ownerValue = record(repo['owner']);
  const login = text(ownerValue['login']);
  const releaseResponse = await send(fetcher, token, 'GET', `${base}/releases/latest`, undefined);
  let release: AppRepositoryStatus['release'];
  if (releaseResponse.ok) {
    const latest = record(await expectJSON(releaseResponse, 'read the latest release'));
    const zip = (toArray(latest['assets']) ?? [])
      .slice(0, APP_GITHUB_LIMITS.assetsMax)
      .map((asset) => record(asset))
      .find((asset) => typeof asset['name'] === 'string' && asset['name'].toLowerCase().endsWith('.zip'));
    release = zip === undefined ? undefined : { tag: text(latest['tag_name']), asset: text(zip['name']) };
  } else {
    await releaseResponse.body?.cancel();
  }
  const holder = await ownerName(fetcher, token, login);
  return {
    owner,
    repository,
    private: repo['private'] === true,
    topic: topics.includes(STACKI_APP_TOPIC),
    license: typeof spdx === 'string' && spdx !== 'NOASSERTION' ? spdx : undefined,
    release,
    holder,
    branch: text(repo['default_branch']),
  };
}

/** The display name of a user or organization, or its login when it has none: a LICENSE's copyright holder. */
export async function ownerName(fetcher: GitHubFetch, token: string | undefined, login: string): Promise<string> {
  assert(login.length > 0, 'An owner has a login');
  const response = await send(fetcher, token, 'GET', `${API_ORIGIN}/users/${encodeURIComponent(login)}`, undefined);
  if (!response.ok) {
    await response.body?.cancel();
    return login;
  }
  const name = record(await expectJSON(response, 'read the owner'))['name'];
  const holder = typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, APP_PUBLISH_LIMITS.holderCharsMax) : login;
  assert(holder.length > 0, 'A copyright holder is never empty');
  return holder;
}

/** Commits the standard MIT `LICENSE` to the default branch, for the marketplace. */
export async function addMitLicense(
  fetcher: GitHubFetch,
  token: string,
  target: { readonly owner: string; readonly repository: string; readonly branch: string; readonly holder: string; readonly year: number },
): Promise<void> {
  const bytes = new TextEncoder().encode(mitLicenseText(target.year, target.holder));
  await commitFiles(fetcher, token, target, [{ path: 'LICENSE', bytes }], 'Add the MIT license');
}

// A field of a JSON object that may be absent or JSON null (GitHub writes `license: null`).
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || Array.isArray(value) || !value) {
    return undefined;
  }
  return record(value)[key];
}

function repositoryAPI(owner: string, repository: string): string {
  return `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function send(fetcher: GitHubFetch, token: string | undefined, method: string, url: string, body: unknown): Promise<Response> {
  assert(url.startsWith(`${API_ORIGIN}/`) || url.startsWith(`${UPLOADS_ORIGIN}/`), 'A token goes to GitHub’s API and upload hosts only');
  const bytes = body instanceof Uint8Array ? body : undefined;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Stacki',
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    ...(body === undefined ? {} : { 'Content-Type': bytes === undefined ? 'application/json' : 'application/zip' }),
  };
  return fetcher(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: bytes === undefined ? JSON.stringify(body) : new Blob([new Uint8Array(bytes)]) }),
    redirect: 'error',
    signal: AbortSignal.timeout(APP_GITHUB_LIMITS.requestMsMax),
  });
}

async function expectJSON(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    let detail = '';
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(await readBounded(response, APP_GITHUB_WRITE_LIMITS.replyBytesMax)));
      const said = record(value)['message'];
      detail = typeof said === 'string' ? `: ${said.slice(0, 200)}` : '';
    } catch {
      detail = '';
    }
    throw new Error(`GitHub answered ${response.status} when asked to ${what}${detail}.`);
  }
  if (response.status === 204) {
    return {};
  }
  const body = await readBounded(response, APP_GITHUB_WRITE_LIMITS.replyBytesMax);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
  return parsed;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || 'GitHub refused the request.').slice(0, APP_LIMITS.messageCharsMax);
}
