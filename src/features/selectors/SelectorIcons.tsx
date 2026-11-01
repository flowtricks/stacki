import type { IconProps } from '../../ui/Icons';

// Three drops: the rail's mark for the style selectors panel, drawn on the
// rail's 24px grid with the same faded inner fill as its neighbours.
export function StyleSelectorsIcon({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g opacity="0.4" fill="currentColor">
        <path d={FILL_LEFT} />
        <path d={FILL_BOTTOM} />
        <path d={FILL_RIGHT} />
      </g>
      <g fill="currentColor">
        <path fillRule="evenodd" clipRule="evenodd" d={DROP_LEFT} />
        <path fillRule="evenodd" clipRule="evenodd" d={DROP_RIGHT} />
        <path fillRule="evenodd" clipRule="evenodd" d={DROP_BOTTOM} />
      </g>
    </svg>
  );
}

// A brush sweeping: the clean-up action.
export function SweepIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2 8.6 7.4" />
      <path d="M8.9 7.1c-1-1-2.6-1-3.5 0L3 9.5l3.5 3.5 2.4-2.4c1-.9 1-2.5 0-3.5Z" />
      <path d="M3 9.5 2 14l4.5-1M4.6 11.4 3.4 12.6" />
    </svg>
  );
}

export function LockIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

export function UnlockIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" />
    </svg>
  );
}

const FILL_LEFT =
  'M6.56699 7.11602C6.82276 6.67301 7.5 6.85447 7.5 7.36602V9.49998C7.5 9.77612 7.27 10.0081 7.00905 9.91779' +
  'C6.42173 9.71445 6 9.15647 6 8.49998C6 8.22823 6.07484 7.95846 6.21413 7.72719L6.56699 7.11602Z';
const FILL_BOTTOM =
  'M11.067 17.116C11.3228 16.673 12 16.8545 12 17.366V19.5C12 19.7761 11.77 20.0081 11.5091 19.9178' +
  'C10.9217 19.7144 10.5 19.1565 10.5 18.5C10.5 18.2281 10.5749 17.9582 10.7144 17.7268L11.067 17.116Z';
const FILL_RIGHT =
  'M16.0091 9.91779C16.27 10.0081 16.5 9.77611 16.5 9.49997V7.36603C16.5 6.85447 15.8228 6.67301 15.567 7.11602' +
  'L15.2144 7.72681C15.0749 7.95818 15 8.22808 15 8.49997C15 9.15646 15.4217 9.71445 16.0091 9.91779Z';
const DROP_LEFT =
  'M4 8.49996C4 10.433 5.567 12 7.5 12C9.433 12 11 10.433 11 8.49996C11 7.86763 10.8267 7.24042 10.5025 6.70053' +
  'L8.36604 3C7.98114 2.33334 7.01889 2.33333 6.63398 3L4.49795 6.69972C4.17349 7.23984 4 7.86732 4 8.49996Z' +
  'M7.5 11C6.11929 11 5 9.88067 5 8.49996C5 8.04667 5.12524 7.59618 5.35694 7.21172L5.36179 7.20368L7.50001 3.5' +
  'L9.64335 7.21238C9.8748 7.59667 10 8.04691 10 8.49996C10 9.88067 8.88071 11 7.5 11Z';
const DROP_RIGHT =
  'M13 8.49996C13 10.433 14.567 12 16.5 12C18.433 12 20 10.433 20 8.49996C20 7.86763 19.8267 7.24042 19.5025 6.70053' +
  'L17.366 3C16.9811 2.33334 16.0189 2.33333 15.634 3L13.4979 6.69972C13.1735 7.23984 13 7.86732 13 8.49996Z' +
  'M16.5 11C15.1193 11 14 9.88067 14 8.49996C14 8.04667 14.1252 7.59618 14.3569 7.21172L14.3618 7.20368L16.5 3.5' +
  'L18.6434 7.21238C18.8748 7.59667 19 8.04691 19 8.49996C19 9.88067 17.8807 11 16.5 11Z';
const DROP_BOTTOM =
  'M12 22C10.067 22 8.5 20.433 8.5 18.5C8.5 17.8673 8.67349 17.2398 8.99795 16.6997L11.134 13' +
  'C11.5189 12.3333 12.4811 12.3333 12.866 13L15.0025 16.7005C15.3267 17.2404 15.5 17.8676 15.5 18.5' +
  'C15.5 20.433 13.933 22 12 22Z' +
  'M9.5 18.5C9.5 19.8807 10.6193 21 12 21C13.3807 21 14.5 19.8807 14.5 18.5C14.5 18.0469 14.3749 17.5966 14.1434 17.2123' +
  'L14.1387 17.2044L12 13.5L9.86172 17.2036L9.85694 17.2117C9.62524 17.5962 9.5 18.0467 9.5 18.5Z';
