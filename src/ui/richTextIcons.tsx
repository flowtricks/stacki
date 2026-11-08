// The rich text toolbar's glyphs, drawn on the shared 16px grid (IconBase.tsx)
// so they sit with the rest of Stacki's icons.
import { type IconProps, I } from './IconBase';

export const BoldIcon = (props: IconProps) => (
  <I {...props} strokeWidth={1.8}>
    <path d="M4.5 3h4.25a2.5 2.5 0 0 1 0 5H4.5zM4.5 8h5a2.5 2.5 0 0 1 0 5h-5z" />
  </I>
);

export const ItalicIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M10 3H6.5M9.5 13H6M9.25 3l-2.5 10" />
  </I>
);

export const UnderlineIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M4.5 2.5V7a3.5 3.5 0 0 0 7 0V2.5M3.5 13.5h9" />
  </I>
);

export const StrikeIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M2.5 8h11M11 4.5C10.5 3.3 9.4 2.75 8 2.75c-1.9 0-3.25 1-3.25 2.5 0 .9.5 1.6 1.4 2" />
    <path d="M5 11.25c.5 1.3 1.6 2 3 2 1.9 0 3.25-1 3.25-2.5 0-.4-.1-.8-.3-1.1" />
  </I>
);

// An X with a small 2 raised to its top right, or dropped to its bottom right:
// the glyphs every editor uses, drawn as strokes so they sit at the weight of
// the icons beside them rather than as a heavier typed X².
export const SuperscriptIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M2.75 5.5 8.25 12.5M8.25 5.5 2.75 12.5" />
    <path d="M10.25 3.6c.2-.65.75-1.1 1.45-1.1.8 0 1.35.5 1.35 1.2 0 .5-.25.85-.75 1.3L10.25 7h2.9" />
  </I>
);

export const SubscriptIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M2.75 3.5 8.25 10.5M8.25 3.5 2.75 10.5" />
    <path d="M10.25 10.1c.2-.65.75-1.1 1.45-1.1.8 0 1.35.5 1.35 1.2 0 .5-.25.85-.75 1.3L10.25 13.5h2.9" />
  </I>
);

export const InlineCodeIcon = (props: IconProps) => (
  <I {...props}>
    <path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5" />
  </I>
);

export const LinkIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M6.75 9.25a3 3 0 0 0 4.25 0l2-2a3 3 0 0 0-4.25-4.25l-.75.75" />
    <path d="M9.25 6.75a3 3 0 0 0-4.25 0l-2 2a3 3 0 0 0 4.25 4.25l.75-.75" />
  </I>
);

export const UnlinkIcon = (props: IconProps) => (
  <I {...props}>
    <path d="m10.5 9.5 2.5-2.5a3 3 0 0 0-4.25-4.25L7.5 4M5.5 6.5 3 9a3 3 0 0 0 4.25 4.25L8.5 12" />
    <path d="M2.5 2.5l11 11" />
  </I>
);

export const BulletListIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
    <circle cx="3" cy="4" r="0.6" fill="currentColor" />
    <circle cx="3" cy="8" r="0.6" fill="currentColor" />
    <circle cx="3" cy="12" r="0.6" fill="currentColor" />
  </I>
);

export const NumberListIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M7 4h6.5M7 8h6.5M7 12h6.5M2.5 2.75 3.5 2.25v3.5" />
    <path d="M2.25 9.75c0-1 2-1 2 0 0 .75-2 1.25-2 2.25h2" />
  </I>
);

export const QuoteIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M3 3.5v9M6.5 5h7M6.5 8h7M6.5 11h4.5" />
  </I>
);

export const RuleIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M2 8h12" />
  </I>
);

export const ClearFormatIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M4 3.5h8M8 3.5 6 12.5M10 10l3.5 3.5M13.5 10 10 13.5" />
  </I>
);

export const UndoIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M5.5 3 2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8H6" />
  </I>
);

export const RedoIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M10.5 3l3 3-3 3M13.5 6h-7a4 4 0 0 0 0 8H10" />
  </I>
);
