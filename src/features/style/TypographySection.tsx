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
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { FontFamilyField, WeightField } from './FontFields';
import { MorePopover, ColumnsRow } from './TypographyColumns';
import { LINE_ORDER, DECOR_PROPS, parseDecoration, composeDecoration, DecorationPopover } from './DecorationPopover';
import { BreakingRow, WrapRow, TruncateRow } from './TextWrapRows';
import { StrokeRow, TextShadowsRow } from './TextStrokeShadow';

export { type Props, PropLabel, GroupLabel, LiveInput, StackedField, type Seg, SegBar } from './TypographyKit';

function alignSegments(translate: Translator): readonly Seg[] {
  return [
    { value: 'left', icon: <AlignLeftIcon />, label: translate('style.typographySection.alignLeft') },
    { value: 'center', icon: <AlignCenterIcon />, label: translate('style.typographySection.alignCenter') },
    { value: 'right', icon: <AlignRightIcon />, label: translate('style.typographySection.alignRight') },
    { value: 'justify', icon: <AlignJustifyIcon />, label: translate('style.typographySection.alignJustify') },
  ];
}

function AlignRow({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const translate = useTranslate();
  const alignOptions = alignSegments(translate);
  const display = displayOf(read('text-align'));
  // Nothing set here → what the page computes for this element (text-align inherits,
  // so that's usually a parent's), falling back to `left` (start, LTR).
  const current = useHighlight(
    // The flag rides in the text, so a flagged value opens the bar's custom
    // field, which shows it (TypographyKit.tsx SegBar).
    displayText(display).trim().toLowerCase(),
    'text-align',
    [...alignOptions.map((segment) => segment.value), 'start', 'end'],
    'left',
  );
  const direction = useComputedValue(current === 'start' ? 'direction' : current === 'end' ? 'direction' : '');
  const aligned = current === 'start' ? (direction === 'rtl' ? 'right' : 'left') : current === 'end' ? (direction === 'rtl' ? 'left' : 'right') : current;
  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label={translate('style.typographySection.align')}
        prop="text-align"
        display={display}
        contributors={read('text-align')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp('text-align')}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegBar
        segs={alignOptions}
        current={aligned}
        ariaLabel={translate('style.typographySection.textAlign')}
        prop="text-align"
        busy={busy}
        onCommit={(value, important) => setProp('text-align', value, important)}
        onLiveCommit={(value, important) => liveSetProp('text-align', value, important)}
        onClear={() => clearProp('text-align')}
      />
    </div>
  );
}

function decorSegments(translate: Translator): readonly Seg[] {
  return [
    { value: 'none', icon: <DecorNoneIcon />, label: translate('style.typographySection.decorNone') },
    { value: 'line-through', icon: <DecorStrikeIcon />, label: translate('style.typographySection.decorStrike') },
    { value: 'underline', icon: <DecorUnderlineIcon />, label: translate('style.typographySection.decorUnderline') },
    { value: 'overline', icon: <DecorOverlineIcon />, label: translate('style.typographySection.decorOverline') },
  ];
}
const DECOR_KEYWORDS = ['underline', 'overline', 'line-through', 'none'];

function DecorRow(props: Props) {
  const { read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props;
  const translate = useTranslate();
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
        label={translate('style.typographySection.decor')}
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
          segs={decorSegments(translate)}
          current={current}
          ariaLabel={translate('style.typographySection.textDecoration')}
          prop="text-decoration"
          busy={busy}
          onCommit={(value, important) => writeLine({ value, important }, 'commit')}
          onLiveCommit={(value, important) => writeLine({ value, important }, 'live')}
          onClear={() => clearProp(['text-decoration', 'text-decoration-line'])}
        />
        <MorePopover title={translate('style.typographySection.decorationTitle')} active={anySet} busy={busy}>
          <DecorationPopover {...props} />
        </MorePopover>
      </div>
    </div>
  );
}

// ─────────────── Stacked segmented cells (italicize / capitalize / direction) ───────────────

function italicSegments(translate: Translator): readonly Seg[] {
  return [
    { value: 'normal', icon: <FontStyleRegularIcon />, label: translate('style.typographySection.styleRegular') },
    { value: 'italic', icon: <FontStyleItalicIcon />, label: translate('style.typographySection.styleItalic') },
  ];
}
function transformSegments(translate: Translator): readonly Seg[] {
  return [
    { value: 'none', icon: <DecorNoneIcon />, label: translate('style.typographySection.decorNone') },
    { value: 'uppercase', icon: <TransformCapsIcon />, label: translate('style.typographySection.transformUpper') },
    { value: 'capitalize', icon: <TransformCapitalizeIcon />, label: translate('style.typographySection.transformCapitalize') },
    { value: 'lowercase', icon: <TransformLowercaseIcon />, label: translate('style.typographySection.transformLower') },
  ];
}
function directionSegments(translate: Translator): readonly Seg[] {
  return [
    { value: 'ltr', icon: <DirectionLTRIcon />, label: translate('style.typographySection.directionLtr') },
    { value: 'rtl', icon: <DirectionRTLIcon />, label: translate('style.typographySection.directionRtl') },
  ];
}

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

const CURRENT_COLOR = 'currentColor'; // i18n-ignore: the CSS keyword shown as the empty value.

function ColorField(props: Props) {
  const translate = useTranslate();
  return (
    <div className="embed-editor_size-row">
      <TextField
        prop="color"
        label={translate('style.typographySection.color')}
        placeholder={CURRENT_COLOR}
        swatchLabel={translate('style.typographySection.textColor')}
        {...props}
      />
    </div>
  );
}

// ─────────────────────────── Section ───────────────────────────

export default function TypographySection(props: Props) {
  const translate = useTranslate();
  return (
    <div className="embed-editor_size embed-editor_type">
      <FontFamilyField {...props} />
      <WeightField {...props} />
      <div className="embed-editor_size-grid">
        <TextField prop="font-size" label={translate('style.typographySection.size')} placeholder="1rem" {...props} />
        <TextField prop="line-height" label={translate('style.typographySection.height')} placeholder="1.5" {...props} />
      </div>
      <ColorField {...props} />
      <AlignRow {...props} />
      <DecorRow {...props} />
      <ColumnsRow {...props} />
      <div className="embed-editor_type-triple embed-editor_type-segs">
        <SegCell
          prop="font-style"
          label={translate('style.typographySection.italicize')}
          ariaLabel={translate('style.typographySection.fontStyle')}
          segs={italicSegments(translate)}
          fallback="normal"
          {...props}
        />
        <SegCell
          prop="text-transform"
          label={translate('style.typographySection.capitalize')}
          ariaLabel={translate('style.typographySection.textTransform')}
          segs={transformSegments(translate)}
          fallback="none"
          {...props}
        />
        <SegCell
          prop="direction"
          label={translate('style.typographySection.direction')}
          ariaLabel={translate('style.typographySection.textDirection')}
          segs={directionSegments(translate)}
          fallback="ltr"
          {...props}
        />
      </div>
      <BreakingRow {...props} />
      <WrapRow {...props} />
      <TruncateRow {...props} />
      <StrokeRow {...props} />
      <TextShadowsRow {...props} />
    </div>
  );
}
