import { assert } from '../../../shared/core/assert';
import type { HistoryCommit } from './historyBridge';
import { gitRefColor } from '../../lib/gitBranchColors';

export function historyGraphColors(commits: readonly HistoryCommit[], branches: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const colors = new Map<string, number>();
  assert(byHash.size === commits.length, 'History graph: duplicate commit');
  // Reserve trunk ancestry first. Then walk feature first parents, stopping at
  // explicit branch tips so shared history is not claimed by a newer branch.
  for (const phase of ['trunk', 'features']) {
    for (const commit of commits) {
      const seeds = commit.refs.flatMap((reference) => {
        const color = gitRefColor(reference, branches);
        return color === undefined ? [] : [color];
      });
      const seed = seeds.length === 0 ? undefined : Math.min(...seeds);
      const assigned = colors.get(commit.hash);
      const color = assigned === 0 ? 0 : (seed ?? assigned);
      if (color === undefined || (phase === 'trunk' && color !== 0)) {
        continue;
      }
      colors.set(commit.hash, color);
      const parent = commit.parents[0];
      if (parent !== undefined && byHash.has(parent) && !colors.has(parent)) {
        colors.set(parent, color);
      }
    }
  }
  assert(colors.size <= commits.length, 'History colors: only loaded commits are colored');
  return colors;
}
