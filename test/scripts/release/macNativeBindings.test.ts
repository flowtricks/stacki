// Goal: each Mac package retains a working terminal on its own architecture.
// Methodology: exercise the packaging verifier with bounded Mach-O fixtures,
// including missing, foreign, truncated, and non-executable native files.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyMacNativeBindings } from '#dist/scripts/release/macNativeBindings.js';

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
