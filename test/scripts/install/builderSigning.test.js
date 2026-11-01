// Goal: the electron-builder signing backport (scripts/fix-electron-builder-
// signing.ts) authenticates the keychain ACL with the keychain password, and the
// patcher refuses anything it does not recognize without changing a byte.
// Method: the installed macCodeSign.js is restored to its pristine text, loaded
// in a VM with `security` mocked, and run both unpatched (the regression must
// fail) and patched; the patcher itself runs against temporary copies of known,
// partly patched and upgraded sources.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { patchSigningSource, fixElectronBuilderSigning } = require('#dist/scripts/install/fixBuilderSigning.js');

const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const signingFile = builderRequire.resolve('app-builder-lib/out/codeSign/macCodeSign.js');
// `npm` postinstall may already have applied the backport. Recover the pristine
// installed implementation so these tests exercise both sides of the change.
const original = fs
  .readFileSync(signingFile, 'utf8')
  .replace(
    'return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);',
    'return await importCerts(keychainFile, certPaths, cscPasswords);',
  )
  .replace(
    'async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {',
    'async function importCerts(keychainFile, paths, keyPasswords) {',
  )
  .replace(
    '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", ' + 'keychainPassword, keychainFile]',
    '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]',
  );

function loadSigning(source) {
  const calls = [];
  const imports = [];
  let keychainPassword;
  const mocks = {
    'builder-util': {
      exec: async (command, args) => {
        assert.equal(command, '/usr/bin/security');
        calls.push([...args]);
        if (args[0] === 'create-keychain') {
          keychainPassword = args[args.indexOf('-p') + 1];
        }
        if (args[0] === 'set-key-partition-list') {
          assert.equal(args[args.indexOf('-k') + 1], keychainPassword, 'ACL must authenticate with the keychain password');
        }
        return '';
      },
    },
    'bluebird-lst': {
      default: {
        map: (items, callback) => Promise.all(items.map(callback)),
        mapSeries: async (items, callback) => {
          for (const item of items) {
            await callback(item);
          }
        },
      },
    },
    'lazy-val': { Lazy: class {} },
    './codesign': {
      importCertificate: async (link, temporaryDirectory, currentDirectory) => {
        imports.push({ link, tmpDir: temporaryDirectory, currentDir: currentDirectory });
        return path.join(temporaryDirectory.root, `${link}.p12`);
      },
    },
    crypto: require('node:crypto'),
    path: path,
    os: os,
    'fs/promises': {},
    'temp-file': {},
    '../util/flags': {},
    '../util/dynamicImport': {},
    '@electron/osx-sign/dist/cjs/util-identities': {},
    '@electron/osx-sign': {},
  };
  const exported = {};
  vm.runInNewContext(
    source,
    {
      exports: exported,
      __dirname: path.dirname(signingFile),
      process: { platform: 'darwin', env: { TRAVIS: 'true' } },
      require: (name) => {
        assert.ok(Object.hasOwn(mocks, name), `Unexpected real dependency: ${name}`);
        return mocks[name];
      },
    },
    { filename: signingFile },
  );
  return { createKeychain: exported.createKeychain, calls, imports };
}

for (const installer of [false, true]) {
  test(`real createKeychain separates keychain ` + `and ${installer ? 'both certificate passwords' : 'certificate password'}`, async () => {
    const { createKeychain, calls, imports } = loadSigning(patchSigningSource(original));
    const currentDirectory = path.join(os.tmpdir(), 'stacki-signing-test-project');
    const temporaryDirectory = {
      root: path.join(os.tmpdir(), 'stacki-signing-test-certificates'),
    };
    const certificatePasswords = installer ? ['app-test-password', 'installer-test-password'] : [''];
    const result = await createKeychain({
      currentDir: currentDirectory,
      tmpDir: temporaryDirectory,
      cscLink: 'app',
      cscKeyPassword: certificatePasswords[0],
      ...(installer ? { cscILink: 'installer', cscIKeyPassword: certificatePasswords[1] } : {}),
    });
    const created = calls.find(([command]) => command === 'create-keychain');
    const unlocked = calls.find(([command]) => command === 'unlock-keychain');
    const keychainPassword = created[created.indexOf('-p') + 1];
    assert.equal(Buffer.from(keychainPassword, 'base64').length, 32);
    assert.ok(!certificatePasswords.includes(keychainPassword));
    assert.equal(unlocked[unlocked.indexOf('-p') + 1], keychainPassword);
    assert.equal(result.keychainFile, created.at(-1));
    assert.equal(imports.length, certificatePasswords.length);
    assert.ok(imports.every((entry) => entry.tmpDir === temporaryDirectory && entry.currentDir === currentDirectory));
    const importCommands = calls.filter(([command]) => command === 'import');
    assert.deepEqual(
      importCommands.map((args) => args[args.indexOf('-P') + 1]),
      certificatePasswords,
    );
    assert.ok(importCommands.every((args) => args[args.indexOf('-k') + 1] === result.keychainFile));
    const aclCommands = calls.filter(([command]) => command === 'set-key-partition-list');
    assert.equal(aclCommands.length, certificatePasswords.length);
    assert.ok(aclCommands.every((args) => args[args.indexOf('-k') + 1] === keychainPassword && args.at(-1) === result.keychainFile));
  });
}

test('regression harness rejects the original wrong-password implementation', async () => {
  const { createKeychain } = loadSigning(original);
  await assert.rejects(
    createKeychain({
      currentDir: os.tmpdir(),
      tmpDir: { root: os.tmpdir() },
      cscLink: 'app',
      cscKeyPassword: 'certificate-password',
    }),
    /ACL must authenticate with the keychain password/,
  );
});

function fixture(context, source = original, version = '26.15.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-builder-signing-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const builder = path.join(root, 'node_modules/electron-builder');
  const library = path.join(builder, 'node_modules/app-builder-lib');
  const file = path.join(library, 'out/codeSign/macCodeSign.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(builder, 'package.json'), JSON.stringify({ name: 'electron-builder', version }));
  fs.writeFileSync(path.join(library, 'package.json'), JSON.stringify({ name: 'app-builder-lib', version }));
  fs.writeFileSync(file, source);
  return { root, file, builder };
}

test('patch resolves non-hoisted builder dependencies and is idempotent', (context) => {
  const { root, file } = fixture(context);
  assert.equal(fixElectronBuilderSigning(root), 'patched');
  const patched = fs.readFileSync(file, 'utf8');
  assert.equal(patched, patchSigningSource(original));
  assert.equal(patchSigningSource(patched), patched);
  assert.equal(fixElectronBuilderSigning(root), 'already-patched');
  assert.equal(fs.readFileSync(file, 'utf8'), patched);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['macCodeSign.js']);
});

test('unknown or partly patched sources are refused without changing any bytes', (context) => {
  for (const source of [
    original + '\n// unexpected upstream edit\n',
    original.replace('cscPasswords);', 'cscPasswords, keychainPassword);'),
    'async function importCerts() {}',
  ]) {
    const { root, file } = fixture(context, source);
    assert.throws(() => fixElectronBuilderSigning(root), /Unrecognized electron-builder signing source/);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['macCodeSign.js']);
  }
});

test('dependency upgrades fail explicitly before modifying their source', (context) => {
  const { root, file } = fixture(context, original, '27.0.0');
  assert.throws(() => fixElectronBuilderSigning(root), /Unsupported app-builder-lib 27.0.0/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('production install without electron-builder succeeds ' + 'without creating dependencies', (context) => {
  const { root, builder } = fixture(context);
  fs.rmSync(builder, { recursive: true });
  assert.equal(fixElectronBuilderSigning(root), 'not-installed');
  assert.deepEqual(fs.readdirSync(path.join(root, 'node_modules')), []);
});
