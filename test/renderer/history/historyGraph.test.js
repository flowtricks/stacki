// Goal: draw Git ancestry faithfully without moving lanes as older pages arrive.
// Methodology: exercise forks, merges, disconnected roots, page boundaries and
// invalid topology through the pure layout, including its explicit capacity bounds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHistoryGraph, HISTORY_COMMITS_MAX } = require('../../helpers/rendererModule')('src/features/history/historyGraph.ts');

const { gitBranchColors, gitRefColor, gitBranchColor } = require('../../helpers/rendererModule')('src/lib/gitBranchColors.ts');

const commit = (hash, parents = [], refs = []) => ({ hash, parents, refs });
const outgoing = (row) => row.edges.filter((edge) => edge.kind === 'outgoing');

test('linear history connects each child to its parent and stops at the root', () => {
  const graph = buildHistoryGraph([commit('c', ['b']), commit('b', ['a']), commit('a')]);
  assert.equal(graph.width, 1);
  assert.deepEqual(
    graph.rows.map((row) => row.lane),
    [0, 0, 0],
  );
  assert.equal(outgoing(graph.rows[0]).length, 1);
  assert.equal(graph.rows[1].edges[0].kind, 'incoming');
  assert.deepEqual(graph.rows[2].continuing, []);
  assert.equal(outgoing(graph.rows[2]).length, 0);
  assert.deepEqual(buildHistoryGraph([]), { rows: [], width: 1 });
});

test('a feature ahead of main has its own color without inventing a fork', () => {
  const commits = [
    commit('feature-tip', ['feature-parent'], ['HEAD -> new-design-test']),
    commit('feature-parent', ['main-tip']),
    commit('main-tip', ['base'], ['main']),
    commit('base'),
  ];
  const graph = buildHistoryGraph(commits);
  assert.equal(graph.width, 1, 'the ancestry remains a single path');
  assert.deepEqual(
    graph.rows.map((row) => row.color),
    [1, 1, 0, 0],
  );
  assert.deepEqual(
    graph.rows.map((row) => row.lane),
    [0, 0, 0, 0],
  );
  assert.equal(outgoing(graph.rows[0])[0].color, 1);
  assert.equal(graph.rows[2].edges[0].color, 1, 'feature color reaches the shared ancestor');
  assert.equal(outgoing(graph.rows[2])[0].color, 0, 'main ancestry continues in blue');
  assert.deepEqual(graph.rows[0].continuing, [{ lane: 0, color: 1 }]);
  assert.deepEqual(buildHistoryGraph(commits.slice(0, 2)).rows, graph.rows.slice(0, 2));
});

test('custom trunk, shared tips, tags and merge side histories keep accurate colors', () => {
  const graph = buildHistoryGraph(
    [
      commit('merge', ['main-parent', 'side'], ['HEAD -> develop']),
      commit('main-parent', ['base']),
      commit('side', ['base'], ['feature']),
      commit('base', [], ['tag: v1']),
    ],
    'develop',
  );
  assert.deepEqual(
    graph.rows.map((row) => row.color),
    [0, 0, 1, 0],
  );
  assert.deepEqual(
    outgoing(graph.rows[0]).map((edge) => edge.color),
    [0, 1],
  );
  const shared = buildHistoryGraph([commit('same', [], ['HEAD -> feature', 'main'])]);
  assert.equal(shared.rows[0].color, 0, 'a shared tip is still part of main');
  const tag = buildHistoryGraph([commit('tagged', [], ['HEAD', 'tag: release'])]);
  assert.equal(tag.rows[0].color, 0, 'tags and detached HEAD do not imply a feature branch');
});

test('a merge splits into two lanes and rejoins at the shared ancestor', () => {
  const graph = buildHistoryGraph([commit('merge', ['main', 'feature']), commit('feature', ['base']), commit('main', ['base']), commit('base')]);
  assert.equal(graph.width, 2);
  assert.deepEqual(
    graph.rows.map((row) => row.lane),
    [0, 1, 0, 1],
  );
  assert.deepEqual(
    outgoing(graph.rows[0]).map((edge) => edge.target),
    [0, 1],
  );
  assert.deepEqual(
    outgoing(graph.rows[2]).map((edge) => [edge.source, edge.target]),
    [[0, 1]],
  );
  assert.deepEqual(graph.rows[3].continuing, []);
});

test('unmerged tips stay independent until they reach their common ancestor', () => {
  const graph = buildHistoryGraph([commit('feature', ['base']), commit('main', ['base']), commit('base'), commit('orphan')]);
  assert.deepEqual(
    graph.rows.map((row) => row.lane),
    [0, 1, 0, 0],
  );
  assert.equal(graph.rows[1].edges[0].kind, 'through');
  assert.deepEqual(graph.rows[3].edges, []);
});

test('octopus merges connect all parents, and loading a page preserves earlier rows', () => {
  const commits = [commit('merge', ['a', 'b', 'c']), commit('a', ['root']), commit('b', ['root']), commit('c', ['root']), commit('root')];
  const partial = buildHistoryGraph(commits.slice(0, 2));
  const complete = buildHistoryGraph(commits);
  assert.equal(complete.width, 3);
  assert.equal(outgoing(complete.rows[0]).length, 3);
  assert.deepEqual(partial.rows, complete.rows.slice(0, 2));
  assert.deepEqual(complete.rows[4].continuing, []);
});

test('invalid graphs fail loudly instead of drawing misleading ancestry', () => {
  assert.throws(() => buildHistoryGraph([commit('a'), commit('a')]), /History graph: duplicate commit/);
  assert.throws(() => buildHistoryGraph([commit('a', ['a'])]), /History graph: self parent/);
  assert.throws(() => buildHistoryGraph([commit('parent'), commit('child', ['parent'])]), /History graph: parents must follow their children/);
  assert.throws(() => buildHistoryGraph([commit('a', ['b', 'b'])]), /History graph: duplicate parent/);
  assert.throws(() => buildHistoryGraph(Array(HISTORY_COMMITS_MAX + 1).fill(commit('a'))), /History graph: commit limit exceeded/);
  assert.throws(
    () =>
      buildHistoryGraph([
        commit(
          'a',
          Array.from({ length: 257 }, (_, index) => `${index}`),
        ),
      ]),
    /History graph: parent limit exceeded/,
  );
  const divergent = Array.from({ length: 257 }, (_, index) => commit(`child-${index}`, [`parent-${index}`]));
  assert.throws(() => buildHistoryGraph(divergent), /History graph: lane limit exceeded/);
});

test('each local branch has a distinct color shared by its remote labels', () => {
  const branches = ['tim', 'main', 'codex/fix-workflow-node', 'one', 'two', 'three', 'four'];
  const colors = gitBranchColors(branches, 'main', ['origin/main', 'origin/codex/fix-workflow-node', 'origin/tim', 'origin/remote-only']);
  assert.equal(colors.size, 8);
  assert.equal(new Set([...colors.values()].map(gitBranchColor)).size, 8);
  for (const branch of branches) {
    assert.equal(gitRefColor(`origin/${branch}`, colors), colors.get(branch));
    assert.equal(gitRefColor(`upstream/${branch}`, colors), colors.get(branch));
    assert.equal(gitRefColor(`HEAD -> ${branch}`, colors), colors.get(branch));
  }
  assert.equal(colors.get('main'), 0);
  for (const reference of ['HEAD', 'origin/HEAD', 'tag: v1.0']) {
    assert.equal(gitRefColor(reference, colors), undefined);
  }
  const reordered = gitBranchColors([...branches].reverse(), 'main');
  for (const branch of branches) {
    assert.equal(reordered.get(branch), colors.get(branch));
  }
  assert.throws(() => gitBranchColor(-1), /nonnegative/);
  assert.throws(() => gitBranchColor(0.5), /integer/);
  assert.throws(() => gitBranchColor(10_000), /index limit/);
  assert.throws(() => gitBranchColors(Array(10_001).fill('x'), 'main'), /branch limit/);
  assert.throws(() => gitBranchColors([], 'main', Array(100_001).fill('x')), /reference limit/);
});

test('multiple features keep distinct paths through shared ancestry and older pages', () => {
  const branches = ['main', 'codex/fix-workflow-node', 'tim'];
  const commits = [
    commit('tim-tip', ['main-tip'], ['HEAD -> tim']),
    commit('main-tip', ['base'], ['origin/main']),
    commit('fix-tip', ['fix-parent'], ['origin/codex/fix-workflow-node']),
    commit('fix-parent', ['base']),
    commit('remote-tip', ['base'], ['origin/remote-only']),
    commit('base'),
  ];
  const colors = gitBranchColors(
    branches,
    'main',
    commits.flatMap((item) => item.refs),
  );
  const graph = buildHistoryGraph(commits, 'main', colors);
  assert.deepEqual(
    graph.rows.map((row) => row.color),
    [2, 0, 1, 1, 3, 0],
  );
  assert.equal(outgoing(graph.rows[0])[0].color, colors.get('tim'));
  assert.equal(outgoing(graph.rows[2])[0].color, colors.get('codex/fix-workflow-node'));
  const prefix = commits.slice(0, 4);
  const prefixColors = gitBranchColors(
    branches,
    'main',
    prefix.flatMap((item) => item.refs),
  );
  assert.deepEqual(buildHistoryGraph(prefix, 'main', prefixColors).rows, graph.rows.slice(0, 4));
  const withSlash = gitBranchColors(['main', 'team/main'], 'main', ['origin/team/main']);
  assert.notEqual(withSlash.get('team/main'), withSlash.get('main'));
  assert.equal(gitRefColor('origin/team/main', withSlash), withSlash.get('team/main'));
});
