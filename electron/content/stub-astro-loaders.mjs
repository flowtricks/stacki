// Stands in for `astro/loaders`. A loader is the difference between a
// collection you can edit and one you can only look at, so what matters is
// which one was used and with what arguments — never running it.
//
// glob() and file() come back as tagged descriptions. Anything else the config
// uses is somebody's own loader: it returns an object with a load() function,
// carries no tag, and the collection it belongs to is read-only, because its
// entries are regenerated from an API, a directory scan or a script on the
// next sync.
export const LOADER = Symbol.for('stacki.astro.loader');

const asPath = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  // base can be a file: URL
  try {
    return value instanceof URL ? value.pathname : String(value);
  } catch {
    return String(value);
  }
};

export function glob(options = {}) {
  return {
    name: 'glob',
    load: () => {},
    [LOADER]: {
      kind: 'glob',
      pattern: options.pattern,
      base: asPath(options.base) || '.',
      // A generateId means the id is not the file path, so renaming the file
      // does not rename the entry (and editing some field might).
      generateId: typeof options.generateId === 'function',
    },
  };
}

export function file(fileName, options = {}) {
  return {
    name: 'file',
    load: () => {},
    [LOADER]: {
      kind: 'file',
      file: asPath(fileName),
      // A parser reshapes the file before Astro ever sees it, so what an entry
      // holds is not what the file holds, and writing back means reversing it.
      parser: typeof options?.parser === 'function',
    },
  };
}
