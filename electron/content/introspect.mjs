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
import { LOADER } from './stub-astro-loaders.mjs';

// Only these carry a body; the same loader over .json or .yaml does not.
const BODY_EXT = new Set(["md", "mdx", "mdoc", "markdown"]);

// The file extensions a glob pattern can match. A pattern ends in its
// extension, either alone ("*.mdoc") or as a brace group ("**/*.{md,mdx}").
const extensionsOf = (pattern) =>
  [].concat(pattern || []).flatMap((p) => {
    const m = String(p).match(/\.(\{[^}]*\}|[A-Za-z0-9]+)$/);
    if (!m) return [];
    return m[1]
      .replace(/[{}]/g, "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  });

const imageStub = () => z.string().meta({ astroImage: true });

const defOf = (schema) => schema?._zod?.def || null;

// zod keeps .refine()/.superRefine() as checks on the schema they wrap. They
// see the whole object, so they are the rules no single field can enforce and
// the reason a form needs an error region of its own.
const hasCrossFieldChecks = (schema) => {
  const def = defOf(schema);
  return Array.isArray(def?.checks) && def.checks.length > 0;
};

// Called for every node zod converts. `jsonSchema` is the object being emitted
// and can be written to.
const override = (ctx) => {
  const def = defOf(ctx.zodSchema);
  if (!def) return;
  if (def.type === 'date') {
    // Dates disappear from an input-side JSON Schema entirely (the input to
    // z.coerce.date() is "anything"), so without this a date field would look
    // like a field with no type at all.
    ctx.jsonSchema.astroDate = true;
    if (def.coerce) ctx.jsonSchema.astroCoerced = true;
  }
  if (def.type === 'pipe' || def.type === 'transform') {
    // The value in the file is not the value in the entry — testimonials'
    // "true" becomes a boolean. A writer that forgets this corrupts the file.
    ctx.jsonSchema.astroTransform = true;
  }
};

const toJsonSchema = (schema) =>
  z.toJSONSchema(schema, {
    // What a file is allowed to hold, which is what an editor writes — not
    // what a page receives after parsing.
    io: 'input',
    unrepresentable: 'any',
    // A recursive schema (navigation) has to be able to point at itself.
    cycles: 'ref',
    reused: 'inline',
    override,
  });

function describeLoader(loader) {
  if (!loader) return { kind: 'none' };
  const tagged = loader[LOADER];
  if (tagged) return tagged;
  // Somebody's own loader: an object with load(), or the result of calling a
  // factory. Its entries come from wherever it says, and are rebuilt on every
  // sync, so nothing the editor writes to them would survive.
  return {
    kind: 'custom',
    name: typeof loader === 'object' && typeof loader.name === 'string' ? loader.name : null,
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
  record.hasBody = record.extensions.some((e) => BODY_EXT.has(e));
  // An id that comes from a field or a filename convention rather than the
  // file path — editing the wrong thing renames the entry.
  record.idFromFile = loader.kind === 'glob' && !loader.generateId;

  // A loader may carry the schema instead of the collection.
  const raw = collection.schema ?? collection.loader?.schema ?? null;
  if (raw == null) {
    // No schema: every key in the file is allowed, and none is required.
    record.schema = null;
    record.freeform = true;
    return record;
  }

  let schema = raw;
  try {
    // `schema: ({ image }) => …` is the only form that can use image().
    if (typeof raw === 'function') schema = raw({ image: imageStub });
    record.crossFieldChecks = hasCrossFieldChecks(schema);
    record.schema = toJsonSchema(schema);
  } catch (err) {
    record.schema = null;
    record.error = `Couldn't read the schema — ${String(err?.message || err)}`;
  }
  return record;
}

export function describe(mod) {
  const collections = mod?.collections;
  if (!collections || typeof collections !== 'object') {
    return { error: 'The content config has no `collections` export.', collections: [] };
  }
  return {
    collections: Object.entries(collections).map(([name, c]) => describeCollection(name, c)),
  };
}
