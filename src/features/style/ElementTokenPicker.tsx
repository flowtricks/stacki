import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ElementSnapshot } from './model/styleTypes';
import { isAstroGeneratedAttribute, snapshotTokens } from './model/elementTokens';
import { TOOLTIP_DELAY_MS } from '../../ui/delayedTooltip';
import { assert } from '../../../shared/core/assert';
import { isInternalAttribute } from '../../../shared/core/internalAttributes';

/**
 * A read-only, monospace rendering of the selected element's identity as a CSS
 * selector — tag + `.class`es + `[attr]`/`[attr="value"]` (e.g.
 * `h2.hero_title.u-text-style-h2[data-x="1"]`). Just a reference; the actual
 * editable selectors live in the SelectorPicker below.
 *
 * The line is one row and scrolls sideways, so a long one is cut off, and it
 * names only the attributes a selector is written with (`data-*`). Resting the
 * pointer on it shows the whole element as grey chips, wrapped to the panel's
 * width: the tag, each class, the id, and every attribute it carries.
 */
export default function ElementTokenPicker({ snapshot }: { snapshot: ElementSnapshot | undefined }) {
  const parts = useMemo(() => elementParts(snapshot), [snapshot]);
  const tipParts = useMemo(() => elementTipParts(snapshot), [snapshot]);
  const tip = useElementTip();
  if (parts.length === 0) {
    return undefined;
  }
  return (
    <>
      <div className="embed-editor_element-id" onMouseEnter={tip.show} onMouseLeave={tip.hide}>
        {parts.join('')}
      </div>
      {tip.place === undefined
        ? undefined
        : createPortal(
            <div className="embed-editor_element-tip" role="tooltip" style={{ left: tip.place.left, top: tip.place.top, maxWidth: tip.place.widthMax }}>
              {tipParts.map((part, index) => (
                <span key={`${index}:${part.text}`} className={`embed-editor_element-tip-chip is-${part.kind}`}>
                  {part.text}
                </span>
              ))}
            </div>,
            document.body,
          )}
    </>
  );
}

/** The element's selector as its parts, in order: `h2`, `.hero_title`, `[data-x="1"]`. */
export function elementParts(snapshot: ElementSnapshot | undefined): readonly string[] {
  // A token without a name has nothing to show and is left out. The snapshot
  // comes from the canvas, so this is a value to handle, never an assertion: a
  // throw here unmounts the whole window (a one-letter tag such as `p` or `a`
  // once tripped a length check and took the app down).
  const named = snapshotTokens(snapshot).filter((token) => (token.label ?? '') !== '');
  const parts = named.map((token) => {
    const name = token.label ?? '';
    if (token.kind === 'tag') {
      return name;
    }
    if (token.kind === 'class') {
      return `.${name}`;
    }
    const value = snapshot?.attributes[name] ?? '';
    return value ? `[${name}="${value}"]` : `[${name}]`;
  });
  assert(parts.length === named.length, 'elementParts: one part per named token');
  return parts;
}

/** One chip in the tip, and what it names: its colour says which. */
export interface TipPart {
  readonly kind: 'tag' | 'class' | 'id' | 'attribute';
  readonly text: string;
}

/**
 * Everything on the element, as the tip's chips: the tag and classes as the
 * line shows them, then `#id`, then every other attribute by name. `class` and
 * `id` are already there as chips of their own, and the attributes Astro stamps
 * on rendered markup are not the author's.
 */
export function elementTipParts(snapshot: ElementSnapshot | undefined): readonly TipPart[] {
  if (snapshot === undefined) {
    return [];
  }
  const named = snapshotTokens(snapshot)
    .filter((token) => token.kind !== 'attribute')
    .filter((token) => (token.label ?? '') !== '')
    .map((token): TipPart => (token.kind === 'tag' ? { kind: 'tag', text: token.label ?? '' } : { kind: 'class', text: `.${token.label ?? ''}` }));
  const id: TipPart[] = snapshot.id === undefined || snapshot.id === '' ? [] : [{ kind: 'id', text: `#${snapshot.id}` }];
  const attributes = Object.keys(snapshot.attributes)
    .filter((name) => name !== '' && name !== 'class' && name !== 'id' && !isAstroGeneratedAttribute(name) && !isInternalAttribute(name))
    .sort()
    .map((name): TipPart => {
      const value = snapshot.attributes[name] ?? '';
      return { kind: 'attribute', text: value ? `[${name}="${value}"]` : `[${name}]` };
    });
  const parts = [...named, ...id, ...attributes];
  // Every chip has text: a one-letter tag (`p`, `a`, `b`) is one character.
  assert(
    parts.every((part) => part.text.length > 0),
    'elementTipParts: every chip has text',
  );
  return parts;
}

// Where the tip sits: under the line, from its left edge, no wider than it
// (the panel's width) so the chips wrap inside the panel rather than off-screen.
interface TipPlace {
  readonly left: number;
  readonly top: number;
  readonly widthMax: number;
}

// Gap between the line and the tip; the narrowest tip, for a short line.
const TIP_GAP_PX = 6;
const TIP_WIDTH_PX_MIN = 200;

function useElementTip(): { readonly place: TipPlace | undefined; readonly show: (event: React.MouseEvent<HTMLElement>) => void; readonly hide: () => void } {
  const [place, setPlace] = useState<TipPlace | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (event: React.MouseEvent<HTMLElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    // A resting pointer, as for every tooltip in the app (delayedTooltip.ts):
    // passing over the line on the way to the selector field shows nothing.
    timer.current = setTimeout(
      () => setPlace({ left: rect.left, top: rect.bottom + TIP_GAP_PX, widthMax: Math.max(rect.width, TIP_WIDTH_PX_MIN) }),
      TOOLTIP_DELAY_MS,
    );
  };
  const hide = (): void => {
    clearTimeout(timer.current);
    setPlace(undefined);
  };
  return { place, show, hide };
}
