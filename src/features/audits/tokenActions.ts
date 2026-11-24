// What the Raw value and Unit rows offer beside their findings, and where a finding's code is.
// Pure, so the panel's quick actions ("Allow em values", "Don't flag widths and heights") and
// the go-to-line a declaration row asks for are tested without drawing the panel.
import { assert } from '../../../shared/core/assert';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import type { AuditCheckId, AuditFinding } from '../../../shared/page/auditFindings';
import { SIZE_PROPERTIES } from '../../../shared/page/auditTokens';
import {
  AUDIT_UNIT_GROUP_IDS,
  AUDIT_UNIT_GROUPS,
  unitGroupAllowed,
  unitGroupOf,
  type AuditTokenSettings,
  type AuditUnitGroup,
} from '../../../shared/properties/auditIgnores';

/** The checks whose findings are raw values a token setting can allow. */
const TOKEN_SETTING_CHECKS: ReadonlySet<AuditCheckId> = new Set<AuditCheckId>(['token-value', 'token-unit']);

/** The unit groups the findings hold that the project still flags, in Settings order. */
export function flaggedUnitGroups(findings: readonly AuditFinding[], settings: Pick<AuditTokenSettings, 'allowedUnits'>): readonly AuditUnitGroup[] {
  const present = new Set<AuditUnitGroup>();
  for (const finding of findings) {
    const token = TOKEN_SETTING_CHECKS.has(finding.check) ? finding.css?.token : undefined;
    const group = token === undefined ? undefined : unitGroupOf(token);
    if (group !== undefined) {
      present.add(group);
    }
  }
  const groups = AUDIT_UNIT_GROUP_IDS.filter((group) => present.has(group) && !unitGroupAllowed(settings, group));
  assert(groups.length <= AUDIT_UNIT_GROUP_IDS.length, 'flaggedUnitGroups: one entry per group');
  return groups;
}

/** Whether any finding is a raw width or height, which "Don't flag widths and heights" would clear. */
export function holdsSizeFindings(findings: readonly AuditFinding[]): boolean {
  return findings.some(
    (finding) => TOKEN_SETTING_CHECKS.has(finding.check) && finding.css !== undefined && SIZE_PROPERTIES.has(finding.css.property.toLowerCase()),
  );
}

/** A group's units as text for a label: `em`, `%`, `vw, vh, vmin…`. Units are CSS and read the same in every language. */
export function unitGroupText(group: AuditUnitGroup, form: 'short' | 'full'): string {
  const units: readonly string[] = AUDIT_UNIT_GROUPS[group];
  assert(units.length > 0, 'unitGroupText: a group has units');
  const shown = form === 'short' && units.length > 3 ? [...units.slice(0, 3), '…'] : units;
  return shown.join(', ').replace(', …', '…');
}

/**
 * Where a finding's code is, for the code window: the offset inside a `<style>` block's text (the editor shows that text, so
 * its line is counted there, not in the .astro file), or a stylesheet's own line. Undefined when there is no code to show:
 * markup has no code window of its own, and an inline `style=""` is edited in the Style panel.
 */
export type AuditCodeTarget =
  { readonly tag: 'style-block'; readonly path: readonly number[]; readonly offset: number } | { readonly tag: 'file'; readonly line: number };

export function codeTarget(finding: Pick<AuditFinding, 'css'>): AuditCodeTarget | undefined {
  const place = finding.css?.place;
  if (place === undefined) {
    return undefined;
  }
  switch (place.tag) {
    case 'style-block':
      assert(place.offset >= 0, 'codeTarget: an offset into the block');
      return { tag: 'style-block', path: place.path, offset: place.offset };
    case 'stylesheet': {
      const line = finding.css?.line;
      return line === undefined ? undefined : { tag: 'file', line };
    }
    default: {
      const exhaustive: never = place;
      return exhaustive;
    }
  }
}

/** The 1-based line of `offset` in `text`: the line the code window reveals for a declaration in a `<style>` block. */
export function lineAtOffset(text: string, offset: number): number {
  assert(Number.isSafeInteger(offset), 'lineAtOffset: an integer offset');
  assert(offset >= 0, 'lineAtOffset: a non-negative offset');
  const end = Math.min(offset, text.length);
  let line = 1;
  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

/**
 * A row's identity in the list: the finding's id with where its bytes are. Two declarations can share an id (the same
 * selector, property and value twice in one block), so the place keeps their rows, and the one marked as gone to, apart.
 */
export function findingRowKey(finding: Pick<AuditFinding, 'id' | 'css'>): string {
  const place = finding.css?.place;
  const where = place === undefined ? (finding.css?.line ?? '') : place.offset;
  assert(finding.id.length > 0, 'findingRowKey: a finding has an id');
  return `${finding.id}#${where}`;
}

/**
 * Whether a lone finding still gets its element's row above it: a raw value in a `<style>` reads as the block's row with the
 * declaration under it, exactly as a block with several does, so one finding never shows as a bare "style" with nothing to open.
 */
export function declarationUnderElement(finding: Pick<AuditFinding, 'css' | 'element'>): boolean {
  return finding.css !== undefined && finding.element !== undefined;
}

/** A declaration row's muted line: its selector and the line it is on, `.nav_toggle · line 42`. */
export function declarationNote(css: Pick<NonNullable<AuditFinding['css']>, 'selector' | 'line'>, translate: Translator = ENGLISH_TRANSLATE): string {
  return css.line === undefined ? css.selector : `${css.selector} · ${translate('auditsUi.fixes.line', { line: css.line })}`;
}
