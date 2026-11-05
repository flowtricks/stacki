import { useComputedValue, useHighlight } from './model/computedStyle';
import { displayOf, displayText } from './model/styleDisplay';
import {
  AlignLeftIcon,
  AlignCenterIcon,
  AlignRightIcon,
  AlignJustifyIcon,
  DecorNoneIcon,
  DecorStrikeIcon,
  DecorUnderlineIcon,
  DecorOverlineIcon,
  FontStyleRegularIcon,
  FontStyleItalicIcon,
  TransformCapsIcon,
  TransformCapitalizeIcon,
  TransformLowercaseIcon,
  DirectionLTRIcon,
  DirectionRTLIcon,
} from './TypographyIcons';
import { type Props, PropLabel, TextField, type Seg, SegBar } from './TypographyKit';
import { FontFamilyField, WeightField } from './FontFields';
import { MorePopover, ColumnsRow } from './TypographyColumns';
import { LINE_ORDER, DECOR_PROPS, parseDecoration, composeDecoration, DecorationPopover } from './DecorationPopover';
import { BreakingRow, WrapRow, TruncateRow } from './TextWrapRows';
import { StrokeRow, TextShadowsRow } from './TextStrokeShadow';

export { type Props, PropLabel, GroupLabel, LiveInput, StackedField, type Seg, SegBar } from './TypographyKit';

const ALIGN_SEGS: readonly Seg[] = [
  { value: 'left', icon: <AlignLeftIcon />, label: 'Left' },
  { value: 'center', icon: <AlignCenterIcon />, label: 'Center' },
  { value: 'right', icon: <AlignRightIcon />, label: 'Right' },
  { value: 'justify', icon: <AlignJustifyIcon />, label: 'Justify' },
];

function AlignRow({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const display = displayOf(read('text-align'));
  // Nothing set here → what the page computes for this element (text-align inherits,
  // so that's usually a parent's), falling back to `left` (start, LTR).
  const current = useHighlight(
    // The flag rides in the text, so a flagged value opens the bar's custom
    // field, which shows it (TypographyKit.tsx SegBar).
    displayText(display).trim().toLowerCase(),
    'text-align',
    [...ALIGN_SEGS.map((segment) => segment.value), 'start', 'end'],
    'left',
  );
  const direction = useComputedValue(current === 'start' ? 'direction' : current === 'end' ? 'direction' : '');
  const aligned = current === 'start' ? (direction === 'rtl' ? 'right' : 'left') : current === 'end' ? (direction === 'rtl' ? 'left' : 'right') : current;
  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label="Align"
        prop="text-align"
        display={display}
        contributors={read('text-align')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp('text-align')}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegBar
        segs={ALIGN_SEGS}
        current={aligned}
        ariaLabel="Text align"
        prop="text-align"
        busy={busy}
        onCommit={(value, important) => setProp('text-align', value, important)}
        onLiveCommit={(value, important) => liveSetProp('text-align', value, important)}
        onClear={() => clearProp('text-align')}
      />
    </div>
  );
}

const DECOR_SEGS: readonly Seg[] = [
  { value: 'none', icon: <DecorNoneIcon />, label: 'None' },
  { value: 'line-through', icon: <DecorStrikeIcon />, label: 'Strikethrough' },
  { value: 'underline', icon: <DecorUnderlineIcon />, label: 'Underline' },
  { value: 'overline', icon: <DecorOverlineIcon />, label: 'Overline' },
];
const DECOR_KEYWORDS = ['underline', 'overline', 'line-through', 'none'];

function DecorRow(props: Props) {
  const { read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props;
  // Webflow's native Style model stores the `text-decoration` SHORTHAND — writing the
  // `text-decoration-line` longhand is silently dropped by the Style API — so edits /
  // clear target the shorthand. Display reads the shorthand, falling back to the
  // longhand an embed might use.
  const display = displayOf(read('text-decoration'));
  const raw = display.present ? display.value : displayOf(read('text-decoration-line')).value;
  const computed = useComputedValue(raw ? '' : 'text-decoration');
  const parts = parseDecoration(raw || computed);
  // The bar reflects only the line facet — a single keyword, or None (X). Combos and
  // the divider style/color live in the "…" popover, so picking a segment recomposes
  // the shorthand while preserving any style/color already set.
  const current = parts.lines.length ? (LINE_ORDER.find((line) => parts.lines.includes(line)) ?? 'none') : 'none';
  const writeLine = ({ value, important }: { value: string; important: boolean }, mode: 'live' | 'commit') => {
    const put = mode === 'live' ? liveSetProp : setProp;
    const low = value.trim().toLowerCase();
    if (DECOR_KEYWORDS.includes(low)) {
      put('text-decoration', composeDecoration({ ...parts, lines: low === 'none' ? [] : [low] }), important);
    } else {
      // A custom value typed in the bar.
      put('text-decoration', value, important);
    }
  };
  const anySet = DECOR_PROPS.some((prop) => read(prop)?.source === 'selected');
  return (
    <div className="embed-editor_size-row embed-editor_more-row">
      <PropLabel
        label="Decor"
        prop="text-decoration"
        display={display}
        contributors={read('text-decoration')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(['text-decoration', 'text-decoration-line'])}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <div className="embed-editor_more-control">
        <SegBar
          segs={DECOR_SEGS}
          current={current}
          ariaLabel="Text decoration"
          prop="text-decoration"
          busy={busy}
          onCommit={(value, important) => writeLine({ value, important }, 'commit')}
          onLiveCommit={(value, important) => writeLine({ value, important }, 'live')}
          onClear={() => clearProp(['text-decoration', 'text-decoration-line'])}
        />
        <MorePopover title="Decoration & underline" active={anySet} busy={busy}>
          <DecorationPopover {...props} />
        </MorePopover>
      </div>
    </div>
  );
}

// ─────────────── Stacked segmented cells (italicize / capitalize / direction) ───────────────

const ITALIC_SEGS: readonly Seg[] = [
  { value: 'normal', icon: <FontStyleRegularIcon />, label: 'Regular' },
  { value: 'italic', icon: <FontStyleItalicIcon />, label: 'Italic' },
];
const TRANSFORM_SEGS: readonly Seg[] = [
  { value: 'none', icon: <DecorNoneIcon />, label: 'None' },
  { value: 'uppercase', icon: <TransformCapsIcon />, label: 'ALL CAPS' },
  { value: 'capitalize', icon: <TransformCapitalizeIcon />, label: 'Capitalize Every Word' },
  { value: 'lowercase', icon: <TransformLowercaseIcon />, label: 'lowercase' },
];
const DIRECTION_SEGS: readonly Seg[] = [
  { value: 'ltr', icon: <DirectionLTRIcon />, label: 'Left to right' },
  { value: 'rtl', icon: <DirectionRTLIcon />, label: 'Right to left' },
];

// A segmented icon bar stacked over its clickable label, for the three-up bottom
// row (mirrors StackedField). `fallback` is the CSS default shown active when unset.
function SegCell({
  prop,
  label,
  ariaLabel,
  segs,
  fallback,
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  prop: string;
  label: string;
  ariaLabel: string;
  segs: readonly Seg[];
  fallback: string;
} & Props) {
  const display = displayOf(read(prop));
  const current = useHighlight(
    // The flag rides in the text, so a flagged value opens the bar's custom
    // field, which shows it (TypographyKit.tsx SegBar).
    displayText(display).trim().toLowerCase(),
    prop,
    segs.map((segment) => segment.value),
    fallback,
  );
  return (
    <div className="embed-editor_type-cell">
      <SegBar
        segs={segs}
        current={current}
        ariaLabel={ariaLabel}
        prop={prop}
        busy={busy}
        onCommit={(value, important) => setProp(prop, value, important)}
        onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
        onClear={() => clearProp(prop)}
      />
      <PropLabel
        label={label}
        prop={prop}
        display={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(prop)}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
    </div>
  );
}

// ─────────────────────────── Color ───────────────────────────

function ColorField(props: Props) {
  return (
    <div className="embed-editor_size-row">
      <TextField prop="color" label="Color" placeholder="currentColor" swatchLabel="Text color" {...props} />
    </div>
  );
}

// ─────────────────────────── Section ───────────────────────────

export default function TypographySection(props: Props) {
  return (
    <div className="embed-editor_size embed-editor_type">
      <FontFamilyField {...props} />
      <WeightField {...props} />
      <div className="embed-editor_size-grid">
        <TextField prop="font-size" label="Size" placeholder="1rem" {...props} />
        <TextField prop="line-height" label="Height" placeholder="1.5" {...props} />
      </div>
      <ColorField {...props} />
      <AlignRow {...props} />
      <DecorRow {...props} />
      <ColumnsRow {...props} />
      <div className="embed-editor_type-triple embed-editor_type-segs">
        <SegCell prop="font-style" label="Italicize" ariaLabel="Font style" segs={ITALIC_SEGS} fallback="normal" {...props} />
        <SegCell prop="text-transform" label="Capitalize" ariaLabel="Text transform" segs={TRANSFORM_SEGS} fallback="none" {...props} />
        <SegCell prop="direction" label="Direction" ariaLabel="Text direction" segs={DIRECTION_SEGS} fallback="ltr" {...props} />
      </div>
      <BreakingRow {...props} />
      <WrapRow {...props} />
      <TruncateRow {...props} />
      <StrokeRow {...props} />
      <TextShadowsRow {...props} />
    </div>
  );
}
