// Goal: a "Move styles" stopped at any point (a crash, a power cut, a quit) is found when the project opens again, says
// exactly what is done and what is left, and is finished or undone exactly, with no CSS rule ever missing: either the
// stylesheets still hold it or the component does, and the page never uses a component that is not there.
// Method: the real main through the windowless harness, on a temporary project. For each point the move can stop at,
// the disk is set to exactly what the move had written by then and its journal recorded as the window records it;
// then a fresh harness on the same app data folder plays the next launch: styleMove:pending is read, and both
// resolutions run on separate copies, each checked text for text against the original or the moved state. The negative
// space: a file someone edited refuses both, writing nothing; a page saved before the journal learnt its text refuses
// undo; a page not saved yet cannot be finished; a journal for a move that is whole or never started only goes.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { parsePendingStyleMove, parseStyleMoveResolution, type StyleMoveJournal } from '#dist/shared/properties/styleMoveJournal.js';

// The move's texts: the rule `.card` leaves base.css for the component, and the page swaps its markup for <Card />.
const RULE = '.card { padding: 1rem; }';
const ORIGINAL = {
  component: undefined,
  page: '---\n---\n<div class="card">A</div>\n',
  base: `${RULE}\n.footer { margin: 0; }\n`,
  patterns: `${RULE.replace('padding', 'margin')}\n.wrap { gap: 0; }\n`,
} as const;
const MOVED = {
  component: `<div class="card">A</div>\n<style is:global>\n${RULE}\n.card { margin: 1rem; }\n</style>\n`,
  page: '---\nimport Card from "../components/Card.astro";\n---\n<Card />\n',
  base: '.footer { margin: 0; }\n',
  patterns: '.wrap { gap: 0; }\n',
} as const;
interface Side {
  readonly component: string | undefined;
  readonly page: string;
  readonly base: string;
  readonly patterns: string;
}

interface Site {
  readonly root: string;
  readonly userData: string;
  readonly files: { readonly component: string; readonly page: string; readonly base: string; readonly patterns: string };
}

function site(): Site {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-style-move-'));
  const userData = path.join(root, '.user');
  for (const folder of ['src/components', 'src/pages', 'src/styles', '.user']) {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const files = {
    component: path.join(root, 'src/components/Card.astro'),
    page: path.join(root, 'src/pages/index.astro'),
    base: path.join(root, 'src/styles/base.css'),
    patterns: path.join(root, 'src/styles/patterns.css'),
  };
  return { root, userData, files };
}

function journalOf(target: Site, pageAfter: string | undefined): StyleMoveJournal {
  const rel = (file: string): string => path.relative(target.root, file);
  return {
    version: 1,
    id: 'move-1',
    startedAt: 1,
    component: 'Card',
    files: [
      { role: 'component', path: target.files.component, rel: rel(target.files.component), before: undefined, after: MOVED.component },
      { role: 'page', path: target.files.page, rel: rel(target.files.page), before: ORIGINAL.page, after: pageAfter },
      { role: 'sheet', path: target.files.base, rel: rel(target.files.base), before: ORIGINAL.base, after: MOVED.base },
      { role: 'sheet', path: target.files.patterns, rel: rel(target.files.patterns), before: ORIGINAL.patterns, after: MOVED.patterns },
    ],
  };
}

function write(file: string, text: string | undefined): void {
  if (text === undefined) {
    fs.rmSync(file, { force: true });
  } else {
    fs.writeFileSync(file, text);
  }
}

function disk(target: Site): { readonly component: string | undefined; readonly page: string; readonly base: string; readonly patterns: string } {
  const read = (file: string): string | undefined => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
  return {
    component: read(target.files.component),
    page: read(target.files.page) ?? '',
    base: read(target.files.base) ?? '',
    patterns: read(target.files.patterns) ?? '',
  };
}

// No rule is ever nowhere, and the page never uses a missing component.
function holdsEveryRule(target: Site, where: string): void {
  const now = disk(target);
  const inSheets = now.base.includes(RULE);
  const inComponent = now.component?.includes(RULE) === true;
  assert.ok(inSheets || inComponent, `${where}: the moved rule is in a stylesheet or in the component`);
  if (now.page.includes('<Card />')) {
    assert.ok(now.component !== undefined, `${where}: the page uses a component that is there`);
  }
}

function assertSide(target: Site, side: Side, where: string): void {
  assert.deepEqual(disk(target), { component: side.component, page: side.page, base: side.base, patterns: side.patterns }, where);
}

// One launch of main on the site's project. The project scan records it as the open project, as the app's first scan
// does, without starting a file watcher that would outlive the launch.
async function launch(target: Site) {
  const harness = mainHarness(target.userData);
  await harness.invoke('project:scan', target.root);
  return harness;
}

// The stop points, in the order the move writes: what is on disk, and what the journal knows, at each.
const STOPS = [
  { name: 'after the journal, before the component', component: false, page: false, sheets: 0, journalKnowsPage: false },
  { name: 'after the component, before the page is saved', component: true, page: false, sheets: 0, journalKnowsPage: false },
  { name: 'after the page is saved, before the journal learnt its text', component: true, page: true, sheets: 0, journalKnowsPage: false },
  { name: 'after the page, before any stylesheet', component: true, page: true, sheets: 0, journalKnowsPage: true },
  { name: 'after one stylesheet of two', component: true, page: true, sheets: 1, journalKnowsPage: true },
  { name: 'after every stylesheet, before the journal went', component: true, page: true, sheets: 2, journalKnowsPage: true },
] as const;

async function stoppedAt(stop: (typeof STOPS)[number]): Promise<Site> {
  const target = site();
  write(target.files.component, stop.component ? MOVED.component : ORIGINAL.component);
  write(target.files.page, stop.page ? MOVED.page : ORIGINAL.page);
  write(target.files.base, stop.sheets >= 1 ? MOVED.base : ORIGINAL.base);
  write(target.files.patterns, stop.sheets >= 2 ? MOVED.patterns : ORIGINAL.patterns);
  const harness = await launch(target);
  try {
    await harness.invoke('styleMove:record', { projectPath: target.root, journal: journalOf(target, stop.journalKnowsPage ? MOVED.page : undefined) });
  } finally {
    harness.dispose();
  }
  holdsEveryRule(target, stop.name);
  return target;
}

async function pendingAfterRestart(target: Site) {
  const harness = await launch(target);
  try {
    return parsePendingStyleMove(await harness.invoke('styleMove:pending', { projectPath: target.root }));
  } finally {
    harness.dispose();
  }
}

async function resolveAfterRestart(target: Site, to: 'moved' | 'original') {
  const harness = await launch(target);
  try {
    const resolution = parseStyleMoveResolution(await harness.invoke('styleMove:resolve', { projectPath: target.root, id: 'move-1', target: to }));
    const left = parsePendingStyleMove(await harness.invoke('styleMove:pending', { projectPath: target.root }));
    return { resolution, left };
  } finally {
    harness.dispose();
  }
}

for (const stop of STOPS) {
  test(`stopped ${stop.name}: the next launch says where it stands, and finishing or undoing is exact`, async () => {
    const forUndo = await stoppedAt(stop);
    const forFinish = await stoppedAt(stop);
    try {
      const pending = await pendingAfterRestart(forUndo);
      assert.ok(pending !== undefined, 'the journal survives the restart');
      const done = Number(stop.component) + Number(stop.page) + stop.sheets;
      if (done === 0) {
        assert.equal(pending.state.kind, 'untouched');
        return;
      }
      if (done === 4) {
        assert.equal(pending.state.kind, 'done');
        return;
      }
      assert.equal(pending.state.kind, 'interrupted');
      assert.equal(pending.state.kind === 'interrupted' ? pending.state.done.length : -1, done, 'exactly the files written are done');
      assert.equal(pending.canFinish, stop.page, 'a move is finished only once its page uses the component');

      const undone = await resolveAfterRestart(forUndo, 'original');
      if (stop.page && !stop.journalKnowsPage) {
        assert.deepEqual(undone.resolution, { ok: false, changed: ['src/pages/index.astro'] }, 'a page whose saved text is unknown is never written back');
        assert.ok(undone.left !== undefined, 'refused: the journal stays');
      } else {
        assert.deepEqual(undone.resolution, { ok: true });
        assertSide(forUndo, ORIGINAL, `${stop.name}: undone, every file is exactly as before the move`);
        assert.equal(undone.left, undefined, 'resolved: the journal is gone');
      }
      holdsEveryRule(forUndo, `${stop.name}, after undo`);

      const finished = await resolveAfterRestart(forFinish, 'moved');
      if (!stop.page) {
        assert.equal(finished.resolution.ok, false, 'not saved yet: finishing is refused');
        assertSide(forFinish, { ...ORIGINAL, component: MOVED.component }, 'and nothing was written');
      } else {
        assert.deepEqual(finished.resolution, { ok: true });
        assertSide(forFinish, MOVED, `${stop.name}: finished, every file is exactly as the move wanted`);
      }
      holdsEveryRule(forFinish, `${stop.name}, after finish`);
    } finally {
      fs.rmSync(forUndo.root, { recursive: true, force: true });
      fs.rmSync(forFinish.root, { recursive: true, force: true });
    }
  });
}

test('a stylesheet edited by someone since refuses both, naming it, and nothing is written', async () => {
  const target = await stoppedAt(STOPS[3]);
  try {
    fs.writeFileSync(target.files.base, `${ORIGINAL.base}.added { color: red; }\n`);
    const before = disk(target);
    const pending = await pendingAfterRestart(target);
    assert.deepEqual(pending?.state, { kind: 'changed', changed: ['src/styles/base.css'] });
    for (const to of ['moved', 'original'] as const) {
      const { resolution, left } = await resolveAfterRestart(target, to);
      assert.deepEqual(resolution, { ok: false, changed: ['src/styles/base.css'] });
      assert.deepEqual(disk(target), before, `${to}: not a byte written`);
      assert.ok(left !== undefined, 'the journal stays until the person dismisses it');
    }
  } finally {
    fs.rmSync(target.root, { recursive: true, force: true });
  }
});

test('the journal lives in the app’s logs folder, named after the project, and never in the project', async () => {
  const target = await stoppedAt(STOPS[1]);
  try {
    const logs = path.join(target.userData, 'logs');
    const names = fs.readdirSync(logs);
    assert.equal(names.length, 1);
    assert.match(names[0] ?? '', /^stacki-style-move-[A-Za-z0-9]+-[0-9a-f]{8}-style-move\.json$/);
    assert.ok(!fs.readdirSync(target.root).some((name) => name.endsWith('style-move.json')), 'nothing written in the project for it');
    assert.ok(!fs.readdirSync(logs).some((name) => name.endsWith('.tmp')), 'no temporary file left behind');
  } finally {
    fs.rmSync(target.root, { recursive: true, force: true });
  }
});
