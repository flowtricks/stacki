// Goal: the attachment line under a sent message stays flush-left with no overflow at 340 and 600 px panel widths: the
// thumbnail box keeps its reserved size before and after the picture decodes (nothing shifts), the first box starts at
// the bubble's left padding edge, and a long label wraps inside the bubble instead of widening it.
// Method: bundle the real UserMessage and the panel's real stylesheets with esbuild, load the page in Electron's
// Chromium at each width with a decodable one-pixel JPEG thumbnail and a very long label, and read the layout back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const { runElectronProbe } = require('../../helpers/electronProbe.js');

const WIDTHS = [340, 600];
// A 1x1 white JPEG, so the picture really decodes in Chromium.
const JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

test('the attachment line is flush-left, keeps its box size through decoding and never overflows at 340 and 600 px', async (context) => {
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
  const directory = repoPath('node_modules/.stacki-test/ai-sent-attachments');
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'entry.tsx');
  const longLabel = `Screenshot 1 (1600×933) ${'a-very-long-name-with-no-break-'.repeat(8)}`;
  fs.writeFileSync(
    entry,
    `import { createRoot } from 'react-dom/client';
import { UserMessage } from ${JSON.stringify(repoPath('src/features/ai/transcript/Messages.tsx'))};
import { LocaleProvider } from ${JSON.stringify(repoPath('src/lib/i18n/LocaleProvider.tsx'))};
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/ai/aiShell.css'))};
import ${JSON.stringify(repoPath('src/features/ai/transcript/transcript.css'))};
import ${JSON.stringify(repoPath('src/features/ai/transcript/chrome.css'))};
const width = Number(new URLSearchParams(location.search).get('w'));
const attachments = [
  { kind: 'image', name: 'Screenshot 1 (1600×933)', thumbnail: ${JSON.stringify(JPEG)} },
  { kind: 'image', name: ${JSON.stringify(longLabel)}, thumbnail: ${JSON.stringify(JPEG)} },
  { kind: 'image', name: 'Screenshot 3 (800×600)' },
];
createRoot(document.getElementById('root')!).render(
  <LocaleProvider onPreference={() => undefined}>
    <div className="ai-body" style={{ width, height: 700, boxSizing: 'border-box' }}>
      <div className="ai-transcript">
        <div className="ai-transcript-flow">
          <UserMessage text="Look at this" attachments={attachments} at={1} onEdit={undefined} onResend={undefined} />
        </div>
      </div>
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
    const read = \`(async () => {
      await new Promise((resolve) => {
        const present = () => document.querySelector('.ai-message-thumb') !== null;
        if (present()) { resolve(); return; }
        const observer = new MutationObserver(() => { if (present()) { observer.disconnect(); resolve(); } });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
      const sizes = () => [...document.querySelectorAll('.ai-message-thumb')].map((box) => { const rect = box.getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)]; });
      const before = sizes();
      // Every picture decodes, then the layout is read again.
      await Promise.all([...document.querySelectorAll('.ai-message-thumb img')].map((image) => image.decode().catch(() => undefined)));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const after = sizes();
      const bubble = document.querySelector('.ai-msg-bubble').getBoundingClientRect();
      const line = document.querySelector('.ai-message-attachments').getBoundingClientRect();
      const scroller = document.querySelector('.ai-transcript');
      const lefts = [...document.querySelectorAll('.ai-message-attachment')].map((item) => Math.round(item.getBoundingClientRect().left - line.left));
      const labels = [...document.querySelectorAll('.ai-message-attachment-label')];
      return {
        width: ${'${width}'},
        before, after,
        decoded: [...document.querySelectorAll('.ai-message-thumb')].map((box) => box.getAttribute('data-decode')),
        lineLeftInset: Math.round(line.left - bubble.left),
        lineRightOverflow: Math.round(line.right - bubble.right),
        firstItemOffset: lefts[0],
        scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth,
        labelsInside: labels.every((label) => label.getBoundingClientRect().right <= bubble.right + 1),
        thumbsCount: before.length,
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
    assert.equal(result.thumbsCount, 2, `two of the three attachments have a box at ${result.width}px: ${detail}`);
    assert.deepEqual(result.before, result.after, `the boxes keep their size when the pictures decode at ${result.width}px: ${detail}`);
    assert.deepEqual(result.decoded, ['ready', 'ready'], `the pictures decode at ${result.width}px: ${detail}`);
    assert.equal(result.lineLeftInset, 10, `the line starts at the bubble's left padding edge at ${result.width}px: ${detail}`);
    assert.equal(result.firstItemOffset, 0, `the first attachment is flush-left at ${result.width}px: ${detail}`);
    assert.ok(result.lineRightOverflow <= 0, `the line stays inside the bubble at ${result.width}px: ${detail}`);
    assert.ok(result.labelsInside, `labels wrap inside the bubble at ${result.width}px: ${detail}`);
    assert.ok(result.scrollWidth <= result.clientWidth, `no horizontal scroll at ${result.width}px: ${detail}`);
  }
});
