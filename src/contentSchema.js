// A collection's schema, turned into the fields an editor can draw.
//
// What arrives from the main process is JSON Schema — zod's own rendering of
// the project's content config (see electron/content/introspect.mjs). It says
// everything, in a shape meant for validators rather than forms: optionality
// lives in a list of required keys somewhere above the field, nullability is an
// anyOf with a null branch, a union is a bare oneOf, and recursion is a $ref.
//
// This turns that into one descriptor per field: what control to draw, what it
// may hold, and what has to be true before it can be saved. Three states that
// most editors collapse into one are kept apart here, because they mean
// different things in the file:
//
//   optional  the key may be absent      → offer to add it, and to remove it
//   nullable  the key must be there      → offer an explicit "none" that
//             but may be null              writes null
//   default   the key may be absent and  → show the value as a placeholder and
//             the value is filled in       do not write it unless it is chosen

const labelize = (key) =>
  String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

// Names that say a string is really something else. Nothing in a zod schema
// marks a string as markdown or as code, and the difference decides whether the
// control is a paragraph box or an editor with a monospace font.
const MARKDOWN_KEYS = /^(markdown|body|answer|content|richText|excerpt)$/i;
const CODE_KEYS = /^(example|snippet|code|markup|payload|query)$/i;
const LONG_KEYS = /^(description|summary|bio|quote|abstract|intro|blurb|tagline)$/i;

// A pattern, said in words. A regular expression in an error message tells an
// editor nothing they can act on.
const PATTERN_HINTS = [
  [/^\^#\(\?:\)?\[0-9a-f\]\{6\}\$$/i, 'a six-digit hex colour, like #2f6df6'],
  [/^\^#\[0-9a-f\]\{6\}\$$/i, 'a six-digit hex colour, like #2f6df6'],
  [/^\^\\d\+\\\.x\$$/, 'a major version, like 7.x'],
  [/^\^\\\/\.\*$/, 'a path starting with /'],
  [/^\^\[A-Z\]\{3\}-\[A-Z\]\+\$$/, 'three capitals, a dash, then capitals — like BCN-STD'],
  [/^\^\[a-z0-9-\]\+\$$/, 'lowercase letters, numbers and dashes'],
];

export function patternHint(pattern) {
  if (!pattern) return null;
  for (const [test, hint] of PATTERN_HINTS) if (test.test(pattern)) return hint;
  return null;
}

const isNullBranch = (node) => node && node.type === 'null';

// anyOf [X, null] is how zod writes .nullable(); unwrap it so the field is X
// and knows it may also be nothing.
function unwrapNullable(node) {
  const branches = node?.anyOf || node?.oneOf;
  if (!Array.isArray(branches) || branches.length !== 2) return { node, nullable: false };
  const nulls = branches.filter(isNullBranch);
  const rest = branches.filter((b) => !isNullBranch(b));
  if (nulls.length !== 1 || rest.length !== 1) return { node, nullable: false };
  return { node: { ...rest[0], default: node.default ?? rest[0].default }, nullable: true };
}

const defsOf = (root) => root?.$defs || {};

function deref(node, root, seen = new Set()) {
  if (!node?.$ref) return node;
  const name = String(node.$ref).split('/').pop();
  if (seen.has(name)) return { ...defsOf(root)[name], recursive: name };
  return { ...defsOf(root)[name], recursive: name };
}

const branchesOf = (node) => node?.oneOf || node?.anyOf || null;

// A union is a type switcher when every branch agrees on a key that is a single
// literal — that key is what the user picks, and it decides the rest of the
// form.
function discriminatorOf(branches) {
  if (!branches || branches.length < 2) return null;
  const first = branches[0]?.properties || {};
  for (const key of Object.keys(first)) {
    const values = branches.map((b) => b?.properties?.[key]);
    if (values.every((v) => v && v.const !== undefined)) return key;
  }
  return null;
}

function controlFor(node, key, nullable) {
  if (!node || node.recursiveOnly) return 'unknown';
  if (node.astroImage) return 'image';
  if (node.astroReference) return 'reference';
  if (node.astroDate) return 'date';
  if (node.enum) return 'enum';
  if (node.const !== undefined) return 'const';

  const type = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type;
  if (type === 'boolean') return 'boolean';
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'array') {
    const items = node.items || {};
    if (items.astroReference) return 'references';
    if (items.type === 'string' && !items.properties) return 'tags';
    return 'list';
  }
  if (type === 'object') {
    if (!node.properties && node.additionalProperties && typeof node.additionalProperties === 'object') {
      return 'record';
    }
    return 'object';
  }
  if (branchesOf(node)) return 'union';
  if (type === 'string') {
    if (MARKDOWN_KEYS.test(key)) return 'markdown';
    if (CODE_KEYS.test(key)) return 'code';
    if (node.format === 'uri') return 'url';
    if (node.format === 'email') return 'email';
    if ((node.maxLength && node.maxLength > 200) || LONG_KEYS.test(key)) return 'longtext';
    return 'text';
  }
  // No type at all: a value zod could not describe on the way in. It is still
  // the user's data, so it is shown as what it looks like rather than hidden.
  return nullable ? 'text' : 'unknown';
}

function constraintsOf(node) {
  const out = {};
  if (node.minLength != null) out.minLength = node.minLength;
  if (node.maxLength != null) out.maxLength = node.maxLength;
  if (node.minimum != null) out.min = node.minimum;
  if (node.maximum != null) out.max = node.maximum;
  if (node.exclusiveMinimum != null) out.min = node.exclusiveMinimum + (node.type === 'integer' ? 1 : 0);
  if (node.exclusiveMaximum != null) out.max = node.exclusiveMaximum - (node.type === 'integer' ? 1 : 0);
  if (node.type === 'integer') out.integer = true;
  if (node.pattern) {
    out.pattern = node.pattern;
    out.patternHint = patternHint(node.pattern);
  }
  if (node.minItems != null) out.minItems = node.minItems;
  if (node.maxItems != null) out.maxItems = node.maxItems;
  // A number whose maximum is the largest integer JavaScript has is not really
  // bounded; zod writes that for .int(), and showing it as a rule would be a
  // lie.
  if (out.max === Number.MAX_SAFE_INTEGER) delete out.max;
  if (out.min === -Number.MAX_SAFE_INTEGER) delete out.min;
  return out;
}

/**
 * One field descriptor. `key` may be null for the item type of an array.
 */
export function describeField(rawNode, key, { required = false, root, depth = 0 } = {}) {
  const resolved = deref(rawNode, root);
  const { node, nullable } = unwrapNullable(resolved || {});
  const control = controlFor(node, key || '', nullable);

  const field = {
    key,
    label: key ? labelize(key) : null,
    control,
    required,
    nullable,
    description: node.description || null,
    constraints: constraintsOf(node),
    transform: !!node.astroTransform,
    coerced: !!node.astroCoerced,
  };
  if ('default' in node) field.default = node.default;
  if (node.enum) field.options = node.enum;
  if (node.const !== undefined) field.const = node.const;
  if (node.astroReference) field.target = node.astroReference;
  if (node.items?.astroReference) field.target = node.items.astroReference;
  if (node.recursive) field.recursive = node.recursive;

  // Deep structures are described one level at a time: a recursive schema has
  // no bottom, and a form only ever draws the level it is showing.
  if (depth > 6) return field;

  if (control === 'object') {
    field.fields = fieldsOf(node, { root, depth: depth + 1 });
  } else if (control === 'record') {
    field.value = describeField(node.additionalProperties, null, { root, depth: depth + 1 });
  } else if (control === 'list') {
    field.item = describeField(node.items || {}, null, { root, depth: depth + 1 });
  } else if (control === 'union') {
    const branches = branchesOf(node) || [];
    const discriminator = discriminatorOf(branches);
    field.discriminator = discriminator;
    field.members = branches.map((branch, index) => {
      const value = discriminator ? branch.properties?.[discriminator]?.const : index;
      return {
        value,
        label: labelize(String(value ?? `Option ${index + 1}`)),
        fields: fieldsOf(branch, { root, depth: depth + 1 }).filter((f) => f.key !== discriminator),
      };
    });
  }
  return field;
}

/** The fields of an object schema, in the order the schema declares them. */
export function fieldsOf(schema, { root = schema, depth = 0 } = {}) {
  const node = deref(schema, root) || {};
  const properties = node.properties || {};
  const required = new Set(node.required || []);
  return Object.entries(properties).map(([key, child]) =>
    describeField(child, key, { required: required.has(key), root, depth })
  );
}

/**
 * The fields of a whole collection. An entry-level union (settings files, where
 * each entry is a different kind of thing) is reported as one union field so
 * the form can switch on it.
 */
export function collectionFields(schema) {
  if (!schema) return { fields: [], freeform: true };
  const branches = branchesOf(schema);
  if (branches) {
    const field = describeField(schema, null, { root: schema });
    return { fields: [], union: field, freeform: false };
  }
  return { fields: fieldsOf(schema), freeform: false };
}

/** Which union member a value is, by its discriminator. */
export function memberFor(union, value) {
  if (!union?.members?.length) return null;
  const key = union.discriminator;
  if (key && value && typeof value === 'object') {
    const found = union.members.find((m) => m.value === value[key]);
    if (found) return found;
  }
  return union.members[0];
}

/**
 * A field's own rules, checked as the user types. The schema's whole-entry
 * rules are checked by zod itself (see validateContentEntry) — this is the part
 * that can answer without a round trip.
 */
export function fieldIssue(field, value) {
  const c = field.constraints || {};
  if (value === undefined || value === null || value === '') {
    if (field.required && !field.nullable && value !== 0 && value !== false) return 'Required';
    return null;
  }
  if (typeof value === 'string') {
    if (c.minLength && value.length < c.minLength) return `At least ${c.minLength} characters`;
    if (c.maxLength && value.length > c.maxLength) return `At most ${c.maxLength} characters`;
    if (c.pattern && !new RegExp(c.pattern).test(value)) {
      return c.patternHint ? `Needs ${c.patternHint}` : `Does not match ${c.pattern}`;
    }
    if (field.control === 'url' && !/^https?:\/\//i.test(value)) return 'Needs a full URL, starting with http';
    if (field.control === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Needs an email address';
  }
  if (typeof value === 'number') {
    if (c.integer && !Number.isInteger(value)) return 'Whole numbers only';
    if (c.min != null && value < c.min) return `At least ${c.min}`;
    if (c.max != null && value > c.max) return `At most ${c.max}`;
  }
  if (Array.isArray(value)) {
    if (c.minItems && value.length < c.minItems) return `At least ${c.minItems}`;
    if (c.maxItems && value.length > c.maxItems) return `At most ${c.maxItems}`;
  }
  return null;
}

/** A short line under a field saying what it will take. */
export function hintFor(field) {
  const c = field.constraints || {};
  const bits = [];
  if (field.description) bits.push(field.description);
  if (c.patternHint) bits.push(c.patternHint);
  else if (c.pattern) bits.push(`matches ${c.pattern}`);
  if (c.minLength && c.maxLength) bits.push(`${c.minLength}–${c.maxLength} characters`);
  else if (c.maxLength) bits.push(`up to ${c.maxLength} characters`);
  else if (c.minLength) bits.push(`at least ${c.minLength} characters`);
  if (c.min != null && c.max != null) bits.push(`${c.min}–${c.max}`);
  else if (c.min != null) bits.push(`${c.min} or more`);
  else if (c.max != null) bits.push(`up to ${c.max}`);
  if (c.minItems && c.maxItems) bits.push(`${c.minItems}–${c.maxItems} items`);
  else if (c.maxItems) bits.push(`up to ${c.maxItems} items`);
  else if (c.minItems) bits.push(`at least ${c.minItems}`);
  if (field.transform) bits.push('stored differently in the file than it reads here');
  return bits.join(' · ') || null;
}

/**
 * The edits that turn `before` into `after`: one per changed path, and nothing
 * for a key neither of them has. This is what keeps a save from writing a
 * schema's defaults into every file it touches — a value the user did not set
 * is a value that was never in the file, and it stays that way.
 */
export function editsBetween(before, after, path = []) {
  const edits = [];
  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  if (Array.isArray(before) || Array.isArray(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) edits.push({ path, value: after });
    return edits;
  }
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(key in after)) {
        edits.push({ path: [...path, key], value: undefined });
        continue;
      }
      if (!(key in before)) {
        edits.push({ path: [...path, key], value: after[key] });
        continue;
      }
      edits.push(...editsBetween(before[key], after[key], [...path, key]));
    }
    return edits;
  }
  if (before !== after) edits.push({ path, value: after });
  return edits;
}

export { labelize };
