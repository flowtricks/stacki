import type { ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import { useTranslate, useTranslateRich } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import DisplayControl from '../DisplayControl';
import { eventsOptions, outlineOptions } from '../EffectsKit';
import { SegmentedIconControl, clearSegments, floatSegments, type Seg } from '../PositionSegments';
import SegmentedField from '../SegmentedField';
import { boxSizingBar, overflowBar } from '../SizeSection';
import { SegmentBar } from '../SizeSegmentBar';
import { SegBar } from '../TypographyKit';
import { alignSegments, decorSegments, directionSegments, italicSegments, transformSegments } from '../TypographySection';
import type { KeywordPropertyName } from './keywordOptions';

// A keyword chip's control is the Style panel's own control for that property, the same component
// with the same option definitions, so the popup and the panel cannot drift apart: display's bar of
// Block, Flex, Grid and its fourth slot with the rest behind the arrow, overflow's and box-sizing's
// icon bars, float's and clear's, the typography bars, the pointer-events and outline bars. Each
// shows the declaration's value as selected; a create chip (no value yet) shows the same bar with
// nothing selected. A property the panel offers as a dropdown keeps the popup's list
// (CodeChips.tsx), which is that dropdown's menu.

/** Which of the panel's controls a keyword property's chip opens. */
export type KeywordControlKind = 'display' | 'segmentBar' | 'iconBar' | 'segBar' | 'segmentedField' | 'list';

/** The panel's control for `property`. */
export function keywordControlOf(property: KeywordPropertyName): KeywordControlKind {
  switch (property) {
    case 'display':
      return 'display';
    case 'overflow':
    case 'overflow-x':
    case 'overflow-y':
    case 'box-sizing':
      return 'segmentBar';
    case 'float':
    case 'clear':
      return 'iconBar';
    case 'text-align':
    case 'text-decoration':
    case 'font-style':
    case 'text-transform':
    case 'direction':
      return 'segBar';
    case 'pointer-events':
    case 'outline-style':
      return 'segmentedField';
    case 'object-fit':
    case 'position':
    case 'word-break':
    case 'white-space':
    case 'text-overflow':
    case 'overflow-wrap':
    case 'background-clip':
    case 'mix-blend-mode':
    case 'cursor':
      return 'list';
    default: {
      const exhaustive: never = property;
      throw new Error(`Assertion failed: keywordControlOf: no control for ${String(exhaustive)}`);
    }
  }
}

/**
 * The panel's control for one keyword declaration in code. `onCommit` receives every value the
 * control writes (a pick, a variable, a custom value as it is typed); `!important` has no place in
 * the range a chip writes, so the flag is left out.
 */
export function KeywordChipControl({
  property,
  value,
  onCommit,
}: {
  readonly property: KeywordPropertyName;
  readonly value: string;
  readonly onCommit: (value: string) => void;
}): ReactNode {
  const translate = useTranslate();
  const translateRich = useTranslateRich();
  const kind = keywordControlOf(property);
  assert(kind !== 'list', 'KeywordChipControl: a listed property has no bar');
  const commit = (next: string): void => {
    const trimmed = next.trim();
    if (trimmed.length > 0) {
      onCommit(trimmed);
    }
  };
  const ignore = (): void => undefined;
  switch (kind) {
    case 'display':
      return <DisplayControl value={value} important={false} busy={false} onCommit={commit} />;
    case 'segmentBar': {
      const config = property === 'box-sizing' ? boxSizingBar(translateRich, translate) : overflowBar(translateRich, translate);
      // No fallback: the chip's own value is what is set, and an empty one selects nothing.
      return (
        <SegmentBar prop={property} config={{ ...config, fallback: '' }} value={value} busy={false} onCommit={commit} onLiveCommit={commit} onClear={ignore} />
      );
    }
    case 'iconBar':
      return (
        <SegmentedIconControl
          prop={property}
          ariaLabel={iconBarLabel(property, translate)}
          segments={property === 'clear' ? clearSegments(translate) : floatSegments(translate)}
          current={value.trim().toLowerCase()}
          busy={false}
          read={() => undefined}
          setProp={(_prop, next) => commit(next)}
          liveSetProp={(_prop, next) => commit(next ?? '')}
          clearProp={ignore}
          onProvenance={ignore}
          onSelectSelector={ignore}
        />
      );
    case 'segBar': {
      assert(isSegBarProperty(property), 'KeywordChipControl: a typography bar is for a typography property');
      const bar = segBarOf(property, translate);
      return (
        <SegBar
          segs={bar.segs}
          current={value.trim().toLowerCase()}
          ariaLabel={bar.label}
          prop={property}
          busy={false}
          onCommit={commit}
          onLiveCommit={commit}
          onClear={ignore}
        />
      );
    }
    case 'segmentedField':
      return (
        <SegmentedField
          value={value}
          important={false}
          options={property === 'outline-style' ? outlineOptions(translate) : eventsOptions(translate)}
          prop={property}
          fallback=""
          busy={false}
          highlight="authored"
          onCommit={commit}
          ariaLabel={property === 'outline-style' ? translate('style.effectsSection.outlineStyle') : translate('style.effectsSection.pointerEvents')}
        />
      );
    default: {
      // `list` was asserted away above; any other kind is a new control this switch must learn.
      throw new Error(`Assertion failed: KeywordChipControl: no control for ${kind}`);
    }
  }
}

function iconBarLabel(property: KeywordPropertyName, translate: Translator): string {
  return property === 'clear' ? translate('style.positionSection.clearProperty') : translate('style.positionSection.float');
}

// The typography bars: each property's segments and the name the panel gives the bar.
const SEG_BAR_PROPERTIES = ['text-align', 'text-decoration', 'font-style', 'text-transform', 'direction'] as const;
type SegBarProperty = (typeof SEG_BAR_PROPERTIES)[number];

function isSegBarProperty(property: KeywordPropertyName): property is SegBarProperty {
  return SEG_BAR_PROPERTIES.some((candidate) => candidate === property);
}

function segBarOf(property: SegBarProperty, translate: Translator): { readonly segs: readonly Seg[]; readonly label: string } {
  switch (property) {
    case 'text-align':
      return { segs: alignSegments(translate), label: translate('style.typographySection.textAlign') };
    case 'text-decoration':
      return { segs: decorSegments(translate), label: translate('style.typographySection.textDecoration') };
    case 'font-style':
      return { segs: italicSegments(translate), label: translate('style.typographySection.fontStyle') };
    case 'text-transform':
      return { segs: transformSegments(translate), label: translate('style.typographySection.textTransform') };
    case 'direction':
      return { segs: directionSegments(translate), label: translate('style.typographySection.textDirection') };
    default: {
      const exhaustive: never = property;
      throw new Error(`Assertion failed: segBarOf: ${String(exhaustive)} is no typography bar`);
    }
  }
}
