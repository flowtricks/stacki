// Goal: the transcript keeps one quiet, aligned rhythm. A tool-call row ("Ran 5 commands  9.4s") starts where the
// prose starts and its duration ends where the prose ends, wears no check mark (success is the default), and is compact;
// the gaps between blocks are the spacing tokens (0.5rem tool row to prose, 0.75rem between paragraphs and around a
// table, 0.25rem between list items, 1rem above and 0.375rem below a heading, 1.25rem between turns) within a pixel, and
// no gap is larger than a turn's; secondary text is the design system's secondary token, the least important the tertiary
// one, and prose the primary; the "Jump to latest" pill is an opaque surface; and the time and Copy row of a message
// has a slot of its own (1.25rem), invisible until hover or focus, so revealing it overlaps no block and moves nothing.
// The command rows of an opened group sit flush left: their chevron under the head's chevron, their duration right-aligned.
// Method: bundle the real activity group, messages and stylesheets into one page, load it in Electron's Chromium at 340
// and 600 px, and read the layout and computed colours back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const { runElectronProbe } = require('../../helpers/electronProbe.js');

const WIDTHS = [340, 600];
const REM = 16;

const REPLY = [
  'First paragraph of the answer.',
  '',
  'Second paragraph, a little longer so it is a real block of prose in the column.',
  '',
  '- one',
  '- two',
  '- three',
  '',
  '### A heading',
  '',
  'Text under the heading.',
  '',
  '| Area | Notes |',
  '|---|---|',
  '| Roles | roles.json |',
  '',
  'Closing paragraph.',
].join('\n');

test('tool rows align with the prose, the gaps are the spacing tokens, colours are the tokens, the pill is opaque', async (context) => {
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
  const directory = repoPath('node_modules/.stacki-test/ai-rhythm');
  fs.mkdirSync(directory, { recursive: true });
  const tool = (id) => ({
    kind: 'tool',
    id,
    turn: 't1',
    call: `c${id}`,
    title: `Run ${id}`,
    toolKind: 'execute',
    status: 'completed',
    paths: [],
    diffs: [],
    output: '',
    exitCode: 0,
    parent: undefined,
    at: 1000,
    endedAt: 3000,
    toolName: undefined,
    command: `echo ${id}`,
    background: false,
  });
  const run = (key) => ({ kind: 'group', key, turn: 't1', items: [1, 2, 3, 4, 5].map((id) => tool(key * 10 + id)), last: false });
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(
    entry,
    `import { createRoot } from 'react-dom/client';
import { ChatText } from ${JSON.stringify(repoPath('src/features/ai/ChatText.tsx'))};
import { ActivityGroup } from ${JSON.stringify(repoPath('src/features/ai/transcript/ActivityGroup.tsx'))};
import { AgentMessage, UserMessage } from ${JSON.stringify(repoPath('src/features/ai/transcript/Messages.tsx'))};
import { LocaleProvider } from ${JSON.stringify(repoPath('src/lib/i18n/LocaleProvider.tsx'))};
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/ai/aiShell.css'))};
import ${JSON.stringify(repoPath('src/features/ai/transcript/transcript.css'))};
import ${JSON.stringify(repoPath('src/features/ai/transcript/chrome.css'))};
const width = Number(new URLSearchParams(location.search).get('w'));
void ChatText;
createRoot(document.getElementById('root')!).render(
  <LocaleProvider onPreference={() => undefined}>
    <div className="ai-body" style={{ width, height: 1400, boxSizing: 'border-box' }}>
      <div className="ai-transcript">
        <div className="ai-transcript-flow">
          <UserMessage text="Do the thing" attachments={[]} at={undefined} />
          <ActivityGroup run={${JSON.stringify(run(1))}} chatId="chat" projectPath="/p" working={false} />
          <AgentMessage text={${JSON.stringify(REPLY)}} at={undefined} collapsible="none" />
          <ActivityGroup run={${JSON.stringify(run(2))}} chatId="chat" projectPath="/p" working={false} />
          <UserMessage text="Next turn" attachments={[]} at={undefined} />
        </div>
        <button className="ai-latest" id="pill">Jump to latest</button>
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
      const box = (element) => element.getBoundingClientRect();
      const colour = (value) => { const probe = document.createElement('span'); probe.style.color = value; document.body.appendChild(probe); const resolved = getComputedStyle(probe).color; probe.remove(); return resolved; };
      const flow = [...document.querySelector('.ai-transcript-flow').children];
      const markdown = document.querySelector('.ai-markdown');
      const prose = box(markdown.querySelector('p'));
      const proseColumn = box(markdown);
      const head = document.querySelector('.ai-group-head');
      const chevron = head.querySelector('svg');
      const time = head.querySelector('.ai-group-time');
      const blocks = [...markdown.children];
      const gaps = (items) => items.slice(1).map((item, index) => Math.round(box(item).top - box(items[index]).bottom));
      const lis = [...markdown.querySelectorAll('li')];
      const heading = markdown.querySelector('h3');
      const headingIndex = blocks.indexOf(heading);
      const pill = getComputedStyle(document.querySelector('#pill'));
      // The actions row of the reply: its slot is reserved, so focusing its Copy button (as Tab would) reveals it in place.
      const reply = document.querySelector('.ai-msg-agent');
      const toolbar = reply.querySelector('.ai-msg-toolbar');
      const copy = toolbar.querySelector('button');
      const scroller = document.querySelector('.ai-transcript');
      const layout = () => ({ scrollHeight: scroller.scrollHeight, tops: [...document.querySelectorAll('.ai-transcript-flow > *, .ai-markdown > *')].map((element) => Math.round(box(element).top)) });
      const hiddenLayout = layout();
      const hiddenOpacity = getComputedStyle(toolbar).opacity;
      const hiddenVisibility = getComputedStyle(toolbar).visibility;
      copy.focus();
      // The reveal is a finite CSS transition: wait until every finite animation has finished, not for a guessed time.
      await Promise.all(document.getAnimations().filter((animation) => animation.effect === null || animation.effect.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
      const shownLayout = layout();
      const slot = box(toolbar);
      const others = [...document.querySelectorAll('.ai-transcript-flow > *')].filter((element) => element !== reply).map(box);
      const body = box(reply.querySelector('.ai-msg-body'));
      const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      // Open the first group last, after every layout reading above: its command rows must sit flush left under the head.
      const headLeftClosed = Math.round(box(chevron).left * 10) / 10;
      const timeRightClosed = time ? Math.round(box(time).right * 10) / 10 : undefined;
      const headHeightClosed = Math.round(box(head).height);
      head.click();
      await new Promise((resolve) => {
        const present = () => document.querySelector('.ai-group-body .ai-tool-head') !== null;
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
      const rowHead = document.querySelector('.ai-group-body .ai-tool-head');
      const rowTime = rowHead.querySelector('.ai-tool-time');
      const rowChevronLeft = Math.round(box(rowHead.querySelector('svg')).left * 10) / 10;
      const rowTimeRight = rowTime ? Math.round(box(rowTime).right * 10) / 10 : undefined;
      return {
        rowChevronLeft,
        rowTimeRight,
        width: ${'${width}'},
        headLeft: headLeftClosed,
        proseLeft: Math.round(prose.left * 10) / 10,
        timeRight: timeRightClosed,
        proseRight: Math.round(proseColumn.right * 10) / 10,
        headHeight: headHeightClosed,
        headSvgCount: head.querySelectorAll('svg').length,
        flowGaps: gaps(flow),
        flowKinds: flow.map((element) => element.className.split(' ')[0]),
        blockGaps: gaps(blocks),
        blockKinds: blocks.map((element) => element.tagName + (element.className ? '.' + element.className.split(' ')[0] : '')),
        listGaps: gaps(lis),
        headingAbove: Math.round(box(heading).top - box(blocks[headingIndex - 1]).bottom),
        headingBelow: Math.round(box(blocks[headingIndex + 1]).top - box(heading).bottom),
        colours: {
          title: getComputedStyle(head.querySelector('.ai-group-title')).color,
          time: time ? getComputedStyle(time).color : undefined,
          prose: getComputedStyle(markdown.querySelector('p')).color,
          th: getComputedStyle(markdown.querySelector('th')).color,
          secondary: colour('var(--text-dim)'),
          tertiary: colour('var(--text-faint)'),
          primary: colour('var(--text)'),
        },
        pillBackground: pill.backgroundColor,
        pillOpacity: pill.opacity,
        slotHeight: Math.round(slot.height * 10) / 10,
        hiddenOpacity,
        hiddenVisibility,
        shownOpacity: getComputedStyle(toolbar).opacity,
        scrollHeights: [hiddenLayout.scrollHeight, shownLayout.scrollHeight],
        moved: JSON.stringify(hiddenLayout.tops) !== JSON.stringify(shownLayout.tops),
        overlapsBlock: others.some((other) => meets(slot, other)) || meets(slot, body),
        slotInsideMessage: slot.top >= box(reply).top && slot.bottom <= box(reply).bottom + 0.5,
        slotLeft: Math.round(slot.left * 10) / 10,
        bodyLeft: Math.round(body.left * 10) / 10,
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
  const run2 = runElectronProbe(electronPath, [probe]);
  const line = (run2.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  assert.ok(line, `the browser probe ran: ${(run2.stderr || run2.stdout || '').slice(0, 400)}`);
  const { seen } = JSON.parse(line);
  for (const result of seen) {
    const detail = JSON.stringify(result);
    const near = (actual, expected, message) =>
      assert.ok(Math.abs(actual - expected) <= 1, `${message} at ${result.width}px: ${actual} vs ${expected}: ${detail}`);
    near(result.headLeft, result.proseLeft, 'the tool row starts where the prose starts');
    near(result.rowChevronLeft, result.headLeft, 'a command row’s chevron sits under the head’s chevron, no indent');
    near(result.rowTimeRight, result.proseRight, 'a command row’s duration ends where the prose ends');
    near(result.timeRight, result.proseRight, 'the duration ends where the prose ends');
    assert.equal(result.headSvgCount, 1, `only the chevron: no check mark at ${result.width}px`);
    assert.ok(result.headHeight <= 24, `the row is compact (${result.headHeight}px) at ${result.width}px`);
    // The flow: user, group, reply, group, user.
    near(result.flowGaps[0], 0.5 * REM, 'the user message to the tool row');
    near(result.flowGaps[1], 0.5 * REM, 'a tool row to the prose after it');
    near(result.flowGaps[2], 0.5 * REM, 'the prose to the next tool row');
    near(result.flowGaps[3], 1.25 * REM, 'between turns');
    result.blockGaps.forEach((gap, index) => {
      const next = result.blockKinds[index + 1];
      const before = result.blockKinds[index];
      const expected = next === 'H3' ? 1 * REM : before === 'H3' ? 0.375 * REM : 0.75 * REM;
      near(gap, expected, `the gap before ${next}`);
    });
    near(result.headingAbove, 1 * REM, 'above a heading');
    near(result.headingBelow, 0.375 * REM, 'below a heading');
    result.listGaps.forEach((gap) => near(gap, 0.25 * REM, 'between list items'));
    assert.ok(Math.max(...result.flowGaps, ...result.blockGaps) <= 1.25 * REM + 1, `no gap past a turn's at ${result.width}px: ${detail}`);
    assert.equal(result.colours.title, result.colours.secondary, 'a tool row’s label is the secondary text colour');
    assert.equal(result.colours.th, result.colours.secondary, 'a table header is secondary');
    assert.equal(result.colours.time, result.colours.tertiary, 'a duration is tertiary');
    assert.equal(result.colours.prose, result.colours.primary, 'prose is primary');
    assert.match(result.pillBackground, /^rgb\(/, `the pill background is opaque at ${result.width}px: ${result.pillBackground}`);
    assert.equal(result.pillOpacity, '1', 'the pill has no opacity');
    near(result.slotHeight, 1.25 * REM, 'the actions slot is reserved at 1.25rem');
    assert.equal(result.hiddenOpacity, '0', 'the slot is invisible at rest');
    assert.notEqual(result.hiddenVisibility, 'hidden', 'but not removed from the tab order');
    assert.equal(result.shownOpacity, '1', `focus inside the message reveals it at ${result.width}px`);
    assert.equal(result.moved, false, `revealing it moves no block at ${result.width}px: ${detail}`);
    assert.equal(result.scrollHeights[0], result.scrollHeights[1], 'and the scroll height is constant');
    assert.equal(result.overlapsBlock, false, `its rect meets no other block at ${result.width}px: ${detail}`);
    assert.ok(result.slotInsideMessage, 'it sits inside its own message');
    near(result.slotLeft, result.bodyLeft, 'it starts at the prose’s left edge');
  }
});
