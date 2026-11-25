import { centralIcon } from '../../ui/central/CentralIcon';
import { lock as centralLock, styles as centralStyles, sweep as centralSweep, unlock as centralUnlock } from '../../ui/central/centralGeometry';
import type { IconProps } from '../../ui/IconBase';

// Central has no selector glyph; its styles mark identifies selectors wherever the panel is named.
export const StyleSelectorsIcon = centralIcon(centralStyles, 20);
export const SweepIcon = centralIcon(centralSweep);

const ClosedLockIcon = centralIcon(centralLock);
const OpenLockIcon = centralIcon(centralUnlock);

// The lock closes and opens by swapping Central's lock and unlock drawings.
export function LockIcon({ open, ...props }: Pick<IconProps, 'size' | 'className' | 'style'> & { readonly open: boolean }) {
  // The class names which state is drawn, for the panel's styles and its tests.
  const className = `selectors-lock-icon${open ? ' is-open' : ''}${props.className === undefined ? '' : ` ${props.className}`}`;
  return open ? <OpenLockIcon {...props} className={className} /> : <ClosedLockIcon {...props} className={className} />;
}
