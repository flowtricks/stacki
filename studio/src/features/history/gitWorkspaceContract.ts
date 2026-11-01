import { record, string } from '../../shared/validation';

export const gitWorkspaceLimits = {
  branches: 64,
  bundleBytes: 96 * 1024 ** 2,
  manifestBytes: 128 * 1024,
} as const;
export interface GitWorkspaceBranch {
  readonly name: string;
  readonly head: string;
  readonly workspace: string;
}
export interface GitWorkspaceManifest {
  readonly version: 1;
  readonly revision: string;
  readonly repository: string;
  readonly branch: string;
  readonly branches: readonly GitWorkspaceBranch[];
  readonly remote: readonly { readonly name: string; readonly head: string }[];
  readonly parked: readonly { readonly name: string; readonly head: string }[];
  readonly draft: string | undefined;
  readonly bundle: string | undefined;
}

export function parseGitWorkspaceManifest(input: unknown): GitWorkspaceManifest {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Unsupported Git workspace version.');
  }
  const repository = string(value['repository'], 200);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split('/').includes('..')) {
    throw new Error('Invalid Git workspace repository.');
  }
  const branches = parseGitWorkspaceList(value['branches'], (entry) => ({
    name: gitBranchName(entry['name']),
    head: gitRevision(entry['head']),
    workspace: gitDraftNamespace(entry['workspace']),
  }));
  if (new Set(branches.map((entry) => entry.workspace)).size !== branches.length) {
    throw new Error('Git branches require distinct draft namespaces.');
  }
  const branch = gitBranchName(value['branch']);
  if (!branches.some((entry) => entry.name === branch)) {
    throw new Error('The active Git branch is missing.');
  }
  const reference = (entry: Record<string, unknown>) => ({
    name: gitBranchName(entry['name']),
    head: gitRevision(entry['head']),
  });
  return {
    version: 1,
    revision: gitDraftNamespace(value['revision']),
    repository,
    branch,
    branches,
    remote: parseGitWorkspaceList(value['remote'], reference),
    parked: parseGitWorkspaceList(value['parked'], reference),
    draft: value['draft'] === undefined ? undefined : gitRevision(value['draft']),
    bundle: value['bundle'] === undefined ? undefined : gitBundleDigest(value['bundle']),
  };
}

export function gitBranchName(input: unknown): string {
  const value = string(input, 200);
  if (value === 'HEAD' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..')) {
    throw new Error('Invalid Git branch name.');
  }
  if (value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Invalid Git branch name.');
  }
  return value;
}
export function gitRevision(input: unknown): string {
  const value = string(input, 40);
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error('Invalid Git revision.');
  }
  return value;
}
export function gitBundleDigest(input: unknown): string {
  const value = string(input, 64);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Invalid Git checkpoint digest.');
  }
  return value;
}
export function gitDraftNamespace(input: unknown): string {
  const value = string(input, 36);
  if (value !== 'legacy' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) {
    throw new Error('Invalid Git draft namespace.');
  }
  return value;
}
export function gitWorkspaceBranch(manifest: GitWorkspaceManifest): GitWorkspaceBranch {
  const branch = manifest.branches.find((entry) => entry.name === manifest.branch);
  if (branch === undefined) {
    throw new Error('Git workspace lost its active branch.');
  }
  return branch;
}
function parseGitWorkspaceList<T extends { readonly name: string }>(input: unknown, parse: (entry: Record<string, unknown>) => T): readonly T[] {
  if (!Array.isArray(input) || input.length > gitWorkspaceLimits.branches) {
    throw new Error('Git workspaces support at most 64 branches.');
  }
  const entries = input.map((entry: unknown) => parse(record(entry)));
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw new Error('Duplicate Git workspace branch.');
  }
  return entries;
}
