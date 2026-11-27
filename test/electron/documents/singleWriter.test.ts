// Goal: from step 5 nothing outside the document actors writes a page, chunk or
// stylesheet (plan §3.3, §5.2 "one writer per file", §11 step 5). Every write of
// project text goes through a file's actor: electron/documents/documentDisk.ts is the one
// module that calls the write primitives of electron/documents/atomicWrite.ts, one host
// (electron/documents/documentActors.ts) owns that disk, and one process-wide installer
// (electron/documents/documentWrites.ts, used by main.ts) owns the host.
// Method: a static inventory of the main process's sources. Every call of a
// file-writing API in electron/ is counted per file and API; each count outside
// the actor's disk must match an entry below, and each entry carries its reason
// — what the site writes and why it is not a document. A new write anywhere, or
// one more in an allowed file, fails here until it is routed through
// documentWrites.ts or given a reason. The renderer (src/) and shared/ cannot
// write files at all; the lint fences keep node:fs out of the engine contracts.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

// Files are named by their whole repository path, so a moved file's entry is
// rewritten with it (scripts/move/moveSources.mts) instead of going stale.
const ROOT = path.resolve('electron');
const repositoryPath = (file: string): string => path.relative('.', file).split(path.sep).join('/');
const WRITE_APIS = [
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'copyFileSync',
  'copyFile',
  'cpSync',
  'createWriteStream',
  'renameSync',
  'linkSync',
  'symlinkSync',
  'symlink',
  'truncateSync',
  'ftruncateSync',
  'replaceFileAtomic',
  'createFileExclusive',
] as const;
const WRITE_API = new RegExp(String.raw`\b(${WRITE_APIS.join('|')})\s*\(`, 'g');

interface Allowed {
  readonly count: number;
  readonly reason: string;
}

/** file → API → count and reason. The actor's own disk is listed too. */
const ALLOWED: Readonly<Record<string, Readonly<Record<string, Allowed>>>> = {
  'electron/documents/atomicWrite.ts': {
    writeFileSync: { count: 2, reason: 'the staged temporary file and an exclusive creation' },
    renameSync: { count: 1, reason: 'the atomic replace itself' },
    replaceFileAtomic: { count: 1, reason: 'its definition' },
    createFileExclusive: { count: 1, reason: 'its definition' },
  },
  'electron/documents/documentDisk.ts': {
    replaceFileAtomic: { count: 1, reason: 'the actor disk: §5.2 step 8' },
    createFileExclusive: { count: 1, reason: 'the actor disk: a new document' },
    writeFileSync: { count: 1, reason: 'the advisory lock file (§5.2 step 7)' },
    renameSync: { count: 1, reason: 'moving a stale lock file aside' },
    linkSync: { count: 1, reason: 'putting back a live lock moved aside by mistake' },
  },
  'electron/content/cmsConnectionStore.ts': {
    writeFileSync: { count: 1, reason: 'encrypted CMS connection keys in userData, never a page' },
    renameSync: { count: 1, reason: 'puts that connection file in place whole (atomic save)' },
  },
  'electron/content/styleMoveJournals.ts': {
    writeFileSync: { count: 1, reason: 'the temporary copy of a "Move styles" journal in userData/logs, the app’s memory of a move and never a page' },
    renameSync: { count: 1, reason: 'puts that journal in place whole (durable save, flushed before and after)' },
  },
  'electron/content/mcpFiles.ts': {
    writeFileSync: { count: 1, reason: 'the project MCP config (.mcp.json or Codex config), a settings file and never a page' },
    renameSync: { count: 1, reason: 'puts that config file in place whole (atomic save)' },
  },
  'electron/content/media/mediaConnectionStore.ts': {
    writeFileSync: { count: 1, reason: 'encrypted media hosting keys in userData (media-connections.json), never a page' },
    renameSync: { count: 1, reason: 'puts that connection file in place whole (atomic save)' },
  },
  'electron/content/contentConfig.ts': {
    writeFileSync: { count: 2, reason: 'runner scripts in the app work directory' },
  },
  'electron/content/contentRefs.ts': {
    renameSync: { count: 1, reason: 'moves a content entry; a move writes no bytes' },
  },
  'electron/app/autoUpdate.ts': {
    appendFileSync: { count: 1, reason: 'the auto-update log in userData' },
  },
  'electron/handlers/assetHandlers.ts': {
    cpSync: { count: 1, reason: 'copies an asset in under a fresh unique name; never replaces' },
    copyFileSync: {
      count: 1,
      reason: 'replaces the bytes of a public/ file or a src/ media file (assets:replace); src/ code is refused before the copy',
    },
    renameSync: { count: 2, reason: 'asset and asset folder moves; a move writes no bytes' },
  },
  'electron/handlers/cmsHandlers.ts': {
    writeFileSync: { count: 2, reason: '.stacki/cms.json metadata' },
  },
  // Design mode (experimental, docs/design-mode/REMOVE.md): its sandbox copy and drafts, in Stacki's data folder,
  // never the project (the fence refuses that: electron/lib/designMode/designWriteGuard.ts).
  'electron/handlers/designMode/designDrafts.ts': {
    renameSync: { count: 1, reason: 'a draft written whole to a temporary file, then put in place' },
    writeFileSync: { count: 1, reason: "the frames' draft, in the app's data folder" },
  },
  'electron/handlers/designMode/designFrames.ts': {
    writeFile: { count: 1, reason: "a frame's file put into the sandbox copy when the frame is shown" },
  },
  'electron/handlers/designMode/designSandbox.ts': {
    copyFile: { count: 1, reason: 'the project copied into the sandbox' },
    symlink: { count: 1, reason: 'a link inside the project kept as a link in the sandbox copy' },
  },
  'electron/handlers/designMode/designSnapshots.ts': {
    writeFile: { count: 1, reason: "a frame's snapshot written whole to a temporary file in the app's data folder" },
  },
  'electron/handlers/devServers.ts': {
    writeFileSync: { count: 6, reason: 'the generated preview harness in node_modules/.avb, with the component preview recipe' },
  },
  'electron/preview/imageCacheConfig.ts': {
    writeFileSync: { count: 1, reason: 'a generated dev server config in node_modules/.avb, never a page' },
  },
  'electron/project/explorerOps.ts': {
    renameSync: {
      count: 4,
      reason:
        'the Files panel renames and moves entries (a case-only rename passes through a free name in the same folder); a move writes no bytes, and a taken name is refused or answered first',
    },
    copyFileSync: { count: 1, reason: 'the Files panel copies a file to a new name with COPYFILE_EXCL, so nothing is ever replaced' },
    symlinkSync: { count: 1, reason: 'a link inside a copied or imported folder is copied as a link, never followed' },
  },
  'electron/project/pageRelocationWrite.ts': {
    createFileExclusive: {
      count: 1,
      reason: 'a page that arrives is first staged whole in the project’s .stacki/io, which the watcher ignores; the edited texts use the host writer',
    },
    renameSync: { count: 4, reason: 'a page file leaves for .stacki/io and arrives at its destination, and the same two moves back on a failure or an undo' },
  },
  'electron/project/studioAuthFile.ts': {
    writeFile: { count: 1, reason: 'Studio’s wrangler.jsonc sign-in variables, written to a temporary file and renamed whole; not a website document' },
  },
  'electron/project/studioUpgrade.ts': {
    writeFile: {
      count: 1,
      reason:
        'the last Studio upgrade’s record (.stacki/studio/updates/last-upgrade.json) for the restore button: app metadata, never a page, chunk or stylesheet',
    },
  },
  'electron/git/gitSnapshot.ts': {
    writeFile: {
      count: 1,
      reason: 'a NUL-separated pathspec list in a fresh OS temporary folder for git --pathspec-from-file, removed after the command; outside the project',
    },
  },
  'electron/project/pageRenameWrite.ts': {
    renameSync: { count: 1, reason: 'a page or folder move; text changes use the host writer' },
  },
  'electron/handlers/componentRenameApply.ts': {
    renameSync: { count: 3, reason: 'a component file or folder move (a case-only rename goes through a temporary name); text changes use the host writer' },
  },
  'electron/project/publishToolInstall.ts': {
    writeFileSync: {
      count: 1,
      reason: 'the package.json of a staging folder Stacki just made for the pinned Wrangler install, created exclusive (wx); never project text',
    },
    renameSync: { count: 1, reason: 'the verified staging folder moved to the tools folder in one step; the old copy is removed first' },
  },
  'electron/project/publishWorkerSetup.ts': {
    writeFile: {
      count: 1,
      reason: 'the Worker config Add Worker writes for a site that has none, created exclusive (wx) so an authored config is never overwritten',
    },
  },
  'electron/project/astroCopyWrite.ts': {
    writeFile: {
      count: 2,
      reason: 'files of a brand-new Astro copy of a plain-HTML site, created exclusive (wx) in a temporary sibling folder; the original is only read',
    },
    copyFile: { count: 1, reason: 'a binary asset copied into that new folder, exclusive (COPYFILE_EXCL); nothing existing is overwritten' },
    renameSync: { count: 1, reason: 'the finished temporary folder moved to the target name in one atomic step, asserted missing just before' },
  },
  'electron/project/cli/cliApply.ts': {
    writeFileSync: { count: 1, reason: 'the CLI undo journal entry in .stacki, written to a temporary file' },
    renameSync: { count: 1, reason: 'the journal entry moved into place whole' },
  },
  'electron/project/cli/cliEffects.ts': {
    writeFileSync: { count: 1, reason: 'binary app files under .stacki/apps/<id>/, created new (wx); never page text' },
  },
  'electron/project/newProjectDefaults.ts': {
    writeFileSync: { count: 1, reason: '.stacki/styles.json metadata for a project Stacki just made' },
  },
  'electron/main.ts': {
    writeFileSync: { count: 3, reason: 'app state in userData (reopen, settings, recents)' },
  },
  'electron/preview/markerConfig.ts': {
    writeFileSync: {
      count: 2,
      reason: 'writes inside the text of a generated Astro integration that runs in the dev server',
    },
  },
  'electron/lib/projectExclusions.ts': {
    writeFileSync: { count: 1, reason: 'git local exclude migration; never website source' },
  },
  'electron/previewServer/studioLocal.ts': {
    writeFileSync: {
      count: 1,
      reason: 'generated Studio dev config in node_modules',
    },
  },
  'electron/project/publishReceipt.ts': {
    writeFile: {
      count: 1,
      reason: 'deployment confirmation in Git private metadata; never website documents',
    },
  },
  'electron/project/publishWorkerConfig.ts': {
    writeFile: {
      count: 1,
      reason: 'exclusive temporary Wrangler config inside a publish snapshot; removed after deploy',
    },
  },
  // An app bundle is static files only ever served to its sandboxed frame, never a page:
  // written whole into a staging folder and renamed into place, beside its lockfile.
  'electron/project/appStore.ts': {
    writeFileSync: { count: 2, reason: "an installed app bundle's files in .stacki/apps/<id> (staged), and the apps lockfile's temporary copy" },
    renameSync: { count: 2, reason: 'puts the staged app folder in place whole, and the lockfile (atomic save)' },
  },
  // What apps keep and do beyond their bundle. None of these is a page, chunk or stylesheet:
  // app metadata, sealed secrets and tokens live in their own JSON files, and the project
  // files an app writes go through the document actors when they are text.
  'electron/handlers/appAccessHandlers.ts': {
    writeFileSync: { count: 1, reason: 'the staged copy of non-UTF-8 bytes an app writes (an image); text goes through the document actors' },
    renameSync: { count: 1, reason: 'puts those staged bytes in place whole' },
  },
  'electron/handlers/appDataHandlers.ts': {
    writeFileSync: { count: 1, reason: "this computer's random person key in userData (app-person-device), made once" },
  },
  'electron/project/appFilesStore.ts': {
    writeFile: {
      count: 2,
      reason: "calls of the host's injected writer (document actors for text on Desktop) for an app's write and its undo, not node:fs",
    },
    renameSync: { count: 1, reason: 'an app moving one project file; a move writes no bytes' },
  },
  'electron/project/appSettingsStore.ts': {
    writeFileSync: { count: 1, reason: 'the temporary copy of .stacki/apps/settings.json or a sealed secrets vault file in userData' },
    renameSync: { count: 1, reason: 'puts that settings file in place whole (atomic save)' },
  },
  'electron/project/appSignIn.ts': {
    writeFileSync: { count: 1, reason: "the temporary copy of an app's sealed OAuth tokens in the secret vault, outside the project" },
    renameSync: { count: 1, reason: 'puts that token file in place whole (atomic save)' },
  },
  'electron/project/deployLinkStore.ts': {
    writeFileSync: { count: 1, reason: 'encrypted deploy links, written atomically and owner-only in app data, never a project document' },
    renameSync: { count: 1, reason: 'puts that deploy link file in place whole (atomic save)' },
  },
  'electron/project/appStorageStore.ts': {
    writeFileSync: { count: 1, reason: "the temporary copy of an app's stored values (.stacki/app-data/<id>.json or the local folder)" },
    renameSync: { count: 1, reason: 'puts that storage file in place whole (atomic save)' },
  },
  'electron/project/publishSnapshot.ts': {
    symlink: { count: 1, reason: "the publish snapshot's node_modules link, in a temporary checkout, never in the project" },
  },
  'electron/project/starter.ts': {
    writeFileSync: { count: 1, reason: 'package.json of a new project from a starter' },
  },
  // The AI chat panel's own files, all in userData or the system temp folder, never in the project.
  // The project files an agent's edit is undone in go through the document actors (aiHandlers.ts).
  'electron/handlers/ai/agentInstaller.ts': {
    writeFileSync: { count: 3, reason: "a pinned adapter's package.json, lockfile and install marker, staged in userData/agents" },
    renameSync: { count: 1, reason: 'puts the staged adapter folder in place whole' },
  },
  'electron/handlers/ai/chatStore.ts': {
    appendFileSync: { count: 1, reason: "a chat's transcript in userData/ai, append-only" },
    writeFileSync: { count: 1, reason: 'the temporary copy of the chat index or a reviews file in userData/ai' },
    renameSync: { count: 1, reason: 'puts that index or reviews file in place whole (atomic save)' },
  },
  'electron/handlers/ai/pinBoardStore.ts': {
    writeFileSync: { count: 1, reason: "the temporary copy of a project's comment pins board or one of its images, in userData/ai" },
    renameSync: { count: 1, reason: 'puts that board or image in place whole (atomic save)' },
  },
  'electron/handlers/ai/pinPictures.ts': {
    writeFileSync: { count: 1, reason: "a pin's picture as an owner-only scratch file in userData/ai/pin-pictures, for the pin's subagent; removed after" },
  },
  'electron/handlers/ai/treeSnapshot.ts': {
    copyFileSync: { count: 1, reason: "a temporary copy of the project's git index in the system temp folder, for a snapshot; removed after" },
  },
  'electron/terminal/terminal.ts': {
    writeFileSync: { count: 1, reason: 'a pasted clipboard image in the app temp directory' },
  },
  // Studio releases are new tool source staged outside website documents;
  // the second write ignores transaction metadata in Git. No website text is edited.
  'electron/previewServer/studioLocalMove.ts': {
    writeFileSync: { count: 1, reason: 'the ignore rule of Studio storage in .stacki/studio' },
    renameSync: { count: 1, reason: "moving an older Studio's state folders into .stacki/studio" },
  },
  'electron/project/studioInstall.ts': {
    writeFile: {
      count: 3,
      reason: 'staged Studio release files and the ignore rules of .stacki/studio and its updates',
    },
  },
  'electron/project/imageConversion.ts': {
    writeFileSync: {
      count: 1,
      reason: 'exclusive binary image creation; references use document actors',
    },
  },
  'electron/project/thumbs.ts': {
    writeFileSync: { count: 2, reason: 'project thumbnails in userData' },
  },
  // App state in userData, never in a project: the crash log ring, the window's bounds and the boot snapshot of recent projects.
  'electron/app/crashLog.ts': {
    writeFileSync: {
      count: 1,
      reason: 'the temporary copy of the bounded crash log in the directory main passes (userData), written for recovery diagnostics',
    },
    renameSync: { count: 1, reason: 'puts that crash log in place whole (atomic save)' },
  },
  'electron/app/dictationDownload.ts': {
    writeFile: {
      count: 1,
      reason: 'the verified-files marker of a downloaded dictation model in userData, written to a temporary file and renamed whole; never a project file',
    },
  },
  'electron/app/windowStateStore.ts': {
    writeFileSync: { count: 1, reason: "the temporary copy of the window's saved bounds in userData" },
    renameSync: { count: 1, reason: 'puts that bounds file in place whole (atomic save)' },
  },
  'electron/boot/bootStore.ts': {
    writeFileSync: { count: 1, reason: 'the temporary copy of the boot snapshot (recent projects) in userData' },
    renameSync: { count: 1, reason: 'puts that boot snapshot in place whole (atomic save)' },
  },
  // The EmDash installer scaffolds project configuration, not website documents: the Astro
  // integration config it merges into, the live collections config it creates, and the ignore
  // rules it appends. The merge is verified after it lands and the original is put back when it fails.
  'electron/handlers/emdashInstall.ts': {
    writeFileSync: {
      count: 3,
      reason:
        'the exclusive temporary copy of the merged Astro config, its restore of the original when the merge fails the check, and the new live config file',
    },
    renameSync: { count: 1, reason: 'puts the merged Astro config in place whole (atomic save)' },
    appendFileSync: { count: 1, reason: 'the ignore rules of EmDash appended to .gitignore; never a page, chunk or stylesheet' },
  },
};

function sources(directory: string): readonly string[] {
  const found: string[] = [];
  const pending = [directory];
  for (let visited = 0; visited < pending.length; visited++) {
    assert.ok(visited < 1_000, 'electron/ is a bounded tree');
    const current = pending[visited];
    assert.ok(current !== undefined);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.name.endsWith('.ts')) {
        if (!entry.name.endsWith('.d.ts')) {
          found.push(full);
        }
      }
    }
  }
  return found.sort();
}

function inventory(): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const file of sources(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(WRITE_API)) {
      const api = match[1];
      assert.ok(api !== undefined);
      const key = repositoryPath(file);
      const perFile = (counts[key] ??= {});
      perFile[api] = (perFile[api] ?? 0) + 1;
    }
  }
  return counts;
}

test('every file write in electron/ is the actor disk or an allowed non-document write', () => {
  const actual = inventory();
  const expected: Record<string, Record<string, number>> = {};
  for (const [file, apis] of Object.entries(ALLOWED)) {
    for (const [api, allowed] of Object.entries(apis)) {
      assert.ok(allowed.reason.length > 0, `${file} ${api} states its reason`);
      (expected[file] ??= {})[api] = allowed.count;
    }
  }
  assert.deepEqual(
    actual,
    expected,
    'A new write site: route project text through electron/documents/documentWrites.ts, ' +
      'or allow it here with the reason it is not a page, chunk or stylesheet.',
  );
});

test('the write primitives, the actor disk and the host each have one owner', () => {
  const users = (pattern: RegExp): readonly string[] =>
    sources(ROOT)
      .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
      .map(repositoryPath);
  assert.deepEqual(users(/\b(replaceFileAtomic|createFileExclusive)\b/), [
    'electron/documents/atomicWrite.ts',
    'electron/documents/documentDisk.ts',
    'electron/project/pageRelocationWrite.ts',
  ]);
  assert.deepEqual(users(/new NodeDocumentDisk\b/), ['electron/documents/documentActors.ts']);
  assert.deepEqual(users(/\bcreateNodeDocumentActors\(/), ['electron/documents/documentActors.ts', 'electron/documents/documentWrites.ts', 'electron/main.ts']);
  assert.deepEqual(users(/\binstallDocumentHost\(/), ['electron/documents/documentWrites.ts', 'electron/main.ts']);
  // The old unverified writer is gone, not merely unused.
  assert.deepEqual(users(/\bwriteFileAtomic\b/), []);
});

test('the renderer and the shared contracts hold no file-writing API', () => {
  for (const directory of ['src', 'shared']) {
    for (const file of sources(path.resolve(directory))) {
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(/from ['"](node:)?fs(\/promises)?['"]/.test(text), false, `${file} imports node:fs`);
    }
  }
});
