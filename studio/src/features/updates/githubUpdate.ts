import { record, string } from '../../shared/validation';
import { retainedPath, type StudioRelease } from './release';

type Request = (endpoint: string, method?: string, body?: unknown) => Promise<unknown>;
interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}
function parseTree(input: unknown): readonly TreeEntry[] {
  const value = record(input);
  const entries = value['tree'];
  if (value['truncated'] || !Array.isArray(entries) || entries.length > 10_000) {
    throw new Error('Studio repository tree is incomplete or too large');
  }
  return entries.map((input: unknown) => {
    const entry = record(input);
    return {
      path: string(entry['path'], 500),
      mode: string(entry['mode'], 10),
      type: string(entry['type'], 10),
      sha: string(entry['sha'], 64),
    };
  });
}

// Create a review branch from the current head. The previous Studio remains in
// Git history and the deployed project is unchanged until its owner merges it.
export async function prepareStudioBranch(repository: string, head: string, release: StudioRelease, request: Request, baseBranch = 'main') {
  const prefix = `/repos/${repository}/git`;
  const original = record(await request(`${prefix}/commits/${head}`));
  const base = string(record(original['tree'])['sha'], 64);
  const root = parseTree(await request(`${prefix}/trees/${base}`));
  const studio = root.find((entry) => entry.path === 'studio');
  if (studio && studio.type !== 'tree') {
    throw new Error('Studio must be a repository directory');
  }
  const existing = studio ? parseTree(await request(`${prefix}/trees/${studio.sha}?recursive=1`)) : [];
  const files = release.files.map((file) => ({
    path: file.path,
    mode: '100644',
    type: 'blob',
    content: file.content,
  }));
  const preserved = existing.filter((entry) => entry.type === 'blob' && retainedPath(entry.path));
  // An entirely new subtree removes custom files as well as replacing known ones.
  const tree = record(await request(`${prefix}/trees`, 'POST', { tree: [...files, ...preserved] }));
  const combined = record(
    await request(`${prefix}/trees`, 'POST', {
      base_tree: base,
      tree: [{ path: 'studio', mode: '040000', type: 'tree', sha: string(tree['sha'], 64) }],
    }),
  );
  const commit = record(
    await request(`${prefix}/commits`, 'POST', {
      message: `Update Stacki Studio to ${release.version}\n\nReplaces Studio customizations; retains project configuration and drafts.`,
      tree: string(combined['sha'], 64),
      parents: [head],
    }),
  );
  const sha = string(commit['sha'], 64);
  const branch = `stacki/studio-${release.version}-${sha.slice(0, 10)}`;
  await request(`${prefix}/refs`, 'POST', { ref: `refs/heads/${branch}`, sha });
  return {
    sha,
    branch,
    url: `https://github.com/${repository}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}?expand=1`,
  };
}
