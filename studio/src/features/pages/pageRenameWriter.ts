import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { err, ok } from '../../../vendor/stacki/shared/core/result';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import type { RenameWriter } from '../../../vendor/stacki/electron/project/pageRenameWrite';

/** Called only while the Studio coordinator owns all flushed collaboration documents. */
export const studioRenameWriter: RenameWriter = {
  lease: (_texts, run) => run(),
  current: (file) => {
    try {
      return ok(fs.readFileSync(file, 'utf8'));
    } catch (error: unknown) {
      return err({ code: 'read', message: String(error) });
    }
  },
  write: (entry) => {
    const temporary = entry.file + '.rename-' + randomUUID();
    try {
      if (fs.readFileSync(entry.file, 'utf8') !== entry.before) {
        return err({ code: 'conflict', ...described('pages.rename.error.changedDuring', { file: entry.file }) });
      }
      fs.writeFileSync(temporary, entry.after, {
        encoding: 'utf8',
        flag: 'wx',
        mode: fs.statSync(entry.file).mode,
      });
      if (fs.readFileSync(entry.file, 'utf8') !== entry.before) {
        return err({ code: 'conflict', ...described('pages.rename.error.changedDuring', { file: entry.file }) });
      }
      fs.renameSync(temporary, entry.file);
      return ok(undefined);
    } catch (error: unknown) {
      return err({ code: 'write', message: String(error) });
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  },
};
