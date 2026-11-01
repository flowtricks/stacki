import { assert } from '../../shared/core/assert';

const BRANCHES_MAX = 10_000;
const REFERENCES_MAX = 100_000;
const PALETTE = ['#6aa9f0', '#c49af5', '#68c8a0', '#e5b86a', '#e58ba7', '#69c9d5'];

export function gitBranchColor(color: number): string {
  assert(Number.isSafeInteger(color), 'History color: integer required');
  assert(color >= 0, 'History color: nonnegative index required');
  assert(color < BRANCHES_MAX, 'History color: index limit exceeded');
  // Extra branches get new hues instead of recycling the first six colors.
  return PALETTE[color] ?? `hsl(${(color * 137.508) % 360} 65% 72%)`;
}

export function gitBranchColors(branches: readonly string[], trunk: string, references: readonly string[] = []): ReadonlyMap<string, number> {
  assert(branches.length <= BRANCHES_MAX, 'History colors: branch limit exceeded');
  assert(references.length <= REFERENCES_MAX, 'History colors: reference limit exceeded');
  const colors = new Map<string, number>([[trunk, 0]]);
  // Local branch colors do not depend on checkout, Git's list order, or graph
  // pagination. Remote-only refs follow in log order so older pages append colors.
  for (const branch of [...branches].sort()) {
    if (!colors.has(branch)) {
      assert(colors.size < BRANCHES_MAX, 'History colors: branch limit exceeded');
      colors.set(branch, colors.size);
    }
  }
  for (const reference of references) {
    const branch = gitRefBranch(reference, colors);
    if (branch !== undefined && !colors.has(branch)) {
      assert(colors.size < BRANCHES_MAX, 'History colors: branch limit exceeded');
      colors.set(branch, colors.size);
    }
  }
  assert(colors.get(trunk) === 0, 'History colors: trunk keeps its color');
  return colors;
}

export function gitRefColor(reference: string, colors: ReadonlyMap<string, number>): number | undefined {
  const branch = gitRefBranch(reference, colors);
  return branch === undefined ? undefined : colors.get(branch);
}

function gitRefBranch(reference: string, colors: ReadonlyMap<string, number>): string | undefined {
  const branch = reference.replace(/^HEAD -> /, '');
  if (branch === 'HEAD' || branch.startsWith('tag: ') || branch.endsWith('/HEAD')) {
    return undefined;
  }
  if (colors.has(branch)) {
    return branch;
  }
  const suffix = branch.slice(branch.indexOf('/') + 1);
  // Match known local counterparts for any remote, while preserving slashes in
  // local names such as codex/fix. Origin-only branches also share this namespace.
  if (branch.startsWith('origin/') || colors.has(suffix)) {
    return suffix;
  }
  return branch;
}
