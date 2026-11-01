// The glyphs the variable picker draws: a check, a plus, a chevron, and an
// icon per variable type (VariableConnect.tsx).

export function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The "connect to variable" affordance (Webflow's): a dot in the input's top-left
// corner, revealed on hover of the input. Hovering the dot grows it into a purple
// "+"; clicking opens a searchable, grouped variable picker. Picking one calls
// onPick with the `var(--…)` binding to write.

export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 4v8M4 8h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export const COLOR_TYPE_ICON_PATH =
  'M8 12C6.61929 12 5.5 10.8807 5.5 9.50002C5.5 9.04673 5.62524 8.59624 5.85694 8.21178' +
  'L5.86179 8.20374L8.00001 4.50006L10.1434 8.21244C10.3748 8.59673 10.5 9.04697 10.5 9.50002' +
  'C10.5 10.8807 9.38071 12 8 12ZM4.5 9.50002C4.5 11.433 6.067 13 8 13C9.933 13 11.5 11.433 ' +
  '11.5 9.50002C11.5 8.86769 11.3267 8.24048 11.0025 7.70059L8.86604 4.00006C8.48114 3.3334 ' +
  '7.51889 3.33339 7.13398 4.00006L4.99795 7.69979C4.67349 8.2399 4.5 8.86738 4.5 9.50002Z';

// Per-type variable glyphs (Webflow's), keyed by the variable's `type`; any other type
// (Size included) uses the Size glyph.
export function ColorTypeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={COLOR_TYPE_ICON_PATH} fill="currentColor" />
    </svg>
  );
}
export const NUMBER_TYPE_ICON_PATH =
  'M11.846 3.13226L11.0637 6.0007H13V7.0007H10.791L10.2455 9.0007H12V10.0007' +
  'H9.9728L9.11873 13.1323L8.15397 12.8691L8.93627 10.0007H5.9728L5.11873 13.1323' +
  'L4.15397 12.8691L4.93627 10.0007H3V9.0007H5.209L5.75445 7.0007H4V6.0007' +
  'H6.02718L6.88124 2.86914L7.84601 3.13226L7.0637 6.0007H10.0272L10.8812 2.86914' +
  'L11.846 3.13226ZM6.24552 9.0007H9.209L9.75446 7.0007H6.79098L6.24552 9.0007Z';

export function NumberTypeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={NUMBER_TYPE_ICON_PATH} fill="currentColor" />
    </svg>
  );
}
export const PERCENTAGE_TYPE_ICON_PATH =
  'M12.8538 3.85249L3.85377 12.8525C3.75995 12.9463 3.63271 12.999 3.50002 12.999C3.36734 ' +
  '12.999 3.24009 12.9463 3.14627 12.8525C3.05245 12.7587 2.99975 12.6314 2.99975 12.4987' +
  'C2.99975 12.3661 3.05245 12.2388 3.14627 12.145L12.1463 3.14499C12.24 3.05116 12.3672 ' +
  '2.99842 12.4998 2.99837C12.6324 2.99831 12.7596 3.05094 12.8535 3.14467C12.9473 3.23841 ' +
  '13 3.36558 13.0001 3.4982C13.0001 3.63083 12.9475 3.75804 12.8538 3.85186V3.85249' +
  'ZM3.15877 6.33999C2.73683 5.91796 2.49982 5.3456 2.49988 4.74883C2.49994 4.15205 2.73706 ' +
  '3.57974 3.15909 3.1578C3.58111 2.73585 4.15347 2.49884 4.75025 2.4989C5.34702 2.49896 ' +
  '5.91933 2.73608 6.34127 3.15811C6.76322 3.58014 7.00023 4.15249 7.00017 4.74927C7.00011 ' +
  '5.34604 6.76299 5.91835 6.34096 6.3403C5.91894 6.76224 5.34658 6.99925 4.7498 6.99919' +
  'C4.15303 6.99914 3.58072 6.76201 3.15877 6.33999ZM3.50002 4.74999C3.50019 4.95552 3.55102 ' +
  '5.15783 3.64804 5.33903C3.74505 5.52022 3.88525 5.6747 4.05621 5.78877C4.22718 5.90285 ' +
  '4.42363 5.97302 4.62818 5.99305C4.83274 6.01308 5.03907 5.98237 5.22892 5.90363C5.41877 ' +
  '5.82488 5.58627 5.70055 5.7166 5.54162C5.84692 5.38269 5.93605 5.19408 5.97608 4.99249' +
  'C6.01612 4.79089 6.00582 4.58254 5.94612 4.38587C5.88641 4.1892 5.77913 4.0103 5.63377 ' +
  '3.86499C5.45888 3.69015 5.23606 3.57111 4.99351 3.52294C4.75095 3.47478 4.49955 3.49963 ' +
  '4.27113 3.59438C4.0427 3.68912 3.84751 3.84949 3.71025 4.05519C3.57299 4.2609 3.49983 ' +
  '4.50269 3.50002 4.74999ZM13.5 11.25C13.4999 11.7705 13.3193 12.2749 12.989 12.6772' +
  'C12.6587 13.0795 12.1991 13.3549 11.6885 13.4563C11.1779 13.5578 10.648 13.479 ' +
  '10.189 13.2336C9.72995 12.9881 9.37023 12.5911 9.17113 12.1101C8.97202 11.6291 ' +
  '8.94583 11.094 9.09703 10.5959C9.24823 10.0978 9.56746 9.66755 10.0003 9.37843' +
  'C10.4332 9.08931 10.9529 8.95923 11.4709 9.01034C11.989 9.06145 12.4733 9.2906 12.8413 ' +
  '9.65873C13.0509 9.86722 13.217 10.1152 13.3301 10.3884C13.4432 10.6615 13.5009 ' +
  '10.9544 13.5 11.25ZM12.5 11.25C12.5001 10.9608 12.3999 10.6805 12.2165 10.4569' +
  'C12.033 10.2333 11.7778 10.0803 11.4941 10.0238C11.2105 9.96731 10.9161 10.0109 10.661 ' +
  '10.1472C10.4059 10.2835 10.206 10.504 10.0953 10.7712C9.98454 11.0383 9.96988 11.3356 ' +
  '10.0538 11.6124C10.1377 11.8891 10.315 12.1282 10.5554 12.2889C10.7958 12.4496 ' +
  '11.0845 12.522 11.3723 12.4937C11.6602 12.4654 11.9293 12.3382 12.1338 12.1337' +
  'C12.2502 12.018 12.3425 11.8802 12.4054 11.7285' +
  'C12.4683 11.5768 12.5004 11.4142 12.5 11.25Z';

export function PercentageTypeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={PERCENTAGE_TYPE_ICON_PATH} fill="currentColor" />
    </svg>
  );
}
export const FONT_FAMILY_TYPE_ICON_PATH =
  'M8.49945 3.49902L8.50043 3.49805V2.99902L8.88422 3L8.98285 3.37012L10.4116 8.7041' +
  'C11.6626 9.16833 12.7329 9.8024 13.4955 10.5137L12.8139 11.2451C12.2954 10.7615 11.5854 ' +
  '10.3001 10.7368 9.91699L11.2954 12H10.2602L9.58344 9.47559C9.40836 9.41951 9.22889 ' +
  '9.3663 9.04633 9.31738C8.17518 9.084 7.32862 8.96439 6.55707 8.94629L5.98481 11.085' +
  'C5.81653 11.7126 5.4687 12.2493 5.01996 12.6016C4.57106 12.9537 3.99165 13.1394 3.4057 ' +
  '12.9824C2.81995 12.8253 2.41134 12.375 2.19867 11.8457C1.98617 11.3163 1.95342 10.6775 ' +
  '2.12152 10.0498C2.31581 9.32507 2.87878 8.80593 3.58344 8.47266C4.19709 8.18251 4.95456 ' +
  '8.01274 5.78656 7.96094L7.01703 3.36914L7.11664 2.99902H8.50043L8.49945 3.49902' +
  'ZM5.51117 8.98828C4.91768 9.0534 4.40905 9.1879 4.01117 9.37598C3.46964 9.63206 3.18054 ' +
  '9.96113 3.08734 10.3086C2.96987 10.7474 3.00204 11.1626 3.12641 11.4727C3.25078 ' +
  '11.7822 3.45071 11.9592 3.66449 12.0166C3.87841 12.0739 4.14016 12.0205 4.40277 11.8145' +
  'C4.66552 11.6081 4.90132 11.265 5.01898 10.8262L5.51117 8.98828ZM6.8227 7.95605' +
  'C7.60256 7.99297 8.43418 8.12006 9.27973 8.34473L8.11664 3.99902H7.88324L6.8227 7.95605Z';

export function FontFamilyTypeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={FONT_FAMILY_TYPE_ICON_PATH} fill="currentColor" />
    </svg>
  );
}
export function SizeTypeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M12 4.70711L4.70711 12H7.5V13H3V8.5H4V11.2929L11.2929 4H8.5V3H13V7.5H12V4.70711Z" fill="currentColor" />
    </svg>
  );
}
export function VariableTypeIcon({ type }: { type: string }) {
  switch (type) {
    case 'Color':
      return <ColorTypeIcon />;
    case 'Number':
      return <NumberTypeIcon />;
    case 'Percentage':
      return <PercentageTypeIcon />;
    case 'FontFamily':
      return <FontFamilyTypeIcon />;
    default:
      return <SizeTypeIcon />;
  }
}
export function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
