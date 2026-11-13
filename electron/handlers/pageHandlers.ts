import { projectAliases } from '../properties/importPaths';
import { desktopRenameWriter } from '../project/pageRenameDesktop';
import { parsePageRename } from '../../shared/properties/pageRename';
import { planPageRename } from '../project/pageRenamePlan';
import { applyPageRename } from '../project/pageRenameWrite';
// The page IPC: reading, parsing and editing a page through its document
// actor, and creating, moving and deleting pages, folders and dynamic routes.

import { buildEdit } from '../documents/editRequests';
import { previewEdit, previewEdits } from '../documents/editPreview';
import { createProjectText } from '../documents/documentWrites';
import { sameFilesystemPath } from '../lib/platform';
import { assert } from '../../shared/core/assert';
import { describeRejection, type RejectionReason } from '../../shared/engine/intent';
import { decodeUtf8, encodeUtf8 } from '../../shared/core/span';
import type { Digest } from '../../shared/core/brand';
import { parseDynamicPaths } from '../app/mainValidation';
import * as path from 'path';
import * as fs from 'fs';
import { readInjectedRoutes } from '../preview/injectedRoutes';
import { newPageText } from '../documents/componentFile';
import { toPosix, errorMessage } from '../lib/mainHelpers';
import type { MainHost } from './mainHost';
import { routeForPage } from '../project/projectFiles';
import { parsePageSource, pageEditError, resolvePagesDirectory, fillRoute } from '../documents/pageRequests';
import { translateMain, translateMainDescribed } from '../lib/mainLocale';
import { DescribedError } from '../../shared/properties/describedError';

export function registerPageHandlers(host: Pick<MainHost, 'documents' | 'ipcMain' | 'noteAppWrite'>): void {
  registerPageReadHandlers(host);
  registerPageMoveHandlers(host);
  registerProjectInjectedRoutesHandlers(host);
}

function registerPageReadHandlers({ ipcMain, documents, noteAppWrite }: Pick<MainHost, 'ipcMain' | 'documents' | 'noteAppWrite'>): void {
  // Read through the page's actor (step 6): the bytes the renderer is shown are
  // the bytes its edits will name, so the host must hold them — as its current
  // snapshot, and retained once an outside write replaces them — or an edit
  // authored against them could only be refused.
  ipcMain.handle('page:read', async (_event, pagePath) => {
    const snapshot = readThroughActor({ documents }, pagePath);
    // Markdown builds the same tree from a different syntax, so everything
    // downstream — navigator, props, text editing, undo — is unchanged. Only
    // the writer has to know which one it is; model.format carries that.
    return { ...parsePageSource(pagePath, snapshot.text), checksum: snapshot.checksum };
  });

  ipcMain.handle('page:parse', async (_event, { pagePath, source }) => {
    return parsePageSource(pagePath, source);
  });

  // A visual edit (plan §11 step 6): the renderer states it against the page it
  // shows; editRequests.ts makes it an intent against that snapshot, and the
  // page's actor plans and writes it — splices, never a reprint of the file.
  // The reply is the page as written plus the inverse Undo will submit.
  //
  // The code editor's saves arrive here too (step 8): a code patch is bytes, not
  // nodes, so it applies to a page that does not parse — before or after.
  // Markdown and MDX pages take every edit since step 10 (markdownEdits.ts).
  ipcMain.handle('page:edit', async (_event, { pagePath, authoredChecksum, edit }) => {
    const code = edit.tag === 'code-patch';
    const gone = code ? ('merge-conflict' as const) : ('anchor-moved' as const);
    const stated = { authoredChecksum, gone };
    const report = documents.submitEdit(pagePath, stated, (base) => buildEdit(edit, base));
    if (report.tag !== 'applied') {
      return { ok: false as const, error: pageEditError(pagePath, report) };
    }
    const decoded = decodeUtf8(report.bytes);
    assert(decoded.ok, 'The actor wrote UTF-8');
    const text = decoded.value;
    // A <style> edit reaches the canvas fresh on this one write: the preview
    // config compiles the file before Vite announces the new stylesheet
    // (avbRecompile in the generated avb-morph plugin).
    noteAppWrite();
    const reply = { ...parsePageSource(pagePath, text), checksum: report.checksum };
    return { ok: true as const, ...reply, inverse: report.inverse };
  });

  // Several edits of one gesture, written once: a loop and the query it reads,
  // sent apart, gave the dev server a page between them whose loop read a
  // query not yet declared. They are planned in memory against the bytes the
  // renderer read (editPreview.ts), each held to what its own write would be
  // held to, and the result is written as one rewrite of those bytes. A page
  // that changed since is refused untouched: the renderer then sends the edits
  // one at a time, which rebase through outside writes.
  ipcMain.handle('page:editBatch', async (_event, { pagePath, authoredChecksum, edits }) => {
    const refused = (reason: RejectionReason, diskChecksum: Digest | undefined) => ({
      ok: false as const,
      error: pageEditError(pagePath, { tag: 'rejected', reason, message: describeRejection(reason), diskChecksum }),
    });
    const disk = documents.current(pagePath);
    if (!disk.ok) {
      return refused('write-failed', undefined);
    }
    if (disk.value.checksum !== authoredChecksum) {
      return refused('anchor-moved', disk.value.checksum);
    }
    const planned = previewEdits(pagePath, disk.value.bytes, authoredChecksum, edits);
    if (!planned.ok) {
      return refused(planned.error, authoredChecksum);
    }
    const decoded = decodeUtf8(planned.value.bytes);
    assert(decoded.ok, 'A plan of UTF-8 text is UTF-8');
    const text = decoded.value;
    const report = documents.writeText(pagePath, text, authoredChecksum);
    if (report.tag !== 'applied') {
      return { ok: false as const, error: pageEditError(pagePath, report) };
    }
    assert(report.checksum === planned.value.checksum, 'The batch wrote the bytes it planned');
    noteAppWrite();
    const reply = { ...parsePageSource(pagePath, text), checksum: report.checksum };
    return { ok: true as const, ...reply, inverse: report.inverse };
  });

  // A visual edit planned against the bytes the renderer sends and never
  // written (electron/documents/editPreview.ts): reviewing a conflicted page in code
  // shows its unsaved gestures as the splices they are. The reply has page:edit's
  // shape, so the renderer states the next request against it as it would
  // against a write.
  ipcMain.handle('page:previewEdit', async (_event, { pagePath, authoredChecksum, edit, source }) => {
    const refused = (reason: RejectionReason) => {
      const error = { code: 'rejected' as const, reason, message: describeRejection(reason) };
      return { ok: false as const, error: { ...error, diskChecksum: undefined } };
    };
    const planned = previewEdit(pagePath, encodeUtf8(source), authoredChecksum, edit);
    if (!planned.ok) {
      return refused(planned.error);
    }
    const decoded = decodeUtf8(planned.value.bytes);
    assert(decoded.ok, 'A plan of UTF-8 text is UTF-8');
    const reply = {
      ...parsePageSource(pagePath, decoded.value),
      checksum: planned.value.checksum,
    };
    return { ok: true as const, ...reply, inverse: planned.value.inverse };
  });

  ipcMain.handle('page:create', async (_event, { projectPath, name, layout }) => {
    const pagesDirectory = path.join(projectPath, 'src', 'pages');
    let fileName = name.trim().replace(/\.astro$/i, '');
    fileName = fileName.replace(/[^a-zA-Z0-9/_-]+/g, '-');
    if (!fileName) {
      throw new Error('Invalid page name');
    }
    const pagePath = path.join(pagesDirectory, fileName + '.astro');
    if (fs.existsSync(pagePath)) {
      throw new Error('A page with that name already exists.');
    }
    fs.mkdirSync(path.dirname(pagePath), { recursive: true });

    const eol = process.platform === 'win32' ? ('\r\n' as const) : ('\n' as const);
    const created = newPageText({ pagePath, layout: layout ?? undefined, eol });
    createProjectText(pagePath, created);
    return { pagePath };
  });

  ipcMain.handle('page:delete', async (_event, pagePath) => {
    noteAppWrite();
    fs.rmSync(pagePath);
    return { ok: true as const };
  });
}

function registerPageMoveHandlers({ ipcMain, noteAppWrite }: Pick<MainHost, 'ipcMain' | 'noteAppWrite'>): void {
  // Moves/renames a page within src/pages. `to` is the new path relative to
  // the pages dir (with extension). When the folder changes, relative imports
  // in the file's frontmatter are rewritten so they keep resolving.
  ipcMain.handle('page:move', async (_event, { projectPath, from, to }) => {
    const pagesDirectory = path.join(projectPath, 'src', 'pages');
    const change = parseRenameRequest({
      kind: 'page',
      from: toPosix(path.relative(pagesDirectory, from)),
      to,
    });
    renameProjectPages(projectPath, change);
    noteAppWrite();
    return { newPath: path.join(pagesDirectory, change.to) };
  });

  ipcMain.handle('pagefolder:create', async (_event, { projectPath, dir: directory }) => {
    fs.mkdirSync(resolvePagesDirectory(projectPath, directory), { recursive: true });
    return { ok: true as const };
  });

  ipcMain.handle('pagefolder:rename', async (_event, { projectPath, from, to }) => {
    renameProjectPages(projectPath, parseRenameRequest({ kind: 'folder', from, to }));
    noteAppWrite();
    return { ok: true as const };
  });

  ipcMain.handle('pagefolder:delete', async (_event, { projectPath, dir: directory }) => {
    const full = resolvePagesDirectory(projectPath, directory);
    const pagesDirectory = path.join(projectPath, 'src', 'pages');
    if (sameFilesystemPath(full, pagesDirectory)) {
      throw new Error('Invalid folder.');
    }
    fs.rmSync(full, { recursive: true, force: true });
    return { ok: true as const };
  });
}

function registerProjectInjectedRoutesHandlers({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  // Routes the project serves that are NOT files under src/pages — pages an
  // integration injected (issue #7). The site's own repo may have none of its
  // own at all, in which case these are the only pages there are. Preview only:
  // their source lives inside a dependency, so nothing here is editable, and
  // they are deliberately kept out of the page list the editor writes through.
  ipcMain.handle('project:injectedRoutes', async (_event, { projectPath }) => ({
    routes: readInjectedRoutes(projectPath),
  }));

  // The concrete URLs a dynamic page stands for, by asking the dev server to run
  // its getStaticPaths. Returns [] for a static page, and for any failure — a
  // page that can't answer is previewed at its own pattern, exactly as before.
  ipcMain.handle('page:dynamicPaths', async (_event, { projectPath, pagePath, devUrl }) => {
    const pattern = routeForPage(projectPath, pagePath);
    if (!pattern.includes('[') || !devUrl) {
      return { entries: [] };
    }
    const rel = toPosix(path.relative(projectPath, pagePath));
    try {
      const response = await fetch(`${devUrl}/__avb/paths?p=${encodeURIComponent(rel)}`);
      if (!response.ok) {
        return { entries: [], error: translateMain('error.pages.devServerStatus', { status: response.status }) };
      }
      const input: unknown = await response.json();
      const data = parseDynamicPaths(input);
      const entries = (data.entries || []).map((entry) => {
        // A dev server started before this app was updated still answers with
        // bare params objects — read both shapes rather than break its preview.
        const params = entry.params;
        return {
          params,
          props: (entry && entry.props) || undefined,
          route: fillRoute(pattern, params),
          // The values themselves read better in a picker than "slug=hello-world".
          label: Object.values(params).map(String).join(' / ') || pattern,
        };
      });
      return { entries, error: data.error || undefined };
    } catch (error: unknown) {
      return { entries: [], error: errorMessage(error) };
    }
  });
}

function readThroughActor({ documents }: Pick<MainHost, 'documents'>, pagePath: string): { readonly text: string; readonly checksum: Digest } {
  const current = documents.current(pagePath);
  if (!current.ok) {
    throw new Error(current.error.message);
  }
  const decoded = decodeUtf8(current.value.bytes);
  if (!decoded.ok) {
    throw new Error(`${path.basename(pagePath)} is not valid UTF-8`);
  }
  return { text: decoded.value, checksum: current.value.checksum };
}

/** `parsePageRename`, with its refusal worded in the language main speaks: the renderer shows a rejected invoke's message as received. */
function parseRenameRequest(input: unknown): ReturnType<typeof parsePageRename> {
  try {
    return parsePageRename(input);
  } catch (failure: unknown) {
    if (failure instanceof DescribedError) {
      throw new Error(translateMainDescribed(failure.problem));
    }
    throw failure;
  }
}

function renameProjectPages(projectPath: string, change: ReturnType<typeof parsePageRename>): void {
  const planned = planPageRename(projectPath, change, projectAliases(projectPath));
  if (!planned.ok) {
    throw new Error(translateMainDescribed(planned.error));
  }
  const saved = applyPageRename(planned.value, desktopRenameWriter());
  if (!saved.ok) {
    throw new Error(translateMainDescribed(saved.error));
  }
}
