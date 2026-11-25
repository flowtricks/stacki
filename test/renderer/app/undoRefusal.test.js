// Goal: an undo or redo that main declined says so as an orange warning, and
// only a write that failed, or may have, is a red error. "Couldn’t undo: The
// element you edited is no longer where it was." used to arrive red with a
// red (i), though nothing broke: the element moved, so the revert was refused
// and the step waited where it was.
// Method: revertedSteps is driven end to end with window.avb.editPage stubbed
// to answer each refusal main can send, and the refusal it returns is pinned
// (message and toast kind). undoRefusal is then checked over every rejection
// reason and write failure code, so a new one cannot land unclassified. The
// source is read to pin that appHistory shows the refusal with its own kind
// and the unsaved-edits refusal as a warning.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');
const load = require('../../helpers/rendererModule');

const { revertedSteps, undoRefusal } = load('src/app/model/appKeys.ts');
const { REJECTION_REASONS, describeRejection } = load('shared/engine/intent.ts');
const { ENGLISH_TRANSLATE } = load('shared/properties/i18n/englishTranslator.ts');

const CHECKSUM = 'a'.repeat(64);
const applied = [{ checksum: CHECKSUM, inverse: [{ span: { start: 0, end: 1 }, text: 'x' }] }];

async function refusalFor(error) {
  globalThis.window = { avb: { editPage: async () => ({ ok: false, error }) } };
  const reverted = await revertedSteps('/site/src/pages/index.astro', applied, undefined, ENGLISH_TRANSLATE);
  assert.equal(reverted.done.length, 0, 'a refused revert reverts nothing');
  assert.equal(reverted.written, undefined, 'and writes nothing');
  return reverted.refusal;
}

async function main() {
  // The reported case: the element moved, so the undo was declined.
  assert.deepEqual(await refusalFor({ code: 'rejected', reason: 'anchor-moved', message: 'anchor moved' }), {
    message: 'The element you edited is no longer where it was.',
    kind: 'warning',
  });
  // A file changed outside Stacki is declined the same way.
  assert.equal((await refusalFor({ code: 'rejected', reason: 'region-externally-modified', message: 'changed' })).kind, 'warning');
  // A write that failed stays an error, with main's own words.
  assert.deepEqual(await refusalFor({ code: 'filesystem', message: 'EACCES: permission denied' }), {
    message: 'EACCES: permission denied',
    kind: 'error',
  });
  assert.equal((await refusalFor({ code: 'rejected', reason: 'write-failed', message: 'disk full' })).kind, 'error');

  // Every reason main can give is classified, and each says why.
  const warnings = new Set([
    'anchor-moved',
    'anchor-ambiguous',
    'region-externally-modified',
    'source-invalid',
    'resource-limit',
    'write-race',
    'merge-conflict',
  ]);
  for (const reason of REJECTION_REASONS) {
    const refusal = undoRefusal({ code: 'rejected', reason, message: 'ignored', diskChecksum: undefined }, ENGLISH_TRANSLATE);
    assert.equal(refusal.message, describeRejection(reason), `${reason} reads as its notice`);
    assert.equal(refusal.kind, warnings.has(reason) ? 'warning' : 'error', `${reason} is a ${warnings.has(reason) ? 'warning' : 'error'}`);
  }
  const writeKinds = { 'write-race': 'warning', backpressured: 'warning', missing: 'error', filesystem: 'error', uncertain: 'error' };
  for (const [code, kind] of Object.entries(writeKinds)) {
    assert.equal(undoRefusal({ code, message: `${code} happened` }, ENGLISH_TRANSLATE).kind, kind, `a ${code} write failure is a ${kind}`);
  }
  // Negative space: a refusal with nothing to say is a programmer error.
  assert.throws(() => undoRefusal({ code: 'filesystem', message: '' }, ENGLISH_TRANSLATE), /Assertion failed: An undo refusal says why/);

  // The app shows the refusal with the kind it carries, never a fixed red.
  const history = fs.readFileSync(repoPath('src/app/state/appHistory.ts'), 'utf8');
  assert.match(history, /\{ message: reverted\.refusal\.message \}\),\s+reverted\.refusal\.kind,?\s*\)/);
  assert.match(history, /'shell\.history\.unsavedUndo' : 'shell\.history\.unsavedRedo'\), 'warning'\)/);
  console.log('undo refusal kinds: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
