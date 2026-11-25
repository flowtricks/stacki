// The Page settings dialog's IPC: planning a step for its confirm (nothing written), applying it (all files or
// none, one undo token), undoing and redoing it, and a template page's settings read back and changed. The plans and
// their writes live in pageSettingsPlan.ts and ../project/pageRelocationWrite.ts; this file only connects them.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { described } from '../../shared/properties/i18n/messageRef';
import type { PageSettingsApplied } from '../../shared/properties/pageSettings';
import type { DataSource } from '../../shared/properties/pageTemplate';
import { readAstroPages } from '../lib/astroConfig';
import { projectAliases } from '../properties/importPaths';
import { readPageTemplate, retargetPageTemplate } from '../content/pageTemplateRead';
import { desktopRenameWriter } from '../project/pageRenameDesktop';
import { readRenameText } from '../project/pageRenameInventory';
import { applyRelocationStep, inverseStep, NO_FOLDERS, RelocationStore, type RelocationStep } from '../project/pageRelocationWrite';
import { planRelocationSliced } from './pageSettingsPlan';
import { registerPageBulkRemoveHandlers } from './pageBulkRemoveHandlers';
import type { MainHost } from './mainHost';

export function registerPageSettingsHandlers({ ipcMain, noteAppWrite }: Pick<MainHost, 'ipcMain' | 'noteAppWrite'>): void {
  const store = new RelocationStore();
  // Select mode's deletion of several pages shares this store, so its Undo is `page:revertSettings` too.
  registerPageBulkRemoveHandlers({ ipcMain, noteAppWrite }, store);

  ipcMain.handle('page:planSettings', async (_event, { projectPath, request }) => {
    const refused = refuseMovedPagesFolder(projectPath);
    if (refused !== undefined) {
      return refused;
    }
    const planned = await planRelocationSliced(projectPath, request, projectAliases(projectPath));
    return planned.ok ? ok(planned.value.summary) : err(planned.error);
  });

  // Planned again from disk: what the confirm showed may be stale, and the write is checked against these bytes.
  ipcMain.handle('page:applySettings', async (_event, { projectPath, request }) => {
    const refused = refuseMovedPagesFolder(projectPath);
    if (refused !== undefined) {
      return refused;
    }
    const planned = await planRelocationSliced(projectPath, request, projectAliases(projectPath));
    if (!planned.ok) {
      return err(planned.error);
    }
    noteAppWrite();
    const applied = applyRelocationStep(planned.value.step, desktopRenameWriter());
    noteAppWrite();
    return applied.ok ? ok({ summary: planned.value.summary, undo: store.record(planned.value.step), page: planned.value.page }) : err(applied.error);
  });

  ipcMain.handle('page:revertSettings', async (_event, { token, direction }) => {
    const step = store.get(token);
    if (step === undefined) {
      return err({ code: 'unknown-undo', ...described('pages.settings.error.undoGone') });
    }
    noteAppWrite();
    const done = applyRelocationStep(direction === 'undo' ? inverseStep(step) : step, desktopRenameWriter());
    noteAppWrite();
    return done.ok ? ok({ files: step.texts.length + step.files.length }) : err(done.error);
  });

  ipcMain.handle('page:readTemplate', async (_event, { projectPath, page }) => {
    const read = readRenameText(projectPath, 'src/pages/' + page);
    return read === undefined ? { kind: 'none' as const } : readPageTemplate(page, read.source);
  });

  ipcMain.handle('page:retargetTemplate', async (_event, { projectPath, page, source }) => {
    const planned = retargetStep(projectPath, page, source);
    if (!planned.ok) {
      return err(planned.error);
    }
    noteAppWrite();
    const applied = applyRelocationStep(planned.value, desktopRenameWriter());
    noteAppWrite();
    const reply: PageSettingsApplied = { summary: { files: 1, links: 0, moves: [], reviews: [], reviewsMore: 0 }, undo: store.record(planned.value), page };
    return applied.ok ? ok(reply) : err(applied.error);
  });
}

/** A template's settings changed as one text step: only its paths function and entry type are rewritten. */
export function retargetStep(projectPath: string, page: string, source: DataSource): Result<RelocationStep> {
  assert(path.isAbsolute(projectPath), 'A template change writes under an absolute project root');
  if (source.kind !== 'content-collection' || source.origin !== 'existing') {
    return err({ code: 'custom', ...described('pages.settings.template.newCollection') });
  }
  const file = 'src/pages/' + page;
  if (!fs.existsSync(path.join(projectPath, ...file.split('/')))) {
    return err({ code: 'missing', ...described('pages.rename.error.missing') });
  }
  const read = readRenameText(projectPath, file);
  if (read === undefined) {
    return err({ code: 'encoding', ...described('pages.settings.error.notText', { file }) });
  }
  const next = retargetPageTemplate(page, read.source, { collection: source.collection, slug: source.slug });
  if (!next.ok) {
    return next;
  }
  return ok({ root: projectPath, texts: next.value === read.source ? [] : [{ file, before: read.source, after: next.value }], files: [], folders: NO_FOLDERS });
}

// Steps name files by their src/pages paths, so a project whose astro.config moves the pages folder is refused with the reason.
function refuseMovedPagesFolder(projectPath: string): Result<never> | undefined {
  const { pagesFolder, configFile } = readAstroPages(projectPath);
  if (pagesFolder === 'src/pages') {
    return undefined;
  }
  return err({
    code: 'pages-folder',
    message: `Renaming pages is not supported when ${configFile ?? 'astro.config'} moves the pages folder to ${pagesFolder}. Rename the file in your editor.`,
  });
}
