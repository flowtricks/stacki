import { centralIcon, centralIconSize } from '../../ui/central/CentralIcon';
import { sweep as centralSweep } from '../../ui/central/centralGeometry';
import { I, type IconProps } from '../../ui/IconBase';

// The three drops identify selectors wherever the panel is named.
export const StyleSelectorsIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 20)} strokeWidth={0.85}>
    <path d="M4.5 2.3C4 3.4 2.5 4.7 2.5 6a2 2 0 0 0 4 0c0-1.3-1.5-2.6-2-3.7Z" />
    <path d="M11.5 2.3c-.5 1.1-2 2.4-2 3.7a2 2 0 0 0 4 0c0-1.3-1.5-2.6-2-3.7Z" />
    <path d="M8 8.3C7.5 9.4 6 10.7 6 12a2 2 0 0 0 4 0c0-1.3-1.5-2.6-2-3.7Z" />
  </I>
);
export const SweepIcon = centralIcon(centralSweep);

// Keep one mounted shackle so opening and closing can animate in place.
export function LockIcon({ open, ...props }: IconProps & { readonly open: boolean }) {
  return (
    <I {...props} size={centralIconSize(props.size ?? 16)} strokeWidth={0.9} className={`selectors-lock-icon ${open ? 'is-open' : ''}`}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path className="selectors-shackle" d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </I>
  );
}
