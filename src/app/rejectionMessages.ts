// Why an edit request was refused, as a catalog key per reason: the shared layer (`describeRejection`) returns the English sentence, this
// table lets Desktop's conflict notice and Studio's write refusals show it in the person's language.
import type { RejectionReason } from '../../shared/engine/intent';
import type { MessageKey } from '../lib/i18n/localeContext';

export const REJECTION_KEYS: Readonly<Record<RejectionReason, MessageKey>> = {
  'anchor-moved': 'shell.rejection.anchorMoved',
  'anchor-ambiguous': 'shell.rejection.anchorAmbiguous',
  'region-externally-modified': 'shell.rejection.regionExternallyModified',
  'source-invalid': 'shell.rejection.sourceInvalid',
  'unsupported-operation': 'shell.rejection.unsupportedOperation',
  'resource-limit': 'shell.rejection.resourceLimit',
  'write-failed': 'shell.rejection.writeFailed',
  'write-race': 'shell.rejection.writeRace',
  'merge-conflict': 'shell.rejection.mergeConflict',
};
