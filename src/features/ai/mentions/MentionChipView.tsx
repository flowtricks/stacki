// A mention chip drawn as plain React: the pill a sent message, a queued one and a pin's words show, the same
// look as the chip in the composer (the editor draws that one as a widget; this is for everywhere else).
// Presentational: it holds no draft and reads nothing from the store.
//
// Resting on a chip, or reaching it with the keyboard, shows its value in a card (useChipCard.tsx). The App
// builder instructions chip is also a button that copies the bundled instructions and says "Copied" for a moment,
// as it does in the composer. Any other chip does nothing on its own; a caller that wants a click passes
// `onClick`, and the chip becomes a button.
//
// `data-chip-copy` holds the chip's readable text, which a copied selection of the transcript writes in the chip's
// place (chipCopy.ts): a pill's label alone would lose a code chip's code.
import { useEffect, useRef, useState } from 'react';
import type { MentionChip } from '../../../../shared/properties/ai/mentions';
import { chipReadableText } from '../../../../shared/properties/ai/sentMessage';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import '../../../ui/chipEditor/chipEditor.css';
import { COPIED_LABEL_MS, copyBuiltinChip } from './builtinChips';
import { CHIP_STYLE_ICONS, chipLook, chipStyleOf } from './mentionChips';
import { useChipCard } from './useChipCard';
import './mentions.css';

export interface MentionChipViewProps {
  readonly chip: MentionChip;
  readonly onClick?: (() => void) | undefined;
  /** A mentioned file's excerpt as the transcript stored it. */
  readonly excerpt?: string | undefined;
  /** `none` inside a button (a pin's row), where a second tab stop would be unreachable. */
  readonly focus?: 'stop' | 'none' | undefined;
}

export function MentionChipView({ chip, onClick, excerpt, focus = 'stop' }: MentionChipViewProps) {
  const translate = useTranslate();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const card = useChipCard();
  const look = chipLook(chip, translate);
  const Icon = CHIP_STYLE_ICONS[chipStyleOf(chip)];
  const copy = (): void => {
    if (chip.kind !== 'builtin') {
      return;
    }
    void copyBuiltinChip(chip.id).then((done) => {
      if (done) {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_LABEL_MS);
      }
    });
  };
  const subject = { chip, excerpt };
  const shared = {
    className: `chip-editor-chip mention-chip-view${copied ? ' is-copied' : ''}`,
    'data-chip-kind': look.kind,
    'data-chip-copy': chipReadableText(chip),
    'data-chip-block': chip.kind === 'code' ? 'true' : undefined,
    'aria-label': `${look.label}, ${look.title ?? look.label}`,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => card.rest(event.currentTarget, subject),
    onMouseLeave: card.leave,
    onFocus: (event: React.FocusEvent<HTMLElement>) => card.focus(event.currentTarget, subject),
    onBlur: card.leave,
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (card.key(event.key)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
  const content = (
    <>
      <Icon size={12} />
      <span className="chip-editor-chip-label" aria-live="polite">
        {copied ? translate('ai.common.copied') : look.label}
      </span>
    </>
  );
  return (
    <>
      {chip.kind === 'builtin' || onClick !== undefined ? (
        <button type="button" {...shared} onClick={chip.kind === 'builtin' ? copy : onClick}>
          {content}
        </button>
      ) : (
        <span {...shared} tabIndex={focus === 'stop' ? 0 : undefined}>
          {content}
        </span>
      )}
      {card.card}
    </>
  );
}
