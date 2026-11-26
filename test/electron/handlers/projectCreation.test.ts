// Drive the real project IPC registrar with a held generator promise. A blocked
// request must not touch either progress channel, and the next request must reach
// the generator once the owner has failed or succeeded.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PROGRESS_CLEARED, registerProjectHandlers } from '#dist/electron/handlers/projectHandlers.js';
import { createIpcRegistrar } from '#dist/electron/lib/ipcRegistrar.js';
import nodeTools from '#dist/electron/lib/nodeTools.js';
import heroUIStarter from '#dist/electron/project/herouiStarter.js';
import { SHADCN_STARTER_DEFAULTS } from '#dist/shared/ipc/shadcnStarter.js';

type Listener = Parameters<Pick<Electron.IpcMain, 'handle'>['handle']>[1];

test('project creation keeps one owner across generators and releases it after either result', async (context) => {
  const handlers = new Map<string, Listener>();
  const messages: { readonly channel: string; readonly payload: unknown }[] = [];
  const ipcMain = { handle: createIpcRegistrar({ handle: (channel, listener) => handlers.set(channel, listener) }) };
  registerProjectHandlers({
    ipcMain,
    send: (channel, payload) => messages.push({ channel, payload }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  });
  const invoke = async (channel: string, input: unknown): Promise<unknown> => {
    const listener = handlers.get(channel);
    assert.ok(listener);
    const response: unknown = Reflect.apply(listener, undefined, [{}, input]);
    return response;
  };
  const location = { parentPath: '/sites', name: 'example' };
  const heroUI = { ...location, starter: 'heroui', packageManager: 'pnpm' };
  context.mock.method(nodeTools, 'ensureToolPath', () => undefined);
  let reportFailure: ((error: Error) => void) | undefined;
  const generator = context.mock.method(heroUIStarter, 'createHeroUIStarter', (request: unknown, onLog: (text: string) => void) => {
    assert.deepEqual(request, heroUI);
    onLog('Installing HeroUI dependencies');
    return new Promise((_, reject) => {
      reportFailure = reject;
    });
  });

  const attempt = invoke('project:createStarter', heroUI);
  const rejected = assert.rejects(attempt, /pnpm install failed/);
  const busy = /already being created/;
  await assert.rejects(invoke('project:createStarter', heroUI), busy);
  await assert.rejects(invoke('project:createStarter', location), busy);
  await assert.rejects(invoke('project:createStarter', { ...location, starter: 'shadcn', shadcn: SHADCN_STARTER_DEFAULTS }), busy);
  await assert.rejects(invoke('project:createAstro', location), busy);
  await assert.rejects(invoke('project:createAstroCopy', { ...location, sourcePath: '/original' }), busy);
  const firstLog = { channel: 'create:log', payload: 'Installing HeroUI dependencies' };
  const cleared = { channel: 'progress', payload: PROGRESS_CLEARED };
  assert.deepEqual(messages, [firstLog]);
  assert.ok(reportFailure);
  reportFailure(new Error('pnpm install failed'));
  await rejected;
  assert.deepEqual(messages, [firstLog, cleared]);

  const projectPath = '/sites/example';
  generator.mock.mockImplementation(async () => ({ projectPath }));
  const success = { ok: true, projectPath };
  assert.deepEqual(await invoke('project:createStarter', heroUI), success);
  assert.deepEqual(await invoke('project:createStarter', heroUI), success);
  assert.deepEqual(messages, [firstLog, cleared, cleared, cleared]);
});
