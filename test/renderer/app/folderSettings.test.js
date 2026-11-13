// Goal: Settings → Folders shows each panel's defaults when nothing is set,
// adds a folder picked in the system dialog, removes one, resets a panel to
// its defaults, refuses a duplicate, covered or outside folder with a message
// and without writing, and saves each change through the project metadata
// bridge against the bytes it read, so the file it leaves reads back. Pages
// show the folder astro.config's srcDir gives, and the CMS section hides
// collections and chooses data files the same way.
// Method: bundle the real FolderSettings component with esbuild, mount it in
// jsdom over a fake bridge that keeps `.stacki/folders.json` in memory and
// answers the folder dialog from a queue, then click through the tab.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/folder-settings.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const bundled = esbuild.build({
  entryPoints: [repoPath('src/app/settings/FolderSettings.tsx')],
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
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;

// The project's folder settings file, as the metadata bridge stores it.
let stored;
const writes = [];
const picks = [];
let lastPickTarget;
const opened = [];
window.avb = {
  projectMetadata: async (input) => {
    assert.equal(input.kind, 'folders');
    return { ok: true, value: stored === undefined ? {} : { source: stored } };
  },
  writeProjectMetadata: async (input) => {
    assert.equal(input.write.kind, 'folders');
    if (input.write.base !== stored) {
      return { ok: false, error: { code: 'conflict', message: 'Project settings changed. Reload before saving.' } };
    }
    writes.push(input.write);
    stored = input.write.source;
    return { ok: true, value: { source: stored } };
  },
  // The CMS sources the tab shows: the content config's collections and the data files detected.
  contentCollections: async () => ({
    collections: [
      { name: 'blog', editable: true, count: 2 },
      { name: 'team', editable: true, count: 3 },
    ],
    covered: { files: [], dirs: [] },
    configPath: 'src/content.config.ts',
  }),
  listCms: async () => ({
    files: [
      { rel: 'consts.ts#*general', name: 'consts.ts', dir: '' },
      { rel: 'consts.ts#LINKS', name: 'consts.ts', dir: '' },
      { rel: 'data/team.json', name: 'team.json', dir: 'data' },
      // Astro frontmatter data (components, pages): always a source, never shown as a data file.
      { rel: 'components/Button.astro#items', name: 'Button.astro', dir: 'components' },
      { rel: 'pages/example-components.astro#items', name: 'example-components.astro', dir: 'pages' },
      { rel: 'components/form/Input.astro#options', name: 'Input.astro', dir: 'components/form' },
    ],
  }),
  pickProjectFolder: async (input) => {
    assert.equal(input.projectPath, '/project');
    lastPickTarget = input.target;
    const next = picks.shift();
    assert.ok(next, 'a pick was queued');
    return next;
  },
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
let component;
test.before(async () => {
  await bundled;
  component = require(output);
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const row = (label) => document.querySelector(`[aria-label="${label} folders"]`) ?? document.querySelector(`[aria-label="${label}"]`);
const chips = (label) => [...row(label).querySelectorAll('.app-folder-chip')].map((chip) => chip.textContent.trim());
const button = (label, text) => [...row(label).querySelectorAll('button')].find((item) => item.textContent.trim() === text);
// A row's title: plain at its defaults, the blue set label once changed, whose menu resets it.
const title = (label) => row(label).querySelector('.app-folder-title .prop-label');
const changed = (label) => title(label).classList.contains('set');
async function reset(label) {
  await click(title(label));
  const item = [...document.querySelectorAll('.prop-menu-item')].find((entry) => entry.textContent.trim() === 'Reset');
  await click(item);
}
const alert = () => [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent.trim()).join(' ');
const click = async (element) => {
  assert.ok(element, 'the control exists');
  await act(async () => element.click());
  await settle();
};

let root;
async function mount(extra = {}) {
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(component.FolderSettings, { projectPath: '/project', onOpenFile: (rel) => opened.push(rel), ...extra })),
  );
  await settle();
}

test('defaults show, and add, remove, reset and refusals all go through the file', async () => {
  stored = undefined;
  await mount();
  assert.deepEqual(chips('Components'), ['src/components']);
  assert.deepEqual(chips('Layouts'), ['src/layouts']);
  assert.deepEqual(chips('Assets'), ['public', 'src']);
  assert.deepEqual(chips('Styles'), ['src', 'public', 'styles']);
  assert.deepEqual(chips('Variables'), ['src', 'public', 'styles'], 'variables have folders of their own, with the same defaults');
  assert.deepEqual(chips('Pages'), ['src/pages'], 'pages are shown, fixed');
  assert.ok(row('Pages').querySelector('button') === null, 'and offer nothing to change');
  assert.equal(changed('Components'), false, 'a row at its defaults has a plain title');
  assert.ok(title('Components').getAttribute('role') === null, 'and nothing to reset');
  assert.equal(button('Components', 'Reset to default'), undefined, 'reset lives in the title, not a button');
  assert.doesNotMatch(row('Components').textContent, /Default/, 'no tag at the defaults');
  assert.equal(writes.length, 0, 'opening the tab writes nothing');

  picks.push({ kind: 'picked', path: 'src/ui' });
  await click(button('Components', 'Add folder'));
  assert.deepEqual(chips('Components'), ['src/components', 'src/ui']);
  assert.deepEqual(JSON.parse(stored), { version: 1, folders: { components: ['src/components', 'src/ui'] } });
  assert.equal(writes[0].base, undefined, 'the first save creates the file');
  assert.equal(changed('Components'), true, 'a changed row turns its title into the blue label');

  picks.push({ kind: 'picked', path: 'src/ui' });
  await click(button('Components', 'Add folder'));
  assert.match(alert(), /src\/ui is already in the list/);
  picks.push({ kind: 'picked', path: 'src/ui/cards' });
  await click(button('Components', 'Add folder'));
  assert.match(alert(), /already covered by src\/ui/);
  picks.push({ kind: 'outside', message: 'That is outside the project.' });
  await click(button('Assets', 'Add folder'));
  assert.match(alert(), /That is outside the project/);
  picks.push({ kind: 'picked', path: 'lib/images' });
  await click(button('Assets', 'Add folder'));
  assert.match(alert(), /lib\/images is outside public\/ and src\//);
  picks.push({ kind: 'canceled' });
  await click(button('Assets', 'Add folder'));
  assert.equal(alert(), '', 'a cancel clears the message and changes nothing');
  assert.equal(writes.length, 1, 'no refused choice was written');

  await click(row('Components').querySelector('[aria-label="Remove src/components from Components"]'));
  assert.deepEqual(chips('Components'), ['src/ui']);
  assert.equal(writes[1].base, writes[0].source, 'each save is checked against the bytes it read');

  await reset('Components');
  assert.deepEqual(chips('Components'), ['src/components']);
  assert.equal(changed('Components'), false);
  assert.deepEqual(JSON.parse(stored), { version: 1, folders: {} });

  await act(async () => root.unmount());
  // Persisted: a fresh mount reads what was saved.
  stored = JSON.stringify({ version: 1, folders: { layouts: ['src/shells'] } });
  await mount();
  assert.deepEqual(chips('Layouts'), ['src/shells']);
  await act(async () => root.unmount());
});

test('the screen carries no intro sentence, and typing the defaults back unchanges a row', async () => {
  stored = undefined;
  await mount();
  const text = document.body.textContent;
  assert.doesNotMatch(text, /saved in \.stacki\/folders\.json/, 'the intro sentence is gone: no prose under the title');
  assert.doesNotMatch(text, /have not changed uses its defaults/, 'the defaults sentence is gone');
  assert.doesNotMatch(text, /Changes save as you make them/, 'and so is the autosave sentence');

  picks.push({ kind: 'picked', path: 'src/ui' });
  await click(button('Components', 'Add folder'));
  assert.equal(changed('Components'), true);
  assert.equal(changed('Layouts'), false, 'only the edited group turns blue');
  await click(row('Components').querySelector('[aria-label="Remove src/components from Components"]'));
  picks.push({ kind: 'picked', path: 'src/components' });
  await click(button('Components', 'Add folder'));
  await click(row('Components').querySelector('[aria-label="Remove src/ui from Components"]'));
  assert.deepEqual(chips('Components'), ['src/components']);
  assert.equal(changed('Components'), false, 'the default list added back is unchanged again');
  assert.ok(title('Components').getAttribute('role') === null, 'and offers no reset');
  await act(async () => root.unmount());
});

test('the CMS connections tab carries no intro paragraph', () => {
  // The component needs a live bridge to render, so the pin reads its source: the intro was removed, not moved.
  const source = fs.readFileSync(repoPath('src/features/cmsConnections/CmsConnections.tsx'), 'utf8');
  assert.doesNotMatch(source, /Connect the CMS this site/);
  assert.doesNotMatch(source, /cms-connections-intro/);
});

test('an unreadable file is reported, the defaults show, and a stale save is refused', async () => {
  stored = '{"version":1,"folders":{"assets":["../outside"]}}';
  await mount();
  assert.match(alert(), /could not be read .*cannot step out/);
  assert.deepEqual(chips('Assets'), ['public', 'src']);
  // Another session changes the file after this tab read it.
  stored = JSON.stringify({ version: 1, folders: {} });
  picks.push({ kind: 'picked', path: 'src/ui' });
  await click(button('Components', 'Add folder'));
  assert.match(alert(), /Project settings changed. Reload before saving./);
  assert.equal(stored, JSON.stringify({ version: 1, folders: {} }), 'the newer file is not overwritten');
  await act(async () => root.unmount());
});

test('a host from before folder settings shows the defaults read-only, and other failures show their message', async () => {
  const projectMetadata = window.avb.projectMetadata;
  try {
    // Electron's own wording around the older main process's refusal.
    window.avb.projectMetadata = async () => {
      throw new Error("Error invoking remote method 'project:metadata': Error: Unknown project metadata file");
    };
    await mount();
    assert.match(document.querySelector('[role="status"]').textContent, /Restart Stacki to edit folders/);
    assert.deepEqual(chips('Components'), ['src/components']);
    assert.deepEqual(chips('Assets'), ['public', 'src']);
    assert.equal(document.querySelectorAll('.app-folders button').length, 0, 'nothing can be changed');
    await act(async () => root.unmount());

    // Studio passes its own note for a server that predates folder settings.
    root = createRoot(document.getElementById('root'));
    await act(async () =>
      root.render(React.createElement(component.FolderSettings, { projectPath: '/project', unsupportedNote: 'Update Studio to edit folders.' })),
    );
    await settle();
    assert.match(document.querySelector('[role="status"]').textContent, /Update Studio to edit folders/);
    await act(async () => root.unmount());

    window.avb.projectMetadata = async () => {
      throw new Error('Permission denied');
    };
    await mount();
    assert.match(alert(), /Permission denied/, 'any other failure is a failure');
    await act(async () => root.unmount());
  } finally {
    window.avb.projectMetadata = projectMetadata;
  }
});

test('a file from a newer Stacki keeps what this one does not know', async () => {
  stored = JSON.stringify({ version: 1, theme: 'dark', folders: { widgets: ['src/widgets'], components: ['src/ui'] } });
  await mount();
  assert.deepEqual(chips('Components'), ['src/ui']);
  picks.push({ kind: 'picked', path: 'src/shells' });
  await click(button('Layouts', 'Add folder'));
  assert.deepEqual(JSON.parse(stored), {
    version: 1,
    theme: 'dark',
    folders: { components: ['src/ui'], layouts: ['src/layouts', 'src/shells'], widgets: ['src/widgets'] },
  });
  await act(async () => root.unmount());
});

test('pages follow srcDir with a link to astro.config, and the content config opens from the CMS section', async () => {
  stored = undefined;
  opened.length = 0;
  await mount({ pages: { folder: 'app/pages', configFile: 'astro.config.mjs' } });
  assert.deepEqual(chips('Pages'), ['app/pages']);
  assert.match(row('Pages').textContent, /Follows srcDir in astro.config/);
  await click(button('Pages', 'Open astro.config'));
  await click(button('CMS collections', 'Open content config'));
  assert.deepEqual(opened, ['astro.config.mjs', 'src/content.config.ts']);
  await act(async () => root.unmount());
  await mount();
  assert.deepEqual(chips('Pages'), ['src/pages'], 'without a scan answer, Astro’s default');
  await act(async () => root.unmount());
});

test('CMS collections can be hidden and shown, and data files added, removed and reset to detection', async () => {
  stored = undefined;
  writes.length = 0;
  await mount();
  const toggle = (name) => row('CMS collections').querySelector(`[aria-label="Show ${name} in the CMS panel"]`);
  assert.equal(toggle('team').getAttribute('aria-checked'), 'true', 'every collection shows by default');
  assert.deepEqual(chips('CMS data files'), ['src/consts.ts', 'src/data/team.json'], 'the detected files, once each');
  assert.doesNotMatch(row('CMS data files').textContent, /Automatic/, 'no tag while detection is automatic');
  assert.equal(changed('CMS data files'), false);

  await click(toggle('team'));
  assert.deepEqual(JSON.parse(stored), { version: 1, folders: {}, cms: { hiddenCollections: ['team'] } });
  assert.equal(toggle('team').getAttribute('aria-checked'), 'false');

  picks.push({ kind: 'picked', path: 'src/lib/settings.ts' });
  await click(button('CMS data files', 'Add file'));
  assert.equal(lastPickTarget, 'file', 'the picker asks for a file');
  assert.deepEqual(chips('CMS data files'), ['src/consts.ts', 'src/data/team.json', 'src/lib/settings.ts']);
  picks.push({ kind: 'picked', path: 'src/pages/about.astro' });
  await click(button('CMS data files', 'Add file'));
  assert.match(alert(), /about.astro is an Astro file: the CMS includes the open one automatically/);
  picks.push({ kind: 'picked', path: 'src/assets/logo.png' });
  await click(button('CMS data files', 'Add file'));
  assert.match(alert(), /logo.png is not a file the CMS can edit/);

  await click(row('CMS data files').querySelector('[aria-label="Remove src/consts.ts from CMS data files"]'));
  assert.deepEqual(JSON.parse(stored).cms, { files: ['src/data/team.json', 'src/lib/settings.ts'], hiddenCollections: ['team'] });

  assert.equal(changed('CMS data files'), true);
  await reset('CMS data files');
  assert.equal(changed('CMS data files'), false);
  assert.deepEqual(JSON.parse(stored).cms, { hiddenCollections: ['team'] }, 'reset returns to detection and keeps the hidden collection');
  await click(toggle('team'));
  assert.deepEqual(JSON.parse(stored), { version: 1, folders: {} }, 'showing it again leaves no cms key');
  await act(async () => root.unmount());
});

test('Styles and Variables are separate rows, and a file from before the split shows both changed', async () => {
  writes.length = 0;
  stored = JSON.stringify({ version: 1, folders: { styles: ['src/css'] } });
  await mount();
  assert.deepEqual(chips('Styles'), ['src/css']);
  assert.deepEqual(chips('Variables'), ['src/css'], 'the old styles key chose the variables folders too');
  assert.equal(changed('Styles'), true);
  assert.equal(changed('Variables'), true);

  await reset('Variables');
  assert.deepEqual(chips('Variables'), ['src', 'public', 'styles']);
  assert.deepEqual(chips('Styles'), ['src/css'], 'resetting variables leaves styles alone');
  assert.equal(changed('Variables'), false);
  // Written out at the defaults: without the key, the styles choice would choose variables again.
  assert.deepEqual(JSON.parse(stored), { version: 1, folders: { styles: ['src/css'], variables: ['src', 'public', 'styles'] } });

  await click(row('Variables').querySelector('[aria-label="Remove public from Variables"]'));
  assert.deepEqual(chips('Variables'), ['src', 'styles']);
  assert.equal(changed('Variables'), true);
  assert.deepEqual(chips('Styles'), ['src/css'], 'each row writes its own key');
  await act(async () => root.unmount());
});
