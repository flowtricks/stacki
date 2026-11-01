// Text decoration's advanced options: which lines, their style and colour,
// and skipping ink, read from and written back to the shorthand
// (TypographySection.tsx).

import Select, { type SelectOption } from './components/Select';
import ColorSwatch from './components/ColorSwatch';
import { splitTopLevelSpaces } from './model/background';
import { displayOf } from './model/styleDisplay';
import { DecorNoneIcon, DecorStrikeIcon, DecorUnderlineIcon, DecorOverlineIcon } from './TypographyIcons';
import { type Props, LiveInput } from './TypographyKit';
import { PopLabel, LengthRow } from './TypographyColumns';

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

export const DECOR_LINE_OPTIONS: SelectOption<string>[] = [
  { value: 'none', label: 'None', icon: <DecorNoneIcon /> },
  { value: 'line-through', label: 'Strikethrough', icon: <DecorStrikeIcon /> },
  { value: 'underline', label: 'Underline', icon: <DecorUnderlineIcon /> },
  { value: 'overline', label: 'Overline', icon: <DecorOverlineIcon /> },
  { value: 'underline overline', label: 'Underline + Overline' },
  { value: 'underline line-through', label: 'Underline + Strikethrough' },
  { value: 'overline line-through', label: 'Overline + Strikethrough' },
  { value: 'underline overline line-through', label: 'All' },
];
export const DECOR_STYLE_OPTIONS: SelectOption<string>[] = [
  { value: 'solid', label: 'Solid', icon: <StyleGlyph variant="solid" /> },
  { value: 'double', label: 'Double', icon: <StyleGlyph variant="double" /> },
  { value: 'dotted', label: 'Dotted', icon: <StyleGlyph variant="dotted" /> },
  { value: 'dashed', label: 'Dashed', icon: <StyleGlyph variant="dashed" /> },
  { value: 'wavy', label: 'Wavy', icon: <StyleGlyph variant="wavy" /> },
];
export const SKIP_INK_OPTIONS: SelectOption<string>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None' },
];

// The Decoration & underline popover body: Line / Style / Color compose the
// `text-decoration` shorthand; Thick and Skip ink are their own longhands.
export function DecorationPopover(props: Props) {
  const { read, busy, setProp, liveSetProp } = props;
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
        label="Line"
        facet="lines"
        value={lineKey(parts.lines)}
        options={DECOR_LINE_OPTIONS}
        toParts={(value) => ({ ...parts, lines: value === 'none' ? [] : value.split(' ') })}
        preview={preview}
      />
      <DecorationSelectRow
        {...rowProps}
        label="Style"
        facet="style"
        value={parts.style || 'solid'}
        options={DECOR_STYLE_OPTIONS}
        toParts={(value) => ({ ...parts, style: value === 'solid' ? '' : value })}
        preview={preview}
      />
      <LengthRow prop="text-decoration-thickness" label="Thick" placeholder="Auto" {...props} />
      <DecorationColorRow {...rowProps} />
      <div className="embed-editor_size-row">
        <PopLabel label="Skip ink" prop="text-decoration-skip-ink" {...props} />
        <Select
          value={skip.present ? skip.value.trim().toLowerCase() : 'auto'}
          options={SKIP_INK_OPTIONS}
          onChange={(value) => setProp('text-decoration-skip-ink', value, false)}
          onPreview={(value) => liveSetProp('text-decoration-skip-ink', value ?? undefined, false)}
          ariaLabel="Skip ink"
          disabled={busy}
        />
      </div>
      <p className="embed-editor_more-note">The browser will try to interrupt overlines and underlines to prevent drawing over glyphs.</p>
    </div>
  );
}

// Writes the `text-decoration` shorthand composed from its facets, committed by
// default or as a live preview.
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
        ariaLabel={lines ? 'Decoration line' : 'Decoration style'}
        disabled={props.busy}
      />
    </div>
  );
}

// The Color row: a swatch and a field for the shorthand's colour facet.
export function DecorationColorRow({ props, parts, shorthandSet, write }: DecorationRowProps) {
  return (
    <div className="embed-editor_size-row">
      <PopLabel label="Color" prop="text-decoration" {...props} active={shorthandSet && parts.color !== ''} onClear={() => write({ ...parts, color: '' })} />
      <div className="embed-editor_type-field">
        <ColorSwatch
          value={parts.color}
          busy={props.busy}
          ariaLabel="Decoration color"
          onChange={(color, live) => write({ ...parts, color }, live ? 'live' : 'commit')}
        />
        <LiveInput
          value={parts.color}
          busy={props.busy}
          placeholder="Set a color"
          ariaLabel="Decoration color"
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
