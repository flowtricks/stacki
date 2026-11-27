// The direction arrows that the Style panel's flex direction bar (DirectionControl.tsx) and the component canvas's
// Layout choices (ComponentCanvasPanel.tsx) both draw. They live here because the two features may not import each other.
import { centralIcon } from './central/CentralIcon';
import { arrowDown as centralArrowDown, arrowRight as centralArrowRight } from './central/centralGeometry';

export const ArrowRightIcon = centralIcon(centralArrowRight);
export const ArrowDownIcon = centralIcon(centralArrowDown);

const ROW_WRAP_ICON_FIRST_PATH =
  'M14.207 11.5L10.8535 14.8535L10.1465 14.1465L12.293 12H3V11H12.293L10.1465 8.85352' + 'L10.8535 8.14648L14.207 11.5ZM11 4H3V3H11V4Z';

export function RowWrapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={ROW_WRAP_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" d="M11 4.20703L4.20703 11H3V10.793L9.79297 4H11V4.20703Z" fill="currentColor" />
    </svg>
  );
}
