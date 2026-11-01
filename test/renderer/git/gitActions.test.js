// Drive real renderer Git actions with a scripted confirmation host and preload.
// Assert destructive-action order, conflict handoff, and restoration after parking;
// malformed invoke responses must fail at the parser before another action runs.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const loadRenderer = require('../../helpers/rendererModule.js');
const { repoPath, stubSources } = require('../../helpers/sources.js');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');
const { parseMergeResult, parseDeleteResult } = loadRenderer('src/features/git/gitBridge.ts');
const success = { ok: true, into: 'main', changed: true };
const dirty = { ok: false, dirty: true, from: 'topic', branch: 'main', files: ['a.astro'] };
const conflict = {
  ok: false,
  conflicted: true,
  from: 'topic',
  branch: 'main',
  files: [{ path: 'a.astro', ours: 'one', theirs: 'two', parts: undefined }],
};
for (const result of [success, dirty, conflict]) {
  assert.deepEqual(parseMergeResult(result), result);
}
for (const result of [
  jsonNull,
  {},
  { ok: true },
  { ok: false },
  { ...dirty, files: [1] },
  { ...conflict, files: [{ path: 'a', ours: 1, theirs: undefined, parts: undefined }] },
  // Absence is `undefined` (AGENTS.md §6): a deleted side is never sent as null.
  { ...conflict, files: [{ path: 'a', ours: 'x', theirs: jsonNull, parts: undefined }] },
]) {
  assert.throws(() => parseMergeResult(result));
}
assert.deepEqual(parseDeleteResult({ ok: true }), { ok: true });
assert.deepEqual(parseDeleteResult({ ok: false, unmerged: true, message: 'Unmerged' }), {
  ok: false,
  unmerged: true,
  message: 'Unmerged',
});
for (const result of [jsonNull, {}, { ok: false }, { ok: false, unmerged: true, message: 1 }]) {
  assert.throws(() => parseDeleteResult(result));
}

async function main() {
  const built = await esbuild.build({
    entryPoints: [repoPath('src/features/git/gitActions.ts')],
    write: false,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      stubSources('script-confirmations', {
        'src/ui/ConfirmDialog.tsx': () => ({
          contents: 'export const confirmDialog = (question) => globalThis.confirmQuestion(question);',
        }),
      }),
    ],
  });
  async function scenario(action, answers, responses, extra = {}) {
    const events = [];
    const jobs = [];
    const preload = Object.fromEntries(
      Object.entries(responses).map(([name, results]) => [
        name,
        async (payload) => {
          events.push({ name, payload });
          return results.shift();
        },
      ]),
    );
    const context = vm.createContext({
      module: { exports: {} },
      window: { avb: preload },
      confirmQuestion: async (question) => {
        events.push({ title: question.title, checkbox: question.checkbox });
        assert(answers.length > 0, 'Unexpected confirmation');
        return answers.shift();
      },
    });
    vm.runInContext(built.outputFiles[0].text, context);
    await context.module.exports[action]({
      projectPath: '/project',
      branch: 'topic',
      into: 'main',
      trunk: 'main',
      run: (task) => jobs.push(task()),
      showToast: (message, kind) => events.push({ message, kind }),
      onConflict: (result) => events.push({ conflict: result }),
      ...extra,
    });
    await Promise.all(jobs);
    return JSON.parse(JSON.stringify(events));
  }
  const names = (events) => events.filter((event) => event.name).map((event) => event.name);
  const merged = await scenario('mergeBranchAction', [{ checked: true }], {
    gitMerge: [success],
    gitDeleteBranch: [{ ok: true }],
  });
  assert.deepEqual(names(merged), ['gitMerge', 'gitDeleteBranch']);
  const trunk = await scenario('mergeBranchAction', [true], { gitMerge: [success] }, { branch: 'main' });
  assert.deepEqual(names(trunk), ['gitMerge']);
  assert.equal(trunk[0].checkbox, undefined);
  const parked = await scenario('mergeBranchAction', [{ checked: true }, true], {
    gitMerge: [dirty, conflict],
    gitPark: [{ ok: true, parked: true, branch: 'main' }],
    gitUnpark: [{ restored: true }],
  });
  assert.deepEqual(names(parked), ['gitMerge', 'gitPark', 'gitMerge', 'gitUnpark']);
  assert.equal(parked.at(-1).conflict.deleteAfter, true);
  const refusal = { ok: false, unmerged: true, message: 'Unmerged commits' };
  const cancelled = await scenario('deleteBranchAction', [true, false], {
    gitDeleteBranch: [refusal],
  });
  assert.deepEqual(names(cancelled), ['gitDeleteBranch']);
  const forced = await scenario('deleteBranchAction', [true, true], {
    gitDeleteBranch: [refusal, { ok: true }],
  });
  assert.equal(forced.filter((event) => event.name).at(-1).payload.force, true);
  console.log('git-actions: parsed outcomes, merge/delete order and conflict handoff passed');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
