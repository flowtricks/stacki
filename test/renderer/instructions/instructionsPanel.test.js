// Goal: the Instructions panel shows a project's skills (named by their
// frontmatter), rules and docs; shows the empty states when a section has
// nothing; creates a skill scaffold and a rule file through main and opens the
// new file; hides a file and a folder from a row's menu by writing
// `.stacki/instructions.json` against the bytes it read; lists again on a change
// event; and Settings → Instructions lists the hidden paths, adds one, refuses a
// bad one with its reason, and shows one again. A role without
// `instructions:edit` sees the files but no create buttons and no Hide items.
// Method: bundle the real panel and settings components with esbuild, mount them
// in jsdom over a fake `window.avb` that keeps the project's files and the
// settings file in memory, and click through as a person would.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/instructions-panel.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as InstructionsPanel } from './src/features/instructions/InstructionsPanel';",
      "export { InstructionsSettings } from './src/app/settings/InstructionsSettings';",
      "export { default as InstructionsDocument } from './src/app/shell/InstructionsDocument';",
      "export { selectedInstruction, selectInstruction } from './src/features/instructions/instructionSelection';",
      "export { setActualRole } from './src/lib/currentRole';",
      "export { ADMIN_VIEW } from './shared/properties/projectRoles';",
      "export { classifyInstruction as sectionOf, readInstructionSettingsSource } from './shared/properties/instructions';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
// The reading view repaints code colours on every change and lays code out a frame later.
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
global.cancelAnimationFrame = (handle) => clearTimeout(handle);
dom.window.document.execCommand = () => true;

// The project as main would answer for it.
let files;
let settingsSource;
const writes = [];
const created = [];
let changeListener;
function entry(file) {
  const section = panel.sectionOf(file);
  const text = files.get(file);
  const skill =
    section === 'skills'
      ? /name: (.+)\ndescription: (.+)/.test(text)
        ? { kind: 'valid', name: RegExp.$1, description: RegExp.$2.replace(/^"|"$/g, '') }
        : { kind: 'invalid', message: 'This skill has no frontmatter. Add a name and a description.' }
      : undefined;
  return { path: file, section, sizeBytes: text.length, skill };
}
function hiddenPaths() {
  const settings = panel.readInstructionSettingsSource(settingsSource);
  return settings.ok ? settings.value.hidden : [];
}
window.avb = {
  listInstructions: async () => ({
    files: [...files.keys()]
      .filter((file) => !hiddenPaths().some((hidden) => file === hidden || file.startsWith(`${hidden}/`)))
      .sort()
      .map(entry),
    folders: [],
    truncated: false,
  }),
  createInstruction: async ({ file, source }) => {
    if (files.has(file)) {
      return { ok: false, error: { code: 'exists', message: `${file} already exists.` } };
    }
    files.set(file, source);
    created.push({ file, source });
    return { ok: true, value: { source } };
  },
  createInstructionFolder: async () => ({ ok: true, value: { source: '' } }),
  revealInstruction: async () => ({ ok: true }),
  projectMetadata: async ({ kind }) => {
    assert.equal(kind, 'instructions');
    return { ok: true, value: settingsSource === undefined ? {} : { source: settingsSource } };
  },
  writeProjectMetadata: async ({ write }) => {
    assert.equal(write.kind, 'instructions');
    if (write.base !== settingsSource) {
      return { ok: false, error: { code: 'conflict', message: 'Project settings changed. Reload before saving.' } };
    }
    writes.push(write);
    settingsSource = write.source;
    return { ok: true, value: { source: settingsSource } };
  },
  onInstructionsChanged: (callback) => {
    changeListener = callback;
    return () => {
      changeListener = undefined;
    };
  },
};
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const panel = require(output);

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const click = async (element) => {
  assert.ok(element, 'the control exists');
  await act(async () => element.click());
  await settle();
};
const type = async (element, value) => {
  assert.ok(element, 'the field exists');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};
const submit = async (form) => {
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  await settle();
};
const section = (name) => document.querySelector(`section[aria-label="${name}"]`);
const labels = (name) => [...section(name).querySelectorAll('.instructions-row-label')].map((label) => label.textContent);
const byLabel = (label) => document.querySelector(`[aria-label="${label}"]`);
const formOf = (label) => document.querySelector(`form[aria-label="${label}"]`);
const menuItem = (text) => [...document.querySelectorAll('.more-menu-item')].find((item) => item.textContent.trim() === text);

let root;
async function mount(element) {
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
  await settle();
  await settle();
}
async function unmount() {
  await act(async () => root.unmount());
  for (const node of [...document.body.children]) {
    if (node.id !== 'root') {
      node.remove();
    }
  }
}
function reset(initial) {
  files = new Map(Object.entries(initial));
  settingsSource = undefined;
  writes.length = 0;
  created.length = 0;
  panel.selectInstruction(undefined);
  panel.setActualRole(panel.ADMIN_VIEW);
}

test('an empty project shows each section’s empty state', async () => {
  reset({});
  await mount(React.createElement(panel.InstructionsPanel, { projectPath: '/project' }));
  assert.match(section('Skills').textContent, /No skills yet\. Create your first skill to give AI the context it needs to do its best work\./);
  assert.match(section('Rules').textContent, /No rules yet\./);
  assert.match(section('Docs').textContent, /No other Markdown files/);
  await unmount();
});

test('skills show their frontmatter; rules and docs show as trees; a click opens the file', async () => {
  reset({
    '.claude/skills/write-tests/SKILL.md': '---\nname: write-tests\ndescription: Writes tests.\n---\n',
    '.claude/skills/broken/SKILL.md': '# none\n',
    'AGENTS.md': '# A\n',
    '.claude/rules/testing.md': '# T\n',
    'docs/guide.md': '# G\n',
  });
  await mount(React.createElement(panel.InstructionsPanel, { projectPath: '/project' }));
  assert.deepEqual(labels('Skills'), ['broken', 'write-tests']);
  const skillRow = [...section('Skills').querySelectorAll('.instructions-row')].find((row) => row.textContent.includes('write-tests'));
  assert.match(skillRow.getAttribute('title'), /^Writes tests\./, 'a skill’s description is its tooltip');
  assert.equal(skillRow.querySelector('.instructions-skill-description') ?? undefined, undefined, 'and never a second line in the sidebar');
  const broken = [...section('Skills').querySelectorAll('.instructions-row')].find((row) => row.textContent.includes('broken'));
  assert.match(broken.getAttribute('title'), /This skill has no frontmatter/, 'a broken skill says why in its tooltip');
  assert.deepEqual(labels('Rules'), ['.claude/rules', 'AGENTS.md'], 'a single-child folder chain is one row');
  await click(byLabel('Expand all'));
  assert.deepEqual(labels('Rules'), ['.claude/rules', 'testing.md', 'AGENTS.md']);
  assert.deepEqual(labels('Docs'), ['docs', 'guide.md']);
  await click(
    [...section('Rules').querySelectorAll('.instructions-row')].find((row) => row.querySelector('.instructions-row-label').textContent === 'AGENTS.md'),
  );
  assert.ok(section('Rules').querySelector('.instructions-row.active'), 'the open file is the selected row');
  assert.deepEqual(panel.selectedInstruction(), { projectPath: '/project', file: 'AGENTS.md' });
  await click(byLabel('Collapse all'));
  assert.equal(section('Rules').querySelector('.instructions-section-body') ?? undefined, undefined, 'collapse all closes the sections');
  await unmount();
});

test('creating a skill writes its scaffold and opens it', async () => {
  reset({});
  await mount(React.createElement(panel.InstructionsPanel, { projectPath: '/project' }));
  await click(byLabel('New skill'));
  const form = formOf('New skill');
  assert.ok(form, 'the form opens');
  await submit(form);
  assert.match(form.textContent, /Give the skill a name\./, 'an empty name is refused before main is asked');
  await type(byLabel('Skill name'), 'Write Tests');
  await submit(form);
  assert.match(formOf('New skill').textContent, /Say when an agent should use this skill\./);
  await type(byLabel('Skill description'), 'Writes tests: use when adding code.');
  assert.match(formOf('New skill').textContent, /Saved as \.claude\/skills\/write-tests\/SKILL\.md/);
  await submit(formOf('New skill'));
  assert.deepEqual(created, [
    {
      file: '.claude/skills/write-tests/SKILL.md',
      source: '---\nname: write-tests\ndescription: "Writes tests: use when adding code."\n---\n\n# Write Tests\n\n',
    },
  ]);
  assert.equal(panel.selectedInstruction()?.file, '.claude/skills/write-tests/SKILL.md');
  await settle();
  assert.deepEqual(labels('Skills'), ['write-tests']);
  await unmount();
});

test('creating a rule writes a heading file in the chosen folder; an existing one is refused', async () => {
  reset({ 'AGENTS.md': '# A\n' });
  await mount(React.createElement(panel.InstructionsPanel, { projectPath: '/project' }));
  await click(byLabel('New rule'));
  await type(byLabel('Rule name'), 'testing');
  await submit(formOf('New rule'));
  assert.deepEqual(created, [{ file: '.claude/rules/testing.md', source: '# testing\n\n' }]);
  await click(byLabel('New rule'));
  await type(byLabel('Rule name'), 'testing.md');
  await submit(formOf('New rule'));
  assert.match(formOf('New rule').textContent, /\.claude\/rules\/testing\.md already exists\./);
  await click([...formOf('New rule').querySelectorAll('button')].find((button) => button.textContent === 'Cancel'));
  assert.equal(formOf('New rule') ?? undefined, undefined, 'cancel closes the form');
  await unmount();
});

test('the row menu hides a file and a folder through the settings file', async () => {
  reset({ 'AGENTS.md': '# A\n', 'docs/a.md': '# a\n', 'docs/b.md': '# b\n' });
  await mount(React.createElement(panel.InstructionsPanel, { projectPath: '/project' }));
  await click(byLabel('Expand all'));
  await click(byLabel('a.md options'));
  await click(menuItem('Hide file'));
  assert.deepEqual(writes, [{ kind: 'instructions', source: '{\n  "version": 1,\n  "hidden": [\n    "docs/a.md"\n  ]\n}\n' }]);
  assert.deepEqual(labels('Docs'), ['docs', 'b.md'], 'the panel lists again after a hide');
  await click(byLabel('b.md options'));
  await click(menuItem('Hide folder'));
  assert.equal(writes[1].base, writes[0].source, 'the second write names the first as its base');
  assert.deepEqual(hiddenPaths(), ['docs/a.md', 'docs']);
  assert.deepEqual(labels('Docs'), []);
  // A change heard from main lists again.
  files.set('NOTES.md', '# n\n');
  await act(async () => changeListener({ files: ['NOTES.md'] }));
  await settle();
  assert.deepEqual(labels('Docs'), ['NOTES.md']);
  await unmount();
});

test('Settings → Instructions lists, adds, refuses and removes hidden paths', async () => {
  reset({});
  settingsSource = '{"version":1,"hidden":["docs/archive"]}';
  await mount(React.createElement(panel.InstructionsSettings, { projectPath: '/project' }));
  const rows = () => [...document.querySelectorAll('.instructions-hidden-row code')].map((code) => code.textContent);
  assert.deepEqual(rows(), ['docs/archive']);
  await type(byLabel('Path or pattern to hide'), '../outside');
  await submit(document.querySelector('.instructions-hidden-add'));
  assert.match(document.querySelector('[role="alert"]').textContent, /A hidden path stays inside the project\./);
  assert.equal(writes.length, 0, 'a refused path writes nothing');
  await type(byLabel('Path or pattern to hide'), '**/CHANGELOG.md');
  await submit(document.querySelector('.instructions-hidden-add'));
  assert.deepEqual(rows(), ['docs/archive', '**/CHANGELOG.md']);
  await type(byLabel('Path or pattern to hide'), 'docs/archive/');
  await submit(document.querySelector('.instructions-hidden-add'));
  assert.match(document.querySelector('[role="alert"]').textContent, /docs\/archive is already hidden\./);
  await click(byLabel('Show docs/archive again'));
  assert.deepEqual(rows(), ['**/CHANGELOG.md']);
  assert.deepEqual(hiddenPaths(), ['**/CHANGELOG.md']);
  assert.equal(writes.length, 2);
  await unmount();
});

test('without instructions:edit the files show but nothing creates or hides', async () => {
  reset({ 'AGENTS.md': '# A\n' });
  panel.setActualRole({ id: 'client', name: 'Client', isAdmin: false, features: new Set(['panel:instructions']), appPermissions: {}, pinnedApps: [] });
  await mount(React.createElement(panel.InstructionsPanel, { projectPath: '/project' }));
  assert.deepEqual(labels('Rules'), ['AGENTS.md']);
  assert.equal(byLabel('New skill') ?? undefined, undefined);
  assert.equal(byLabel('New rule') ?? undefined, undefined);
  await click(byLabel('AGENTS.md options'));
  assert.equal(menuItem('Hide file'), undefined);
  assert.ok(menuItem('Copy path'));
  await unmount();
});

test('the open file is a CMS entry: its frontmatter as CMS fields and its body as the CMS rich text field', async () => {
  reset({ '.claude/skills/a/SKILL.md': '---\nname: write-tests\ndescription: A long description that wraps over several lines in the block.\n---\n\n# A\n' });
  const saves = [];
  window.avb.readInstruction = async ({ file }) => ({ ok: true, value: { source: files.get(file) } });
  window.avb.writeInstruction = async ({ file, source, base }) => {
    assert.equal(base, files.get(file), 'a save names the text it was edited from');
    saves.push(source);
    files.set(file, source);
    return { ok: true, value: { source } };
  };
  await mount(
    React.createElement(panel.InstructionsDocument, { projectPath: '/project', file: '.claude/skills/a/SKILL.md', editable: true, onClose: () => {} }),
  );
  assert.equal(document.querySelector('.cms-detail-head .cms-detail-title').textContent, 'write-tests', 'the entry is titled by its name');
  assert.match(document.querySelector('.cms-detail-head').textContent, /\.claude\/skills\/a\/SKILL\.md/, 'the path shows beside it');
  const fields = [...document.querySelectorAll('.remote-cms-fields > .props-field')];
  const labelOf = (field) => field.querySelector('.prop-label')?.textContent.trim();
  assert.deepEqual(fields.map(labelOf), ['name', 'description', undefined], 'one CMS field per key, then the body with no label');
  const description = fields[1].querySelector('textarea');
  assert.ok(description, 'the description is a multiline box, so a long value wraps');
  assert.equal(description.value, 'A long description that wraps over several lines in the block.');
  assert.ok(fields[2].querySelector('.html-field'), 'the body is the CMS rich text field');
  await type(description, 'Shorter.');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 700)));
  await settle();
  assert.deepEqual(saves, ['---\nname: write-tests\ndescription: Shorter.\n---\n\n# A\n'], 'only the edited line changes');
  await unmount();
});
