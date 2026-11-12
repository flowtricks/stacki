// A small (i) mark that holds the longer explanation a settings tab does not spend screen space on. The tip is
// the app's own delayed tooltip (the dark `.rail-tooltip`), not the native `title`: the operating system draws
// that one late and in its own place. The text is also the button's accessible name, so a screen reader and
// keyboard focus reach it without hovering.
import { assert } from '../../../shared/core/assert';
import { centralIcon } from '../../ui/central/CentralIcon';
import { info as centralInfo } from '../../ui/central/centralGeometry';
import { useDelayedTooltip } from '../../ui/delayedTooltip';

const InfoIcon = centralIcon(centralInfo, 12);

export default function InfoHint({ text }: { readonly text: string }) {
  assert(text.length > 0, 'InfoHint: the explanation is not empty');
  const tooltip = useDelayedTooltip();
  return (
    <>
      <button
        type="button"
        className="settings-info"
        aria-label={text}
        onMouseEnter={tooltip.show}
        onMouseLeave={tooltip.hide}
        onBlur={tooltip.hide}
        onClick={(event) => event.stopPropagation()}
      >
        <InfoIcon />
      </button>
      {tooltip.value !== undefined && (
        <div className="rail-tooltip below settings-info-tip" style={tooltip.value} role="tooltip">
          {text}
        </div>
      )}
    </>
  );
}
