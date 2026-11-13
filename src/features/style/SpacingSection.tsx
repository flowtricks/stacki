import { SpacingFill, useSpacingBox } from './SpacingBox';
import type { ClearProp, LiveSetProp, Read, SelectSelector, SetProp } from './SpacingBox';
import { useTranslate } from '../../lib/i18n/useTranslate';

// The Spacing section — Webflow's nested margin/padding box. Composes the shared
// SpacingBox primitives: two frames (margin, then padding nested in its centre
// hole) that share one editor popover, each side driven by the resolved model.

type Props = {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: SelectSelector;
};

const CENTER_HORIZONTALLY_FRAME_PATH =
  'M2 2C2 1.44772 2.44772 1 3 1H14C14.5523 1 15 1.44772 15 2V4H14V2H3V4H2V2ZM3 11' +
  'V13H14V11H15V13C15 13.5523 14.5523 14 14 14H3C2.44772 14 2 13.5523 2 13V11H3Z';
const CENTER_HORIZONTALLY_BOX_PATH =
  'M6.5 6.5C6.5 5.94772 6.94772 5.5 7.5 5.5H9.5C10.0523 5.5 10.5 5.94772 10.5 6.5' +
  'V8.5C10.5 9.05228 10.0523 9.5 9.5 9.5H7.5C6.94772 9.5 6.5 9.05228 6.5 8.5V6.5Z';

// Webflow's "center horizontally" glyph.
function CenterHorizontallyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d={CENTER_HORIZONTALLY_FRAME_PATH} fill="currentColor" />
      <path d={CENTER_HORIZONTALLY_BOX_PATH} fill="currentColor" />
      <path d="M16 8H13V7H16V8Z" fill="currentColor" />
      <path d="M1 8H4V7H1V8Z" fill="currentColor" />
    </svg>
  );
}

// The effective (winning) value of a side, for the centered-state check.
function sideValue(read: Read, prop: string): string {
  const resolved = read(prop);
  if (!resolved) {
    return '';
  }
  const effective = resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue : resolved.winner;
  return effective.value.trim().toLowerCase();
}

// "Center horizontally" = margin-left/right auto. Rendered in the Spacing section
// header, next to the collapse arrow. Toggle: set both to auto, or clear both.
export function SpacingCenterButton({ read, busy, setProp, clearProp }: { read: Read; busy: boolean; setProp: SetProp; clearProp: ClearProp }) {
  const translate = useTranslate();
  const centered = sideValue(read, 'margin-left') === 'auto' && sideValue(read, 'margin-right') === 'auto';
  const toggle = () => {
    if (centered) {
      clearProp(['margin-left', 'margin-right']);
      return;
    }
    setProp('margin-left', 'auto', false);
    setProp('margin-right', 'auto', false);
  };
  return (
    <button
      type="button"
      className={`embed-editor_spacing-center ${centered ? 'is-active' : ''}`}
      disabled={busy}
      title={translate('style.spacingSection.centerTitle')}
      aria-label={translate('style.spacingSection.centerAria')}
      aria-pressed={centered}
      onClick={toggle}
    >
      <CenterHorizontallyIcon />
    </button>
  );
}

export default function SpacingSection(props: Props) {
  const translate = useTranslate();
  const { label, fillHandlers, editor } = useSpacingBox(props, { variableLabels: true });

  return (
    <div className="embed-editor_spacing">
      <div className="embed-editor_spacing-margin">
        <SpacingFill
          frame="margin"
          propFor={(side) => `margin-${side}`}
          read={props.read}
          busy={props.busy}
          setProp={props.setProp}
          liveSetProp={props.liveSetProp}
          {...fillHandlers}
        />
        <span className="embed-editor_spacing-tag">{translate('style.spacingSection.margin')}</span>
        {label('margin-top', 'top')}
        {label('margin-right', 'right')}
        {label('margin-bottom', 'bottom')}
        {label('margin-left', 'left')}
        <div className="embed-editor_spacing-padding">
          <SpacingFill
            frame="padding"
            propFor={(side) => `padding-${side}`}
            inward
            read={props.read}
            busy={props.busy}
            setProp={props.setProp}
            liveSetProp={props.liveSetProp}
            {...fillHandlers}
          />
          <span className="embed-editor_spacing-tag">{translate('style.spacingSection.padding')}</span>
          {label('padding-top', 'top')}
          {label('padding-right', 'right')}
          {label('padding-bottom', 'bottom')}
          {label('padding-left', 'left')}
          <div className="embed-editor_spacing-content" />
        </div>
      </div>

      {editor}
    </div>
  );
}
