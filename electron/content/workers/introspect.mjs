// Turns a loaded content config into a manifest the editor can work from:
// one record per collection saying where its entries live, whether they can be
// edited at all, and what shape each one has.
//
// The shape is emitted as JSON Schema, which zod produces itself — so the
// constraints an editor has to honour (lengths, ranges, patterns, enums,
// defaults, optionality, unions, recursion) arrive as data rather than as
// something we re-derive from the source. Three things JSON Schema has no way
// to say are stamped on by the override hook below: which strings are really
// dates, which are references, and which values pass through a transform on
// the way in — the last one being the difference between what the file holds
// and what an entry holds.
import { z } from 'astro/zod';
import { LOADER } from './stubAstroLoaders.mjs';
import { withMetadata, hasCrossFieldChecks, toJsonSchema } from './schemaTools.mjs';

// Only these carry a body; the same loader over .json or .yaml does not.
const BODY_EXT = new Set(['md', 'mdx', 'mdoc', 'markdown']);

// The file extensions a glob pattern can match. A pattern ends in its
// extension, either alone ("*.mdoc") or as a brace group ("**/*.{md,mdx}").
const extensionsOf = (pattern) =>
  [].concat(pattern || []).flatMap((glob) => {
    const match = String(glob).match(/\.(\{[^}]*\}|[A-Za-z0-9]+)$/);
    if (!match) {
      return [];
    }
    return match[1]
      .replace(/[{}]/g, '')
      .split(',')
      .map((extension) => extension.trim().toLowerCase())
      .filter(Boolean);
  });

const imageStub = () => withMetadata(z.string(), { astroImage: true });

function describeLoader(loader) {
  if (!loader) {
    return { kind: 'none' };
  }
  const tagged = loader[LOADER];
  if (tagged) {
    return tagged;
  }
  // Somebody's own loader: an object with load(), or the result of calling a
  // factory. Its entries come from wherever it says, and are rebuilt on every
  // sync, so nothing the editor writes to them would survive.
  return {
    kind: 'custom',
    name: typeof loader === 'object' && typeof loader.name === 'string' ? loader.name : undefined,
  };
}

function describeCollection(name, collection) {
  const record = { name, editable: false };
  if (!collection || typeof collection !== 'object') {
    record.error = 'Not a collection definition.';
    return record;
  }

  const loader = describeLoader(collection.loader);
  record.loader = loader;
  record.editable = loader.kind === 'glob' || loader.kind === 'file';
  record.extensions = loader.kind === 'glob' ? extensionsOf(loader.pattern) : [];
  record.hasBody = record.extensions.some((extension) => BODY_EXT.has(extension));
  // An id that comes from a field or a filename convention rather than the
  // file path — editing the wrong thing renames the entry.
  record.idFromFile = loader.kind === 'glob' && !loader.generateId;

  // A loader may carry the schema instead of the collection.
  const raw = collection.schema ?? collection.loader?.schema ?? undefined;
  if (raw === undefined) {
    // No schema: every key in the file is allowed, and none is required.
    record.schema = undefined;
    record.freeform = true;
    return record;
  }

  let schema = raw;
  try {
    // `schema: ({ image }) => …` is the only form that can use image().
    if (typeof raw === 'function') {
      schema = raw({ image: imageStub });
    }
    record.crossFieldChecks = hasCrossFieldChecks(schema);
    record.schema = toJsonSchema(schema);
  } catch (error) {
    record.schema = undefined;
    record.error = `Couldn't read the schema — ${String(error?.message || error)}`;
  }
  return record;
}

export function describe(mod) {
  const collections = mod?.collections;
  if (!collections || typeof collections !== 'object') {
    return { error: 'The content config has no `collections` export.', collections: [] };
  }
  return {
    collections: Object.entries(collections).map(([name, collection]) => describeCollection(name, collection)),
  };
}

// --- validation ------------------------------------------------------------
//
// The same schemas, used the way Astro uses them. A form can enforce a field's
// own rules on its own, but not `.refine()` or `.superRefine()` — those see the
// whole entry, and the only thing that can answer them is the schema itself.
// So an edited entry is parsed here, against the real zod, and what comes back
// is the list of issues with the exact paths they belong to.

const schemaCache = new Map();

function schemaOf(mod, name) {
  if (schemaCache.has(name)) {
    return schemaCache.get(name);
  }
  const collection = mod?.collections?.[name];
  const raw = collection?.schema ?? collection?.loader?.schema ?? undefined;
  const schema = typeof raw === 'function' ? raw({ image: imageStub }) : raw;
  schemaCache.set(name, schema || undefined);
  return schema || undefined;
}

export function validate(mod, { collection, data }) {
  const schema = schemaOf(mod, collection);
  // No schema means every shape is allowed — which is a real answer, not a
  // missing one.
  if (!schema) {
    return { issues: [], unchecked: true };
  }
  const result = schema.safeParse(data);
  if (result.success) {
    return { issues: [] };
  }
  return {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
      message: issue.message,
      code: issue.code,
    })),
  };
}
