// Goal: the Running panel lays out cleanly at the AI panel's narrow and wide widths (340 and 600 px). Its rows keep the
// subagent strip's fixed columns whatever their words: the dots share one left edge, the names one left edge, the
// models one left edge, and the times end on one right edge in tabular figures; a long title is cut with an ellipsis
// before the model column, never pushing it; an opened agent's steps sit flush under it (their chevron under the
// row's, their time ending where the row's time ends). The panel stays inside the window and inside the chat column,
// and nothing in it, or on the page, scrolls sideways.
// Method: views are folded by the real wire parser, the host's event builder and the reducer from
// test/fixtures/ai/runningWork.jsonl (a long-running agent, a background command, a failed agent) plus an agent with
// a very long title, their stamps moved to just now; the real chip, panel and stylesheets are bundled into one page,
// loaded in a hidden Electron window at each width; the probe opens the panel and an agent with real clicks, waits
// for each state by observing the DOM (no fixed pauses), and reads the layout back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const loadRenderer = require('../../helpers/rendererModule.js');
const { repoPath } = require('../../helpers/sources.js');
const { runElectronProbe } = require('../../helpers/electronProbe.js');

const WIDTHS = [340, 600];
const TURN = `t${'1'.padStart(16, '0')}`;
const LONG_TITLE = 'Audit every component of the marketing site for spacing, colour contrast and responsive behaviour at all breakpoints';

/** The chat the panel is drawn for, folded by the real pipeline, every stamp moved so the run started a minute ago. */
function viewForPage() {
  const wire = loadRenderer('shared/properties/ai/acpWire.ts');
  const { eventsForUpdate } = loadRenderer('electron/handlers/ai/chatEvents.ts');
  const { parseChatEvent } = loadRenderer('shared/properties/ai/chatModel.ts');
  const { EMPTY_CHAT, reduceChat } = loadRenderer('src/features/ai/chatReducer.ts');
  const lines = fs
    .readFileSync(repoPath('test/fixtures/ai/runningWork.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
    .filter((entry) => ['long', 'background', 'failed'].includes(entry.scenario));
  const events = [
    { kind: 'turn-start', turn: TURN, at: 0 },
    { kind: 'user', turn: TURN, text: 'go', attachments: [], at: 0 },
  ];
  for (const entry of lines) {
    const notification = wire.parseSessionNotification(wire.parseAcpLine(entry.line).value.params);
    events.push(...eventsForUpdate(notification.value.update, TURN, { at: entry.at }).map((event) => parseChatEvent(JSON.parse(JSON.stringify(event)))));
  }
  events.push({
    kind: 'tool',
    turn: TURN,
    call: 'toolu_wide',
    title: LONG_TITLE,
    toolKind: 'think',
    toolName: 'Agent',
    agentModel: 'haiku',
    status: 'in_progress',
    at: 3000,
  });
  const view = reduceChat(EMPTY_CHAT, events);
  const offset = Date.now() - 60_000;
  const moved = JSON.parse(JSON.stringify(view), (key, value) =>
    typeof value === 'number' && ['at', 'endedAt', 'until', 'startedAt', 'turnStartedAt'].includes(key) ? value + offset : value,
  );
  return moved;
}

test('the Running panel keeps its columns, cuts long titles and stays inside the window at 340 and 600 px', async (context) => {
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
  const directory = repoPath('node_modules/.stacki-test/ai-running-layout');
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(
    entry,
    `import { createRoot } from 'react-dom/client';
import { RunningChip } from ${JSON.stringify(repoPath('src/features/ai/transcript/RunningPanel.tsx'))};
import { LocaleProvider } from ${JSON.stringify(repoPath('src/lib/i18n/LocaleProvider.tsx'))};
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/ai/aiShell.css'))};
import ${JSON.stringify(repoPath('src/features/ai/transcript/transcript.css'))};
import ${JSON.stringify(repoPath('src/features/ai/transcript/chrome.css'))};
const width = Number(new URLSearchParams(location.search).get('w'));
const view = ${JSON.stringify(viewForPage())};
createRoot(document.getElementById('root')!).render(
  <LocaleProvider onPreference={() => undefined}>
    <div className="ai-body" style={{ width, height: 860, boxSizing: 'border-box' }}>
      <div className="ai-transcript" style={{ flex: 1 }}>
        <div className="ai-transcript-flow">transcript</div>
      </div>
      <RunningChip view={view} chatId="chat" projectPath="/site" />
      <div className="ai-composer-stand-in" style={{ height: 120, background: 'var(--bg-input)' }} />
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
    // Not throttled while hidden, so the popup's opening frames run and it reaches its resting state.
    const window = new BrowserWindow({ width: width + 40, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
    await window.loadURL('file://' + ${JSON.stringify(path.join(directory, 'index.html'))} + '?w=' + width);
    const read = \`(async () => {
      // Resumes the moment the selector's element exists; the probe's own timeout bounds one that never appears.
      const present = (selector) => new Promise((resolve) => {
        if (document.querySelector(selector) !== null) {
          resolve();
          return;
        }
        const observer = new MutationObserver(() => {
          if (document.querySelector(selector) !== null) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      });
      await present('.ai-running-chip');
      document.querySelector('.ai-running-chip').click();
      await present('.ai-running-panel[data-popup-phase="open"]');
      document.querySelector('.ai-running-head').click();
      await present('.ai-running-steps .ai-step');
      const box = (element) => element.getBoundingClientRect();
      const round = (value) => Math.round(value * 10) / 10;
      const panel = document.querySelector('.ai-running-panel');
      const rows = [...panel.querySelectorAll('.ai-running-head')].map((row) => {
        const name = row.querySelector('.ai-running-name');
        const time = row.querySelector('.ai-agent-time');
        return {
          text: name.textContent,
          dotLeft: round(box(row.querySelector('.ai-agent-dot')).left),
          nameLeft: round(box(name).left),
          nameRight: round(box(name).right),
          nameCut: name.scrollWidth > name.clientWidth,
          nameEllipsis: getComputedStyle(name).textOverflow,
          modelLeft: round(box(row.querySelector('.ai-agent-model')).left),
          modelShown: getComputedStyle(row.querySelector('.ai-agent-model')).display !== 'none',
          inlineModelShown: getComputedStyle(row.querySelector('.ai-running-model-inline') ?? row).display === 'inline',
          timeLeft: time === null ? null : round(box(time).left),
          timeRight: time === null ? null : round(box(time).right),
          figures: time === null ? '' : getComputedStyle(time).fontVariantNumeric,
          chevronLeft: round(box(row.querySelector('.ai-step-chevron svg')).left),
        };
      });
      const steps = [...panel.querySelectorAll('.ai-running-steps .ai-step')].map((step) => {
        const time = step.querySelector('.ai-agent-time');
        return {
          chevronLeft: round(box(step.querySelector('.ai-step-chevron svg')).left),
          markLeft: round(box(step.querySelector('.ai-step-mark')).left),
          labelLeft: round(box(step.querySelector('.ai-step-label')).left),
          timeRight: time === null ? null : round(box(time).right),
        };
      });
      const rectangle = box(panel);
      const column = box(document.querySelector('.ai-body'));
      return {
        width: ${'${width}'},
        rows,
        steps,
        panel: { left: round(rectangle.left), right: round(rectangle.right), top: round(rectangle.top), bottom: round(rectangle.bottom) },
        column: { left: round(column.left), right: round(column.right) },
        panelScrollWidth: panel.scrollWidth,
        panelClientWidth: panel.clientWidth,
        gutter: getComputedStyle(panel).scrollbarGutter,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        pageWidth: document.documentElement.scrollWidth,
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
  for (const result of seen) {
    const detail = JSON.stringify(result);
    const near = (actual, expected, message) =>
      assert.ok(Math.abs(actual - expected) <= 1, `${message} at ${result.width}px: ${actual} vs ${expected}: ${detail}`);
    assert.deepEqual(
      result.rows.map((row) => row.text),
      ['Release Stacki 1.4.14', LONG_TITLE, 'Dev server'],
      'the running rows: two agents and the dev server',
    );
    const [first] = result.rows;
    // At 340 px the panel gives the task the model's column and names the model on the summary line instead.
    const narrow = result.width < 400;
    for (const row of result.rows) {
      near(row.dotLeft, first.dotLeft, 'the dots share one left edge');
      near(row.nameLeft, first.nameLeft, 'the names share one left edge');
      near(row.timeRight, first.timeRight, 'the times end on one right edge');
      assert.equal(row.modelShown, !narrow, `the model column at ${result.width}px: ${detail}`);
      if (narrow) {
        assert.ok(row.nameRight <= row.timeLeft + 0.5, `a name ends before the time column at ${result.width}px: ${detail}`);
      } else {
        near(row.modelLeft, first.modelLeft, 'the models share one left edge');
        assert.ok(row.nameRight <= row.modelLeft + 0.5, `a name ends before the model column at ${result.width}px: ${detail}`);
      }
      assert.match(row.figures, /tabular-nums/, 'the times are tabular figures');
      assert.equal(row.nameEllipsis, 'ellipsis', 'a long name is cut with an ellipsis');
    }
    assert.equal(result.rows[1].nameCut, true, `the long title is cut, not wrapped or overflowing, at ${result.width}px`);
    assert.equal(result.rows[0].nameCut, false, 'a short title is whole');
    assert.equal(result.rows[0].inlineModelShown, narrow, 'a narrow panel names the model on the summary line');
    assert.ok(result.steps.length >= 2, `the opened agent shows its steps: ${detail}`);
    for (const step of result.steps) {
      near(step.chevronLeft, first.chevronLeft, 'a step sits flush under its agent’s chevron');
      near(step.markLeft, first.dotLeft, 'a step’s mark sits in the dot column');
      near(step.labelLeft, first.nameLeft, 'a step’s words start where the names start');
      if (step.timeRight !== null) {
        near(step.timeRight, first.timeRight, 'a step’s time ends where the agent’s time ends');
      }
    }
    assert.ok(result.panel.left >= 0 && result.panel.top >= 0, `the panel is inside the window at ${result.width}px: ${detail}`);
    assert.ok(result.panel.right <= result.windowWidth && result.panel.bottom <= result.windowHeight, `the panel is inside the window: ${detail}`);
    assert.ok(
      result.panel.left >= result.column.left - 0.5 && result.panel.right <= result.column.right + 0.5,
      `the panel stays in the chat column: ${detail}`,
    );
    assert.ok(result.panelScrollWidth <= result.panelClientWidth, `nothing in the panel scrolls sideways at ${result.width}px: ${detail}`);
    assert.equal(result.gutter, 'stable', 'the panel reserves its scrollbar gutter');
    assert.ok(result.pageWidth <= result.width + 40, `nothing on the page scrolls sideways at ${result.width}px`);
  }
});
