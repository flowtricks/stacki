// Goal: the subagent strip and the subagent units line up. In the strip every row has the same columns whatever its
// text: the dots share one left edge, the tasks one left edge, the models one left edge, and the times end on one right
// edge in tabular figures, whether a row says "11s", "5.9s" or "4m 3s"; a long task is cut with an ellipsis before the
// model column, never pushing it; the dot sits centred on the task's line. In the transcript a unit's chevron starts
// where the prose starts and its time ends where the prose ends, as a group's do, and the calls inside an opened unit
// sit flush under it (their chevron under the unit's), with no indent; the unit's columns are the strip's.
// Method: bundle the real strip, unit card, message and stylesheets into one page, load it in Electron's Chromium at
// 340 and 600 px, open the strip's summary and the unit with real clicks, and read the layout back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const { runElectronProbe } = require('../../helpers/electronProbe.js');

const WIDTHS = [340, 600];

const agent = (call, title, durationMs, model) => ({
  call,
  turn: 't1',
  kind: 'agent',
  role: 'general-purpose',
  title,
  model,
  status: { kind: 'done', durationMs },
  activity: { kind: 'starting' },
  result: 'All good.',
});

const LIST = {
  agents: [
    agent('a1', 'Audit the hero', 11_000, { kind: 'chosen', id: 'sonnet' }),
    agent('a2', 'Check the build', 5_900, { kind: 'inherited' }),
    agent('a3', 'A very long task description that cannot possibly fit beside the model and time columns of a narrow panel', 243_000, {
      kind: 'chosen',
      id: 'haiku',
    }),
    agent('a4', 'Read', 900, { kind: 'chosen', id: 'opus' }),
  ],
  omitted: 0,
};

const child = (id, command) => ({
  kind: 'tool',
  id,
  turn: 't1',
  call: `k${id}`,
  title: command,
  toolKind: 'execute',
  status: 'completed',
  paths: [],
  diffs: [],
  output: '',
  exitCode: 0,
  parent: 'a1',
  at: 1000,
  endedAt: 3000,
  toolName: 'Bash',
  command,
  background: false,
  agentType: undefined,
  agentModel: undefined,
  resultFrom: 0,
});

const UNIT = { agent: LIST.agents[0], children: [child(1, 'npm test'), child(2, 'cd /tmp/pw-tool; npx playwright test')], omitted: 0 };

test('the strip’s columns line up across rows, and a unit sits flush with the prose', async (context) => {
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
  const directory = repoPath('node_modules/.stacki-test/ai-subagent-layout');
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(
    entry,
    `import { createRoot } from 'react-dom/client';
import { SubagentStrip } from ${JSON.stringify(repoPath('src/features/ai/transcript/SubagentStrip.tsx'))};
import { SubagentCard } from ${JSON.stringify(repoPath('src/features/ai/transcript/SubagentCard.tsx'))};
import { AgentMessage } from ${JSON.stringify(repoPath('src/features/ai/transcript/Messages.tsx'))};
import { LocaleProvider } from ${JSON.stringify(repoPath('src/lib/i18n/LocaleProvider.tsx'))};
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/ai/aiShell.css'))};
import ${JSON.stringify(repoPath('src/features/ai/transcript/transcript.css'))};
import ${JSON.stringify(repoPath('src/features/ai/transcript/chrome.css'))};
const width = Number(new URLSearchParams(location.search).get('w'));
createRoot(document.getElementById('root')!).render(
  <LocaleProvider onPreference={() => undefined}>
    <div className="ai-body" style={{ width, height: 1200, boxSizing: 'border-box' }}>
      <SubagentStrip list={${JSON.stringify(LIST)}} chatId="chat" projectPath="/p" options={[]} onOpen={() => undefined} />
      <div className="ai-transcript">
        <div className="ai-transcript-flow">
          <AgentMessage text="Starting four agents to look at the site." at={undefined} collapsible="none" />
          <SubagentCard unit={${JSON.stringify(UNIT)}} chatId="chat" projectPath="/p" options={[]} live={false} reveal={undefined} onOpenTranscript={() => undefined} />
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
    const window = new BrowserWindow({ width: width + 40, height: 900, show: false });
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
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
      await present('.ai-agents-head');
      document.querySelector('.ai-agents-head').click();
      await present('.ai-agent');
      document.querySelector('.ai-subagent-head').click();
      await present('.ai-subagent-body .ai-tool-head');
      const box = (element) => element.getBoundingClientRect();
      const round = (value) => Math.round(value * 10) / 10;
      const rows = [...document.querySelectorAll('.ai-agent')].map((row) => {
        const dot = box(row.querySelector('.ai-agent-dot'));
        const name = row.querySelector('.ai-agent-name');
        const model = box(row.querySelector('.ai-agent-model'));
        const time = row.querySelector('.ai-agent-time');
        return {
          dotLeft: round(dot.left),
          dotCentre: round(dot.top + dot.height / 2),
          nameLeft: round(box(name).left),
          nameRight: round(box(name).right),
          nameCentre: round(box(name).top + box(name).height / 2),
          nameCut: name.scrollWidth > name.clientWidth,
          nameEllipsis: getComputedStyle(name).textOverflow,
          modelLeft: round(model.left),
          timeRight: round(box(time).right),
          timeText: time.textContent,
          figures: getComputedStyle(time).fontVariantNumeric,
          rowRight: round(box(row).right),
        };
      });
      const prose = box(document.querySelector('.ai-markdown'));
      const unitHead = document.querySelector('.ai-subagent-head');
      const unitChevron = box(unitHead.querySelector('.ai-subagent-chevron svg'));
      const unitTime = box(unitHead.querySelector('.ai-agent-time'));
      const unitModel = box(unitHead.querySelector('.ai-agent-model'));
      const childHeads = [...document.querySelectorAll('.ai-subagent-body .ai-tool-head')];
      return {
        width: ${'${width}'},
        rows,
        proseLeft: round(prose.left),
        proseRight: round(prose.right),
        unitChevronLeft: round(unitChevron.left),
        unitTimeRight: round(unitTime.right),
        unitModelWidth: round(unitModel.width),
        stripModelWidth: round(box(document.querySelector('.ai-agent .ai-agent-model')).width),
        childChevronLefts: childHeads.map((head) => round(box(head.querySelector('svg')).left)),
        childNested: document.querySelectorAll('.ai-subagent-body .ai-tool-nested').length,
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
    assert.equal(result.rows.length, LIST.agents.length, 'every subagent has a row');
    assert.deepEqual(
      result.rows.map((row) => row.timeText),
      ['11s', '5.9s', '4m 3s', '0.9s'],
      'times of different widths, so the alignment is really tested',
    );
    const [first] = result.rows;
    for (const row of result.rows) {
      near(row.dotLeft, first.dotLeft, 'the dots share one left edge');
      near(row.nameLeft, first.nameLeft, 'the tasks share one left edge');
      near(row.modelLeft, first.modelLeft, 'the models share one left edge');
      near(row.timeRight, first.timeRight, 'the times end on one right edge');
      near(row.dotCentre, row.nameCentre, 'the dot sits centred on the task’s line');
      assert.ok(row.nameRight <= row.modelLeft + 0.5, `the task ends before the model column at ${result.width}px: ${detail}`);
      assert.match(row.figures, /tabular-nums/, 'the times are tabular figures');
      assert.equal(row.nameEllipsis, 'ellipsis', 'a long task is cut with an ellipsis');
    }
    assert.equal(result.rows[2].nameCut, true, `the long task is cut, not wrapped or overflowing, at ${result.width}px`);
    assert.equal(result.rows[0].nameCut, false, 'a short task is whole');
    near(result.unitChevronLeft, result.proseLeft, 'a unit’s chevron starts where the prose starts');
    near(result.unitTimeRight, result.proseRight, 'a unit’s time ends where the prose ends');
    near(result.unitModelWidth, result.stripModelWidth, 'a unit’s model column is the strip’s');
    assert.equal(result.childChevronLefts.length, UNIT.children.length, 'the opened unit shows its calls');
    for (const left of result.childChevronLefts) {
      near(left, result.unitChevronLeft, 'a call inside the unit sits flush under the unit’s chevron');
    }
    assert.equal(result.childNested, 0, 'its direct calls are not indented');
    assert.ok(result.pageWidth <= result.width + 40, `nothing scrolls sideways at ${result.width}px`);
  }
});
