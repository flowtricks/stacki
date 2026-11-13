// Goal: what the CMS and content-config code says when something fails reaches the renderer as English text AND a reference,
// so the panel can show it in the language on screen; and a reference that arrives broken never fails the value that carried it.
// Method: call the pure producers (network failure, config edits, slug and field-name checks) and the boundary parsers directly,
// asserting the English sentence is unchanged and the reference names the key and its parameters; bad shapes fall back to English.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cmsNetworkProblem } = require('#dist/electron/content/cmsNetworkFailure.js');
const { cmsFailureProblem } = require('#dist/electron/content/cmsRemoteService.js');
const { statusProblem } = require('#dist/electron/content/media/mediaHttp.js');
const { addCollectionToConfig } = require('#dist/electron/content/astroCollectionConfig.js');
const { DescribedError } = require('#dist/shared/properties/describedError.js');
const { slugProblem, slugNote, checkEntrySlug } = require('#dist/shared/properties/entrySlug.js');
const { fieldNameProblem, typedFieldName } = require('#dist/shared/properties/collectionSettings.js');
const { parseRemoteRevisions } = require('#dist/shared/properties/cmsRemote.js');
const { parseRemoteSchemaField } = require('#dist/shared/properties/cmsRemoteSchema.js');

const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });

test('a network failure names a message reference with the address', () => {
  const problem = cmsNetworkProblem(refused, 'http://localhost:3000');
  assert.equal(problem.messageRef.key, 'settings.cms.payload.error.refused');
  assert.deepEqual(problem.messageRef.params, { address: 'http://localhost:3000' });
  assert.match(problem.message, /Nothing is answering at http:\/\/localhost:3000/);
});

test('a failure with nothing to say gets our sentence; the system’s own words stay as they were', () => {
  assert.equal(cmsFailureProblem(new Error('')).messageRef.key, 'cmsBackend.network.failed');
  const said = cmsFailureProblem(new Error('Disk is full'));
  assert.equal(said.message, 'Disk is full');
  assert.equal(said.messageRef, undefined);
});

test('a described error keeps its reference through the CMS failure path', () => {
  const error = new DescribedError(addCollectionToConfig('export default {};\n', 'news').error);
  assert.equal(cmsFailureProblem(error).messageRef.key, 'cmsBackend.config.noCollections');
});

test('a media host status keeps the host’s words in the same sentence', () => {
  const problem = statusProblem(401, ' Cloudflare said: nope');
  assert.equal(problem.message, 'The host refused the keys. Check them, and that they may read and write this bucket. Cloudflare said: nope');
  assert.equal(problem.messageRef.key, 'cmsBackend.media.status.refusedKeys');
});

test('slug and field-name sentences translate through the translator passed last, and default to English', () => {
  const check = checkEntrySlug('', { taken: [] });
  assert.equal(slugProblem(check), 'A slug needs at least one letter or number');
  assert.equal(
    slugProblem(check, (key) => `<${key}>`),
    '<cmsBackend.slug.empty>',
  );
  assert.equal(slugNote({ kind: 'ok', slug: 'a', normalised: true }), 'Saved as “a”');
  assert.equal(fieldNameProblem('1bad').messageRef.key, 'cmsBackend.fieldName.invalid');
  assert.equal(fieldNameProblem('good'), undefined);
  assert.equal(typedFieldName('1bad').kind, 'invalid');
  assert.equal(typedFieldName('1bad').messageRef.key, 'cmsBackend.fieldName.invalid');
});

test('a revision author reference is kept when well formed and dropped when broken', () => {
  const row = { id: 'tx1', timestamp: '2026-10-29T10:00:00Z', author: 'Someone' };
  assert.deepEqual(parseRemoteRevisions([{ ...row, authorRef: { key: 'cmsBackend.sanity.someone' } }])[0].authorRef, { key: 'cmsBackend.sanity.someone' });
  assert.equal('authorRef' in parseRemoteRevisions([{ ...row, authorRef: { key: 'not a key' } }])[0], false);
  assert.equal('authorRef' in parseRemoteRevisions([{ ...row, authorRef: 7 }])[0], false);
});

test('a field’s title reference parses the same way', () => {
  const field = { name: 'body', title: 'Body', description: '', required: false, rules: [], type: { kind: 'text', options: [] } };
  assert.deepEqual(parseRemoteSchemaField({ ...field, titleRef: { key: 'cmsBackend.body.title' } }).titleRef, { key: 'cmsBackend.body.title' });
  assert.equal('titleRef' in parseRemoteSchemaField({ ...field, titleRef: 'x' }), false);
});
