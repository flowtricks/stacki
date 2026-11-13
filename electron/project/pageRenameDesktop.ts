import { LIMITS } from '../../shared/core/limits';
import { err, ok } from '../../shared/core/result';
import { decodeUtf8 } from '../../shared/core/span';
import { digestOf } from '../documents/atomicWrite';
import { documentHost, describeWriteReport } from '../documents/documentWrites';
import type { RenameWriter } from './pageRenameWrite';
import { translateMain } from '../lib/mainLocale';

/** Desktop uses the same witnessed actors as normal editor saves. */
export function desktopRenameWriter(): RenameWriter {
  const { documents, noteWrite } = documentHost();
  return {
    lease: (texts, run) => {
      if (texts.length > LIMITS.documentActorsMax) {
        return err({
          code: 'limit',
          message: translateMain('error.pageRename.tooManyFiles'),
        });
      }
      const leased = documents.withLeases(texts, run);
      return leased.ok ? leased.value : err({ code: 'filesystem', message: leased.error });
    },
    current: (file) => {
      const current = documents.current(file);
      if (!current.ok) {
        return current;
      }
      const decoded = decodeUtf8(current.value.bytes);
      return decoded.ok ? ok(decoded.value) : err({ code: 'encoding', message: translateMain('error.pageRename.notUtf8', { file }) });
    },
    write: (entry) => {
      noteWrite(entry.file);
      const report = documents.writeText(entry.file, entry.after, digestOf(entry.before));
      return report.tag === 'applied' ? ok(undefined) : err({ code: 'write', message: describeWriteReport(entry.file, report) });
    },
  };
}
