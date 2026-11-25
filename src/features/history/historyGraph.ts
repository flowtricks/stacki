import { assert } from '../../../shared/core/assert';
import type { HistoryCommit } from './historyBridge';
import { historyGraphColors } from './historyGraphColors';
import { gitBranchColors } from '../../lib/gitBranchColors';

export const HISTORY_COMMITS_MAX = 10_000;
const GRAPH_LANES_MAX = 256;

export interface HistoryGraphEdge {
  readonly source: number;
  readonly target: number;
  readonly color: number;
  readonly kind: 'incoming' | 'outgoing' | 'through';
}

export interface HistoryGraphRow {
  readonly commit: HistoryCommit;
  readonly lane: number;
  readonly color: number;
  readonly edges: readonly HistoryGraphEdge[];
  readonly continuing: readonly { readonly lane: number; readonly color: number }[];
}

interface GraphFrontier {
  readonly hash: string;
  readonly color: number;
}

export interface HistoryGraph {
  readonly rows: readonly HistoryGraphRow[];
  readonly width: number;
}

// Slots retain their position until their ancestry ends, so adding older
// commits cannot move the lanes that the user has already been reading.
export function buildHistoryGraph(
  commits: readonly HistoryCommit[],
  trunk = 'main',
  branches: ReadonlyMap<string, number> = gitBranchColors(
    [],
    trunk,
    commits.flatMap((commit) => commit.refs),
  ),
): HistoryGraph {
  assert(commits.length <= HISTORY_COMMITS_MAX, 'History graph: commit limit exceeded');
  const seen = new Set<string>();
  const colors = historyGraphColors(commits, branches);
  let lanes: readonly (GraphFrontier | undefined)[] = [];
  let width = 1;
  const rows: HistoryGraphRow[] = [];
  for (const commit of commits) {
    assert(!seen.has(commit.hash), 'History graph: duplicate commit');
    assert(commit.parents.length <= GRAPH_LANES_MAX, 'History graph: parent limit exceeded');
    assert(new Set(commit.parents).size === commit.parents.length, 'History graph: duplicate parent');
    for (const parent of commit.parents) {
      assert(parent !== commit.hash, 'History graph: self parent');
      assert(!seen.has(parent), 'History graph: parents must follow their children');
    }
    const row = buildHistoryGraphRow(commit, lanes, colors);
    rows.push(row.row);
    lanes = row.lanes;
    width = Math.max(width, row.row.lane + 1, lanes.length);
    seen.add(commit.hash);
  }
  assert(rows.length === commits.length, 'History graph: every commit has a row');
  assert(width <= GRAPH_LANES_MAX, 'History graph: lane limit exceeded');
  return { rows, width };
}

function buildHistoryGraphRow(
  commit: HistoryCommit,
  before: readonly (GraphFrontier | undefined)[],
  colors: ReadonlyMap<string, number>,
): { readonly row: HistoryGraphRow; readonly lanes: readonly (GraphFrontier | undefined)[] } {
  const existing = before.findIndex((entry) => entry?.hash === commit.hash);
  const lane = existing < 0 ? buildHistoryGraphFreeLane(before) : existing;
  const color = colors.get(commit.hash) ?? before[lane]?.color ?? lane;
  assert(lane < GRAPH_LANES_MAX, 'History graph: lane limit exceeded');
  // Mutation is local to this row; neither the prior frontier nor returned
  // rows are modified while the next row is built.
  const lanes = [...before];
  lanes[lane] = undefined;
  const edges: HistoryGraphEdge[] = [];
  before.forEach((entry, index) => {
    if (entry !== undefined) {
      edges.push({
        source: index,
        target: index,
        color: entry.color,
        kind: index === lane ? 'incoming' : 'through',
      });
    }
  });
  commit.parents.forEach((parent, index) => {
    let target = lanes.findIndex((entry) => entry?.hash === parent);
    if (target < 0) {
      target = index === 0 ? lane : buildHistoryGraphFreeLane(lanes);
      assert(target < GRAPH_LANES_MAX, 'History graph: lane limit exceeded');
      lanes[target] = { hash: parent, color: index === 0 ? color : (colors.get(parent) ?? target) };
    }
    const edgeColor = index === 0 ? color : (lanes[target]?.color ?? target);
    edges.push({ source: lane, target, color: edgeColor, kind: 'outgoing' });
  });
  const continuing = lanes.flatMap((entry, lane) => (entry === undefined ? [] : [{ lane, color: entry.color }]));
  assert(new Set(continuing.map((entry) => entry.lane)).size === continuing.length, 'History graph: unique continuing lanes');
  return { row: { commit, lane, color, edges, continuing }, lanes };
}

function buildHistoryGraphFreeLane(lanes: readonly (GraphFrontier | undefined)[]): number {
  const vacant = lanes.indexOf(undefined);
  return vacant < 0 ? lanes.length : vacant;
}
