// electron-builder hook that restores node-pty's spawn-helper execute bit in
// the copied application, where packaging can otherwise remove it.

import fs = require('node:fs');
import path = require('node:path');
import type { AfterPackContext } from 'app-builder-lib';
import { Arch } from 'builder-util';
import { fixNodePtyPermissions } from '../install/fixNodePtyPermissions';
import { verifyLinuxNativeBinding } from './linuxNativeBinding';
import { verifyMacNativeBindings } from './macNativeBindings';

function packageArchitecture(architecture: Arch): 'arm64' | 'x64' {
  if (architecture === Arch.arm64) {
    return 'arm64';
  }
  if (architecture === Arch.x64) {
    return 'x64';
  }
  throw new Error(`The package architecture ${architecture} is not supported.`);
}

export default function afterPack(context: AfterPackContext): void {
  const appName = context.packager.appInfo.productFilename;
  const unpacked =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app.asar.unpacked')
      : path.join(context.appOutDir, 'resources', 'app.asar.unpacked');
  const nodePtyDirectory = path.join(unpacked, 'node_modules', 'node-pty');

  if (context.electronPlatformName === 'linux') {
    if (context.arch !== Arch.x64) {
      throw new Error('The Linux release currently supports x64.');
    }
    verifyLinuxNativeBinding(nodePtyDirectory);
    console.log('  • afterPack: verified the Linux x64 node-pty native binding');
    return;
  }

  if (context.electronPlatformName === 'win32') {
    const architecture = packageArchitecture(context.arch);
    const nativeBinding = path.join(
      nodePtyDirectory,
      'prebuilds',
      `win32-${architecture}`,
      'pty.node',
    );
    if (!fs.existsSync(nativeBinding)) {
      throw new Error(`The packaged Windows app is missing the ${architecture} node-pty binding.`);
    }
    console.log('  • afterPack: verified the Windows node-pty native binding');
    return;
  }

  const fixed = fixNodePtyPermissions(nodePtyDirectory);
  verifyMacNativeBindings(nodePtyDirectory, packageArchitecture(context.arch));
  console.log(
    fixed.length > 0
      ? `  • afterPack: restored exec bit on ${fixed.length} node-pty spawn-helper(s)`
      : '  • afterPack: node-pty spawn-helper already executable',
  );
}
