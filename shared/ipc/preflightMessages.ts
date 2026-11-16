// The words of a pre-flight finding (shared/engine/preflight.ts): one plain sentence per finding,
// in the person's language, for the notice that says why an edit was held. Desktop and Studio
// translate with their own `translate`; main, which has no editor catalog loaded, writes the
// English form for the report's detail and logs (ENGLISH_TRANSLATE).
import { assert } from '../core/assert';
import type { PreflightCode, PreflightFinding } from '../engine/preflight';
import type { MessageKey } from '../properties/i18n/messages/en/index';
import type { Translator } from '../properties/i18n/messageRef';

const FINDING_KEYS: Readonly<Record<PreflightCode, MessageKey>> = {
  'undefined-name': 'editor.preflight.finding.undefinedName',
  'missing-component': 'editor.preflight.finding.missingComponent',
  'named-from-astro': 'editor.preflight.finding.namedFromAstro',
  'default-from-module': 'editor.preflight.finding.defaultFromModule',
  'duplicate-name': 'editor.preflight.finding.duplicateName',
  'props-in-page': 'editor.preflight.finding.propsInPage',
  'missing-file': 'editor.preflight.finding.missingFile',
  'frontmatter-syntax': 'editor.preflight.finding.frontmatterSyntax',
};

/** One finding as a sentence fragment: "Button isn’t defined in this file." */
export function preflightFindingText(finding: PreflightFinding, translate: Translator): string {
  return translate(FINDING_KEYS[finding.code], { subject: finding.subject });
}

/** The notice for a held edit: why, naming the first finding; the rest are in the technical details. */
export function preflightRefusalText(findings: readonly PreflightFinding[], translate: Translator): string {
  const first = findings[0];
  if (first === undefined) {
    return translate('editor.preflight.refused');
  }
  const text = translate('editor.preflight.refusedBecause', { reason: preflightFindingText(first, translate) });
  assert(text.length > 0, 'A refusal says why');
  return text;
}
