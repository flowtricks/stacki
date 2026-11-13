// Text decoration's advanced options: which lines, their style and colour,
// and skipping ink, read from and written back to the shorthand
// (TypographySection.tsx).

import Select, { type SelectOption } from './components/Select';
import ColorSwatch from './components/ColorSwatch';
import { splitTopLevelSpaces } from './model/background';
import { displayOf } from './model/styleDisplay';
import ImportantMark from './components/ImportantMark';
import { DecorNoneIcon, DecorStrikeIcon, DecorUnderlineIcon, DecorOverlineIcon } from './TypographyIcons';
import { type Props, LiveInput } from './TypographyKit';
import { PopLabel, LengthRow } from './TypographyColumns';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';

// ─────────────────────────── Text-decoration advanced options ───────────────────────────

// Webflow (and this control) stores line + style + color in the `text-decoration`
// shorthand; thickness + skip-ink are separate longhands. Splitting the shorthand
// lets the popover's Line / Style / Color each edit one facet without touching the
// others — and it stays in sync with the Decor segmented bar (same property).
export const DECOR_LINE_KW = ['underline', 'overline', 'line-through', 'blink'];
export const DECOR_STYLE_KW = ['solid', 'double', 'dotted', 'dashed', 'wavy'];
export const LINE_ORDER = ['underline', 'overline', 'line-through'];
export const DECOR_PROPS = ['text-decoration', 'text-decoration-thickness', 'text-decoration-skip-ink'] as const;

export type DecorParts = { lines: string[]; style: string; color: string };

export function parseDecoration(value: string): DecorParts {
  const lines: string[] = [];
  let style = '';
  const color: string[] = [];
  for (const tok of splitTopLevelSpaces(value).filter(Boolean)) {
    const low = tok.toLowerCase();
    if (low === 'none') {
      continue;
    }
    if (DECOR_LINE_KW.includes(low)) {
      if (!lines.includes(low)) {
        lines.push(low);
      }
    } else if (DECOR_STYLE_KW.includes(low)) {
      style = low;
    } else {
      color.push(tok);
    }
  }
  return { lines, style, color: color.join(' ') };
}
export function composeDecoration({ lines, style, color }: DecorParts): string {
  const ordered = LINE_ORDER.filter((line) => lines.includes(line));
  return [...ordered, style, color].filter(Boolean).join(' ').trim() || 'none';
}
// The canonical Line-select key for a parsed value (ordered keywords, or 'none').
export function lineKey(lines: string[]): string {
  const ordered = LINE_ORDER.filter((line) => lines.includes(line));
  return ordered.length ? ordered.join(' ') : 'none';
}

// Small horizontal glyphs for the Style select (a decoration line drawn each way).
export function StyleGlyph({ variant }: { variant: 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy' }) {
  if (variant === 'double') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 6h12M2 10h12" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  if (variant === 'wavy') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 8q1.5-2 3 0t3 0 3 0 3 0" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  const dash = variant === 'dotted' ? '1 2' : variant === 'dashed' ? '3 2' : undefined;
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 8h12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeDasharray={dash} />
    </svg>
  );
}

export const decorLineOptions = (translate: Translator): SelectOption<string>[] => [
  { value: 'none', label: translate('style.decorationPopover.lineNone'), icon: <DecorNoneIcon /> },
  { value: 'line-through', label: translate('style.decorationPopover.lineStrike'), icon: <DecorStrikeIcon /> },
  { value: 'underline', label: translate('style.decorationPopover.lineUnderline'), icon: <DecorUnderlineIcon /> },
  { value: 'overline', label: translate('style.decorationPopover.lineOverline'), icon: <DecorOverlineIcon /> },
  { value: 'underline overline', label: translate('style.decorationPopover.lineUnderOver') },
  { value: 'underline line-through', label: translate('style.decorationPopover.lineUnderStrike') },
  { value: 'overline line-through', label: translate('style.decorationPopover.lineOverStrike') },
  { value: 'underline overline line-through', label: translate('style.decorationPopover.lineAll') },
];
export const decorStyleOptions = (translate: Translator): SelectOption<string>[] => [
  { value: 'solid', label: translate('style.decorationPopover.styleSolid'), icon: <StyleGlyph variant="solid" /> },
  { value: 'double', label: translate('style.decorationPopover.styleDouble'), icon: <StyleGlyph variant="double" /> },
  { value: 'dotted', label: translate('style.decorationPopover.styleDotted'), icon: <StyleGlyph variant="dotted" /> },
  { value: 'dashed', label: translate('style.decorationPopover.styleDashed'), icon: <StyleGlyph variant="dashed" /> },
  { value: 'wavy', label: translate('style.decorationPopover.styleWavy'), icon: <StyleGlyph variant="wavy" /> },
];
export const skipInkOptions = (translate: Translator): SelectOption<string>[] => [
  { value: 'auto', label: translate('style.decorationPopover.skipAuto') },
  { value: 'none', label: translate('style.decorationPopover.skipNone') },
];

// The Decoration & underline popover body: Line / Style / Color compose the
// `text-decoration` shorthand; Thick and Skip ink are their own longhands.
export function DecorationPopover(props: Props) {
  const { read, busy, setProp, liveSetProp } = props;
  const translate = useTranslate();
  const display = displayOf(read('text-decoration'));
  const raw = display.present ? display.value : displayOf(read('text-decoration-line')).value;
  const parts = parseDecoration(raw);
  const write: DecorationWrite = (next, mode = 'commit') =>
    (mode === 'live' ? liveSetProp : setProp)('text-decoration', composeDecoration(next), display.important);
  // A preview that ends (the menu closed without a pick) puts the live write back.
  const preview = (value: string | undefined, next: (value: string) => DecorParts) => {
    if (value === undefined) {
      liveSetProp('text-decoration', undefined, display.important);
    } else {
      write(next(value), 'live');
    }
  };
  const rowProps = { props, parts, shorthandSet: display.isSelected, write };
  const skip = displayOf(read('text-decoration-skip-ink'));

  return (
    <div className="embed-editor_more-group">
      <DecorationSelectRow
        {...rowProps}
        label={translate('style.decorationPopover.line')}
        facet="lines"
        value={lineKey(parts.lines)}
        options={decorLineOptions(translate)}
        toParts={(value) => ({ ...parts, lines: value === 'none' ? [] : value.split(' ') })}
        preview={preview}
      />
      <DecorationSelectRow
        {...rowProps}
        label={translate('style.decorationPopover.style')}
        facet="style"
        value={parts.style || 'solid'}
        options={decorStyleOptions(translate)}
        toParts={(value) => ({ ...parts, style: value === 'solid' ? '' : value })}
        preview={preview}
      />
      <LengthRow prop="text-decoration-thickness" label={translate('style.decorationPopover.thick')} placeholder={AUTO_KEYWORD} {...props} />
      <DecorationColorRow {...rowProps} />
      <div className="embed-editor_size-row">
        <PopLabel label={translate('style.decorationPopover.skipInk')} prop="text-decoration-skip-ink" {...props} />
        {/* No custom field: a flagged value is marked, and picks keep the flag. */}
        <ImportantMark important={skip.important}>
          <Select
            value={skip.present ? skip.value.trim().toLowerCase() : 'auto'}
            options={skipInkOptions(translate)}
            onChange={(value) => setProp('text-decoration-skip-ink', value, skip.important)}
            onPreview={(value) => liveSetProp('text-decoration-skip-ink', value ?? undefined, skip.important)}
            ariaLabel={translate('style.decorationPopover.skipInk')}
            disabled={busy}
          />
        </ImportantMark>
      </div>
      <p className="embed-editor_more-note">{translate('style.decorationPopover.note')}</p>
    </div>
  );
}

// Writes the `text-decoration` shorthand composed from its facets, committed by
// default or as a live preview.
const AUTO_KEYWORD = 'Auto'; // i18n-ignore: the CSS keyword `auto`, shown as the empty value.

export type DecorationWrite = (next: DecorParts, mode?: 'live' | 'commit') => void;

export type DecorationRowProps = {
  props: Props;
  parts: DecorParts;
  /** Whether the picked selector sets the shorthand these rows edit. */
  shorthandSet: boolean;
  write: DecorationWrite;
};

// The Line or Style row: one facet of the shorthand, picked from a dropdown.
export function DecorationSelectRow({
  props,
  parts,
  shorthandSet,
  write,
  label,
  facet,
  value,
  options,
  toParts,
  preview,
}: DecorationRowProps & {
  label: string;
  facet: 'lines' | 'style';
  value: string;
  options: SelectOption<string>[];
  toParts: (value: string) => DecorParts;
  preview: (value: string | undefined, next: (value: string) => DecorParts) => void;
}) {
  const translate = useTranslate();
  // The Line label clears the whole shorthand (and the longhand an embed may use);
  // the Style label clears only its own facet.
  const lines = facet === 'lines';
  return (
    <div className="embed-editor_size-row">
      <PopLabel
        label={label}
        prop="text-decoration"
        {...props}
        active={lines ? shorthandSet : shorthandSet && parts.style !== ''}
        onClear={() => (lines ? props.clearProp(['text-decoration', 'text-decoration-line']) : write({ ...parts, style: '' }))}
      />
      <Select
        value={value}
        options={options}
        onChange={(next) => write(toParts(next))}
        onPreview={(next) => preview(next ?? undefined, toParts)}
        ariaLabel={lines ? translate('style.decorationPopover.decorationLine') : translate('style.decorationPopover.decorationStyle')}
        disabled={props.busy}
      />
    </div>
  );
}

// The Color row: a swatch and a field for the shorthand's colour facet.
export function DecorationColorRow({ props, parts, shorthandSet, write }: DecorationRowProps) {
  const translate = useTranslate();
  return (
    <div className="embed-editor_size-row">
      <PopLabel
        label={translate('style.decorationPopover.color')}
        prop="text-decoration"
        {...props}
        active={shorthandSet && parts.color !== ''}
        onClear={() => write({ ...parts, color: '' })}
      />
      <div className="embed-editor_type-field">
        <ColorSwatch
          value={parts.color}
          busy={props.busy}
          ariaLabel={translate('style.decorationPopover.decorationColor')}
          onChange={(color, live) => write({ ...parts, color }, live ? 'live' : 'commit')}
        />
        <LiveInput
          value={parts.color}
          busy={props.busy}
          placeholder={translate('style.decorationPopover.setColor')}
          ariaLabel={translate('style.decorationPopover.decorationColor')}
          className="u-input embed-editor_size-input"
          prop="color"
          onCommit={(value) => write({ ...parts, color: value })}
          onLiveCommit={(value) => write({ ...parts, color: value }, 'live')}
          onClear={() => write({ ...parts, color: '' })}
        />
      </div>
    </div>
  );
}
