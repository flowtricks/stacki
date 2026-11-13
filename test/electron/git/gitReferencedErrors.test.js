// Goal: the git refusals we word ourselves reach the renderer with a reference to their translation, and git's own words do not.
// Method: drive the real branch functions with a scripted git, then pass what they throw through the IPC wrapper and read it back the way
// the renderer does (split the appended reference; translate through the catalog). A refusal git worded keeps no reference.
const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteBranch, switchBranch } = require('#dist/electron/git/gitBranches.js');
const { referencedFailure, referencingIpc } = require('#dist/electron/lib/referencingIpc.js');
const { splitReferencedMessage } = require('#dist/shared/core/i18n/referencedMessage.js');
const { englishText } = require('#dist/shared/properties/i18n/messageRef.js');

const onMain = async () => ({ stdout: 'main\n' });

test('deleting the branch you are on throws a reference that survives the wrapper', async () => {
  const error = await deleteBranch(onMain, { projectPath: '/p', branch: 'main' }).then(
    () => undefined,
    (thrown) => thrown,
  );
  assert.ok(error instanceof Error);
  assert.deepEqual(error.messageRef, { key: 'git.error.deleteSelf', params: { branch: 'main' } });
  const wire = referencedFailure(error);
  assert.ok(wire instanceof Error);
  const read = splitReferencedMessage(wire.message);
  assert.equal(read.message, error.message);
  assert.deepEqual(read.messageRef, error.messageRef);
  assert.equal(englishText(read.messageRef), error.message);
});

test('git’s own words pass through without a reference', async () => {
  const git = async (_path, args) => {
    if (args[0] === 'rev-parse') {
      return { stdout: 'topic\n' };
    }
    throw Object.assign(new Error('failed'), { stderr: 'fatal: a branch named x already exists' });
  };
  const error = await switchBranch(git, { projectPath: '/p', branch: 'x', create: true, park: async () => false, unpark: async () => undefined }).then(
    () => undefined,
    (thrown) => thrown,
  );
  assert.equal(error.message, 'fatal: a branch named x already exists');
  assert.equal(referencedFailure(error), error);
});

test('the wrapper rejects with the referenced copy and leaves plain errors alone', async () => {
  const handlers = new Map();
  const wrapped = referencingIpc({ handle: (channel, listener) => handlers.set(channel, listener) });
  wrapped.handle('git:deleteBranch', async () => {
    throw Object.assign(new Error('English.'), { messageRef: { key: 'git.error.deleteFailed', params: { branch: 'b' } } });
  });
  wrapped.handle('git:merge', async () => {
    throw new Error('Plain.');
  });
  await assert.rejects(handlers.get('git:deleteBranch')({}, {}), (error) => {
    const read = splitReferencedMessage(error.message);
    return read.message === 'English.' && read.messageRef?.key === 'git.error.deleteFailed';
  });
  await assert.rejects(handlers.get('git:merge')({}, {}), { message: 'Plain.' });
});
