// What a chip's card shows: the chip's value in a person's words. A code selection shows its captured code,
// highlighted and scrollable; a place its file (and route and the page it was seen on); every other chip what it
// names. Never the compact reference the agent gets: an element's place in the tree means nothing to a reader.
import { CodeBlock, CodeInline } from '../../../ui/CodeBlock';
import type { MentionChip } from '../../../../shared/properties/ai/mentions';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { BUILTIN_CHIPS } from './builtinChips';
import { baseName, codeLinesLabel, componentLabel, memberLabel } from './mentionChips';

/** A chip and what its card adds to it: why it no longer matches the project, and a mentioned file's stored excerpt. */
export interface ChipSubject {
  readonly chip: MentionChip;
  readonly problem?: string | undefined;
  readonly excerpt?: string | undefined;
}

export function ChipValue({ subject }: { readonly subject: ChipSubject }) {
  const translate = useTranslate();
  const rows = valueRows(subject, translate);
  return (
    <>
      <div className="ai-chip-card-title">
        <span className="ai-chip-card-kind">{rows.kind}</span>
        <span className="ai-chip-card-name">{rows.name}</span>
      </div>
      {rows.details.map((detail) => (
        <div key={detail} className="ai-chip-card-detail">
          <bdi>{detail}</bdi>
        </div>
      ))}
      {rows.code !== undefined && (
        <CodeBlock className="ai-chip-card-code" text={rows.code.text} filename={rows.code.filename} label={translate('ai.chip.card.code')} />
      )}
      {rows.value !== undefined && <CodeInline className="ai-chip-card-value" text={rows.value} />}
      {subject.problem !== undefined && <div className="ai-chip-card-why">{subject.problem}</div>}
    </>
  );
}

interface ValueRows {
  readonly kind: string;
  readonly name: string;
  readonly details: readonly string[];
  readonly code?: { readonly text: string; readonly filename: string } | undefined;
  readonly value?: string | undefined;
}

function valueRows({ chip, excerpt }: ChipSubject, translate: Translator): ValueRows {
  switch (chip.kind) {
    case 'code':
      return {
        kind: translate('ai.chip.kind.code'),
        name: `${chip.element ?? baseName(chip.path)} · ${codeLinesLabel(chip)}`,
        details: [chip.path],
        code: { text: chip.code, filename: chip.path },
      };
    case 'page':
      return {
        kind: translate(`ai.chip.kind.${chip.role}`),
        name: chip.name,
        details: [
          chip.path,
          ...(chip.route === undefined ? [] : [translate('ai.chip.place.route', { route: chip.route })]),
          ...(chip.viewedOn === undefined ? [] : [translate('ai.chip.place.viewedOn', { page: chip.viewedOn })]),
        ],
      };
    case 'file':
      return {
        kind: translate('ai.chip.kind.file'),
        name: baseName(chip.path),
        details: [chip.path],
        ...(excerpt === undefined ? {} : { code: { text: excerpt, filename: chip.path } }),
      };
    case 'skill':
      return { kind: translate('ai.chip.kind.skill'), name: chip.name, details: chip.path === '' ? [] : [chip.path] };
    case 'builtin':
      return {
        kind: translate('ai.chip.kind.instructions'),
        name: translate(BUILTIN_CHIPS[chip.id].titleKey),
        details: [translate(BUILTIN_CHIPS[chip.id].descriptionKey)],
      };
    case 'component':
      return { kind: translate('ai.chip.kind.component'), name: chip.name, details: [chip.path] };
    case 'element':
      return { kind: translate('ai.chip.kind.element'), name: `<${chip.tag}>`, details: [chip.path] };
    case 'member': {
      const owner = componentLabel(chip.component).replace(/#.*$/u, '');
      return {
        kind: translate(`ai.chip.member.${chip.role}`),
        name: memberLabel(chip, translate),
        details: [owner],
        value: chip.role === 'slot' ? undefined : chip.value,
      };
    }
    case 'css':
      return {
        kind: translate(chip.target === 'variable' ? 'ai.chip.kind.variable' : 'ai.chip.kind.class'),
        name: chip.target === 'variable' ? chip.name : `.${chip.name}`,
        details: chip.path === undefined ? [] : [chip.path],
      };
    case 'asset':
      return { kind: translate('ai.chip.kind.asset'), name: baseName(chip.path), details: [chip.path] };
    default: {
      const exhaustive: never = chip;
      return exhaustive;
    }
  }
}
