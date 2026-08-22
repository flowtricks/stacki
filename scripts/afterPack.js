// electron-builder afterPack hook.
//
// Restores node-pty's spawn-helper exec bit inside the packaged app. The
// postinstall script already fixed it in node_modules, but the bit can be lost
// while copying into the bundle — and without it every pty.spawn throws
// `posix_spawnp failed.` in the shipped build only, which is the worst place to
// discover it. See scripts/fix-node-pty-permissions.js.

const path = require('node:path');
const fs = require('node:fs');
const { fixNodePtyPermissions } = require('./fix-node-pty-permissions');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return;

  const appName = context.packager.appInfo.productFilename;
  // node-pty is asarUnpack'd, so it lives beside app.asar as real files.
  const unpacked =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${appName}.app`,
          'Contents',
          'Resources',
          'app.asar.unpacked'
        )
      : path.join(context.appOutDir, 'resources', 'app.asar.unpacked');

  const nodePtyDir = path.join(unpacked, 'node_modules', 'node-pty');
  if (!fs.existsSync(nodePtyDir)) {
    console.warn('  • afterPack: node-pty not found in the packaged app; the terminal will not start.');
    return;
  }

  const fixed = fixNodePtyPermissions(nodePtyDir);
  console.log(
    fixed.length
      ? `  • afterPack: restored exec bit on ${fixed.length} node-pty spawn-helper(s)`
      : '  • afterPack: node-pty spawn-helper already executable'
  );
};
