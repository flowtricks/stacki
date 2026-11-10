// Goal: the Git panel's optional Conventional Commits type never changes a
// message nobody asked to change, and when a type is picked the subject the
// panel previews is exactly the subject git receives.
// Methodology: first the pure pieces through the app's bundler — the subject
// builder for every type, scope, breaking mark, no type, a replaced prefix and
// a user-typed prefix left alone; the scope parser on valid and invalid input
// (including the bound and the value just past it); the stored preference
// parser on malformed storage; and the commit-subject highlighter. Then the real
// GitChip in jsdom against a stubbed IPC transport: with the default (no type)
// the typed message is committed unchanged, picking a type shows the preview
// and changes the committed subject, and the type is remembered for the project
// across a remount but not carried to another project.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { repoPath, sourceSpecifier } = require('../../helpers/sources');

const { COMMIT_TYPES, COMMIT_SCOPE_LENGTH_MAX, buildCommitSubject, parseCommitScope, stripCommitTypePrefix } = loadRenderer('src/features/git/commitType.ts');
const { COMMIT_TYPE_PROJECTS_MAX, parseStoredCommitTypes, withCommitType, commitTypeProjectKey } = loadRenderer('src/features/git/commitTypePreference.ts');
const { codeTokenLines } = loadRenderer('src/ui/codeHighlight.ts');

const NONE = { kind: 'none' };
const typed = (type, options = {}) => {
  const scope = parseCommitScope(options.scope ?? '');
  assert.ok(scope.ok);
  return { kind: 'typed', type, scope: scope.value, breaking: options.breaking ?? false };
};

test('no type writes the message as typed, including a prefix the person typed', () => {
  assert.equal(buildCommitSubject('Fix the footer', NONE, 'Update from Stacki'), 'Fix the footer');
  assert.equal(buildCommitSubject('feat: x', NONE, 'Update from Stacki'), 'feat: x');
  assert.equal(buildCommitSubject('fix(nav)!: y', NONE, 'Update from Stacki'), 'fix(nav)!: y');
  assert.equal(buildCommitSubject('   ', NONE, 'Update from Stacki'), 'Update from Stacki');
});

test('each type leads the subject, with an optional scope and breaking mark', () => {
  assert.equal(COMMIT_TYPES.length, 12);
  for (const type of COMMIT_TYPES) {
    assert.equal(buildCommitSubject('Change things', typed(type), 'Update'), `${type}: Change things`);
    assert.equal(buildCommitSubject('Change things', typed(type, { scope: 'nav' }), 'Update'), `${type}(nav): Change things`);
    assert.equal(buildCommitSubject('Change things', typed(type, { breaking: true }), 'Update'), `${type}!: Change things`);
    assert.equal(buildCommitSubject('Change things', typed(type, { scope: 'nav', breaking: true }), 'Update'), `${type}(nav)!: Change things`);
  }
  // An empty message takes the fallback, which gets the type like any message.
  assert.equal(buildCommitSubject('', typed('feat'), 'Update from Stacki'), 'feat: Update from Stacki');
});

test('a picked type replaces an existing type prefix rather than stacking', () => {
  assert.equal(buildCommitSubject('fix: header gap', typed('feat'), 'Update'), 'feat: header gap');
  assert.equal(buildCommitSubject('FIX(nav)!: header gap', typed('style', { scope: 'footer' }), 'Update'), 'style(footer): header gap');
  assert.equal(buildCommitSubject('feat: ', typed('feat'), 'Update'), 'feat: Update');
  // Only known types are prefixes: an ordinary "Word:" opening stays in the message.
  assert.equal(buildCommitSubject('Note: header gap', typed('fix'), 'Update'), 'fix: Note: header gap');
  assert.equal(stripCommitTypePrefix('content: new copy'), 'new copy');
  assert.equal(stripCommitTypePrefix('contents: new copy'), 'contents: new copy');
});

test('the scope is validated where it is typed', () => {
  assert.deepEqual(parseCommitScope(''), { ok: true, value: undefined });
  assert.deepEqual(parseCommitScope('  '), { ok: true, value: undefined });
  assert.deepEqual(parseCommitScope(' nav '), { ok: true, value: 'nav' });
  assert.deepEqual(parseCommitScope('a'.repeat(COMMIT_SCOPE_LENGTH_MAX)), { ok: true, value: 'a'.repeat(COMMIT_SCOPE_LENGTH_MAX) });
  assert.match(parseCommitScope('a'.repeat(COMMIT_SCOPE_LENGTH_MAX + 1)).error, /at most 32/);
  for (const bad of ['two words', 'a(b', 'a)b', 'a:b', 'tab\there']) {
    const parsed = parseCommitScope(bad);
    assert.equal(parsed.ok, false, bad);
    assert.match(parsed.error, /spaces, parentheses or colons/);
  }
  // A scope that skipped the parser is a programmer error, and crashes loudly.
  assert.throws(
    () => buildCommitSubject('x', { kind: 'typed', type: 'feat', scope: 'a b', breaking: false }, 'Update'),
    /Assertion failed: Commit subject: the scope was parsed/,
  );
  assert.throws(() => buildCommitSubject('x', NONE, ' '), /Assertion failed: Commit subject: the fallback message is non-empty/);
});

test('the stored preference is parsed like any input, and stays bounded', () => {
  assert.equal(parseStoredCommitTypes(undefined).size, 0);
  assert.equal(parseStoredCommitTypes('not json').size, 0);
  assert.equal(parseStoredCommitTypes('[]').size, 0);
  assert.deepEqual([...parseStoredCommitTypes(JSON.stringify({ a: 'feat', b: 'nope', c: 3 }))], [['a', 'feat']]);
  let choices = new Map();
  for (let index = 0; index < COMMIT_TYPE_PROJECTS_MAX + 5; index++) {
    choices = withCommitType(choices, `project-${index}`, 'fix');
  }
  assert.equal(choices.size, COMMIT_TYPE_PROJECTS_MAX);
  assert.equal(choices.has('project-0'), false);
  assert.equal(withCommitType(choices, 'project-9', undefined).has('project-9'), false);
  assert.notEqual(commitTypeProjectKey({ path: 'studio', name: 'one' }), commitTypeProjectKey({ path: 'studio', name: 'two' }));
});

test('the commit subject is highlighted by its parts', () => {
  const [line] = codeTokenLines('feat(nav)!: New menu', 'commit');
  assert.deepEqual(
    line.map((token) => token.text),
    ['feat', '(', 'nav', ')', '!', ':', ' New menu'],
  );
  assert.ok(line[0].style.color);
  assert.equal(line.at(-1).style, undefined);
  assert.deepEqual(codeTokenLines('Plain message', 'commit'), [[{ text: 'Plain message' }]]);
});

test('the Git panel commits as typed by default, and with the picked type once chosen', async () => {
  const directory = repoPath('node_modules/.stacki-test/commit-type');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'panel.cjs');
  await esbuild.build({
    stdin: { contents: `export {default as Controls} from ${sourceSpecifier('src/features/git/GitChip.tsx')};`, resolveDir: repoPath('src'), loader: 'tsx' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  window.matchMedia = () => ({ matches: true });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { Controls } = require(outfile);
  const commits = [];
  window.avb = {
    gitCommit: async (payload) => {
      commits.push(payload.message);
      return { ok: true, files: 1 };
    },
    gitStatus: async () => [],
    gitLog: async () => ({ commits: [], atEnd: true }),
  };
  const info = { isRepo: true, branch: 'main', branches: ['main'], parked: [], head: 'a'.repeat(40), dirty: true, ahead: 0, trunk: 'main' };
  const root = createRoot(document.getElementById('root'));
  const render = (project) =>
    act(async () =>
      root.render(
        React.createElement(Controls, {
          key: project.path,
          info,
          project,
          busy: undefined,
          incoming: { kind: 'checking' },
          flushSave: async () => {},
          refresh: async () => {},
          showToast: () => {},
        }),
      ),
    );
  const query = (selector) => document.querySelector(selector);
  const button = (label) => [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === label);
  const fill = (selector, value) =>
    act(async () => {
      const input = query(selector);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const pickType = async (label) => {
    await act(async () => query('[aria-label="Commit type"]').click());
    const row = [...document.querySelectorAll('.dd-option')].find((option) => option.querySelector('.dd-option-label').textContent === label);
    assert.ok(row, `the type menu lists ${label}`);
    await act(async () => row.click());
  };
  try {
    await render({ path: '/site', name: 'Site' });
    // Default: no type, no scope or breaking fields, no preview, and the message unchanged.
    assert.equal(query('[aria-label="Commit type"]').textContent, 'No type');
    assert.equal(query('[aria-label="Commit scope"]') === null, true);
    assert.equal(query('.git-commit-preview') === null, true);
    await fill('[aria-label="Commit message"]', 'feat: typed by hand');
    await act(async () => button('Commit all changes').click());
    assert.equal(commits.at(-1), 'feat: typed by hand');

    // The menu describes each type in a line, with no hover preview.
    await act(async () => query('[aria-label="Commit type"]').click());
    const rows = [...document.querySelectorAll('.dd-option')];
    assert.equal(rows.length, 13);
    assert.equal(rows[1].querySelector('.dd-description').textContent, 'a new feature');
    assert.equal(rows[3].querySelector('.dd-description').textContent, 'copy, images or data');
    await act(async () => rows[2].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
    assert.equal(query('[aria-label="Commit type"]').textContent, 'No type');
    await act(async () => rows[0].click());

    // The message has its row to itself; the type picker sits on the row beneath.
    assert.equal(query('[aria-label="Commit message"]').parentElement.classList.contains('git-commit-type-row'), false);
    assert.ok(query('.git-commit-type-row > [aria-label="Commit type"]'));
    assert.ok(query('[aria-label="Commit message"]').compareDocumentPosition(query('[aria-label="Commit type"]')) & window.Node.DOCUMENT_POSITION_FOLLOWING);

    // Searching filters by name and description; "No type" always stays listed.
    const labels = () => [...document.querySelectorAll('.dd-option .dd-option-label')].map((label) => label.textContent);
    const search = (text) =>
      act(async () => {
        const input = query('.dd-search');
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    const key = (name) => act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true })));
    await act(async () => query('[aria-label="Commit type"]').click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(document.activeElement, query('.dd-search'), 'the search box takes focus when the menu opens');
    await search('bug');
    assert.deepEqual(labels(), ['No type', 'fix']);
    await search('css');
    assert.deepEqual(labels(), ['No type', 'style']);
    await search('images');
    assert.deepEqual(labels(), ['No type', 'content']);
    await search('zzzz');
    assert.deepEqual(labels(), ['No type']);
    assert.equal(query('.dd-empty').textContent, 'Nothing matches');
    await search('');
    assert.equal(labels().length, 13);
    assert.equal(query('.dd-empty') === null, true);
    await key('Escape');
    assert.equal(query('.dd-popup') === null, true);
    assert.equal(query('[aria-label="Commit type"]').textContent, 'No type');
    // Arrows move through the filtered rows and Enter picks.
    await act(async () => query('[aria-label="Commit type"]').click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await search('bug');
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter');
    assert.equal(query('.dd-popup') === null, true);
    assert.equal(query('[aria-label="Commit type"]').textContent, 'fix');
    assert.ok(query('.git-commit-type-row > [aria-label="Commit scope"]'), 'the scope shares the type row');
    await pickType('No type');
    assert.equal(query('[aria-label="Commit scope"]') === null, true);

    await pickType('fix');
    await fill('[aria-label="Commit message"]', 'feat: header gap');
    assert.equal(query('.git-commit-preview').textContent, 'fix: header gap');
    assert.ok(query('.git-commit-preview .code-token'), 'the preview is syntax highlighted');
    await fill('[aria-label="Commit scope"]', 'nav bar');
    assert.match(query('.git-commit-scope-error').textContent, /no spaces/);
    assert.equal(button('Commit all changes').disabled, true);
    await fill('[aria-label="Commit scope"]', 'nav');
    await act(async () => query('.git-commit-type-row input[type="checkbox"]').click());
    assert.equal(query('.git-commit-preview').textContent, 'fix(nav)!: header gap');
    await act(async () => button('Commit all changes').click());
    assert.equal(commits.at(-1), 'fix(nav)!: header gap');
    // Scope and breaking described that commit; the type stays for the next.
    assert.equal(query('[aria-label="Commit scope"]').value, '');
    assert.equal(query('[aria-label="Commit type"]').textContent, 'fix');

    // Remembered for this project across a remount, never carried to another.
    await act(async () => root.render(React.createElement(React.Fragment)));
    await render({ path: '/site', name: 'Site' });
    assert.equal(query('[aria-label="Commit type"]').textContent, 'fix');
    await act(async () => button('Commit all changes').click());
    assert.equal(commits.at(-1), 'fix: Update from Stacki');
    await render({ path: '/other', name: 'Other' });
    assert.equal(query('[aria-label="Commit type"]').textContent, 'No type');

    // Choosing None again forgets the type for the project.
    await render({ path: '/site', name: 'Site' });
    await pickType('No type');
    await act(async () => root.render(React.createElement(React.Fragment)));
    await render({ path: '/site', name: 'Site' });
    assert.equal(query('[aria-label="Commit type"]').textContent, 'No type');
  } finally {
    await act(async () => root.unmount());
  }
});
