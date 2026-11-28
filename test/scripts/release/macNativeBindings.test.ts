// Goal: each Mac package retains a working terminal on its own architecture.
// Methodology: exercise the packaging verifier with bounded Mach-O fixtures,
// including missing, foreign, truncated, and non-executable native files.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeIntelBindings, verifyMacNativeBindings } from '#dist/scripts/release/macNativeBindings.js';

test('only the Apple silicon package leaves out the Intel terminal binaries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stacki-mac-intel-'));
  try {
    const folders = ['darwin-arm64', 'darwin-x64'].map((name) => join(directory, 'prebuilds', name));
    for (const folder of folders) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'pty.node'), '');
    }
    const [arm, intel] = folders.map((folder) => join(folder, 'pty.node'));
    assert.ok(arm !== undefined && intel !== undefined);
    removeIntelBindings(directory, 'x64');
    assert.ok(existsSync(arm));
    assert.ok(existsSync(intel));
    removeIntelBindings(directory, 'arm64');
    assert.ok(existsSync(arm));
    assert.ok(!existsSync(intel));
    // A package that never held them is accepted.
    assert.doesNotThrow(() => removeIntelBindings(directory, 'arm64'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const architecture of ['x64', 'arm64'] as const) {
  // Windows cannot represent the Unix execute bits this packaging check enforces.
  test(
    `Mac ${architecture} packaging requires correct native bindings and executable helpers`,
    {
      skip: process.platform === 'win32',
    },
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'stacki-mac-bindings-'));
      try {
        assert.throws(
          () => verifyMacNativeBindings(directory, architecture),
          /Missing Mac node-pty/,
        );
        {
          const folder = join(directory, 'prebuilds', `darwin-${architecture}`);
          mkdirSync(folder, { recursive: true });
          const header = Buffer.alloc(8);
          header.writeUInt32LE(0xfeedfacf, 0);
          header.writeUInt32LE(architecture === 'x64' ? 0x01000007 : 0x0100000c, 4);
          for (const name of ['pty.node', 'spawn-helper'] as const) {
            writeFileSync(join(folder, name), header, { mode: 0o755 });
          }
        }
        assert.doesNotThrow(() => verifyMacNativeBindings(directory, architecture));
        const binding = join(directory, 'prebuilds', `darwin-${architecture}`, 'pty.node');
        const header = Buffer.alloc(8);
        header.writeUInt32LE(0xfeedfacf, 0);
        header.writeUInt32LE(architecture === 'x64' ? 0x0100000c : 0x01000007, 4);
        writeFileSync(binding, header);
        assert.throws(
          () => verifyMacNativeBindings(directory, architecture),
          /match its prebuild directory/,
        );
        header.writeUInt32LE(architecture === 'x64' ? 0x01000007 : 0x0100000c, 4);
        header.writeUInt32LE(0, 0);
        writeFileSync(binding, header);
        assert.throws(() => verifyMacNativeBindings(directory, architecture), /64-bit Mach-O/);
        writeFileSync(binding, header.subarray(0, 4));
        assert.throws(() => verifyMacNativeBindings(directory, architecture));
        header.writeUInt32LE(0xfeedfacf, 0);
        writeFileSync(binding, header);
        const helper = join(directory, 'prebuilds', `darwin-${architecture}`, 'spawn-helper');
        // Windows does not expose Unix execute bits; the Mac packaging job checks them.
        if (process.platform !== 'win32') {
          chmodSync(helper, 0o644);
          assert.throws(
            () => verifyMacNativeBindings(directory, architecture),
            /must be executable/,
          );
          chmodSync(helper, 0o755);
        }
        rmSync(helper);
        assert.throws(
          () => verifyMacNativeBindings(directory, architecture),
          /Missing Mac node-pty/,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}
