// The inspector's styles: every value is written as an inline style on the selected elements of the frame,
// never a class or a selector, so there is nothing to choose before changing how something looks. The fields
// show the inline value when there is one and the computed value, dimmed, when there is not.
import Dropdown from '../../../ui/Dropdown';
import SegmentedControl from '../../../ui/SegmentedControl';
import ColorSwatch from '../../../features/style/components/ColorSwatch';
import { inlineStyleOf, isFree } from '../model/designDom';
import { clearSelectionStyles, flowSelection, freeSelection, previewStyle, styleSelection } from '../runtime/designGestures';
import type { DesignWords } from '../i18n/designWords';
import type { DesignWordKey } from '../i18n/en';
import { DesignField } from './DesignField';

interface PanelProps {
  readonly elements: readonly Element[];
  readonly words: DesignWords;
}

function computedOf(element: Element, property: string): string {
  return element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue(property) ?? '';
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="dm-section">
      <h3 className="dm-section-title">{title}</h3>
      {children}
    </section>
  );
}

const DISPLAY_OPTIONS = ['block', 'flex', 'grid', 'inline-block', 'inline', 'inline-flex', 'none'] as const;
const ALIGN_OPTIONS = ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'] as const;
const JUSTIFY_OPTIONS = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] as const;
const WEIGHT_OPTIONS = ['100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;
const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double'] as const;
const TEXT_ALIGN = ['left', 'center', 'right', 'justify'] as const;

export function DesignStylePanel({ elements, words }: PanelProps) {
  const first = elements[0];
  if (first === undefined) {
    return undefined;
  }
  const inline = (property: string) => inlineStyleOf(first, property);
  const computed = (property: string) => computedOf(first, property);
  const field = (labelKey: DesignWordKey, property: string, wide = false) => (
    <DesignField
      key={property}
      label={words(labelKey)}
      property={property}
      value={inline(property)}
      computed={computed(property)}
      scrubTip={words('field.scrubTip')}
      wide={wide}
    />
  );
  const display = computed('display');
  const flex = display.includes('flex');
  const grid = display.includes('grid');
  const free = isFree(first);
  const hasText = (first.textContent ?? '').trim() !== '';
  const choose = (property: string, options: readonly string[], labelKey: DesignWordKey) => (
    <div className="dm-row">
      <span className="dm-row-label">{words(labelKey)}</span>
      <div className="dm-row-control">
        <Dropdown
          value={options.includes(computed(property)) ? computed(property) : (options[0] ?? '')}
          options={options.map((option) => ({ value: option, label: option }))}
          ariaLabel={words(labelKey)}
          onChange={(value) => styleSelection(property, value)}
        />
      </div>
    </div>
  );
  const color = (labelKey: DesignWordKey, property: string) => (
    <div className="dm-row">
      <span className="dm-row-label">{words(labelKey)}</span>
      <div className="dm-row-control dm-color">
        <ColorSwatch
          value={inline(property) || computed(property)}
          ariaLabel={words(labelKey)}
          onChange={(value, live) => (live ? previewStyle(property, value) : void styleSelection(property, value))}
        />
        <DesignField label="" property={property} value={inline(property)} computed={computed(property)} scrubTip={words('field.scrubTip')} wide />
      </div>
    </div>
  );
  return (
    <div className="dm-style-panel">
      <Section title={words('section.position')}>
        <SegmentedControl
          options={[
            { value: 'flow', label: words('position.flow'), tooltip: words('position.flowTip') },
            { value: 'free', label: words('position.free'), tooltip: words('position.freeTip') },
          ]}
          value={free ? 'free' : 'flow'}
          ariaLabel={words('section.position')}
          onChange={(value) => (value === 'free' ? freeSelection() : flowSelection())}
        />
        <div className="dm-grid">
          {free && field('field.x', 'left')}
          {free && field('field.y', 'top')}
          {field('field.rotation', 'rotate')}
          {field('field.zIndex', 'z-index')}
        </div>
      </Section>
      <Section title={words('section.size')}>
        <div className="dm-grid">
          {field('field.width', 'width')}
          {field('field.height', 'height')}
          {field('field.minWidth', 'min-width')}
          {field('field.maxWidth', 'max-width')}
        </div>
      </Section>
      <Section title={words('section.layout')}>
        {choose('display', DISPLAY_OPTIONS, 'field.display')}
        {flex && (
          <SegmentedControl
            options={[
              { value: 'row', label: words('field.row') },
              { value: 'column', label: words('field.column') },
            ]}
            value={computed('flex-direction').startsWith('column') ? 'column' : 'row'}
            ariaLabel={words('field.direction')}
            onChange={(value) => styleSelection('flex-direction', value)}
          />
        )}
        {(flex || grid) && (
          <>
            <div className="dm-grid">{field('field.gap', 'gap', true)}</div>
            {choose('align-items', ALIGN_OPTIONS, 'field.align')}
            {choose('justify-content', JUSTIFY_OPTIONS, 'field.justify')}
          </>
        )}
      </Section>
      <Section title={words('section.spacing')}>
        <div className="dm-grid dm-grid-four">
          <span className="dm-grid-caption">{words('field.padding')}</span>
          {field('field.top', 'padding-top')}
          {field('field.right', 'padding-right')}
          {field('field.bottom', 'padding-bottom')}
          {field('field.left', 'padding-left')}
          <span className="dm-grid-caption">{words('field.margin')}</span>
          {field('field.top', 'margin-top')}
          {field('field.right', 'margin-right')}
          {field('field.bottom', 'margin-bottom')}
          {field('field.left', 'margin-left')}
        </div>
      </Section>
      {hasText && (
        <Section title={words('section.text')}>
          <div className="dm-grid">
            {field('field.font', 'font-family', true)}
            {field('field.fontSize', 'font-size')}
            {field('field.lineHeight', 'line-height')}
            {field('field.letterSpacing', 'letter-spacing')}
          </div>
          {choose('font-weight', WEIGHT_OPTIONS, 'field.weight')}
          <SegmentedControl
            options={TEXT_ALIGN.map((value) => ({ value, label: value }))}
            value={TEXT_ALIGN.find((value) => computed('text-align') === value) ?? 'left'}
            ariaLabel={words('field.textAlign')}
            onChange={(value) => styleSelection('text-align', value)}
          />
          {color('field.color', 'color')}
        </Section>
      )}
      <Section title={words('section.fill')}>
        {color('field.background', 'background-color')}
        <div className="dm-grid">{field('field.opacity', 'opacity')}</div>
      </Section>
      <Section title={words('section.border')}>
        <div className="dm-grid">
          {field('field.radius', 'border-radius')}
          {field('field.borderWidth', 'border-width')}
        </div>
        {choose('border-style', BORDER_STYLES, 'field.borderStyle')}
        {color('field.borderColor', 'border-color')}
      </Section>
      <Section title={words('section.effects')}>
        <div className="dm-grid">{field('field.shadow', 'box-shadow', true)}</div>
      </Section>
      <button type="button" className="ghost dm-clear" onClick={() => clearSelectionStyles()}>
        {words('style.clear')}
      </button>
    </div>
  );
}
