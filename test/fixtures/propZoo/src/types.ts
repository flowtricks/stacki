// Types the components import, so the scan must follow them to this file.
// Kept free of astro imports so the repository's own type check can read it.

export type Tone = 'info' | 'success' | 'warning' | 'danger';

export interface Author {
  name: string;
  avatar?: string;
  url?: string;
}

export interface CardProps {
  /** The card's heading. */
  title: string;
  /** Short supporting text. */
  body?: string;
  tone?: Tone;
  /** Where the card links to. */
  href?: string;
}

export type LinkItem = {
  label: string;
  href: string;
};
