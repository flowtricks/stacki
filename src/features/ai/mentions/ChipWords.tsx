// Words with `@` chips as they read once written: the text, and each chip drawn as the composer draws it (the same
// label, colour and icon, mentionChips.ts), for places that show words rather than edit them: a comment pin's box once
// sent, its row in the list and its card in the transcript. The chips are not controls, so the words can sit inside a
// button that does something with the whole of them.
import { Fragment } from 'react';
import type { ComposerSegments, MentionChip } from '../../../../shared/properties/ai/mentions';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import '../../../ui/chipEditor/chipEditor.css';
import { chipLook, chipStyleOf, CHIP_STYLE_ICONS } from './mentionChips';
import './mentions.css';

export function ChipWords({ segments }: { readonly segments: ComposerSegments }) {
  return segments.map((segment, index) =>
    segment.kind === 'text' ? <Fragment key={index}>{segment.text}</Fragment> : <ChipWord key={index} chip={segment.chip} />,
  );
}

function ChipWord({ chip }: { readonly chip: MentionChip }) {
  const translate = useTranslate();
  const look = chipLook(chip, translate);
  const Icon = CHIP_STYLE_ICONS[chipStyleOf(chip)];
  return (
    <span className="chip-editor-chip mention-chip-view" data-chip-kind={look.kind} title={look.title}>
      <Icon size={12} />
      <span className="chip-editor-chip-label">{look.label}</span>
    </span>
  );
}
