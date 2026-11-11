// The rows of the Load App From GitHub chooser, from what is typed and the
// account's repositories. Only repositories carrying the `stacki-app` topic are
// listed, under "Stacki apps", and typing searches only those. The same field
// takes a pasted repository: text that names one (owner/repo, or a github.com
// address) pins a "Use owner/repo" row first, for any repository, unless it is
// already a row below, so it never shows twice; the release bundle's
// `stacki-app.json` check guards what that row installs. An account with no
// tagged repository gets the list area's empty state, not rows. Pure, so the
// rows, the dedupe and the keyboard movement are tested without a browser.
import { assert } from '../../../shared/core/assert';
import { APP_GITHUB_CHOICE_LIMITS, parseGitHubRepositoryReference, type AppRepository } from '../../../shared/properties/apps';

/** What the action that installs an app from a GitHub release is called, everywhere it appears. */
export const LOAD_FROM_GITHUB_LABEL = 'Load App From GitHub';

export type ChooserRow =
  | { readonly kind: 'use'; readonly key: string; readonly owner: string; readonly repository: string }
  | { readonly kind: 'section'; readonly key: string; readonly label: string }
  | { readonly kind: 'repository'; readonly key: string; readonly repository: AppRepository }
  | { readonly kind: 'notice'; readonly key: string; readonly notice: 'no-match' };

/** A row Enter or a click can pick. */
export type ChooserPickable = Extract<ChooserRow, { readonly kind: 'use' | 'repository' }>;

export interface ChooserInput {
  readonly query: string;
  /** Undefined while the list is not there to show: loading, failed, or no account. */
  readonly repositories: readonly AppRepository[] | undefined;
}

export function chooserRows(input: ChooserInput): readonly ChooserRow[] {
  const reference = parseGitHubRepositoryReference(input.query);
  const needle = reference === undefined ? input.query.trim().toLowerCase() : `${reference.owner}/${reference.repository}`.toLowerCase();
  const searching = needle.length > 0;
  const tagged = (input.repositories ?? []).slice(0, APP_GITHUB_CHOICE_LIMITS.repositoriesMax).filter((repository) => repository.stackiApp);
  const matches = searching ? tagged.filter((repository) => repositoryKey(repository).includes(needle)) : tagged;
  const rows: ChooserRow[] = [];
  if (reference !== undefined) {
    const key = `${reference.owner}/${reference.repository}`.toLowerCase();
    if (!matches.some((repository) => repositoryKey(repository) === key)) {
      rows.push({ kind: 'use', key: `use:${key}`, owner: reference.owner, repository: reference.repository });
    }
  }
  if (matches.length > 0) {
    rows.push({ kind: 'section', key: 'section:tagged', label: 'Stacki apps' });
    rows.push(...matches.map((repository) => repositoryRow(repository)));
  } else if (searching && tagged.length > 0) {
    // With nothing tagged, the empty state speaks instead; a notice would repeat it.
    rows.push({ kind: 'notice', key: 'notice:no-match', notice: 'no-match' });
  }
  assert(matches.length <= tagged.length, 'Rows come from the tagged repositories');
  assert(
    rows.every((row) => row.kind !== 'repository' || row.repository.stackiApp),
    'Only tagged repositories are listed',
  );
  return rows;
}

/** Whether the account has any repository to list: none means the "No Stacki apps" empty state. */
export function hasStackiApps(repositories: readonly AppRepository[]): boolean {
  return repositories.some((repository) => repository.stackiApp);
}

/** The rows Enter and the arrows move over, in order. */
export function chooserPickables(rows: readonly ChooserRow[]): readonly ChooserPickable[] {
  const pickables = rows.filter((row): row is ChooserPickable => row.kind === 'use' || row.kind === 'repository');
  assert(pickables.length <= rows.length, 'Pickables are a subset of the rows');
  return pickables;
}

/** The highlighted row after an arrow: one step, held to the ends rather than wrapping. */
export function moveChooserActive(active: number, step: -1 | 1, count: number): number {
  assert(Number.isSafeInteger(active), 'The active row is an index');
  assert(Number.isSafeInteger(count), 'The row count is an integer');
  assert(count >= 0, 'The row count is not negative');
  if (count === 0) {
    return 0;
  }
  const next = Math.min(count - 1, Math.max(0, active + step));
  assert(next >= 0, 'The active row is not before the first');
  assert(next < count, 'The active row is not past the last');
  return next;
}

function repositoryKey(repository: AppRepository): string {
  return `${repository.owner}/${repository.name}`.toLowerCase();
}

function repositoryRow(repository: AppRepository): ChooserRow {
  return { kind: 'repository', key: `repository:${repositoryKey(repository)}`, repository };
}
