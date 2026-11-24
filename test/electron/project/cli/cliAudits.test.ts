// Goal: `stacki audits` lets a person or an AI agent list, add, update, remove and test custom audits safely: a write is a dry
// run until applied, writes `.stacki/audits.json` through the app's serializer (other settings and ignores untouched) and can be
// undone; every pattern goes through the guard, so an unsafe or invalid one is refused naming the flag and nothing is written;
// `audits test` counts matches with the panel's bounded matcher over fixture files, for a saved audit or one described inline.
// Method: generated fixture projects (never a real one); each command runs through `runCommand`, the entry point the shell and
// the MCP server share, and the JSON envelope and the file on disk are asserted.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { runCommand, type RunRequest } from '#dist/electron/project/cli/cliRun.js';
import { parseAuditIgnoresSource } from '#dist/shared/properties/auditIgnores.js';
import { COMMANDS } from '#dist/shared/properties/cli/stackiCommands.js';
import { dig, parseJson } from '../../../helpers/cliJson.ts';
import { makeProject, readText, removeProjects } from '../../../helpers/cliProject.ts';

afterEach(removeProjects);

function request(
  project: string,
  words: readonly string[],
  args: Record<string, unknown>,
  apply: 'apply' | 'plan' = 'plan',
  yes: 'yes' | 'no' = 'no',
): RunRequest {
  return { words, args, project, role: {}, apply, yes, waitSeconds: 0 };
}

const FIXTURE = {
  '.stacki/audits.json': `${JSON.stringify({ version: 2, ignored: [{ id: 'img-alt|src/pages/index.astro|0|x', reason: 'Decorative' }] }, undefined, 2)}\n`,
  'src/styles/site.css': '.hero { text-align: center; color: var(--swatch-red); }\n.card { text-align: var(--align); }\n/* text-align: left */\n',
  'src/pages/index.astro': '---\n---\n<h1>TODO title</h1>\n<style is:global>\n.page { text-align: right; border: 1px solid var(--swatch-grey); }\n</style>\n',
};

const TEXT_ALIGN = { name: 'Hard-coded text-align', icon: 'text', category: 'tokens', property: '^text-align$', valueMustNotMatch: 'var\\(' };

function audits(root: string) {
  return parseAuditIgnoresSource(readText(root, '.stacki/audits.json')).customAudits;
}

test('every audits command is in the table, with read commands on cli:read and writes on cli:config', () => {
  const rows = COMMANDS.filter((spec) => spec.words[0] === 'audits').map((spec) => `${spec.words.join(' ')}:${spec.access}:${spec.feature}`);
  assert.deepEqual(rows.sort(), [
    'audits add:write:cli:config',
    'audits list:read:cli:read',
    'audits presets:read:cli:read',
    'audits remove:write:cli:config',
    'audits test:read:cli:read',
    'audits update:write:cli:config',
  ]);
});

test('add is a dry run until applied, then writes the audit beside the ignores, and undo puts the file back', async () => {
  const root = makeProject(FIXTURE);
  const before = readText(root, '.stacki/audits.json');
  const plan = await runCommand(request(root, ['audits', 'add'], TEXT_ALIGN));
  assert.ok(plan.ok, plan.ok ? '' : plan.error.message);
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.files[0]?.file, '.stacki/audits.json');
  assert.equal(readText(root, '.stacki/audits.json'), before, 'a plan leaves the disk alone');
  const applied = await runCommand(request(root, ['audits', 'add'], TEXT_ALIGN, 'apply'));
  assert.ok(applied.ok);
  assert.equal(dig(applied.result, 'audit', 'id'), 'hard-coded-text-align');
  const written = parseJson(readText(root, '.stacki/audits.json'));
  assert.equal(dig(written, 'ignored', 0, 'reason'), 'Decorative', 'the ignores are untouched');
  assert.equal(dig(written, 'customAudits', 0, 'match', 'valueMustNotMatch'), 'var\\(');
  assert.equal(audits(root)[0]?.enabled, true);
  const undone = await runCommand(request(root, ['undo'], { id: applied.undoId }, 'apply'));
  assert.ok(undone.ok);
  assert.equal(readText(root, '.stacki/audits.json'), before);
});

test('add from a preset, a second add gets a unique id, an explicit id that exists is refused', async () => {
  const root = makeProject(FIXTURE);
  const first = await runCommand(request(root, ['audits', 'add'], { preset: 'core-swatch-instead-of-theme' }, 'apply'));
  assert.ok(first.ok, first.ok ? '' : first.error.message);
  const second = await runCommand(request(root, ['audits', 'add'], { preset: 'core-swatch-instead-of-theme', severity: 'high' }, 'apply'));
  assert.ok(second.ok);
  assert.deepEqual(
    audits(root).map((audit) => [audit.id, audit.severity]),
    [
      ['core-swatch-instead-of-theme', 'medium'],
      ['core-swatch-instead-of-theme-2', 'high'],
    ],
  );
  const taken = await runCommand(request(root, ['audits', 'add'], { ...TEXT_ALIGN, id: 'core-swatch-instead-of-theme' }));
  assert.equal(taken.ok ? '' : taken.error.code, 'exists');
  const unknown = await runCommand(request(root, ['audits', 'add'], { preset: 'nope' }));
  assert.equal(unknown.ok ? '' : unknown.error.code, 'missing');
});

test('an unsafe, invalid or incomplete audit is refused naming the flag, and nothing is written', async () => {
  const root = makeProject(FIXTURE);
  const before = readText(root, '.stacki/audits.json');
  const cases: readonly (readonly [Record<string, unknown>, string, RegExp])[] = [
    [{ ...TEXT_ALIGN, valueMustNotMatch: '(a+)+' }, 'invalid-value', /--value-must-not-match: a repeat inside a repeated group/],
    [{ ...TEXT_ALIGN, property: '(unclosed' }, 'invalid-value', /--property: not a regular expression/],
    [{ ...TEXT_ALIGN, property: 'x*' }, 'invalid-value', /--property: it matches empty text/],
    [{ name: 'Markup', scope: 'markup', regex: '(a)\\1' }, 'invalid-value', /--regex: backreferences/],
    [{ name: 'Markup', scope: 'markup' }, 'invalid-value', /--regex: expected a regular expression/],
    [{ ...TEXT_ALIGN, icon: undefined, category: 'c'.repeat(41) }, 'invalid-value', /--category: longer than 40/],
    [{ icon: 'text', property: '^x$' }, 'required', /Name the audit/],
  ];
  for (const [args, code, message] of cases) {
    const answer = await runCommand(request(root, ['audits', 'add'], args, 'apply'));
    assert.equal(answer.ok ? 'ok' : answer.error.code, code, JSON.stringify(args));
    assert.match(answer.ok ? '' : answer.error.message, message);
  }
  assert.equal(readText(root, '.stacki/audits.json'), before);
});

test('update changes only the flags given; remove needs --yes; list shows every audit with whether it is safe', async () => {
  const root = makeProject(FIXTURE);
  assert.ok((await runCommand(request(root, ['audits', 'add'], TEXT_ALIGN, 'apply'))).ok);
  const updated = await runCommand(
    request(root, ['audits', 'update'], { id: 'hard-coded-text-align', enabled: false, category: 'Brand', exclude: 'inherit' }, 'apply'),
  );
  assert.ok(updated.ok, updated.ok ? '' : updated.error.message);
  const [audit] = audits(root);
  assert.equal(audit?.enabled, false);
  assert.equal(audit?.category, 'Brand');
  assert.equal(audit?.exclude, 'inherit');
  assert.equal(audit?.name, 'Hard-coded text-align', 'a flag not given keeps its value');
  const missing = await runCommand(request(root, ['audits', 'update'], { id: 'nope', name: 'x' }));
  assert.equal(missing.ok ? '' : missing.error.code, 'missing');
  const listed = await runCommand(request(root, ['audits', 'list'], {}));
  assert.ok(listed.ok);
  assert.equal(dig(listed.result, 'audits', 0, 'safe'), true);
  const unconfirmed = await runCommand(request(root, ['audits', 'remove'], { id: 'hard-coded-text-align' }, 'apply'));
  assert.equal(unconfirmed.ok ? '' : unconfirmed.error.code, 'confirmation-required');
  const removed = await runCommand(request(root, ['audits', 'remove'], { id: 'hard-coded-text-align' }, 'apply', 'yes'));
  assert.ok(removed.ok);
  assert.deepEqual(audits(root), []);
  assert.ok(!(readText(root, '.stacki/audits.json') ?? '').includes('customAudits'), 'an empty list is not written');
});

test('test counts matches in stylesheets and style blocks for a saved audit and an inline one, and writes nothing', async () => {
  const root = makeProject(FIXTURE);
  assert.ok((await runCommand(request(root, ['audits', 'add'], TEXT_ALIGN, 'apply'))).ok);
  const before = readText(root, '.stacki/audits.json');
  const saved = await runCommand(request(root, ['audits', 'test'], { id: 'hard-coded-text-align' }));
  assert.ok(saved.ok, saved.ok ? '' : saved.error.message);
  assert.equal(dig(saved.result, 'count'), 2, 'center in the stylesheet, right in the style block; the var() and the comment are not');
  assert.deepEqual(dig(saved.result, 'matches'), [
    { file: 'src/pages/index.astro', line: 5, text: 'text-align: right' },
    { file: 'src/styles/site.css', line: 1, text: 'text-align: center' },
  ]);
  const swatch = await runCommand(request(root, ['audits', 'test'], { preset: 'core-swatch-instead-of-theme' }));
  assert.ok(swatch.ok);
  assert.equal(dig(swatch.result, 'count'), 2);
  const markup = await runCommand(request(root, ['audits', 'test'], { scope: 'markup', regex: '\\bTODO\\b' }));
  assert.ok(markup.ok);
  assert.equal(dig(markup.result, 'count'), 1);
  const unsafe = await runCommand(request(root, ['audits', 'test'], { scope: 'css', regex: '(x+)+y' }));
  assert.equal(unsafe.ok ? '' : unsafe.error.code, 'invalid-value');
  const rendered = await runCommand(request(root, ['audits', 'test'], { scope: 'rendered', regex: 'lorem' }));
  assert.equal(rendered.ok ? '' : rendered.error.code, 'refused');
  assert.equal(readText(root, '.stacki/audits.json'), before, 'test never writes');
});

test('presets lists every preset as a whole audit', async () => {
  const root = makeProject();
  const answer = await runCommand(request(root, ['audits', 'presets'], {}));
  assert.ok(answer.ok);
  const presets = dig(answer.result, 'presets');
  assert.ok(Array.isArray(presets));
  assert.ok(presets.length >= 4);
  assert.equal(dig(presets, 0, 'safe'), true);
});
