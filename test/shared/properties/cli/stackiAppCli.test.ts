// Goal: the `cli` section of an app manifest is parsed by hand into bounded, typed commands and files, and every malformed shape is refused with a
// reason instead of being read loosely; app files register into the key registry only under the rules core files obey; `.stacki/cli.json` is a
// strict file; and a line for an app command parses against the rows apps add.
// Method: known-good sections pass and their rows and registry entries are checked; each known-bad shape fails with the expected reason; the
// registry is set and cleared per run and refuses ids and paths it must not take; cli.json parses good and bad documents.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseLine } from '#dist/shared/properties/cli/stackiArgs.js';
import { appCommandSpec, appFileSchema, ownsPath, parseAppCliSection } from '#dist/shared/properties/cli/stackiAppCli.js';
import { allFiles, appFilePathProblem, clearAppFiles, fileSchemaById, registerAppFiles, STACKI_FILES } from '#dist/shared/properties/cli/stackiFiles.js';
import { parseCliSettingsSource, readCliSettings } from '#dist/shared/properties/cli/files/cliFile.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';
import { notesCli } from '../../../helpers/cliApp.ts';

afterEach(clearAppFiles);

const parse = (section: unknown, appId: string = 'notes', permissionIds: readonly string[] = ['reset']) =>
  parseAppCliSection({ appId, section, permissionIds });

function refusal(section: unknown, appId?: string): string {
  const result = parse(section, appId);
  assert.equal(result.kind, 'refused', JSON.stringify(result));
  return result.kind === 'refused' ? result.reason : '';
}

const command = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  name: 'go',
  description: 'Go.',
  writes: true,
  owns: [{ file: 'guide', keys: ['settings.visible'] }],
  handler: { kind: 'declarative', operations: [{ op: 'set', file: 'guide', path: 'settings.visible', value: true }] },
  ...overrides,
});

test('no cli section is none, and the fixture section is ready with typed commands and files', () => {
  assert.equal(parse(undefined).kind, 'none');
  const result = parse(notesCli());
  assert.equal(result.kind, 'ready');
  if (result.kind === 'ready') {
    assert.equal(result.section.commands.length, 5);
    assert.equal(result.section.files[0]?.id, 'notes.settings');
    const spec = appCommandSpec('notes', result.section.commands[0] ?? assert.fail());
    assert.deepEqual(spec.words, ['notes', 'set-title']);
    assert.equal(spec.featureKey, 'cli.app.notes.set-title');
    assert.equal(spec.feature, 'cli:apps');
    assert.equal(spec.access, 'write');
    assert.deepEqual(
      spec.args.map((arg) => [arg.name, arg.kind, arg.required]),
      [['title', 'string', true]],
    );
  }
});

test('an unknown or missing apiVersion is refused with a clear error', () => {
  assert.match(refusal({ apiVersion: 2, commands: [] }), /apiVersion 2 is not supported: this Stacki understands apiVersion 1 only/);
  assert.match(refusal({ commands: [] }), /apiVersion undefined/);
  assert.match(refusal('x'), /cli must be an object/);
});

test('each malformed command shape is refused', () => {
  const bad: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
    ['uppercase name', { name: 'Go' }, /lowercase/],
    ['writes missing', { writes: undefined }, /writes must be true or false/],
    ['declarative that does not write', { writes: false }, /writes must be true/],
    ['unknown key', { surprise: 1 }, /not a key/],
    ['permission not declared', { permission: 'nope' }, /permission must be the id of a permission the manifest declares/],
    ['destructive without writes', { destructive: true, writes: false }, /only a command that writes/],
    [
      'op outside owned keys',
      { handler: { kind: 'declarative', operations: [{ op: 'set', file: 'guide', path: 'settings.color', value: 'red' }] } },
      /not inside a key/,
    ],
    ['file not declared', { owns: [{ file: 'nothing', keys: ['a'] }] }, /neither a file this app declares nor a core file id/],
    [
      '$input not declared',
      { handler: { kind: 'declarative', operations: [{ op: 'set', file: 'guide', path: 'settings.visible', value: { $input: 'ghost' } }] } },
      /names one input/,
    ],
    ['set without value', { handler: { kind: 'declarative', operations: [{ op: 'set', file: 'guide', path: 'settings.visible' }] } }, /value is required/],
    ['module entry outside the bundle', { handler: { kind: 'module', entry: '../x.mjs' } }, /entry/],
    ['module entry not js', { handler: { kind: 'module', entry: 'x.json' } }, /\.mjs or \.js/],
    ['module that writes owns nothing', { owns: [], handler: { kind: 'module', entry: 'x.mjs' } }, /must say which files and keys/],
    ['unknown handler kind', { handler: { kind: 'shell', command: 'rm' } }, /declarative.*module/],
    ['reserved input name', { input: { type: 'object', properties: { apply: { type: 'boolean', description: 'x' } } } }, /not an input name/],
    [
      'input kind outside the DSL',
      { input: { type: 'object', properties: { a: { type: 'array', description: 'x' } } } },
      /is not one of string, integer, number, boolean/,
    ],
    ['required names a missing property', { input: { type: 'object', properties: {}, required: ['a'] } }, /not a property/],
    [
      'too many operations',
      { handler: { kind: 'declarative', operations: Array.from({ length: 17 }, () => ({ op: 'set', file: 'guide', path: 'settings.visible', value: true })) } },
      /at most 16/,
    ],
  ];
  for (const [what, overrides, expected] of bad) {
    assert.match(refusal({ apiVersion: 1, commands: [command(overrides)] }), expected, what);
  }
  assert.match(refusal({ apiVersion: 1, commands: [command({}), command({})] }), /share a name/);
  assert.match(refusal({ apiVersion: 1, commands: [command({ name: 'x'.repeat(30) })] }, 'a'.repeat(40)), /longer than 64/);
  assert.match(refusal({ apiVersion: 1, commands: [] }, 'has.dot'), /no dots/);
});

test('an app cannot own roles, the trust record or the apps lock', () => {
  for (const file of ['roles', 'cli', 'apps']) {
    assert.match(
      refusal({ apiVersion: 1, commands: [command({ owns: [{ file, keys: ['apps'] }], handler: { kind: 'module', entry: 'x.mjs' } })] }),
      /cannot be owned by an app/,
    );
  }
});

test('declared schemas are bounded and typed: bad kinds, bounds, patterns and a required key without a default are refused', () => {
  const file = (keys: Record<string, unknown>) => ({ apiVersion: 1, files: [{ id: 'notes.x', path: '.stacki/notes.json', description: 'X.', keys }] });
  assert.equal(parse(file({ a: { type: { kind: 'boolean' }, description: 'A.' } })).kind, 'ready');
  assert.match(refusal(file({ a: { type: { kind: 'json', reason: 'x' }, description: 'A.' } })), /is not one of/);
  assert.match(refusal(file({ a: { type: { kind: 'integer', min: 5, max: 1 }, description: 'A.' } })), /min and max/);
  assert.match(refusal(file({ a: { type: { kind: 'string' }, description: 'A.' } })), /charsMax/);
  assert.match(refusal(file({ a: { type: { kind: 'string', charsMax: 99999 }, description: 'A.' } })), /charsMax/);
  assert.match(refusal(file({ a: { type: { kind: 'string', charsMax: 9, pattern: '(' }, description: 'A.' } })), /not a valid regular expression/);
  assert.match(refusal(file({ a: { type: { kind: 'string', charsMax: 9, pattern: '(a+)+$' }, description: 'A.' } })), /nested repetition/);
  assert.match(refusal(file({ a: { type: { kind: 'boolean' }, description: 'A.', required: true } })), /needs a default/);
  assert.match(refusal(file({ 'bad key': { type: { kind: 'boolean' }, description: 'A.' } })), /not a key name/);
  assert.match(refusal(file({ a: { type: { kind: 'boolean' } } })), /description/);
  assert.match(refusal(file({ a: { type: { kind: 'array', item: { kind: 'boolean' }, itemsMax: 9999 }, description: 'A.' } })), /itemsMax/);
  let deep: unknown = { kind: 'boolean' };
  for (let level = 0; level < 12; level += 1) {
    deep = { kind: 'object', fields: { n: { type: deep, description: 'N.' } } };
  }
  assert.match(refusal(file({ a: { type: deep, description: 'A.' } })), /deeper than/);
});

test("app files must be namespaced and sit in the app's own place, never on a core path", () => {
  const file = (id: string, path: string) => ({
    apiVersion: 1,
    files: [{ id, path, description: 'X.', keys: { a: { type: { kind: 'boolean' }, description: 'A.' } } }],
  });
  assert.equal(parse(file('notes.prefs', '.stacki/notes.json')).kind, 'ready');
  assert.equal(parse(file('notes.prefs', '.stacki/apps/notes/data/prefs.json')).kind, 'ready');
  assert.match(refusal(file('prefs', '.stacki/notes.json')), /must be "notes\.<name>"/);
  assert.match(refusal(file('other.prefs', '.stacki/notes.json')), /must be "notes\.<name>"/);
  for (const path of [
    '.stacki/guide.json',
    '.stacki/cli.json',
    '.stacki/apps/apps.json',
    '.stacki/apps/settings.json',
    '.stacki/other.json',
    '.stacki/apps/other/p.json',
    '.stacki/apps/notes/stacki-app.json',
    '.stacki/apps/notes/a.mjs',
    '.stacki/apps/notes/a/b/c/d/e.json',
    'src/x.json',
  ]) {
    assert.match(refusal(file('notes.prefs', path)), /path/, path);
  }
  assert.equal(appFilePathProblem('cms', '.stacki/cms.json') !== undefined, true, 'an unsettable core path cannot be claimed');
});

test('the registry holds app files for one run: registered, found, validated by the declared schema, then replaced and cleared', () => {
  const parsed = parse(notesCli());
  assert.ok(parsed.kind === 'ready');
  const schema = appFileSchema('notes', parsed.section.files[0] ?? assert.fail(), ['set-title']);
  assert.equal(fileSchemaById('notes.settings'), undefined);
  registerAppFiles([schema]);
  assert.equal(fileSchemaById('notes.settings')?.file, '.stacki/apps/notes/settings.json');
  assert.equal(allFiles().length, STACKI_FILES.length + 1);
  assert.equal(schema.validate?.('{"title":"x","pageSize":3}'), undefined);
  assert.throws(() => schema.validate?.('{"pageSize":0}'), /between 1 and 100/);
  assert.throws(() => schema.validate?.('{"nope":1}'), /unknown key/);
  assert.throws(() => schema.validate?.('[]'), /expected an object/);
  assert.equal(checkValue({ kind: 'object', fields: schema.fields }, schema.empty, 'x'), undefined, 'the empty document is valid');
  registerAppFiles([]);
  assert.equal(fileSchemaById('notes.settings'), undefined);
  const coreId = { ...schema, id: 'guide' };
  assert.throws(() => registerAppFiles([coreId]), /core file id|must be/);
  const corePath = { ...schema, file: '.stacki/guide.json' };
  assert.throws(() => registerAppFiles([corePath]), /outside/);
  assert.throws(() => registerAppFiles([schema, schema]), /repeats/);
  const anonymous = { ...schema };
  Reflect.deleteProperty(anonymous, 'appId');
  assert.throws(() => registerAppFiles([anonymous]), /names no app/);
});

test('ownsPath accepts the owned key and anything under it, and nothing beside it', () => {
  const owns = [{ file: 'f', keys: [{ text: 'a.b', segments: ['a', 'b'] }] }];
  assert.equal(ownsPath(owns, 'f', ['a', 'b']), true);
  assert.equal(ownsPath(owns, 'f', ['a', 'b', 'c', 0]), true);
  assert.equal(ownsPath(owns, 'f', ['a']), false);
  assert.equal(ownsPath(owns, 'f', ['a', 'c']), false);
  assert.equal(ownsPath(owns, 'g', ['a', 'b']), false);
});

test('a command line for an app command parses against the rows apps add, and the core table is unchanged without them', () => {
  const parsed = parse(notesCli());
  assert.ok(parsed.kind === 'ready');
  const specs = parsed.section.commands.map((entry) => appCommandSpec('notes', entry));
  const line = parseLine(['notes', 'set-title', '--title', 'Hello', '--apply'], specs);
  assert.ok(line.ok && typeof line.value === 'object');
  if (line.ok && typeof line.value === 'object') {
    assert.deepEqual(line.value.spec.words, ['notes', 'set-title']);
    assert.deepEqual(line.value.args, { title: 'Hello' });
    assert.equal(line.value.options.apply, 'apply');
  }
  assert.ok(!parseLine(['notes', 'set-title'], specs).ok, 'a required input is required');
  assert.ok(!parseLine(['notes', 'nope'], specs).ok);
  assert.ok(!parseLine(['notes', 'set-title', '--title', 'x']).ok, 'without the apps the line is unknown');
});

test('cli.json is strict: known keys only, booleans, a 64 hex digest', () => {
  const good = JSON.stringify({ version: 1, apps: { notes: { enabled: true, trusted: true, sha256: 'a'.repeat(64) } } });
  assert.equal(parseCliSettingsSource(good).get('notes')?.network, false);
  assert.equal(readCliSettings(undefined).kind, 'ready');
  const bad = [
    '[]',
    '{"version":2,"apps":{}}',
    '{"version":1,"apps":{},"extra":1}',
    '{"version":1,"apps":{"Bad Id":{"enabled":true,"trusted":true,"sha256":"' + 'a'.repeat(64) + '"}}}',
    '{"version":1,"apps":{"x":{"enabled":"yes","trusted":true,"sha256":"' + 'a'.repeat(64) + '"}}}',
    '{"version":1,"apps":{"x":{"enabled":true,"trusted":true,"sha256":"short"}}}',
    '{"version":1,"apps":{"x":{"enabled":true,"trusted":true,"sha256":"' + 'a'.repeat(64) + '","extra":1}}}',
    'nope',
  ];
  for (const source of bad) {
    assert.equal(readCliSettings(source).kind, 'invalid', source);
  }
});
