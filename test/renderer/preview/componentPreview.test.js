// Goal: drilling into a component and saving keep the real preview iframe and
// inspector mounted, and never let a stale read replace the edited model.
// Method: render the real App in jsdom over a bridge whose disk replies are
// held on deferreds; saves record their payload and answer like main does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { createHash } = require('node:crypto');
// Disk replies carry the SHA-256 of the bytes, as main's do.
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { NODE_PROJECTOR } = require('#dist/electron/documents/documentDisk.js');
const { buildEditIntent } = require('#dist/electron/documents/editRequests.js');
const { toIntent } = require('#dist/shared/engine/intent.js');
const { planIntent } = require('#dist/shared/engine/planner.js');
const { applySplices, inverseEdits } = require('#dist/shared/engine/splice.js');
const { repoPath, stubPanels } = require('../../helpers/sources.js');

// A visual edit request as main's handler applies it (step 9: every edit of an
// .astro file is splices): main's translation and planner, on the text held.
function applyEditRequest(file, text, edit) {
  const snapshot = NODE_PROJECTOR.snapshot(file, Buffer.from(text));
  const draft = buildEditIntent(edit, snapshot);
  assert.ok(draft.ok, `the edit is built (${draft.ok ? '' : draft.error})`);
  const intent = toIntent({ id: 't', file, authoredChecksum: snapshot.checksum, ...draft.value });
  const planned = planIntent({ authored: snapshot, current: snapshot }, intent);
  assert.ok(planned.ok, `the edit plans (${planned.ok ? '' : planned.error})`);
  const written = Buffer.from(applySplices(snapshot.bytes, planned.value.splices)).toString('utf8');
  return { text: written, inverse: inverseEdits(planned.value.splices) };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test(
  'component navigation keeps the real iframe ' + 'and inspector mounted while loading and saving',
  async () => {
    const buildDirectory = repoPath('node_modules/.stacki-test/component-preview');
    fs.mkdirSync(buildDirectory, { recursive: true });
    await esbuild.build({
      entryPoints: [repoPath('src/app/App.tsx')],
      outfile: path.join(buildDirectory, 'app.js'),
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
      logLevel: 'silent',
      plugins: [
        stubPanels('capture-inspectors', (name) => {
          // Keep both preview components real: a mocked pane cannot reveal frame
          // replacement, navigation, or an inspector vanishing beside the frame.
          if (
            [
              'PreviewPane',
              'CanvasView',
              'DevOffline',
              'PreviewOverlays',
              'PreviewToolbar',
              'PreviewSizeControls',
            ].includes(name)
          ) {
            return;
          }
          return {
            contents:
              `export const relativeTime = () => ''; export default function Panel(props) { ` +
              `globalThis.__componentPanels[${JSON.stringify(name)}] = props; return null; }`,
            loader: 'jsx',
          };
        }),
      ],
    });
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    });
    global.window = dom.window;
    for (const name of [
      'document',
      'navigator',
      'HTMLElement',
      'Element',
      'Node',
      'MutationObserver',
    ]) {
      global[name] = dom.window[name];
    }
    global.getComputedStyle = dom.window.getComputedStyle;
    global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    global.cancelAnimationFrame = clearTimeout;
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    dom.window.ResizeObserver = global.ResizeObserver;
    dom.window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    });
    global.__componentPanels = {};
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const page = { name: 'index.astro', path: '/project/src/pages/index.astro', route: '/' };
    const card = { name: 'Card', path: '/project/src/components/Card.astro', folder: '' };
    const pageSource =
      "---\nimport Card from '../components/Card.astro';\n---\n<main><Card /></main>";
    const cardSource = '<section class="card"><p>Card content</p></section>';
    const pageRead = (source) => ({
      ...parsePage(source, { locs: true }),
      source,
      checksum: sha256(source),
    });
    const states = new Map([
      [page.path, pageRead(pageSource)],
      [card.path, pageRead(cardSource)],
    ]);
    const heldReads = new Map();
    const previewChecks = [];
    const writes = [];
    let writeError;
    const bridge = new Proxy(
      {
        pendingProject: async () => undefined,
        scanProject: async () => ({
          pages: [page],
          components: [card],
          layouts: [],
          pageFolders: [],
        }),
        startDevServer: async () => ({ url: 'http://localhost:4321' }),
        listProjectClasses: async () => [],
        resolveImport: async () => ({ path: card.path }),
        readPage: async (file) => heldReads.get(file)?.promise ?? structuredClone(states.get(file)),
        editPage: async ({ pagePath, authoredChecksum, edit }) => {
          if (writeError) {
            throw writeError;
          }
          const held = states.get(pagePath);
          assert.equal(authoredChecksum, held.checksum, 'an edit names the bytes it is stated on');
          const applied = applyEditRequest(pagePath, held.source, edit);
          const written = pageRead(applied.text);
          writes.push({ pagePath, model: written.model });
          states.set(pagePath, written);
          return { ok: true, ...structuredClone(written), inverse: applied.inverse };
        },
        gitInfo: async () => ({ isRepo: false }),
        publishAvailability: async () => ({ github: 'unknown', hosting: 'unconfigured' }),
        // Main's disk check of a canvas rendering (step 7): the files are the ones
        // this fake holds, so every stamped file is current.
        checkPreview: async ({ render }) => {
          previewChecks.push(render);
          return { tag: 'current' };
        },
        onCssChanged: () => () => {},
      },
      {
        get: (target, name) =>
          name in target
            ? target[name]
            : String(name).startsWith('on')
              ? () => () => {}
              : async () => undefined,
      },
    );
    window.avb = bridge;
    global.avb = bridge;
    const React = require('react');
    const { act } = React;
    const { createRoot } = require('react-dom/client');
    const App = require(path.join(buildDirectory, 'app.js')).default;
    const root = createRoot(document.getElementById('root'));
    const hold = (file) => {
      const request = deferred();
      heldReads.set(file, request);
      return request;
    };
    const resolve = async (file, request) =>
      act(async () => {
        heldReads.delete(file);
        request.resolve(structuredClone(states.get(file)));
        await settle();
      });
    try {
      await act(async () => {
        root.render(React.createElement(App));
        await settle();
      });
      await act(async () => {
        await __componentPanels.WelcomeScreen.onOpen('/project');
        await settle();
      });
      const frame = document.querySelector('.frame-clip iframe');
      const frameWindow = frame.contentWindow;
      const source = frame.src;
      const inspector = document.querySelector('.panel.right');
      assert.ok(frame && inspector);
      const outgoing = [];
      frameWindow.postMessage = (message) => outgoing.push(message);
      const unchanged = () => {
        assert.equal(
          document.querySelector('.frame-clip iframe'),
          frame,
          'the loaded iframe is retained',
        );
        assert.equal(frame.contentWindow, frameWindow, 'the document window stays alive');
        assert.equal(frame.src, source, 'component edits keep the same preview page URL');
        assert.equal(
          document.querySelector('.panel.right'),
          inspector,
          'the inspector stays mounted so the page cannot expand and reflow',
        );
      };
      // The frame announces the rendering it shows — stamped with the page's
      // bytes as they are now — and the double-click carries its token (step 7).
      const announce = async () => {
        const checksum = states.get(page.path).checksum;
        const canonical = `${checksum} src/pages/index.astro\n`;
        const token = sha256(canonical);
        const stamps = [{ file: 'src/pages/index.astro', checksum }];
        await act(async () => {
          const data = { type: 'avb:render', token, stamps };
          window.dispatchEvent(
            new dom.window.MessageEvent('message', { source: frameWindow, data }),
          );
          await settle();
        });
        return token;
      };
      const dblclick = async (token) =>
        act(async () => {
          const data = { type: 'avb:open-node', path: '0.0', occurrence: 0, token };
          window.dispatchEvent(
            new dom.window.MessageEvent('message', { source: frameWindow, data }),
          );
          await settle();
        });
      const openCard = async () => dblclick(await announce());
      const back = async () =>
        act(async () => {
          document.querySelector('button.comp-back').click();
          await settle();
        });
      const editTitle = async (value) =>
        act(async () => {
          __componentPanels.PropsPanel.onSetProp('title', { type: 'string', value });
          await settle();
        });

      const entering = hold(card.path);
      // No rendering announced yet: the double-click opens nothing, and main is
      // never asked.
      await dblclick(undefined);
      const backButton = document.querySelector('button.comp-back');
      assert.ok(backButton === null, 'a tokenless event opens nothing');
      assert.equal(previewChecks.length, 0);
      await openCard();
      assert.equal(previewChecks.length, 1, 'main checked the rendering before the card opened');
      unchanged();
      assert.equal(
        __componentPanels.PropsPanel.filePath,
        page.path,
        'the old file remains paired with its own model while reading',
      );
      await editTitle('page edit during read');
      await resolve(card.path, entering);
      unchanged();
      assert.equal(__componentPanels.PropsPanel.filePath, card.path);
      assert.equal(writes.at(-1).pagePath, page.path);
      assert.equal(writes.at(-1).model.nodes[0].props.title.value, 'page edit during read');
      assert.ok(
        outgoing.some(
          (message) =>
            message.type === 'avb:track' && message.scope === 'src/components/Card.astro|',
        ),
      );

      const reopening = hold(card.path);
      await act(async () => {
        void __componentPanels.StructurePanel.onOpenComponent('Card');
        await settle();
      });
      unchanged();
      await editTitle('same file edit during read');
      await resolve(card.path, reopening);
      unchanged();
      assert.equal(__componentPanels.PropsPanel.filePath, card.path);
      assert.equal(
        __componentPanels.PropsPanel.node.props.title.value,
        'same file edit during read',
        'reopening a file preserves edits newer than its read snapshot',
      );
      assert.equal(writes.at(-1).pagePath, card.path);
      assert.equal(writes.at(-1).model.nodes[0].props.title.value, 'same file edit during read');

      const exiting = hold(page.path);
      await back();
      unchanged();
      assert.equal(__componentPanels.PropsPanel.filePath, card.path);
      await editTitle('card edit during return');
      await resolve(page.path, exiting);
      unchanged();
      assert.equal(__componentPanels.PropsPanel.filePath, page.path);
      assert.equal(writes.at(-1).pagePath, card.path);
      assert.equal(writes.at(-1).model.nodes[0].props.title.value, 'card edit during return');
      assert.equal(outgoing.filter((message) => message.type === 'avb:track').at(-1).scope, '');
      assert.equal(
        __componentPanels.PropsPanel.node.name,
        'Card',
        'closing a component selects the instance that opened it',
      );

      const failedRead = hold(card.path);
      await openCard();
      unchanged();
      await act(async () => {
        heldReads.delete(card.path);
        failedRead.reject(new Error('unreadable component'));
        await settle();
      });
      unchanged();
      assert.equal(
        __componentPanels.PropsPanel.filePath,
        page.path,
        'a read failure preserves the current editor',
      );
      assert.match(document.querySelector('.toast.error').textContent, /unreadable component/);

      const failedSave = hold(card.path);
      await openCard();
      await editTitle('must remain unsaved');
      writeError = new Error('disk full during navigation');
      await resolve(card.path, failedSave);
      unchanged();
      assert.equal(
        __componentPanels.PropsPanel.filePath,
        page.path,
        'a failed final save cancels navigation',
      );
      assert.equal(__componentPanels.PropsPanel.node.props.title.value, 'must remain unsaved');
      assert.match(
        document.querySelector('.toast.error').textContent,
        /disk full during navigation/,
      );
      writeError = undefined;

      const wrappedMarkup = [
        {
          label: 'conditional after script and style siblings',
          source:
            `---\nconst render = true;\n---\n<script>console.log('ready');</script>\n` +
            `<style>.target { color: red; }</style>\n` +
            `{render && (<section class="target"><p>Content</p></section>)}`,
          selectionPath: '2.0.0',
          name: 'section',
        },
        {
          label: 'nested shorthand and named fragments',
          source:
            `---\nconst render = true;\n---\n{render && (<><style>.target { color: red; }</style>` +
            `<Fragment><script>console.log('ready');</script><section class="target"><p>` +
            `Content</p></section></Fragment></>)}`,
          selectionPath: '0.0.0.1.1',
          name: 'section',
        },
        {
          label: 'loop within a conditional branch and fragment',
          source:
            `---\nconst render = true;\nconst items = [1];\n---\n` +
            `{render ? (<>{items.map((item) => (<section class="target">{item}</section>))}</>) ` +
            `: (<aside>Empty</aside>)}`,
          selectionPath: '0.0.0.0.0',
          name: 'section',
        },
        {
          label: 'a real component before its slotted children',
          source:
            `---\nimport Panel from './Panel.astro';\nconst render = true;\n---\n` +
            `{render && (<Panel><section class="target">Slotted content</section></Panel>)}`,
          selectionPath: '0.0.0',
          name: 'Panel',
        },
        {
          label: 'layout body retains priority over html and head',
          source:
            '<html><head><title>Document</title></head><body><main>Content</main></body></html>',
          selectionPath: '0.1',
          name: 'body',
        },
      ];
      for (const fixture of wrappedMarkup) {
        const parsed = pageRead(fixture.source);
        assert.equal(parsed.editable, true, `${fixture.label}: fixture remains tree editable`);
        states.set(card.path, parsed);
        await openCard();
        unchanged();
        const selected = __componentPanels.PropsPanel.node;
        assert.equal(selected.name, fixture.name, `${fixture.label}: selects the rendered target`);
        assert.equal(
          __componentPanels.StructurePanel.selectedId,
          selected.id,
          `${fixture.label}: navigator and inspector agree`,
        );
        const track = outgoing.filter((message) => message.type === 'avb:track').at(-1);
        assert.equal(
          track.scope,
          'src/components/Card.astro|',
          `${fixture.label}: selection stays scoped to the component`,
        );
        assert.equal(
          track.paths[0],
          `src/components/Card.astro|${fixture.selectionPath}`,
          `${fixture.label}: the actual child path is highlighted`,
        );
        assert.equal(
          track.focus,
          '0.0',
          `${fixture.label}: the original page instance retains focus`,
        );
        await back();
        unchanged();
        assert.equal(
          __componentPanels.PropsPanel.node.name,
          'Card',
          `${fixture.label}: closing selects the component instance`,
        );
      }
      for (const fixture of [
        { source: '---\nconst render = true;\n---\n{render && (<>Text only</>)}', kind: 'cond' },
        { source: '', kind: undefined },
      ]) {
        states.set(card.path, pageRead(fixture.source));
        await openCard();
        unchanged();
        const selected = __componentPanels.PropsPanel.node;
        assert.equal(
          selected?.kind,
          fixture.kind,
          'a component without a rendered target retains the first-node or empty fallback',
        );
        assert.equal(__componentPanels.StructurePanel.selectedId, selected?.id);
        const track = outgoing.filter((message) => message.type === 'avb:track').at(-1);
        assert.equal(track.scope, 'src/components/Card.astro|');
        assert.deepEqual(
          track.paths,
          fixture.kind ? ['src/components/Card.astro|0', '0.0'] : ['0.0'],
        );
        await back();
        unchanged();
        assert.equal(__componentPanels.PropsPanel.node.name, 'Card');
      }
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  },
);
