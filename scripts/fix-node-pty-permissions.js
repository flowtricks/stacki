// node-pty ships prebuilt binaries whose `spawn-helper` is packed WITHOUT the
// execute bit — the published tarball has it as `-rw-r--r--`, so npm faithfully
// extracts it as 0644. node-pty execs that helper (via posix_spawnp) to
// allocate a pty on Unix, so a non-executable helper makes EVERY pty.spawn
// throw `posix_spawnp failed.` and the terminal never starts.
//
// Nothing upstream restores it: node-pty's install step is
// `prebuild.js || node-gyp rebuild`, and prebuild.js exits 0 when a prebuild
// exists for the platform — so the node-gyp build, which would have produced an
// executable helper, never runs. VS Code chmods it in its own build for the
// same reason.
//
// Only Unix prebuilds have a spawn-helper (Windows uses ConPTY), and node-pty
// currently publishes prebuilds for darwin only — Linux still compiles from
// source and gets an executable helper from node-gyp, so this is a no-op there.
//
// Runs from `postinstall` (dev + CI installs) and again from electron-builder's
// afterPack against the packaged app, in case the bit is lost while copying
// into the bundle.

const fs = require('node:fs');
const path = require('node:path');

const EXEC_MODE = 0o755;

// Every `<root>/prebuilds/<platform>-<arch>/spawn-helper` under a node-pty dir.
function findSpawnHelpers(nodePtyDir) {
  const prebuilds = path.join(nodePtyDir, 'prebuilds');
  let entries;
  try {
    entries = fs.readdirSync(prebuilds, { withFileTypes: true });
  } catch {
    return []; // built from source, or no prebuilds — nothing to fix
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(prebuilds, e.name, 'spawn-helper'))
    .filter((p) => fs.existsSync(p));
}

// Also covers a node-gyp build output, which normally already has +x.
function findBuiltHelper(nodePtyDir) {
  const p = path.join(nodePtyDir, 'build', 'Release', 'spawn-helper');
  return fs.existsSync(p) ? [p] : [];
}

/**
 * Ensure every spawn-helper under `nodePtyDir` is executable.
 * @returns {string[]} paths whose mode was actually changed
 */
function fixNodePtyPermissions(nodePtyDir) {
  const fixed = [];
  for (const helper of [...findSpawnHelpers(nodePtyDir), ...findBuiltHelper(nodePtyDir)]) {
    const mode = fs.statSync(helper).mode & 0o777;
    if ((mode & 0o111) === 0o111) continue; // already executable for all
    fs.chmodSync(helper, EXEC_MODE);
    fixed.push(helper);
  }
  return fixed;
}

module.exports = { fixNodePtyPermissions };

if (require.main === module) {
  // Windows has no spawn-helper — ConPTY needs no exec bit.
  if (process.platform === 'win32') process.exit(0);
  const root = path.join(__dirname, '..');
  const nodePtyDir = path.join(root, 'node_modules', 'node-pty');
  if (!fs.existsSync(nodePtyDir)) process.exit(0); // not installed yet
  try {
    for (const p of fixNodePtyPermissions(nodePtyDir)) {
      console.log(`  • node-pty: made ${path.relative(root, p)} executable`);
    }
  } catch (err) {
    // Never fail the install over this — surface it instead. A broken terminal
    // is bad; a broken `npm install` is worse.
    console.warn(`  • node-pty: could not fix spawn-helper permissions: ${err.message}`);
  }
}
