// Goal: the updater shipped in universal releases selects the native successor.
// Method: exercise the installed updater's own architecture filter against a
// mixed manifest in both orders, without constructing an Electron application.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MacUpdater } from 'electron-updater/out/MacUpdater.js';
import type { ResolvedUpdateFileInfo } from 'electron-updater';

class MacUpdaterProbe extends MacUpdater {
  static selectNative(
    files: readonly ResolvedUpdateFileInfo[],
    architecture: 'arm64' | 'x64',
  ): readonly ResolvedUpdateFileInfo[] {
    return this.filterFilesForArch([...files], architecture === 'arm64');
  }
}

const files = ['arm64', 'x64'].flatMap((architecture) =>
  ['dmg', 'zip'].map((extension) => {
    const name = `Stacki-0.1.88-${architecture}.${extension}`;
    return {
      url: new URL(`https://example.com/${name}`),
      info: { url: name, sha512: Buffer.alloc(64).toString('base64'), size: 12345 },
    };
  }),
);

test('universal installations select the correct native ZIP regardless of manifest order', () => {
  for (const architecture of ['arm64', 'x64'] as const) {
    for (const order of [files, [...files].reverse()]) {
      const selected = MacUpdaterProbe.selectNative(order, architecture);
      assert.equal(selected.length, 2);
      assert.equal(
        selected.find((file) => file.url.pathname.endsWith('.zip'))?.info.url,
        `Stacki-0.1.88-${architecture}.zip`,
      );
      assert.ok(selected.every((file) => file.info.url.includes(`-${architecture}.`)));
    }
  }
});

test('legacy universal assets remain usable before the architecture split', () => {
  const universal = [
    {
      url: new URL('https://example.com/Stacki-0.1.87-universal.zip'),
      info: { url: 'Stacki-0.1.87-universal.zip', sha512: '', size: 12345 },
    },
  ];
  for (const architecture of ['arm64', 'x64'] as const) {
    assert.deepEqual(MacUpdaterProbe.selectNative(universal, architecture), universal);
  }
});
