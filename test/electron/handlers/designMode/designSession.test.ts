// Goal: Design mode's main process half keeps its promise that nothing reaches the project. The sandbox is a copy
// in the app's data folder, private to the person; frames swap files inside it; drafts keep no secrets; the fence
// refuses every request and every write that could reach past the copy; ending, quitting and the next start all
// delete the copy with its `.env`. Each property is also checked from the negative side: what is refused, what
// is left behind when something fails, what a crash leaves.
//
// Method: real folders under the temporary directory. A small fixture project (pages, a style file, a `.env`,
// a node_modules with an `astro` package) stands in for a site; nothing runs Astro. The session is driven through
// `createDesignSessions` with a stand-in host, the same function the IPC handler calls, on this computer's own
// platform: every test runs on macOS, Windows and Linux. Links between folders are made as junctions, which Windows
// lets anyone make and other systems take for an ordinary link. The platform rule and main's refusal take the
// platform as an argument. Stopping what still runs from a copy has its own suite (designLeftovers.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandbox, ensurePrivateDirectory, isSecretFile, sweepSandboxes, sandboxesRoot } from '#dist/electron/handlers/designMode/designSandbox.js';
import { applyFrame, captureChanges } from '#dist/electron/handlers/designMode/designFrames.js';
import { draftFolder, readDraft, saveDraft } from '#dist/electron/handlers/designMode/designDrafts.js';
import { createDesignSessions } from '#dist/electron/handlers/designMode/designModeHandlers.js';
import {
  checkDesignFence,
  designFenceState,
  designWriteAllowed,
  lowerDesignFence,
  observeDesignFence,
  raiseDesignFence,
} from '#dist/electron/lib/designMode/designFence.js';
import { guardDesignWrites } from '#dist/electron/lib/designMode/designWriteGuard.js';
import { designModeAvailable, parseDesignSessionReply, parseDesignSessionRequest } from '#dist/shared/ipc/designSession.js';
import {
  DESIGN_SNAPSHOT_LIMITS,
  deepestDesignNode,
  designNodeMark,
  parseDesignCanvasMessage,
  parseDesignSnapshotRequest,
} from '#dist/shared/ipc/designSnapshot.js';

const REFUSAL = 'Not while you design';

function scratch(): { readonly project: string; readonly appData: string; readonly root: string } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-design-')));
  const project = path.join(root, 'site');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
  };
  write('src/pages/index.astro', '---\n---\n<h1 class="title">Hello</h1>\n');
  write('src/styles/global.css', '.title { color: red; }\n');
  write('.env', 'SECRET=1\n');
  write('.git/HEAD', 'ref: refs/heads/main\n');
  write('dist/index.html', '<html></html>');
  write('node_modules/astro/package.json', '{"name":"astro"}');
  // A second app inside the project, as in a real site that holds its own tooling: never copied but its source.
  write('studio/node_modules/huge/index.js', 'x');
  write('studio/dist/app.js', 'x');
  write('studio/src/index.ts', 'export {};');
  write('.claude/worktrees/agent/src/pages/index.astro', 'x');
  const appData = path.join(root, 'userData');
  fs.mkdirSync(appData);
  return { project, appData, root };
}

/** Only the person may enter `directory`. Windows has no mode bits: the app data folder is the person's own there. */
function assertPrivate(directory: string): void {
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
}

/** Every file under `directory` and its bytes, as one string: equal strings mean an untouched tree. */
function digest(directory: string): string {
  const parts: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const rel = pending.pop() ?? '';
    for (const entry of fs.readdirSync(path.join(directory, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else {
        parts.push(`${child}:${fs.readFileSync(path.join(directory, child), 'base64')}`);
      }
    }
  }
  return parts.sort().join('\n');
}

test('the sandbox is one private copy outside the project; the project is its original; output is skipped at any depth', async () => {
  const { project, appData } = scratch();
  const before = digest(project);
  const created = await createSandbox({ appDataRoot: appData, realRoot: project });
  assert.ok(created.ok);
  const { sandbox } = created;
  assert.ok(sandbox.root.startsWith(sandboxesRoot(appData)));
  assertPrivate(sandboxesRoot(appData));
  assertPrivate(sandbox.root);
  assert.equal(fs.readFileSync(path.join(sandbox.live, '.env'), 'utf8'), 'SECRET=1\n');
  assert.ok(fs.existsSync(path.join(sandbox.live, 'node_modules/astro/package.json')));
  assert.equal(sandbox.base, fs.realpathSync.native(project), 'the original is the project itself, never copied twice');
  assert.ok(!fs.existsSync(path.join(sandbox.live, 'studio/node_modules')), "a nested app's dependencies are skipped");
  assert.ok(!fs.existsSync(path.join(sandbox.live, 'studio/dist')), 'and its build');
  assert.ok(fs.existsSync(path.join(sandbox.live, 'studio/src/index.ts')), 'its source is copied');
  assert.ok(!fs.existsSync(path.join(sandbox.live, '.git')));
  assert.ok(!fs.existsSync(path.join(sandbox.live, 'dist')));
  assert.equal(digest(project), before, 'copying reads the project and writes nothing in it');
});

test('a project that links outside itself, or keeps its packages above it, is refused and nothing is left', async () => {
  const linked = scratch();
  fs.symlinkSync(os.tmpdir(), path.join(linked.project, 'src/outside'), 'junction');
  const refused = await createSandbox({ appDataRoot: linked.appData, realRoot: linked.project });
  assert.deepEqual(refused, { ok: false, reason: 'outside-link' });
  assert.ok(!fs.existsSync(sandboxesRoot(linked.appData)), 'refused before anything was made');

  const hoisted = scratch();
  fs.rmSync(path.join(hoisted.project, 'node_modules'), { recursive: true });
  assert.deepEqual(await createSandbox({ appDataRoot: hoisted.appData, realRoot: hoisted.project }), { ok: false, reason: 'outside-link' });

  const inside = scratch();
  // Windows keeps a junction's whole path; elsewhere the link is as written.
  const written = process.platform === 'win32' ? path.join(inside.project, 'src/styles') : path.join('..', 'styles');
  fs.symlinkSync(written, path.join(inside.project, 'src/pages/styles'), 'junction');
  const kept = await createSandbox({ appDataRoot: inside.appData, realRoot: inside.project });
  assert.ok(kept.ok);
  const copied = path.join(kept.sandbox.live, 'src/pages/styles');
  assert.equal(fs.realpathSync.native(copied), fs.realpathSync.native(path.join(kept.sandbox.live, 'src/styles')), 'the link names the copy’s own folder');
  if (process.platform !== 'win32') {
    assert.equal(fs.readlinkSync(copied), path.join('..', 'styles'));
  }
});

test('a change made the moment the copy is ready is seen, though it keeps the file’s size', async () => {
  // What a kept draft does as the mode begins. Linux stamps a file from a clock that lags the one the copy is timed by.
  const { project, appData } = scratch();
  const created = await createSandbox({ appDataRoot: appData, realRoot: project });
  assert.ok(created.ok);
  const { base, live, copiedAtMs } = created.sandbox;
  fs.writeFileSync(path.join(live, 'src/styles/global.css'), '.title { color: tan; }\n');
  assert.deepEqual([...(await captureChanges(base, live, copiedAtMs)).keys()], ['src/styles/global.css']);
});

test('a sandbox a crash left behind is swept, with its .env; private folders are checked', async () => {
  const { appData } = scratch();
  const left = path.join(sandboxesRoot(appData), 'left-by-a-crash', 'live');
  fs.mkdirSync(left, { recursive: true });
  fs.writeFileSync(path.join(left, '.env'), 'SECRET=1\n');
  assert.equal(await sweepSandboxes(appData), 1);
  assert.deepEqual(fs.readdirSync(sandboxesRoot(appData)), []);
  assert.equal(await sweepSandboxes(path.join(appData, 'never-made')), 0);
  const folder = path.join(appData, 'private');
  ensurePrivateDirectory(folder);
  assertPrivate(folder);
});

test('frames: what live differs by is captured and applied both ways', async () => {
  const { project, appData } = scratch();
  const created = await createSandbox({ appDataRoot: appData, realRoot: project });
  assert.ok(created.ok);
  const { base, live, copiedAtMs } = created.sandbox;
  assert.equal((await captureChanges(base, live, copiedAtMs)).size, 0, 'a fresh copy differs by nothing');
  fs.writeFileSync(path.join(live, 'src/styles/global.css'), '.title { color: blue; }\n');
  fs.writeFileSync(path.join(live, 'src/pages/new.astro'), '<p>new</p>\n');
  fs.rmSync(path.join(live, 'src/pages/index.astro'));
  const changed = await captureChanges(base, live, copiedAtMs);
  assert.deepEqual([...changed.keys()].sort(), ['src/pages/index.astro', 'src/pages/new.astro', 'src/styles/global.css']);
  assert.equal(changed.get('src/pages/index.astro')?.kind, 'delete');
  await applyFrame({ base, live, from: changed, to: new Map() });
  assert.equal((await captureChanges(base, live, copiedAtMs)).size, 0, 'back to the project as copied');
  await applyFrame({ base, live, from: new Map(), to: changed });
  assert.equal(fs.readFileSync(path.join(live, 'src/styles/global.css'), 'utf8'), '.title { color: blue; }\n');
  assert.ok(!fs.existsSync(path.join(live, 'src/pages/index.astro')));
  await assert.rejects(applyFrame({ base, live, from: new Map(), to: new Map([['../escape.txt', { kind: 'delete' }]]) }), /inside the copy/);
});

test('drafts keep no secrets, notice a changed project, and refuse a kept path that climbs', async () => {
  const { project, appData } = scratch();
  const created = await createSandbox({ appDataRoot: appData, realRoot: project });
  assert.ok(created.ok);
  const files = new Map([
    ['src/styles/global.css', { kind: 'write' as const, bytes: Buffer.from('.title{}') }],
    ['.env', { kind: 'write' as const, bytes: Buffer.from('SECRET=2') }],
  ]);
  saveDraft({
    appDataRoot: appData,
    realRoot: project,
    base: created.sandbox.base,
    draft: { frames: [{ id: 'f1', name: 'One', at: { x: 0, y: 0 }, files }], active: 'f1' },
  });
  const text = fs.readFileSync(path.join(draftFolder(appData, project), 'draft.json'), 'utf8');
  assert.ok(!text.includes(Buffer.from('SECRET=2').toString('base64')));
  assertPrivate(draftFolder(appData, project));
  const read = readDraft({ appDataRoot: appData, realRoot: project, base: created.sandbox.base });
  assert.equal(read.kind, 'draft');
  assert.ok(read.kind === 'draft' && !read.stale && read.draft.frames[0]?.files.size === 1);
  fs.writeFileSync(path.join(project, 'src/styles/global.css'), '.changed{}');
  const stale = readDraft({ appDataRoot: appData, realRoot: project, base: created.sandbox.base });
  assert.ok(stale.kind === 'draft' && stale.stale);
  fs.writeFileSync(path.join(draftFolder(appData, project), 'draft.json'), text.replace('src/styles/global.css', '../../escape.css'));
  assert.deepEqual(readDraft({ appDataRoot: appData, realRoot: project, base: created.sandbox.base }), { kind: 'none' });
  // A draft kept before frames had places is laid out in a row.
  fs.writeFileSync(path.join(draftFolder(appData, project), 'draft.json'), text.replace('"at":{"x":0,"y":0},', ''));
  const unplaced = readDraft({ appDataRoot: appData, realRoot: project, base: created.sandbox.base });
  assert.ok(unplaced.kind === 'draft');
  assert.deepEqual(unplaced.draft.frames[0]?.at, { x: 0, y: 0 });
  assert.ok(isSecretFile('.env.production'));
  assert.ok(isSecretFile('certs/site.pem'));
  assert.ok(!isSecretFile('src/env.ts'));
});

test('the fence refuses unlisted channels, the project and climbing paths, and lets the copy be edited', async () => {
  const { project, appData } = scratch();
  const created = await createSandbox({ appDataRoot: appData, realRoot: project });
  assert.ok(created.ok);
  const { live, root } = created.sandbox;
  checkDesignFence('git:commit', { projectPath: project }); // Down: everything passes.
  raiseDesignFence({ sandboxRoot: root, realRoot: project, refusal: REFUSAL, appDataRoot: appData });
  try {
    assert.throws(() => checkDesignFence('git:commit', { projectPath: live }), { message: REFUSAL });
    assert.throws(() => checkDesignFence('publish:start', { projectPath: live }), { message: REFUSAL });
    assert.throws(() => checkDesignFence('publish:netlifySite', { projectPath: live, site: { team: 'acme', name: 'x' } }), { message: REFUSAL });
    assert.throws(() => checkDesignFence('terminal:start', {}), { message: REFUSAL });
    assert.throws(() => checkDesignFence('ai:prompt', { projectPath: live }), { message: REFUSAL });
    assert.throws(() => checkDesignFence('a:channelAddedLater', {}), { message: REFUSAL });
    assert.throws(() => checkDesignFence('page:edit', { projectPath: project, edits: [] }), { message: REFUSAL });
    assert.throws(() => checkDesignFence('style:writeFile', { projectPath: live, rel: '../../site/src/x.css' }), { message: REFUSAL });
    assert.throws(() => checkDesignFence('watch:start', project), { message: REFUSAL });
    assert.throws(() => checkDesignFence('shell:openExternal', `file://${project}`), { message: REFUSAL });
    assert.deepEqual(checkDesignFence('git:info', live), { kind: 'answer', value: { isRepo: false } }, 'the copy is no repository');
    assert.deepEqual(checkDesignFence('page:edit', { projectPath: live, edits: [{ text: '/about' }] }), { kind: 'run' });
    checkDesignFence('watch:start', live);
    checkDesignFence('assets:upload', { projectPath: live, destRel: 'public', filePaths: [path.join(project, 'photo.png')] });
    checkDesignFence('shell:openExternal', 'https://astro.build');
    checkDesignFence('project:close', project);
  } finally {
    lowerDesignFence();
  }
});

test('while the fence is up, every file system write into the project fails before it runs', async () => {
  const { project, appData } = scratch();
  const created = await createSandbox({ appDataRoot: appData, realRoot: project });
  assert.ok(created.ok);
  guardDesignWrites();
  const before = digest(project);
  raiseDesignFence({ sandboxRoot: created.sandbox.root, realRoot: project, refusal: REFUSAL, appDataRoot: appData });
  try {
    const target = path.join(project, 'src/pages/index.astro');
    assert.equal(designWriteAllowed(target), false);
    assert.throws(() => fs.writeFileSync(target, 'x'), { code: 'EACCES' });
    assert.throws(() => fs.rmSync(path.join(project, 'src'), { recursive: true }), { code: 'EACCES' });
    assert.throws(() => fs.renameSync(target, path.join(created.sandbox.live, 'stolen.astro')), { code: 'EACCES' });
    assert.throws(() => fs.openSync(target, 'a'), { code: 'EACCES' });
    assert.throws(() => fs.mkdirSync(path.join(project, 'new')), { code: 'EACCES' });
    await assert.rejects(fs.promises.writeFile(target, 'x'), { code: 'EACCES' });
    await assert.rejects(fs.promises.cp(path.join(created.sandbox.live, 'src'), path.join(project, 'src2'), { recursive: true }), { code: 'EACCES' });
    await new Promise<void>((resolve) => {
      fs.unlink(target, (error) => {
        assert.equal(error?.code, 'EACCES');
        resolve();
      });
    });
    // Through a link in the copy that points back at the project: the target is resolved first.
    fs.symlinkSync(path.join(project, 'src'), path.join(created.sandbox.live, 'back'), 'junction');
    assert.throws(() => fs.writeFileSync(path.join(created.sandbox.live, 'back/pages/index.astro'), 'x'), { code: 'EACCES' });
    fs.writeFileSync(path.join(created.sandbox.live, 'src/pages/index.astro'), 'edited in the copy');
    fs.writeFileSync(path.join(appData, 'settings.json'), '{}');
    assert.equal(fs.readFileSync(target, 'utf8').includes('Hello'), true, 'reading the project is not a write');
  } finally {
    lowerDesignFence();
  }
  assert.equal(digest(project), before);
  fs.writeFileSync(path.join(project, 'after.txt'), 'the fence is down');
});

test('a session: enter, edit, duplicate, switch, leave; the copy and its .env are gone, the project is untouched', async () => {
  const { project, appData } = scratch();
  const before = digest(project);
  const sent: { readonly channel: string; readonly payload: unknown }[] = [];
  const send = (channel: string, payload: unknown) => void sent.push({ channel, payload });
  const sessions = createDesignSessions({ openProject: () => project, send }, { appDataRoot: appData, platform: process.platform });
  observeDesignFence(sessions.observe);
  const ask = async (request: unknown) => parseDesignSessionReply(await sessions.answer(parseDesignSessionRequest(request)));
  assert.deepEqual(await ask({ op: 'enter', projectPath: path.join(project, 'elsewhere'), refusal: REFUSAL, frameName: 'Original' }), {
    kind: 'refused',
    reason: 'not-open',
    folder: undefined,
  });
  const snapshot = { html: '<html><body>seed</body></html>', url: 'http://localhost:1/', title: 'Seed', viewportWidthPx: 1200, viewportHeightPx: 800 };
  const entering = { op: 'enter', projectPath: project, page: 'src/pages/index.astro', refusal: REFUSAL, frameName: 'Original', snapshot };
  const entered = await ask(entering);
  assert.equal(entered.kind, 'entered');
  assert.equal(designFenceState().kind, 'on');
  const live = entered.kind === 'entered' ? entered.liveRoot : '';
  checkDesignFence('project:close', live); // The window opening the copy does not end the session.
  assert.ok(sessions.current() !== undefined);
  fs.writeFileSync(path.join(live, 'src/styles/global.css'), '.title { color: green; }\n');
  const duplicated = await ask({ op: 'frame-duplicate', source: 'f1', name: 'Green', at: { x: 1520, y: 40 } });
  assert.ok(duplicated.kind === 'state' && duplicated.state.kind === 'on' && duplicated.state.frames.length === 2);
  assert.equal(duplicated.state.active, 'f1', 'duplicating leaves the copy showing the same frame');
  assert.deepEqual(duplicated.state.frames[1]?.at, { x: 1520, y: 40 });
  const pictured = await ask({ op: 'frame-snapshots' });
  assert.deepEqual(pictured, {
    kind: 'snapshots',
    snapshots: [
      { frame: 'f1', snapshot },
      { frame: 'f2', snapshot },
    ],
  });
  // Switching hands back the asked page as the shown frame holds it; a page outside the copy is never read.
  const page = path.join(live, 'src/styles/global.css');
  const switched = await ask({ op: 'frame-switch', frame: 'f2', page });
  assert.ok(switched.kind === 'shown' && switched.pageSource === '.title { color: green; }\n');
  const outside = await ask({ op: 'frame-switch', frame: 'f2', page: path.join(project, 'src/styles/global.css') });
  assert.ok(outside.kind === 'shown' && outside.pageSource === undefined);
  fs.writeFileSync(path.join(live, 'src/styles/global.css'), '.title { color: purple; }\n');
  await ask({ op: 'frame-move', frame: 'f2', at: { x: -300, y: 12 } });
  const drawn = { ...snapshot, html: '<html><body>purple</body></html>' };
  assert.deepEqual(await ask({ op: 'frame-snapshot', frame: 'f2', snapshot: drawn }), { kind: 'kept' });
  assert.deepEqual(await ask({ op: 'frame-snapshot', frame: 'f7', snapshot: drawn }), { kind: 'kept' }, 'a frame that is gone is not made');
  // Showing a frame announces what it rewrote: the watcher would take bytes the editor saved before for its own.
  sent.length = 0;
  await ask({ op: 'frame-switch', frame: 'f1' });
  assert.deepEqual(sent, [
    { channel: 'fs:changed', payload: { files: [path.join(live, 'src/styles/global.css')] } },
    { channel: 'css:changed', payload: {} },
  ]);
  sent.length = 0;
  await ask({ op: 'frame-switch', frame: 'f1' });
  await ask({ op: 'frame-rename', frame: 'f2', name: 'Purple' });
  assert.deepEqual([...sent], [], 'nothing rewritten, nothing announced');
  assert.equal(fs.readFileSync(path.join(live, 'src/styles/global.css'), 'utf8'), '.title { color: green; }\n');
  await ask({ op: 'frame-switch', frame: 'f2' });
  assert.equal(fs.readFileSync(path.join(live, 'src/styles/global.css'), 'utf8'), '.title { color: purple; }\n');
  assert.throws(() => parseDesignSessionRequest({ op: 'changes' }), /unknown op/, 'no source change is ever described');
  assert.deepEqual(await ask({ op: 'exit', handoff: { text: 'Rebuild it like this', images: [], names: [] } }), { kind: 'left', realRoot: project });
  assert.deepEqual(await ask({ op: 'take-handoff' }), { kind: 'handoff', handoff: undefined }, 'not while the copy is still open');
  checkDesignFence('project:close', project);
  assert.equal(designFenceState().kind, 'off');
  await sessions.end();
  assert.equal(sessions.current(), undefined);
  assert.deepEqual(fs.readdirSync(sandboxesRoot(appData)), []);
  assert.deepEqual(await ask({ op: 'take-handoff' }), { kind: 'handoff', handoff: { text: 'Rebuild it like this', images: [], names: [] } });
  assert.deepEqual(await ask({ op: 'take-handoff' }), { kind: 'handoff', handoff: undefined }, 'handed over once');
  assert.equal(digest(project), before);

  // Before coming back, the kept frames can be drawn at once; another project's, or none, are never read.
  const preview = await ask({ op: 'preview', projectPath: project });
  assert.ok(preview.kind === 'preview' && preview.frames.length === 2 && preview.snapshots.length === 2);
  assert.deepEqual(await ask({ op: 'preview', projectPath: path.join(project, 'elsewhere') }), { kind: 'preview', frames: [], snapshots: [] });

  // Coming back: the frames return from the draft, the shown one laid over the new copy.
  const again = await ask({ op: 'enter', projectPath: project, refusal: REFUSAL, frameName: 'Original' });
  const state = await ask({ op: 'state' });
  assert.ok(state.kind === 'state' && state.state.kind === 'on' && state.state.frames.length === 2 && state.state.active === 'f2');
  const againLive = again.kind === 'entered' ? again.liveRoot : '';
  assert.equal(fs.readFileSync(path.join(againLive, 'src/styles/global.css'), 'utf8'), '.title { color: purple; }\n');
  const back = await ask({ op: 'frame-snapshots' });
  assert.deepEqual(
    back,
    {
      kind: 'snapshots',
      snapshots: [
        { frame: 'f1', snapshot },
        { frame: 'f2', snapshot: drawn },
      ],
    },
    'frames come back drawn',
  );
  assert.ok(state.state.kind === 'on' && state.state.frames[1]?.at.x === -300);
  const removed = await ask({ op: 'frame-delete', frame: 'f2' });
  assert.ok(removed.kind === 'shown' && removed.state.kind === 'on' && removed.state.active === 'f1' && removed.state.frames.length === 1);
  assert.equal(fs.readFileSync(path.join(againLive, 'src/styles/global.css'), 'utf8'), '.title { color: green; }\n');
  assert.ok(!fs.existsSync(path.join(draftFolder(appData, project), 'f2.snapshot.json')), "a removed frame's document goes with it");
  await assert.rejects(ask({ op: 'frame-delete', frame: 'f1' }), /the last frame stays/);
  sent.length = 0;
  const over = await ask({ op: 'start-over', frameName: 'Original' });
  assert.equal(sent.at(0)?.channel, 'fs:changed');
  assert.ok(over.kind === 'shown' && over.state.kind === 'on' && over.state.frames.length === 1 && over.state.frames[0]?.changedFiles === 0);
  await sessions.end(); // As the window leaves the copy.
  assert.equal(designFenceState().kind, 'off');
  assert.deepEqual(fs.readdirSync(sandboxesRoot(appData)), []);
  assert.equal(digest(project), before);
  observeDesignFence(undefined);
});

test('requests and replies are parsed: unknown ops, bad frame ids, oversized names and foreign images are refused', () => {
  assert.throws(() => parseDesignSessionRequest({ op: 'format-disk' }), /unknown op/);
  assert.throws(() => parseDesignSessionRequest({ op: 'frame-switch', frame: 'f0' }), /frame id/);
  assert.throws(() => parseDesignSessionRequest({ op: 'frame-switch', frame: '../f1' }), /frame id/);
  const duplicate = { op: 'frame-duplicate', source: 'f1', at: { x: 0, y: 0 } };
  assert.throws(() => parseDesignSessionRequest({ ...duplicate, name: '  ' }), /expected text/);
  assert.throws(() => parseDesignSessionRequest({ ...duplicate, name: 'x'.repeat(61) }), /exceeds/);
  assert.throws(() => parseDesignSessionRequest({ op: 'frame-move', frame: 'f1', at: { x: 0.5, y: 0 } }), /whole numbers/);
  assert.throws(() => parseDesignSessionRequest({ op: 'frame-move', frame: 'f1', at: { x: 2_000_000, y: 0 } }), /too far/);
  const handoff = { text: 'x', images: ['data:text/html,<script>'], names: ['One'] };
  assert.throws(() => parseDesignSessionRequest({ op: 'exit', handoff }), /PNG/);
  const snapshot = { html: '<html></html>', url: '', title: '', viewportWidthPx: 10, viewportHeightPx: 10 };
  const keep = (change: object) => () => parseDesignSessionRequest({ op: 'frame-snapshot', frame: 'f1', snapshot: { ...snapshot, ...change } });
  assert.throws(keep({ html: '' }), /expected a document/);
  assert.throws(keep({ html: 'x'.repeat(DESIGN_SNAPSHOT_LIMITS.htmlCharsMax + 1) }), /exceeds/);
  assert.throws(keep({ viewportWidthPx: 1_000_000 }), /too large/);
  assert.throws(() => parseDesignSessionReply({ kind: 'state', state: { kind: 'on', frames: [], active: 'f1' } }), /at least one/);
  assert.throws(() => parseDesignSessionReply({ kind: 'refused', reason: 'because' }), /unknown refusal/);
  assert.deepEqual(parseDesignSessionRequest({ op: 'frame-rename', frame: 'f2', name: ' Bold ' }), { op: 'frame-rename', frame: 'f2', name: 'Bold' });
});

test('the preflight refuses a project past its bounds, naming the largest folder, and leaves nothing', async () => {
  const { project, appData } = scratch();
  for (let index = 0; index < 20_050; index += 1) {
    const folder = path.join(project, 'src/content/many', String(Math.floor(index / 500)));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${index}.md`), 'x');
  }
  const refused = await createSandbox({ appDataRoot: appData, realRoot: project });
  assert.deepEqual(refused, { ok: false, reason: 'too-large', folder: 'src' });
  assert.ok(!fs.existsSync(sandboxesRoot(appData)) || fs.readdirSync(sandboxesRoot(appData)).length === 0, 'nothing was made');
});

test('a copy the person cancels stops and leaves nothing', async () => {
  const { project, appData } = scratch();
  const cancelled = await createSandbox({ appDataRoot: appData, realRoot: project, cancel: { cancelled: () => true } });
  assert.deepEqual(cancelled, { ok: false, reason: 'cancelled' });
  assert.ok(!fs.existsSync(sandboxesRoot(appData)) || fs.readdirSync(sandboxesRoot(appData)).length === 0);
});

test("a canvas frame's messages and node marks are parsed: forged and malformed ones are ignored", () => {
  // A request that does not say the page may be walked leaves it where it is.
  const asked = { type: 'stacki:design-snapshot', nonce: 'a' } as const;
  assert.deepEqual(parseDesignSnapshotRequest(asked), { ...asked, walking: 'held' });
  assert.deepEqual(parseDesignSnapshotRequest({ ...asked, walking: 'allowed' }), { ...asked, walking: 'allowed' });
  assert.deepEqual(parseDesignSnapshotRequest({ ...asked, walking: 'yes' }), { ...asked, walking: 'held' });
  const heard = { type: 'stacki:design-snapshot-started', nonce: 'a' } as const;
  assert.deepEqual(parseDesignCanvasMessage(heard), heard);
  assert.equal(parseDesignCanvasMessage({ ...heard, nonce: 'a'.repeat(65) }), undefined);
  assert.equal(parseDesignCanvasMessage({ type: heard.type }), undefined);
  assert.equal(parseDesignSnapshotRequest({ type: 'stacki:design-snapshot', nonce: 'a'.repeat(65) }), undefined);
  assert.equal(parseDesignSnapshotRequest({ type: 'avb:render' }), undefined);
  assert.equal(parseDesignCanvasMessage({ type: 'stacki:design-snapshot-reply', nonce: 'a', ok: true, snapshot: {} }), undefined);
  assert.equal(parseDesignCanvasMessage('stacki:design-changed'), undefined);
  const marks = [designNodeMark('0.1', 0), designNodeMark('0.1.2', 3)].join(' ');
  assert.deepEqual(deepestDesignNode(marks), { path: '0.1.2', copy: 3 });
  const spaced = designNodeMark('src/components/Hero Card.astro|0.1', 1);
  assert.ok(!spaced.includes(' '), 'a space in a file name cannot split a mark');
  assert.deepEqual(deepestDesignNode(spaced), { path: 'src/components/Hero Card.astro|0.1', copy: 1 });
  assert.equal(deepestDesignNode('0.1 0.2:-1 :3 %E0%A4%A:1'), undefined);
});

test('Design mode is offered on macOS, Windows and Linux, and nowhere else', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(designModeAvailable(platform), true, platform);
  }
  for (const platform of ['freebsd', 'openbsd', 'sunos', 'aix', 'android', '']) {
    assert.equal(designModeAvailable(platform), false, platform);
  }
});

test('elsewhere, main refuses every design:session request and makes no copy', async () => {
  const { project, appData } = scratch();
  for (const platform of ['freebsd', 'sunos'] as const) {
    // What the design:session handler calls with every request (registerDesignModeHandlers).
    const sessions = createDesignSessions({ openProject: () => project, send: () => undefined }, { appDataRoot: appData, platform });
    for (const request of [{ op: 'enter', projectPath: project, refusal: REFUSAL, frameName: 'Original' }, { op: 'state' }, { op: 'cancel' }]) {
      await assert.rejects(sessions.answer(parseDesignSessionRequest(request)), /not available on this computer/, `${platform} ${request.op}`);
    }
    assert.equal(sessions.current(), undefined);
  }
  assert.ok(!fs.existsSync(sandboxesRoot(appData)), 'no copy, and so no copy of .env');
  assert.equal(designFenceState().kind, 'off');
});
