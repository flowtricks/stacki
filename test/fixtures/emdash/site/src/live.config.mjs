// The file EmDash documents as src/live.config.ts; .mjs here only so the repository's own type check does not read it.
import { defineLiveCollection } from 'astro:content';
import { emdashLoader } from 'emdash/runtime';

export const collections = {
  _emdash: defineLiveCollection({ loader: emdashLoader() }),
};
