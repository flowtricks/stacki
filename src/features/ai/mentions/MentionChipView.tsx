// A mention chip drawn as plain React: the purple pill a sent message shows in its
// bubble, the same look as the chip in the composer (the editor draws that one as a
// widget, this is for everywhere else). Presentational: it holds no draft and reads
// nothing from the store.
//
// The App builder instructions chip is a button that copies the bundled instructions
// and says "Copied" for a moment, as it does in the composer. A file or skill chip does
// nothing on its own; a caller that wants a click (to expand the file's excerpt) passes
// `onClick`, and the chip becomes a button.
import { useEffect, useRef, useState } from 'react';
import type { BuiltinChipId } from '../../../../shared/properties/ai/mentions';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { FileIcon, InstructionsIcon, SkillIcon } from '../../../ui/Icons';
import '../../../ui/chipEditor/chipEditor.css';
import { BUILTIN_CHIPS, COPIED_LABEL_MS, copyBuiltinChip } from './builtinChips';
import { baseName } from './mentionChips';
import './mentions.css';

/** What a chip view needs to draw one; a draft's `MentionChip` and a sent message's part both fit. */
export type MentionChipViewChip =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'skill'; readonly name: string; readonly path?: string }
  | { readonly kind: 'builtin'; readonly id: BuiltinChipId };

export function MentionChipView({ chip, onClick }: { readonly chip: MentionChipViewChip; readonly onClick?: () => void }) {
  const translate = useTranslate();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
    },
    [],
  );
  const look = viewLook(chip, translate);
  const copy = (): void => {
    if (chip.kind !== 'builtin') {
      return;
    }
    void copyBuiltinChip(chip.id).then((done) => {
      if (done) {
        setCopied(true);
        if (timer.current !== undefined) {
          clearTimeout(timer.current);
        }
        timer.current = setTimeout(() => setCopied(false), COPIED_LABEL_MS);
      }
    });
  };
  const className = `chip-editor-chip mention-chip-view${copied ? ' is-copied' : ''}`;
  const content = (
    <>
      {look.icon}
      <span className="chip-editor-chip-label" aria-live="polite">
        {copied ? translate('ai.common.copied') : look.label}
      </span>
    </>
  );
  if (chip.kind === 'builtin' || onClick !== undefined) {
    return (
      <button
        type="button"
        className={className}
        data-chip-kind={chip.kind}
        title={look.title}
        aria-label={look.title}
        onClick={chip.kind === 'builtin' ? copy : onClick}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={className} data-chip-kind={chip.kind} title={look.title}>
      {content}
    </span>
  );
}

function viewLook(chip: MentionChipViewChip, translate: Translator): { readonly label: string; readonly title: string; readonly icon: React.ReactNode } {
  switch (chip.kind) {
    case 'file':
      return { label: baseName(chip.path), title: chip.path, icon: <FileIcon size={12} /> };
    case 'skill':
      return {
        label: chip.name,
        title:
          chip.path === undefined
            ? translate('ai.mention.skillTitleShort', { name: chip.name })
            : translate('ai.mention.skillTitle', { name: chip.name, path: chip.path }),
        icon: <SkillIcon size={12} />,
      };
    case 'builtin':
      return {
        label: translate(BUILTIN_CHIPS[chip.id].titleKey),
        title: translate(BUILTIN_CHIPS[chip.id].descriptionKey),
        icon: <InstructionsIcon size={12} />,
      };
    default: {
      const exhaustive: never = chip;
      return exhaustive;
    }
  }
}
