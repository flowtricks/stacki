// Goal: the AI panel's message scroller never scrolls sideways, at any panel width. A markdown table wider than
// the column, a code line with no spaces, a long URL and a long inline code span are all drawn inside the column:
// the table and the code block scroll in their own boxes, and the URL and the inline code wrap.
// The panel's content keeps a 16px inset on both sides: the transcript's rows and tables, the composer card and the footer
// rows are measured against the panel body's edges.
// Method: bundle the real ChatText and the panel's real stylesheets with esbuild into one page, put them in the
// real transcript structure inside a column of each width (260, 340 and 600 px), load it in Electron's Chromium
// and read the layout back: the scroller's scrollWidth must not exceed its clientWidth, no element outside a table
// or code box may reach past the scroller's right edge, and the table box must itself scroll sideways.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const { runElectronProbe } = require('../../helpers/electronProbe.js');

const WIDTHS = [260, 340, 600];

const REPLY = [
  '| Command | What it does | Example |',
  '|---|---|---|',
  '| `git history --since=2025-01-01 --author=someone --format=oneline --no-merges` | Shows a very long history of commits | `stacki roles list --json --project /Users/someone/Documents/Projects/a-very-long-project-name` |',
  '| status | short | https://example.com/a/very/long/url/that/never/breaks/anywhere/at/all/and/keeps/going/and/going/on?with=query |',
  '',
  'A long URL https://example.com/a/very/long/url/that/never/breaks/anywhere/at/all/and/keeps/going/and/going and `inline_code_that_is_extremely_long_and_has_no_spaces_at_all_so_it_must_wrap_somewhere_else`.',
  '',
  '- A list item holding a table:',
  '',
  '  | Command | Example |',
  '  |---|---|',
  '  | `git history --since=2025-01-01 --author=someone --format=oneline --no-merges` | `stacki roles list --json --project /Users/someone/Documents/Projects/a-very-long-project-name` |',
  '',
  '> a quote with `inline_code_that_is_extremely_long_and_has_no_spaces_at_all_so_it_must_wrap_somewhere_else` and a [link](https://example.com/a/very/long/url/that/never/breaks/anywhere/at/all/and/keeps/going/and/going)',
  '',
  '```',
  `const line = '${'x'.repeat(400)}';`,
  '```',
].join('\n');

test('the message scroller has no horizontal scroll at 260, 340 and 600 px with a wide table, long code and a long URL', async (context) => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    context.skip('needs a Chromium');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/ai-overflow');
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(
    entry,
    `import { createRoot } from 'react-dom/client';
import { ChatText } from ${JSON.stringify(repoPath('src/features/ai/ChatText.tsx'))};
import { LocaleProvider } from ${JSON.stringify(repoPath('src/lib/i18n/LocaleProvider.tsx'))};
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/ai/aiShell.css'))};
import ${JSON.stringify(repoPath('src/features/ai/transcript/transcript.css'))};
import ${JSON.stringify(repoPath('src/features/ai/transcript/chrome.css'))};
const width = Number(new URLSearchParams(location.search).get('w'));
createRoot(document.getElementById('root')!).render(
  <LocaleProvider onPreference={() => undefined}>
    <div className="ai-body" style={{ width, height: 700, boxSizing: 'border-box' }}>
      <div className="ai-transcript">
        <div className="ai-transcript-flow">
          <div className="ai-message ai-message-agent ai-msg ai-msg-agent">
            <div className="ai-msg-body">
              <ChatText text={${JSON.stringify(REPLY)}} />
            </div>
          </div>
        </div>
      </div>
      <div className="ai-composer" id="composer-card">A composer card</div>
      <div className="ai-status-line" id="footer-row">A footer row</div>
    </div>
  </LocaleProvider>,
);
`,
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    outfile: path.join(directory, 'page.js'),
    jsx: 'automatic',
    nodePaths: [repoPath('node_modules')],
    loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    '<!doctype html><html data-platform="darwin"><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body style="margin:0"><div id="root"></div><script src="page.js"></script></body></html>',
  );
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
app.on('window-all-closed', () => {});
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const seen = [];
  for (const width of ${JSON.stringify(WIDTHS)}) {
    const window = new BrowserWindow({ width: width + 40, height: 800, show: false });
    await window.loadURL('file://' + ${JSON.stringify(path.join(directory, 'index.html'))} + '?w=' + width);
    // The page draws on its first frame; the table box exists once React has rendered.
    const read = \`(async () => {
      // The page draws on its first frame; a mutation observer resumes the moment the table box exists, with no guessed delay
      // (the probe's own timeout bounds a table that never appears).
      await new Promise((resolve) => {
        const present = () => document.querySelector('.ai-md-table-wrap') !== null;
        if (present()) {
          resolve();
          return;
        }
        const observer = new MutationObserver(() => {
          if (present()) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
      const scroller = document.querySelector('.ai-transcript');
      const edge = scroller.getBoundingClientRect().right;
      const body = document.querySelector('.ai-body').getBoundingClientRect();
      const insets = (element) => { const box = element.getBoundingClientRect(); return [Math.round(box.left - body.left), Math.round(body.right - box.right)]; };
      const box = document.querySelector('.ai-md-table-wrap');
      const escaped = [...scroller.querySelectorAll('*')]
        .filter((element) => !element.closest('.ai-md-table-wrap') && !element.closest('pre'))
        .filter((element) => element.getBoundingClientRect().right > edge + 1)
        .map((element) => element.className || element.tagName)
        .slice(0, 5);
      return {
        width: ${'${width}'},
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        tableBoxScrolls: box ? box.scrollWidth > box.clientWidth : false,
        tableBoxInside: box ? box.getBoundingClientRect().right <= edge + 1 : false,
        codeScrolls: [...document.querySelectorAll('pre')].some((pre) => pre.scrollWidth > pre.clientWidth),
        escaped,
        rowInsets: insets(document.querySelector('.ai-markdown')),
        composerInsets: insets(document.querySelector('#composer-card')),
        footerInsets: insets(document.querySelector('#footer-row')),
        tableInsets: box ? insets(box) : [],
      };
    })()\`;
    seen.push(await window.webContents.executeJavaScript(read));
    window.destroy();
  }
  console.log(JSON.stringify({ seen }));
  app.exit(0);
});
`.replace(/\$\{'\$\{width\}'\}/g, '${width}'),
  );
  const run = runElectronProbe(electronPath, [probe]);
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  assert.ok(line, `the browser probe ran: ${(run.stderr || run.stdout || '').slice(0, 400)}`);
  const { seen } = JSON.parse(line);
  assert.equal(seen.length, WIDTHS.length);
  for (const result of seen) {
    const detail = JSON.stringify(result);
    assert.ok(result.scrollWidth <= result.clientWidth, `no horizontal scroll at ${result.width}px: ${detail}`);
    assert.deepEqual(result.escaped, [], `nothing outside a table or code box passes the column at ${result.width}px: ${detail}`);
    assert.ok(result.tableBoxInside, `the table box stays inside the column at ${result.width}px: ${detail}`);
    assert.ok(result.tableBoxScrolls, `the wide table scrolls in its own box at ${result.width}px: ${detail}`);
    for (const [name, [left, right]] of Object.entries({ row: result.rowInsets, composer: result.composerInsets, footer: result.footerInsets })) {
      // The scrollbar gutter is inside the transcript's right padding, so its content may sit a gutter further in, never nearer.
      assert.ok(left >= 16 && right >= 16, `the ${name} keeps a 16px inset at ${result.width}px: ${detail}`);
    }
    assert.ok(result.tableInsets[0] >= 16 && result.tableInsets[1] >= 16, `the table stays inside the padded column at ${result.width}px: ${detail}`);
    assert.ok(result.codeScrolls, `the long code line scrolls in its own block at ${result.width}px: ${detail}`);
  }
});
