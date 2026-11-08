// The Style panel's CSS Code box: a long line scrolls sideways, it never wraps.
//
//   node test/renderer/style/cssCodeScroll.test.js
//
// Goal: `background-color: var(--light-100);` and a long `transition` each stay
// on one line, in the editable rule and in the read-only preview, and the box
// around them keeps working: it scrolls both ways inside the panel's width, the
// caret stays visible while typing at the end of a long line, the dimmed
// selectors around a nested rule stay in step with the rule, and the sideways
// bar sits below the last line instead of over it. The clip-path code shares
// CodeEditor and must keep wrapping.
//
// Method: the real EditableCssRule, CssCodePreview and clip-path CodeEditor with
// the app's stylesheets, built and laid out in Electron, because jsdom has no
// layout and every fault here is one of layout. Each box sits in a 280px panel
// and is measured as drawn; typing is replayed as `input.type` transactions. What
// a page cannot measure, the scrollbar track's inset, is read from the stylesheet.
// Without Electron the layout half is skipped, as popoverDropdown.test.js does.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const PANEL_WIDTH_PX = 280;
// The app-wide `::-webkit-scrollbar` height (src/app/styles.css).
const SCROLLBAR_HEIGHT_PX = 8;

// ── The stylesheet ──────────────────────────────────────────────────────────
const embedCss = fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8');
assert.match(
  embedCss,
  /\.embed-editor_css-code-editor \.cm-scroller::-webkit-scrollbar-track:horizontal,\s*\.embed-editor_css-code-preview::-webkit-scrollbar-track:horizontal \{\s*(?:\/\*[^]*?\*\/\s*)?margin-inline: var\(--radius-xl\);/,
  'both sideways bars start past the rounded corners',
);
assert.doesNotMatch(
  embedCss,
  /\.embed-editor_css-code-(editor|preview)[^{]*\{[^}]*\bborder(-(top|right|bottom|left))?: [^0]/,
  'the box is a fill, never a border',
);

// ── Real layout ─────────────────────────────────────────────────────────────
const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail === undefined ? '' : `\n    ${detail}`}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/css-code-scroll');
  fs.mkdirSync(buildDirectory, { recursive: true });

  // The stylesheets in the order the app loads them: embedEditor.css comes in
  // through CodeVariables, and CssCodeEditor.css after it. Importing either here
  // would reorder them (esbuild keeps a sheet's last import), and the two set the
  // same properties at the same specificity.
  const entry = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { EditorView } from '@codemirror/view'
    import postcss from 'postcss'
    import './src/app/styles.css'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import { CodeEditor } from './src/features/style/components/CssCodeEditor'
    import { CssCodePreview, EditableCssRule } from './src/features/style/embed/QueryForms'

    const LONG = 'transition: background-color 200ms ease, color 200ms ease, transform 300ms cubic-bezier(0.2, 0, 0, 1);'
    const SHORT = 'background-color: var(--light-100);'
    const nested = (lines) => {
      const root = postcss.parse('@media (min-width: 900px) {\\n.card {\\n&:hover {\\n' + lines.join('\\n') + '\\n}\\n}\\n}')
      return { node: root.first.first.first, selectorText: '&:hover', ruleId: 'rule' }
    }
    const manyLines = Array.from({ length: 30 }, (_, index) => '--token-' + index + ': 1px;')
    const previewOf = (lines) => ({ code: lines.join('\\n'), highlights: [], selectorLists: [], selectors: [] })
    const Panel = ({ id, children }) => (
      <div id={id} className="embed-editor_root" style={{ width: ${PANEL_WIDTH_PX} }}>
        <section className="embed-editor_css-code is-open"><div className="embed-editor_css-code-body">{children}</div></section>
      </div>
    )
    const ignore = () => undefined
    createRoot(document.getElementById('root')).render(
      <>
        <Panel id="rule"><EditableCssRule rule={nested([SHORT, LONG, 'color: red;'])} busy={false} onSave={ignore} /></Panel>
        <Panel id="tall-rule"><EditableCssRule rule={nested([...manyLines, LONG])} busy={false} onSave={ignore} /></Panel>
        <Panel id="short-rule"><EditableCssRule rule={nested(['color: red;'])} busy={false} onSave={ignore} /></Panel>
        <Panel id="preview"><CssCodePreview view={previewOf([SHORT, LONG, 'color: red;'])} ariaLabel="Preview" /></Panel>
        <Panel id="tall-preview"><CssCodePreview view={previewOf([...manyLines, LONG])} ariaLabel="Tall preview" /></Panel>
        <Panel id="clip">
          <CodeEditor value={'polygon(' + '50% 0%, '.repeat(20) + '0% 50%)'} language="css" ariaLabel="Clip" className="clip-path_code" variables={{ kind: 'value', prop: 'clip-path' }} />
        </Panel>
      </>,
    )
    window.viewOf = (element) => EditorView.findFromDOM(element)
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'jsx' },
    outfile: path.join(buildDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl', '.woff2': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(buildDirectory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><div id="root"></div><script src="bundle.js"></script>',
  );

  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('css code scroll: stylesheet ok; layout skipped — no Electron to lay it out in');
    return;
  }

  const measurePath = path.join(buildDirectory, 'measure.js');
  fs.writeFileSync(measurePath, `(${measure.toString()})()`);
  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     const fs = require('node:fs');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 500, height: 900 });
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       await new Promise((resolve) => setTimeout(resolve, 300));
       const out = await win.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(measurePath)}, 'utf8'));
       console.log(JSON.stringify(out));
       app.quit();
     });`,
  );

  const { spawnSync } = require('node:child_process');
  // Electron run as plain Node has no BrowserWindow; the gate's shell may set it.
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 90000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (line === undefined) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 400));
  } else {
    assertLayout(JSON.parse(line));
  }
  if (failures.length > 0) {
    console.error(`css code scroll: ${failures.length} failure(s)\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('css code scroll: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function assertLayout(out) {
  for (const name of ['rule', 'preview']) {
    const box = out[name];
    check(`${name}: the lines are all there`, box.lineHeights.length >= 3, JSON.stringify(box.lineHeights));
    check(`${name}: every line is one row high`, new Set(box.lineHeights).size === 1, JSON.stringify(box.lineHeights));
    check(`${name}: the long line runs past the box`, box.scrollWidth > box.clientWidth, JSON.stringify(box));
    check(`${name}: and the box keeps the panel's width`, box.width === PANEL_WIDTH_PX, JSON.stringify(box));
    check(`${name}: the panel keeps its width too`, box.panelWidth === PANEL_WIDTH_PX, JSON.stringify(box));
    check(`${name}: the bar is the app's height`, box.height - box.clientHeight === SCROLLBAR_HEIGHT_PX, JSON.stringify(box));
    check(`${name}: nothing is hidden behind it`, box.scrollHeight === box.clientHeight, JSON.stringify(box));
    check(`${name}: the corners stay rounded`, box.radius === '16px', box.radius);
    check(`${name}: and clip what scrolls`, box.clipped, JSON.stringify(box));
  }
  for (const name of ['tall-rule', 'tall-preview']) {
    const box = out[name];
    check(`${name}: it scrolls down`, box.scrollTop > 0, JSON.stringify(box));
    check(`${name}: to a last line above the bar`, box.lastLineBottom <= box.viewportBottom, JSON.stringify(box));
  }
  check('the preview keeps its right padding at the end of the scroll', out['tall-preview'].textGapRight >= 11, JSON.stringify(out['tall-preview']));

  const rule = out.rule;
  check('the rule is framed by dimmed lines', rule.dimmedOpacities.length === 5, JSON.stringify(rule.dimmedOpacities));
  check(
    'they are dimmed',
    rule.dimmedOpacities.every((opacity) => opacity === '0.55'),
    JSON.stringify(rule.dimmedOpacities),
  );
  check('they start at the column the rule does', new Set(rule.lineLefts).size === 1, JSON.stringify(rule.lineLefts));
  const pitches = rule.lineTops.slice(1).map((top, index) => Math.round((top - rule.lineTops[index]) * 10));
  check('and sit at the same line pitch', new Set(pitches).size === 1, JSON.stringify(rule.lineTops));

  const caret = out.caret;
  check('typing scrolled the box', caret.scrollLeft > 0, JSON.stringify(caret));
  check('the caret stays right of the box’s left edge', caret.left >= caret.boxLeft, JSON.stringify(caret));
  check('and left of its right edge', caret.left <= caret.boxRight, JSON.stringify(caret));

  check('a rule that fits has no bar', out['short-rule'].height === out['short-rule'].clientHeight, JSON.stringify(out['short-rule']));
  check('the clip-path code still wraps', out.clip.wrapping, JSON.stringify(out.clip));
  check('so it never scrolls sideways', out.clip.scrollWidth === out.clip.clientWidth, JSON.stringify(out.clip));
}

// Runs in the page, so it can only use what it declares.
async function measure() {
  const wait = (timeMs) => new Promise((resolve) => setTimeout(resolve, timeMs));
  const textRect = (line) => {
    const range = document.createRange();
    range.selectNodeContents(line);
    return range.getBoundingClientRect();
  };
  const boxOf = (id) => {
    const panel = document.getElementById(id);
    const scroller = panel.querySelector('.cm-scroller, .embed-editor_css-code-preview');
    const rounded = panel.querySelector('.cm-editor, .embed-editor_css-code-preview');
    const lines = [...panel.querySelectorAll('.cm-line, .embed-editor_css-code-line')];
    return { panel, scroller, rounded, lines };
  };
  const sizes = (id) => {
    const { panel, scroller, rounded, lines } = boxOf(id);
    return {
      panelWidth: panel.offsetWidth,
      width: rounded.offsetWidth,
      height: scroller.offsetHeight,
      clientHeight: scroller.clientHeight,
      clientWidth: scroller.clientWidth,
      scrollHeight: scroller.scrollHeight,
      scrollWidth: scroller.scrollWidth,
      radius: getComputedStyle(rounded).borderTopLeftRadius,
      clipped: getComputedStyle(rounded).overflowX !== 'visible',
      lineHeights: lines.map((line) => Math.round(line.getBoundingClientRect().height)),
      lineLefts: lines.map((line) => line.getBoundingClientRect().left),
      lineTops: lines.map((line) => line.getBoundingClientRect().top),
      dimmedOpacities: [...panel.querySelectorAll('.code-editor_context')].map((mark) => getComputedStyle(mark).opacity),
      wrapping: panel.querySelector('.cm-lineWrapping') !== null,
    };
  };
  const scrolledToEnd = async (id) => {
    const { scroller } = boxOf(id);
    // Until it rests, bounded: CodeMirror draws only the lines in view, so the end
    // moves as it draws them.
    for (let pass = 0; pass < 10; pass += 1) {
      const scrollTopBefore = scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight;
      scroller.scrollLeft = scroller.scrollWidth;
      await wait(100);
      if (pass > 0 && scroller.scrollTop === scrollTopBefore) {
        break;
      }
    }
    const lines = boxOf(id).lines;
    const last = lines[lines.length - 1];
    const bounds = scroller.getBoundingClientRect();
    const viewportRight = bounds.left + scroller.clientWidth;
    return {
      scrollTop: scroller.scrollTop,
      lastLineBottom: last.getBoundingClientRect().bottom,
      viewportBottom: bounds.top + scroller.clientHeight,
      textGapRight: viewportRight - textRect(last).right,
    };
  };
  const caretWhileTyping = async () => {
    const view = window.viewOf(document.querySelector('#rule .cm-editor'));
    const longLine = Array.from({ length: view.state.doc.lines }, (_, index) => view.state.doc.line(index + 1)).sort(
      (left, right) => right.length - left.length,
    )[0];
    view.dispatch({ selection: { anchor: longLine.to }, scrollIntoView: true });
    for (let typed = 0; typed < 30; typed += 1) {
      const head = view.state.selection.main.head;
      view.dispatch({ changes: { from: head, insert: 'x' }, selection: { anchor: head + 1 }, scrollIntoView: true, userEvent: 'input.type' });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await wait(100);
    const coordinates = view.coordsAtPos(view.state.selection.main.head);
    const bounds = view.scrollDOM.getBoundingClientRect();
    return { left: coordinates.left, boxLeft: bounds.left, boxRight: bounds.left + view.scrollDOM.clientWidth, scrollLeft: view.scrollDOM.scrollLeft };
  };

  const out = {};
  for (const id of ['rule', 'short-rule', 'preview', 'clip']) {
    out[id] = sizes(id);
  }
  out['tall-rule'] = await scrolledToEnd('tall-rule');
  out['tall-preview'] = await scrolledToEnd('tall-preview');
  out.caret = await caretWhileTyping();
  return out;
}
