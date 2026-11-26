// Goal: Design mode's main process half keeps its promise that nothing reaches the project. The sandbox is a copy
// in the app's data folder, private to the person; frames swap files inside it; drafts keep no secrets; the fence
// refuses every request and every write that could reach past the copy; ending, quitting and the next start all
// delete the copy with its `.env`. Each property is also checked from the negative side: what is refused, what
// is left behind when something fails, what a crash leaves.
//
// Method: real folders under the temporary directory. A small fixture project (pages, a style file, a `.env`,
// a node_modules with an `astro` package) stands in for a site; nothing runs Astro. The session is driven through
// `createDesignSessions` with a stand-in host, the same function the IPC handler calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandbox, ensurePrivateDirectory, sweepSandboxes, sandboxesRoot } from '#dist/electron/handlers/designMode/designSandbox.js';
import { applyFrame, captureChanges, describeFile } from '#dist/electron/handlers/designMode/designFrames.js';
import { draftFolder, isSecretFile, readDraft, saveDraft } from '#dist/electron/handlers/designMode/designDrafts.js';
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
import { parseDesignSessionReply, parseDesignSessionRequest } from '#dist/shared/ipc/designSession.js';

const REFUSAL = 'Not while you design';

function scratch(): { readonly project: string; readonly appData: string; readonly root: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-design-')));
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
  const appData = path.join(root, 'userData');
  fs.mkdirSync(appData);
  return { project, appData, root };
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

test('the sandbox is a private copy outside the project: base and live, node_modules in live only, output skipped', async () => {
  const { project, appData } = scratch();
  const before = digest(project);
  const created = await createSandbox({ appDataRoot: appData, realRoot: project });
  assert.ok(created.ok);
  const { sandbox } = created;
  assert.ok(sandbox.root.startsWith(sandboxesRoot(appData)));
  assert.equal(fs.statSync(sandboxesRoot(appData)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(sandbox.root).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(sandbox.live, '.env'), 'utf8'), 'SECRET=1\n');
  assert.ok(fs.existsSync(path.join(sandbox.live, 'node_modules/astro/package.json')));
  assert.ok(!fs.existsSync(path.join(sandbox.base, 'node_modules')));
  assert.ok(!fs.existsSync(path.join(sandbox.live, '.git')));
  assert.ok(!fs.existsSync(path.join(sandbox.live, 'dist')));
  assert.equal(digest(project), before, 'copying reads the project and writes nothing in it');
});

test('a project that links outside itself, or keeps its packages above it, is refused and nothing is left', async () => {
  const linked = scratch();
  fs.symlinkSync(os.tmpdir(), path.join(linked.project, 'src/outside'));
  const refused = await createSandbox({ appDataRoot: linked.appData, realRoot: linked.project });
  assert.deepEqual(refused, { ok: false, reason: 'outside-link' });
  assert.deepEqual(fs.readdirSync(sandboxesRoot(linked.appData)), []);

  const hoisted = scratch();
  fs.rmSync(path.join(hoisted.project, 'node_modules'), { recursive: true });
  assert.deepEqual(await createSandbox({ appDataRoot: hoisted.appData, realRoot: hoisted.project }), { ok: false, reason: 'outside-link' });

  const inside = scratch();
  fs.symlinkSync('../styles', path.join(inside.project, 'src/pages/styles'));
  const kept = await createSandbox({ appDataRoot: inside.appData, realRoot: inside.project });
  assert.ok(kept.ok);
  assert.equal(fs.readlinkSync(path.join(kept.sandbox.live, 'src/pages/styles')), '../styles');
});

test('a sandbox a crash left behind is swept, with its .env; private folders are checked', () => {
  const { appData } = scratch();
  const left = path.join(sandboxesRoot(appData), 'left-by-a-crash', 'live');
  fs.mkdirSync(left, { recursive: true });
  fs.writeFileSync(path.join(left, '.env'), 'SECRET=1\n');
  assert.equal(sweepSandboxes(appData), 1);
  assert.deepEqual(fs.readdirSync(sandboxesRoot(appData)), []);
  assert.equal(sweepSandboxes(path.join(appData, 'never-made')), 0);
  const folder = path.join(appData, 'private');
  ensurePrivateDirectory(folder);
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
});

test('frames: what live differs by is captured, applied both ways, and described as hunks', async () => {
  const { project, appData } = scratch();
  const created = await createSandbox({ appDataRoot: appData, realRoot: project });
  assert.ok(created.ok);
  const { base, live, copiedAtMs } = created.sandbox;
  assert.equal(captureChanges(base, live, copiedAtMs).size, 0, 'a fresh copy differs by nothing');
  fs.writeFileSync(path.join(live, 'src/styles/global.css'), '.title { color: blue; }\n');
  fs.writeFileSync(path.join(live, 'src/pages/new.astro'), '<p>new</p>\n');
  fs.rmSync(path.join(live, 'src/pages/index.astro'));
  const changed = captureChanges(base, live, copiedAtMs);
  assert.deepEqual([...changed.keys()].sort(), ['src/pages/index.astro', 'src/pages/new.astro', 'src/styles/global.css']);
  assert.equal(changed.get('src/pages/index.astro')?.kind, 'delete');
  applyFrame({ base, live, from: changed, to: new Map() });
  assert.equal(captureChanges(base, live, copiedAtMs).size, 0, 'back to the project as copied');
  applyFrame({ base, live, from: new Map(), to: changed });
  assert.equal(fs.readFileSync(path.join(live, 'src/styles/global.css'), 'utf8'), '.title { color: blue; }\n');
  assert.ok(!fs.existsSync(path.join(live, 'src/pages/index.astro')));
  assert.throws(() => applyFrame({ base, live, from: new Map(), to: new Map([['../escape.txt', { kind: 'delete' }]]) }), /inside the copy/);
  const hunk = describeFile('a.css', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  assert.equal(hunk, 'a.css @@ line 2\n- two\n+ TWO');
});

test('drafts keep no secrets, notice a changed project, and refuse a kept path that climbs', async () => {
  const { project, appData } = scratch();
  const created = await createSandbox({ appDataRoot: appData, realRoot: project });
  assert.ok(created.ok);
  const files = new Map([
    ['src/styles/global.css', { kind: 'write' as const, bytes: Buffer.from('.title{}') }],
    ['.env', { kind: 'write' as const, bytes: Buffer.from('SECRET=2') }],
  ]);
  saveDraft({ appDataRoot: appData, realRoot: project, base: created.sandbox.base, draft: { frames: [{ id: 'f1', name: 'One', files }], active: 'f1' } });
  const text = fs.readFileSync(path.join(draftFolder(appData, project), 'draft.json'), 'utf8');
  assert.ok(!text.includes(Buffer.from('SECRET=2').toString('base64')));
  assert.equal(fs.statSync(draftFolder(appData, project)).mode & 0o777, 0o700);
  const read = readDraft({ appDataRoot: appData, realRoot: project, base: created.sandbox.base });
  assert.equal(read.kind, 'draft');
  assert.ok(read.kind === 'draft' && !read.stale && read.draft.frames[0]?.files.size === 1);
  fs.writeFileSync(path.join(created.sandbox.base, 'src/styles/global.css'), '.changed{}');
  const stale = readDraft({ appDataRoot: appData, realRoot: project, base: created.sandbox.base });
  assert.ok(stale.kind === 'draft' && stale.stale);
  fs.writeFileSync(path.join(draftFolder(appData, project), 'draft.json'), text.replace('src/styles/global.css', '../../escape.css'));
  assert.deepEqual(readDraft({ appDataRoot: appData, realRoot: project, base: created.sandbox.base }), { kind: 'none' });
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
    fs.symlinkSync(path.join(project, 'src'), path.join(created.sandbox.live, 'back'));
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
  const sessions = createDesignSessions({ openProject: () => project }, { appDataRoot: appData });
  observeDesignFence(sessions.observe);
  const ask = async (request: unknown) => parseDesignSessionReply(await sessions.answer(parseDesignSessionRequest(request)));
  assert.deepEqual(await ask({ op: 'enter', projectPath: path.join(project, 'elsewhere'), refusal: REFUSAL, frameName: 'Original' }), {
    kind: 'refused',
    reason: 'not-open',
  });
  const entered = await ask({ op: 'enter', projectPath: project, page: 'src/pages/index.astro', refusal: REFUSAL, frameName: 'Original' });
  assert.equal(entered.kind, 'entered');
  assert.equal(designFenceState().kind, 'on');
  const live = entered.kind === 'entered' ? entered.liveRoot : '';
  checkDesignFence('project:close', live); // The window opening the copy does not end the session.
  assert.ok(sessions.current() !== undefined);
  fs.writeFileSync(path.join(live, 'src/styles/global.css'), '.title { color: green; }\n');
  const duplicated = await ask({ op: 'frame-duplicate', name: 'Green' });
  assert.ok(duplicated.kind === 'state' && duplicated.state.kind === 'on' && duplicated.state.frames.length === 2 && duplicated.state.active === 'f2');
  fs.writeFileSync(path.join(live, 'src/styles/global.css'), '.title { color: purple; }\n');
  await ask({ op: 'frame-switch', frame: 'f1' });
  assert.equal(fs.readFileSync(path.join(live, 'src/styles/global.css'), 'utf8'), '.title { color: green; }\n');
  await ask({ op: 'frame-switch', frame: 'f2' });
  assert.equal(fs.readFileSync(path.join(live, 'src/styles/global.css'), 'utf8'), '.title { color: purple; }\n');
  const changes = await ask({ op: 'changes' });
  assert.ok(changes.kind === 'changes' && changes.frames[1]?.text.includes('+ .title { color: purple; }'));
  assert.deepEqual(await ask({ op: 'exit', handoff: { text: 'Rebuild it like this', images: [], names: [] } }), { kind: 'left', realRoot: project });
  assert.deepEqual(await ask({ op: 'take-handoff' }), { kind: 'handoff', handoff: undefined }, 'not while the copy is still open');
  checkDesignFence('project:close', project);
  assert.equal(designFenceState().kind, 'off');
  assert.equal(sessions.current(), undefined);
  assert.deepEqual(fs.readdirSync(sandboxesRoot(appData)), []);
  assert.deepEqual(await ask({ op: 'take-handoff' }), { kind: 'handoff', handoff: { text: 'Rebuild it like this', images: [], names: [] } });
  assert.deepEqual(await ask({ op: 'take-handoff' }), { kind: 'handoff', handoff: undefined }, 'handed over once');
  assert.equal(digest(project), before);

  // Coming back: the frames return from the draft, the shown one laid over the new copy.
  const again = await ask({ op: 'enter', projectPath: project, refusal: REFUSAL, frameName: 'Original' });
  const state = await ask({ op: 'state' });
  assert.ok(state.kind === 'state' && state.state.kind === 'on' && state.state.frames.length === 2 && state.state.active === 'f2');
  const againLive = again.kind === 'entered' ? again.liveRoot : '';
  assert.equal(fs.readFileSync(path.join(againLive, 'src/styles/global.css'), 'utf8'), '.title { color: purple; }\n');
  const over = await ask({ op: 'start-over', frameName: 'Original' });
  assert.ok(over.kind === 'state' && over.state.kind === 'on' && over.state.frames.length === 1 && over.state.frames[0]?.changedFiles === 0);
  sessions.end(); // As the app quits.
  assert.equal(designFenceState().kind, 'off');
  assert.deepEqual(fs.readdirSync(sandboxesRoot(appData)), []);
  assert.equal(digest(project), before);
  observeDesignFence(undefined);
});

test('requests and replies are parsed: unknown ops, bad frame ids, oversized names and foreign images are refused', () => {
  assert.throws(() => parseDesignSessionRequest({ op: 'format-disk' }), /unknown op/);
  assert.throws(() => parseDesignSessionRequest({ op: 'frame-switch', frame: 'f0' }), /frame id/);
  assert.throws(() => parseDesignSessionRequest({ op: 'frame-switch', frame: '../f1' }), /frame id/);
  assert.throws(() => parseDesignSessionRequest({ op: 'frame-duplicate', name: '  ' }), /expected text/);
  assert.throws(() => parseDesignSessionRequest({ op: 'frame-duplicate', name: 'x'.repeat(61) }), /exceeds/);
  assert.throws(() => parseDesignSessionRequest({ op: 'frame-image', frame: 'f1', image: 'data:text/html,<script>' }), /PNG/);
  assert.throws(() => parseDesignSessionReply({ kind: 'state', state: { kind: 'on', frames: [], active: 'f1' } }), /at least one/);
  assert.throws(() => parseDesignSessionReply({ kind: 'refused', reason: 'because' }), /unknown refusal/);
  assert.deepEqual(parseDesignSessionRequest({ op: 'frame-rename', frame: 'f2', name: ' Bold ' }), { op: 'frame-rename', frame: 'f2', name: 'Bold' });
});
