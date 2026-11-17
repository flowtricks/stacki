// Goal: the `stacki` program a person or a script types works for every command in the table: each command documents itself, runs from a real
// command line against a scratch project, answers the documented exit code, writes nothing without --apply, and the defects found by the docs
// review stay fixed (breakpoints sync with --value, doctor failing on errors, options before the command, role-filtered help, per-command help,
// the component list without a cap, roles components with a positional path, a flag-named argument with the other one positional).
// Method: `main()` (the entry the executable calls) is driven with argument lists, exactly as a shell passes them, on generated fixture projects
// (never a real one). A table holds one realistic dry-run line per command and its expected exit code; every line is also run with --help. The
// project tree is snapshot before and after each dry run and must not change. The regressions get their own tests below the table.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import '#dist/electron/handlers/cliComponentCommands.js';
import { main } from '#dist/electron/project/cli/cliMain.js';
import { spellingOf, usageOf } from '#dist/shared/properties/cli/stackiArgs.js';
import { COMMANDS } from '#dist/shared/properties/cli/stackiCommands.js';
import { listOf } from '../../../helpers/cliApp.ts';
import { dig, parseJson } from '../../../helpers/cliJson.ts';
import { makeProject, readText, removeProjects, ROLES_FIXTURE } from '../../../helpers/cliProject.ts';

afterEach(removeProjects);

interface Ran {
  readonly code: number;
  readonly output: string;
}

async function run(cwd: string, argv: readonly string[]): Promise<Ran> {
  let output = '';
  const code = await main(argv, cwd, (text) => {
    output += text;
  });
  return { code, output };
}

// A Lumos-style site (LUMOS.md, rem stylesheets): the length unit the breakpoint sync writes is rem.
const SITE_FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "scratch-site", "private": true }\n',
  'LUMOS.md': '# Lumos\n',
  'src/styles/global.css': [
    ':root { --site-margin: 2rem; }',
    '@media screen and (max-width: 64rem) { .a { color: red; } }',
    '@media screen and (max-width: 1024px) { .b { color: blue; } }',
    '@media screen and (max-width: 48rem) { .c { color: green; } }',
    '',
  ].join('\n'),
  'src/components/Card.astro': '<div class="card">card</div>\n<style>\n@media screen and (max-width: 64rem) { .card { padding: 1rem; } }\n</style>\n',
  'src/pages/index.astro': "---\nimport Card from '../components/Card.astro';\n---\n<Card />\n",
  '.stacki/roles.json': ROLES_FIXTURE,
  '.stacki/styles.json': '{ "version": 1, "keep": ["is-*"] }\n',
};

function snapshot(root: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  const pending = [root];
  // Each pass reads one folder of a small generated fixture; the walk ends when no folder is left.
  while (pending.length > 0) {
    const directory = pending.pop();
    assert.ok(directory !== undefined);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (relative === '.stacki/io') {
        continue; // Locks and the undo journal are the CLI's own bookkeeping, not the project.
      }
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        files.set(relative, fs.readFileSync(full, 'utf8'));
      }
    }
  }
  return files;
}

// One realistic line per command, run as a dry run in a project that has roles (the shell acts as the owner) and the Lumos site above.
const LINES: ReadonlyArray<{ readonly words: string; readonly argv: readonly string[]; readonly code: number }> = [
  { words: 'schema', argv: ['schema', 'guide'], code: 0 },
  { words: 'list', argv: ['list', 'components'], code: 0 },
  { words: 'doctor', argv: ['doctor'], code: 0 },
  { words: 'config get', argv: ['config', 'get', 'breakpoints', 'desktop'], code: 0 },
  { words: 'config set', argv: ['config', 'set', 'guide', 'settings.visible', 'true'], code: 0 },
  { words: 'config unset', argv: ['config', 'unset', 'styles', 'keep'], code: 0 },
  { words: 'config add', argv: ['config', 'add', 'styles', 'keep', 'w-*'], code: 0 },
  { words: 'config remove', argv: ['config', 'remove', 'styles', 'keep', 'is-*'], code: 0 },
  { words: 'guides set', argv: ['guides', 'set', '--visible', '--columns', '4', '--margin', '2rem'], code: 0 },
  { words: 'guides clear', argv: ['guides', 'clear', 'all'], code: 0 },
  { words: 'breakpoints set', argv: ['breakpoints', 'set', 'laptop', '--value', '62'], code: 0 },
  { words: 'breakpoints add', argv: ['breakpoints', 'add', 'Wide', '--value', '100', '--unit', 'rem'], code: 0 },
  { words: 'breakpoints remove', argv: ['breakpoints', 'remove', 'tablet'], code: 1 },
  { words: 'breakpoints sync', argv: ['breakpoints', 'sync', 'laptop', '--value', '60'], code: 0 },
  { words: 'roles add', argv: ['roles', 'add', 'Client'], code: 0 },
  { words: 'roles remove', argv: ['roles', 'remove', 'editor'], code: 0 },
  { words: 'roles members add', argv: ['roles', 'members', 'add', 'viewer', 'someone'], code: 0 },
  { words: 'roles members remove', argv: ['roles', 'members', 'remove', 'editor', 'ed'], code: 0 },
  { words: 'roles access grant', argv: ['roles', 'access', 'grant', 'viewer', 'cli:guides'], code: 0 },
  { words: 'roles access revoke', argv: ['roles', 'access', 'revoke', 'editor', 'cli:guides'], code: 0 },
  { words: 'roles components hide', argv: ['roles', 'components', 'hide', 'viewer', 'src/components/Card.astro'], code: 0 },
  { words: 'roles components show', argv: ['roles', 'components', 'show', 'viewer', '--path', 'src/components/Card.astro'], code: 0 },
  { words: 'folders add', argv: ['folders', 'add', 'components', 'src/blocks'], code: 0 },
  { words: 'folders remove', argv: ['folders', 'remove', 'components', 'src/components'], code: 0 },
  { words: 'folders reset', argv: ['folders', 'reset', 'components'], code: 0 },
  { words: 'apps commands', argv: ['apps', 'commands'], code: 0 },
  { words: 'apps add', argv: ['apps', 'add', './no-such-app'], code: 1 },
  { words: 'apps remove', argv: ['apps', 'remove', 'notes'], code: 1 },
  { words: 'apps settings set', argv: ['apps', 'settings', 'set', 'notes', 'title', 'Hello'], code: 0 },
  { words: 'apps enable', argv: ['apps', 'enable', 'notes'], code: 1 },
  { words: 'apps disable', argv: ['apps', 'disable', 'notes'], code: 1 },
  { words: 'components rename', argv: ['components', 'rename', 'src/components/Card.astro', 'Big Card'], code: 0 },
  { words: 'components move', argv: ['components', 'move', 'src/components/Card.astro', 'src/pages'], code: 1 },
  { words: 'components duplicate', argv: ['components', 'duplicate', 'src/components/Card.astro'], code: 0 },
  { words: 'components delete', argv: ['components', 'delete', 'src/components/Card.astro'], code: 1 },
  { words: 'undo', argv: ['undo', 'abcdefgh1'], code: 1 },
];

test('the table of lines covers every command of the table', () => {
  assert.deepEqual(
    LINES.map((line) => line.words),
    COMMANDS.map((spec) => spec.words.join(' ')),
  );
});

test('every command documents itself: its usage line and each argument in "<command> --help", its name in "--help"', async () => {
  const root = makeProject(SITE_FILES);
  const top = await run(root, ['--help']);
  assert.equal(top.code, 0);
  for (const spec of COMMANDS) {
    assert.ok(top.output.includes(`stacki ${spec.words.join(' ')} `), `--help lists ${spec.words.join(' ')}`);
    const own = await run(root, [...spec.words, '--help']);
    assert.equal(own.code, 0, `${spec.words.join(' ')} --help`);
    assert.ok(own.output.includes(`Usage: ${usageOf(spec)}`), `${spec.words.join(' ')} --help prints its usage`);
    for (const argument of spec.args) {
      assert.ok(own.output.includes(spellingOf(argument)), `${spec.words.join(' ')} --help names ${argument.name}`);
    }
    const word = await run(root, ['help', ...spec.words]);
    assert.equal(word.output, own.output, '"help <command>" is "<command> --help"');
  }
});

test('every command runs from a command line with its documented exit code, and a dry run writes nothing', async () => {
  for (const line of LINES) {
    const root = makeProject(SITE_FILES);
    const before = snapshot(root);
    const ran = await run(root, [...line.argv, '--json']);
    assert.equal(ran.code, line.code, `${line.argv.join(' ')}: ${ran.output}`);
    const envelope = parseJson(ran.output);
    assert.equal(dig(envelope, 'schemaVersion'), 1, line.argv.join(' '));
    assert.equal(dig(envelope, 'ok'), line.code === 0, line.argv.join(' '));
    assert.deepEqual(snapshot(root), before, `${line.argv.join(' ')} wrote nothing without --apply`);
  }
});

test('global options work before the command as well as after it', async () => {
  const root = makeProject(SITE_FILES);
  const elsewhere = makeProject();
  for (const argv of [
    ['--json', 'doctor'],
    ['doctor', '--json'],
    ['--project', root, '--json', 'list', 'breakpoints'],
    ['--project=' + root, 'list', 'breakpoints', '--json'],
  ]) {
    const ran = await run(elsewhere, argv);
    assert.equal(ran.code, 0, argv.join(' '));
    assert.equal(dig(parseJson(ran.output), 'ok'), true, argv.join(' '));
  }
  const listed = parseJson((await run(elsewhere, ['--project', root, '--json', 'list', 'breakpoints'])).output);
  assert.equal(dig(listed, 'project'), root, '--project before the command chooses the project');
  assert.equal((await run(root, ['--bogus', 'doctor'])).code, 2, 'an unknown option before the command is a usage error');
  assert.equal((await run(root, ['--project'])).code, 2, 'an option without its value is a usage error');
  assert.equal((await run(root, ['nothing'])).code, 2);
});

test('help for a role lists only what the role may run, before or after the command', async () => {
  const root = makeProject(SITE_FILES);
  for (const argv of [
    ['--help', '--as-role', 'viewer'],
    ['--as-role', 'viewer', '--help'],
  ]) {
    const help = await run(root, argv);
    assert.equal(help.code, 0);
    assert.ok(help.output.includes('stacki doctor'), argv.join(' '));
    assert.ok(!help.output.includes('stacki guides set'), `${argv.join(' ')} hides write commands`);
    assert.ok(help.output.includes('role "viewer"'));
  }
  const denied = await run(root, ['breakpoints', 'sync', '--help', '--as-role', 'viewer']);
  assert.match(denied.output, /Role "viewer" may not run this command/);
  const group = await run(root, ['roles', '--help']);
  assert.equal(group.code, 0);
  assert.ok(group.output.includes('stacki roles components hide'));
});

test('doctor exits 1 when a settings file is refused, with the findings in the JSON, and 0 when healthy', async () => {
  const root = makeProject({ ...SITE_FILES, '.stacki/breakpoints.json': '{ "version": 4, "desktop": "wide" }\n' });
  const sick = await run(root, ['doctor', '--json']);
  assert.equal(sick.code, 1);
  const envelope = parseJson(sick.output);
  assert.equal(dig(envelope, 'ok'), false);
  assert.equal(dig(envelope, 'error', 'code'), 'invalid-file');
  assert.equal(dig(envelope, 'result', 'healthy'), false);
  assert.equal(dig(envelope, 'result', 'errors'), 1);
  const text = await run(root, ['doctor']);
  assert.match(text.output, /breakpoints\.json/);
  fs.rmSync(path.join(root, '.stacki/breakpoints.json'));
  assert.equal((await run(root, ['doctor'])).code, 0);
});

test('breakpoints sync moves the boundary and its media queries in rem, refuses bad input, repeats as a no-op and undoes', async () => {
  const root = makeProject(SITE_FILES);
  const before = snapshot(root);
  const plan = parseJson((await run(root, ['breakpoints', 'sync', 'laptop', '--value', '60', '--json'])).output);
  assert.equal(dig(plan, 'mode'), 'plan');
  const planned = listOf(dig(plan, 'files')).map((file) => dig(file, 'file'));
  assert.deepEqual(planned, ['src/components/Card.astro', 'src/styles/global.css', '.stacki/breakpoints.json', '.stacki/breakpoint-sync.json']);
  assert.deepEqual(snapshot(root), before, 'the plan wrote nothing');
  const applied = await run(root, ['breakpoints', 'sync', 'laptop', '--value', '60', '--apply', '--json']);
  assert.equal(applied.code, 0, applied.output);
  const css = readText(root, 'src/styles/global.css') ?? '';
  assert.ok(css.includes('(max-width: 60rem) { .a'), 'the exact query moved');
  assert.ok(css.includes('(max-width: 60rem) { .b'), 'a px query of the same boundary is written in rem in a Lumos site');
  assert.ok(css.includes('(max-width: 48rem)'), 'another breakpoint is left alone');
  assert.ok((readText(root, 'src/components/Card.astro') ?? '').includes('max-width: 60rem'), 'a component <style> block moved too');
  assert.equal(dig(parseJson(readText(root, '.stacki/breakpoints.json')), 'breakpoints', 0, 'value'), 60);
  const again = await run(root, ['breakpoints', 'sync', 'laptop', '--value', '60', '--apply', '--json']);
  assert.equal(again.code, 0, 'the same sync again succeeds');
  assert.equal(dig(parseJson(again.output), 'applied'), false, 'and changes nothing');
  const undoId = dig(parseJson(applied.output), 'undoId');
  assert.equal(typeof undoId, 'string');
  assert.equal((await run(root, ['undo', String(undoId), '--apply'])).code, 0);
  assert.deepEqual(snapshot(root), before, 'undo puts every file back');
});

test('breakpoints sync --from moves media queries after the saved boundary already changed', async () => {
  const root = makeProject(SITE_FILES);
  assert.equal((await run(root, ['breakpoints', 'set', 'laptop', '--value', '62', '--apply'])).code, 0);
  const without = parseJson((await run(root, ['breakpoints', 'sync', 'laptop', '--value', '62', '--json'])).output);
  assert.equal(dig(without, 'files', 'length'), 0, 'without --from there is nothing to move');
  const moved = await run(root, ['breakpoints', 'sync', 'laptop', '--value', '62', '--from', '64rem', '--apply']);
  assert.equal(moved.code, 0, moved.output);
  assert.ok((readText(root, 'src/styles/global.css') ?? '').includes('(max-width: 62rem) { .a'));
});

test('breakpoints sync refuses what Settings refuses, with usage or refusal exit codes and no write', async () => {
  const root = makeProject(SITE_FILES);
  const before = snapshot(root);
  const cases: ReadonlyArray<{ readonly argv: readonly string[]; readonly code: number }> = [
    { argv: ['breakpoints', 'sync', 'laptop'], code: 2 },
    { argv: ['breakpoints', 'sync', 'laptop', '--value', 'wide'], code: 2 },
    { argv: ['breakpoints', 'sync', 'laptop', '--value', '60', '--unit', 'em'], code: 2 },
    { argv: ['breakpoints', 'sync', 'laptop', '--value', '60', '--places', 'some'], code: 2 },
    { argv: ['breakpoints', 'sync', 'laptop', '--value', '-4'], code: 1 },
    { argv: ['breakpoints', 'sync', 'laptop', '--value', '20'], code: 1 },
    { argv: ['breakpoints', 'sync', 'laptop', '--value', '60', '--from', '64'], code: 1 },
    { argv: ['breakpoints', 'sync', 'desktop', '--value', '100'], code: 1 },
    { argv: ['breakpoints', 'sync', 'nothing', '--value', '60'], code: 1 },
  ];
  for (const entry of cases) {
    const ran = await run(root, [...entry.argv, '--apply']);
    assert.equal(ran.code, entry.code, `${entry.argv.join(' ')}: ${ran.output}`);
  }
  assert.deepEqual(snapshot(root), before);
});

test('list components lists every component of a big, deep project, with no cap', async () => {
  const files: Record<string, string> = {};
  const count = 5_050;
  for (let index = 0; index < count; index += 1) {
    files[`src/components/many/C${index}.astro`] = '<div />\n';
  }
  const deep = Array.from({ length: 14 }, (_, level) => `l${level}`).join('/');
  files[`src/components/${deep}/Deep.astro`] = '<div />\n';
  const root = makeProject(files);
  const listed = parseJson((await run(root, ['list', 'components', '--json'])).output);
  const components = listOf(dig(listed, 'result', 'components'));
  assert.equal(components.length, count + 2, 'every component, the fixture Card included');
  assert.ok(components.includes(`src/components/${deep}/Deep.astro`), 'a component 14 folders deep is listed');
});

test('a positional argument named by its flag leaves the bare word to the next one', async () => {
  const root = makeProject(SITE_FILES);
  for (const argv of [
    ['roles', 'members', 'add', '--role', 'editor', 'newbie'],
    ['roles', 'members', 'add', 'newbie', '--role', 'editor'],
    ['roles', 'members', 'add', 'editor', '--login', 'newbie'],
    ['roles', 'members', 'add', 'editor', 'newbie'],
  ]) {
    const ran = await run(root, [...argv, '--json']);
    assert.equal(ran.code, 0, `${argv.join(' ')}: ${ran.output}`);
    assert.equal(dig(parseJson(ran.output), 'summary'), 'Add newbie to editor.', argv.join(' '));
  }
  assert.equal((await run(root, ['roles', 'members', 'add', '--role', 'editor', 'newbie', 'extra'])).code, 2, 'a word too many is a usage error');
});
