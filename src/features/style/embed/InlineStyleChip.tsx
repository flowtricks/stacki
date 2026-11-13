import { centralIcon } from '../../../ui/central/CentralIcon';
import { braces as centralBraces, edit as centralEdit } from '../../../ui/central/centralGeometry';
// The "Inline styles" chip: the last in the selector well, standing for the selected
// element's `style` attribute (useInlineTarget.ts). Amber in every state, so it never
// reads as a selector: it is not one, and it outranks them all. Clicking it makes the
// attribute the edit target; clicking it again leaves it. Right-click, or its `⋯`,
// offers to clear the attribute.

import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import { MenuSurface, menuBoxBelow, type MenuItem } from '../../../ui/MoreMenu';
import { MoreIcon } from '../../../ui/Icons';
import { ENGLISH_TRANSLATE } from '../../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../../shared/properties/i18n/messageRef';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { INLINE_STYLE_LABEL_KEY } from '../model/inlineTarget';
import type { InlineChip } from './useInlineTarget';

const MENU_WIDTH_PX = 170;

export function InlineStyleChip({ chip, busy }: { readonly chip: InlineChip; readonly busy: boolean }): ReactNode {
  const translate = useTranslate();
  const [box, setBox] = useState<CSSProperties | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const items: readonly MenuItem[] =
    chip.onClear === undefined ? [] : [{ label: translate('styleModel.embed.chip.clear'), danger: true, onSelect: chip.onClear }];
  assert(items.length <= 1, 'InlineStyleChip: one action');
  const openAt = (rect: DOMRect): void => {
    if (items.length === 0) {
      return;
    }
    setBox(menuBoxBelow(rect, items.length, MENU_WIDTH_PX));
    setOpen(true);
  };
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={inlineChipClassName(chip)}
        disabled={busy}
        aria-pressed={chip.active}
        aria-label={inlineChipLabel(chip, translate)}
        title={inlineChipTitle(chip, translate)}
        onClick={() => {
          if (chip.active) {
            chip.onDeselect();
          } else {
            chip.onSelect();
          }
        }}
        onContextMenu={(event) => {
          if (items.length === 0) {
            return;
          }
          event.preventDefault();
          openAt(new DOMRect(event.clientX, event.clientY, 0, 0));
        }}
      >
        {chip.state === 'code' ? <CodeGlyph className="embed-editor_inline-chip-icon" /> : <StyleGlyph className="embed-editor_inline-chip-icon" />}
        <span className="embed-editor_selector-chip-text">{translate(INLINE_STYLE_LABEL_KEY)}</span>
      </button>
      {items.length > 0 ? (
        <button
          type="button"
          className="embed-editor_inline-chip-more"
          title={translate('styleModel.embed.chip.options')}
          aria-label={translate('styleModel.embed.chip.options')}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            if (open) {
              setOpen(false);
            } else {
              openAt(event.currentTarget.getBoundingClientRect());
            }
          }}
        >
          <MoreIcon size={12} />
        </button>
      ) : undefined}
      {box ? (
        <MenuSurface
          open={open}
          anchor={chipRef.current ?? undefined}
          rows={items}
          box={box}
          width={MENU_WIDTH_PX}
          menuRef={menuRef}
          close={() => setOpen(false)}
        />
      ) : undefined}
    </>
  );
}

/** The chip's classes: its own colour family, then its state. */
export function inlineChipClassName(chip: Pick<InlineChip, 'state' | 'active'>): string {
  return ['embed-editor_selector-chip', 'is-inline', chip.state === 'code' && 'is-code', chip.active && 'is-active'].filter(Boolean).join(' ');
}

export function inlineChipTitle(chip: Pick<InlineChip, 'state' | 'active'>, translate: Translator = ENGLISH_TRANSLATE): string {
  const label = translate(INLINE_STYLE_LABEL_KEY);
  if (chip.state === 'code') {
    return translate('styleModel.embed.chip.titleCode', { label });
  }
  return chip.active ? translate('styleModel.embed.chip.titleActive', { label }) : translate('styleModel.embed.chip.titleIdle', { label });
}

function inlineChipLabel(chip: Pick<InlineChip, 'state'>, translate: Translator): string {
  const label = translate(INLINE_STYLE_LABEL_KEY);
  return chip.state === 'code' ? translate('styleModel.embed.chip.labelCode', { label }) : label;
}

// A brush: styles written on the element itself.
const StyleGlyph = centralIcon(centralEdit, 12);

// Braces: an attribute written as code.
const CodeGlyph = centralIcon(centralBraces, 12);
