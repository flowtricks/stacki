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
    renameSync: { count: 2, reason: 'asset and asset folder moves; a move writes no bytes' },
  },
  'electron/handlers/cmsHandlers.ts': {
    writeFileSync: { count: 2, reason: '.stacki/cms.json metadata' },
  },
  'electron/handlers/devServers.ts': {
    writeFileSync: { count: 4, reason: 'the generated preview harness in node_modules/.avb' },
  },
  'electron/project/pageRenameWrite.ts': {
    renameSync: { count: 1, reason: 'a page or folder move; text changes use the host writer' },
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
      count: 2,
      reason: 'generated Studio dev config in node_modules and session metadata ignore rules',
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
  'electron/project/starter.ts': {
    writeFileSync: { count: 1, reason: 'package.json of a new project from a starter' },
  },
  'electron/terminal/terminal.ts': {
    writeFileSync: { count: 1, reason: 'a pasted clipboard image in the app temp directory' },
  },
  // Studio releases are new tool source staged outside website documents;
  // the second write ignores transaction metadata in Git. No website text is edited.
  'electron/project/studioInstall.ts': {
    writeFile: {
      count: 2,
      reason: 'staged Studio release files and transaction metadata ignore rules',
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
  ]);
  assert.deepEqual(users(/new NodeDocumentDisk\b/), ['electron/documents/documentActors.ts']);
  assert.deepEqual(users(/\bcreateNodeDocumentActors\(/), [
    'electron/documents/documentActors.ts',
    'electron/documents/documentWrites.ts',
    'electron/main.ts',
  ]);
  assert.deepEqual(users(/\binstallDocumentHost\(/), [
    'electron/documents/documentWrites.ts',
    'electron/main.ts',
  ]);
  // The old unverified writer is gone, not merely unused.
  assert.deepEqual(users(/\bwriteFileAtomic\b/), []);
});

test('the renderer and the shared contracts hold no file-writing API', () => {
  for (const directory of ['src', 'shared']) {
    for (const file of sources(path.resolve(directory))) {
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(
        /from ['"](node:)?fs(\/promises)?['"]/.test(text),
        false,
        `${file} imports node:fs`,
      );
    }
  }
});
