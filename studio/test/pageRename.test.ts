// Goal: Studio shares Desktop's rename semantics and preserves deletion across restarts.
// Method: exercise HTTP with open collaboration rooms, then checkpoint a real Git draft
// and recover its objects into a fresh store, without publishing a commit to GitHub.
import { scanProject } from '../src/features/project/projectServer';
import { parseProject } from '../src/features/project/projectClient';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRooms } from '../src/features/collaboration/rooms';
import { pageRenameRoute, persistPageRename } from '../src/features/pages/pageRenameServer';
import { planPageRename } from '../vendor/stacki/electron/project/pageRenamePlan';
import { applyPageRename } from '../vendor/stacki/electron/project/pageRenameWrite';
import { studioRenameWriter } from '../src/features/pages/pageRenameWriter';
import { createGitWorkspaceFixture } from './gitWorkspaceFixture';
import { readGitWorkspace, gitDraftHeaders } from '../src/features/history/gitWorkspaceStorage';
import { gitWorkspaceRun, initializeGitWorkspace } from '../src/features/history/gitWorkspaceObjects';
import { gitWorkspaceBranch } from '../src/features/history/gitWorkspaceContract';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-page-rename-'));
  await mkdir(path.join(root, 'src/pages/about'), { recursive: true });
  await writeFile(path.join(root, 'src/pages/about/team.astro'), '<a href="/about/team">Team</a>');
  await writeFile(path.join(root, 'src/pages/index.astro'), '<a href="/about/team">Team</a>');
  const rooms = createRooms(root);
  const server = createServer((request, response) => {
    void pageRenameRoute(root, rooms, request, response, '/studio/api/pages/rename', async () => {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
      }
      return body;
    }).catch((error: unknown) => {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    root,
    rooms,
    post: (input: unknown) =>
      fetch(`http://127.0.0.1:${address.port}/studio/api/pages/rename`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    close: async () => {
      await rooms.resetWorkspace();
      server.close();
      server.closeAllConnections();
      rooms.sockets.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('Studio renames with open drafts, updates links and reloads durable rooms', async () => {
  const setup = await fixture();
  try {
    const room = await setup.rooms.get('src/pages/index.astro');
    await room.setSource('<h1>Unsaved draft</h1><a href="/about/team">Team</a>');
    const response = await setup.post({ kind: 'folder', from: 'about', to: 'company' });
    assert.equal(response.status, 200, await response.text());
    await assert.rejects(readFile(path.join(setup.root, 'src/pages/about/team.astro')), {
      code: 'ENOENT',
    });
    assert.match(await readFile(path.join(setup.root, 'src/pages/index.astro'), 'utf8'), /Unsaved draft/);
    const reopened = await setup.rooms.get('src/pages/index.astro');
    assert.match(reopened.text.toString(), /\/company\/team/);
    const moved = await setup.rooms.get('src/pages/company/team.astro');
    assert.match(moved.text.toString(), /\/company\/team/);
    assert.equal((await setup.post({ kind: 'page', from: 'company/team.astro', to: 'index.astro' })).status, 409);
  } finally {
    await setup.close();
  }
});
test('rename checkpoint preserves deletions and isolates stale cloud document identities', async () => {
  const setup = await createGitWorkspaceFixture();
  try {
    const state = await setup.workspace.load();
    const planned = planPageRename(setup.root, {
      kind: 'page',
      from: 'about.astro',
      to: 'company.astro',
    });
    assert.ok(planned.ok);
    assert.ok(applyPageRename(planned.value, studioRenameWriter).ok);
    await persistPageRename(planned.value, state);
    const saved = await readGitWorkspace(setup.root);
    assert.ok(saved?.draft);
    assert.equal(gitWorkspaceBranch(saved).head, setup.head);
    assert.notEqual((await gitDraftHeaders(setup.root))['x-studio-draft'], 'legacy');
    await rm(state.git.directory, { recursive: true, force: true });
    await initializeGitWorkspace(state.git, setup.connection, saved, { remote: setup.remote });
    const run = gitWorkspaceRun(state.git);
    assert.equal(await run(['show', saved.draft + ':src/pages/company.astro']), '<h1>Draft</h1>');
    await assert.rejects(run(['show', saved.draft + ':src/pages/about.astro']));
  } finally {
    await rm(setup.parent, { recursive: true, force: true });
  }
});

test('Studio publishes empty folders for live conflict validation with bounded parsing', async () => {
  const setup = await fixture();
  try {
    await mkdir(path.join(setup.root, 'src/pages/empty'));
    const project = await scanProject(setup.root);
    assert.deepEqual([...(parseProject(project).pageFolders ?? [])].sort(), ['about', 'empty']);
    assert.throws(() => parseProject({ ...project, pageFolders: [42] }));
    assert.throws(() => parseProject({ ...project, pageFolders: Array(10_001).fill('folder') }));
  } finally {
    await setup.close();
  }
});
