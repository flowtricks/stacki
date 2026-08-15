// Stands in for `astro:content` while the project's content config is read.
//
// The config is real code — it calls defineCollection, reference() and z, and
// Astro resolves that virtual module at build time. Reading the config outside
// Astro means supplying it ourselves. Everything here keeps the shape the
// config expects but records what it was asked for instead of doing it:
// reference() and image() come back as ordinary string schemas carrying a
// note about what they really are, which survives all the way into the JSON
// Schema (see introspect.mjs).
//
// `z` is the project's own zod, not a copy — the same instance the config
// would have used, so every check and brand behaves identically.
import { z } from 'astro/zod';

export { z };

export function defineCollection(config) {
  return config;
}

export function reference(collection) {
  return z.string().meta({ astroReference: String(collection) });
}

// Only the runtime helpers exist to be called at module scope; a config that
// imports them never runs them while it is being defined. They are here so an
// import of one doesn't fail the load.
const notAtConfigTime = (name) => () => {
  throw new Error(`${name}() can't be called while the content config is being read.`);
};
export const getCollection = notAtConfigTime('getCollection');
export const getEntry = notAtConfigTime('getEntry');
export const getEntries = notAtConfigTime('getEntries');
export const render = notAtConfigTime('render');
export const getLiveCollection = notAtConfigTime('getLiveCollection');
export const getLiveEntry = notAtConfigTime('getLiveEntry');
export const defineLiveCollection = (config) => config;
