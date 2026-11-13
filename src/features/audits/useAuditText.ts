// The audit model's sentences, in the language on screen. `shared/page` cannot call a hook, so a check, a finding and a fix
// carry their English beside an optional message reference (docs/i18n-playbook.md section 7); this hook shows the translation
// when the catalog knows the key and the English the model produced otherwise. One place, so every row says the same thing.
import { AUDIT_CHECKS, type AuditCheckId, type AuditFinding, type AuditFix } from '../../../shared/page/auditFindings';
import { useTranslateDescribed } from '../../lib/i18n/useTranslate';

export interface AuditText {
  /** A check's name: "Missing alt text". */
  readonly checkTitle: (check: AuditCheckId) => string;
  /** Why a check matters, for the (i) tip. */
  readonly checkWhy: (check: AuditCheckId) => string;
  /** What this occurrence is: a sentence, or the code it names (`src="/a.png"`) when the detail has no reference. */
  readonly detail: (finding: Pick<AuditFinding, 'detail' | 'detailRef'>) => string;
  /** The measurement shown beside a row ("35 characters"), or undefined when the finding has none. */
  readonly measure: (finding: Pick<AuditFinding, 'measure' | 'measureRef'>) => string | undefined;
  /** A fix's button words: "Add lang". */
  readonly fixLabel: (fix: Pick<AuditFix, 'label' | 'labelRef'>) => string;
}

export function useAuditText(): AuditText {
  const translateDescribed = useTranslateDescribed();
  return {
    checkTitle: (check) => translateDescribed({ message: AUDIT_CHECKS[check].title, messageRef: AUDIT_CHECKS[check].titleRef }),
    checkWhy: (check) => translateDescribed({ message: AUDIT_CHECKS[check].why, messageRef: AUDIT_CHECKS[check].whyRef }),
    detail: (finding) => translateDescribed({ message: finding.detail, messageRef: finding.detailRef }),
    measure: (finding) => (finding.measure === undefined ? undefined : translateDescribed({ message: finding.measure, messageRef: finding.measureRef })),
    fixLabel: (fix) => translateDescribed({ message: fix.label, messageRef: fix.labelRef }),
  };
}
