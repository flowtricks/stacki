// Goal: the build wires studio/cloudflare/auth-provider.ts in when it exists and satisfies the interface, falls back to
// GitHub when it does not exist, and stops loudly when it exists but does not fit.
// Method: a throwaway copy of the Studio layout (src/cloudflare copied, everything else linked) so the real slot module is
// never touched; run the build step (scripts/authProviderSlot.ts) against a good, a wrong and an absent provider file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_PROVIDER_FILE, SLOT_FILE, authProviderSlotSource, prepareAuthProvider, typeCheckCommand } from '../scripts/authProviderSlot';

const studio = fileURLToPath(new URL('../', import.meta.url));

async function layout(): Promise<string> {
  const copy = await mkdtemp(path.join(tmpdir(), 'studio-auth-slot-'));
  for (const file of ['tsconfig.json', 'tsconfig.worker.json', 'package.json']) {
    await cp(path.join(studio, file), path.join(copy, file));
  }
  for (const link of ['node_modules', 'vendor']) {
    await symlink(path.join(studio, link), path.join(copy, link));
  }
  await mkdir(path.join(copy, 'src'));
  for (const entry of await readdir(path.join(studio, 'src'))) {
    if (entry === 'cloudflare') {
      await cp(path.join(studio, 'src/cloudflare'), path.join(copy, 'src/cloudflare'), { recursive: true });
    } else {
      await symlink(path.join(studio, 'src', entry), path.join(copy, 'src', entry));
    }
  }
  await mkdir(path.join(copy, 'cloudflare'));
  return copy;
}

const GOOD = `import type { AuthProviderFactory } from '../src/features/auth/authProvider';
const factory: AuthProviderFactory = () => ({
  id: 'example',
  displayName: 'Example',
  begin: () => Promise.resolve(new Response(null, { status: 302, headers: { Location: 'https://idp.example/x' } })),
  identify: () => Promise.resolve({ ok: false, error: { problem: 'expired' } }),
});
export default factory;
`;

test('with no provider file the slot is the committed default', async () => {
  assert.equal(
    authProviderSlotSource('built-in'),
    await readFile(path.join(studio, SLOT_FILE), 'utf8'),
    'the committed slot is what the build writes with no custom provider',
  );
  const copy = await layout();
  try {
    assert.equal(await prepareAuthProvider(copy), 'built-in');
    assert.equal(await readFile(path.join(copy, SLOT_FILE), 'utf8'), authProviderSlotSource('built-in'));
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});

test('a provider file that satisfies the interface is wired in, and removing it restores GitHub', { timeout: 300_000 }, async () => {
  const copy = await layout();
  try {
    await writeFile(path.join(copy, AUTH_PROVIDER_FILE), GOOD);
    assert.equal(await prepareAuthProvider(copy), 'custom');
    assert.equal(await readFile(path.join(copy, SLOT_FILE), 'utf8'), authProviderSlotSource('custom'));
    await rm(path.join(copy, AUTH_PROVIDER_FILE));
    assert.equal(await prepareAuthProvider(copy), 'built-in');
    assert.equal(await readFile(path.join(copy, SLOT_FILE), 'utf8'), authProviderSlotSource('built-in'));
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});

test('a provider file that does not satisfy the interface fails the build with the reason', { timeout: 300_000 }, async () => {
  const copy = await layout();
  try {
    for (const wrong of [
      'export default 42;\n',
      GOOD.replace("id: 'example',", 'id: 5,'),
      GOOD.replace('begin:', 'start:'),
      'export const notDefault = 1;\n',
    ]) {
      await writeFile(path.join(copy, AUTH_PROVIDER_FILE), wrong);
      await assert.rejects(() => prepareAuthProvider(copy), /does not satisfy the AuthProvider interface[\s\S]*error TS/);
    }
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});

test('the interface check runs the compiler through Node, so it starts on Windows too', () => {
  // node_modules/.bin/tsc is a shell script Windows cannot spawn; the 010980b8 Check failed there with a null stdout.
  const { command, argumentsList } = typeCheckCommand(studio);
  assert.equal(command, process.execPath);
  assert.equal(argumentsList[0], path.join(studio, 'node_modules', 'typescript', 'bin', 'tsc'));
  assert.deepEqual(argumentsList.slice(1), ['-p', 'tsconfig.worker.json', '--noEmit', '--pretty', 'false']);
});
