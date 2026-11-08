import { assert } from '../../../vendor/stacki/shared/core/assert';
import { forwardsRest, parseSlots, rootTag, defaultSlotInline } from '../../../vendor/stacki/electron/parse/astroComponentApi';
import { componentSchema } from '../components/componentSchema';
import { numericStyleBindings } from '../preview/numericStyleBindings';

const ENTRIES_MAX = 128;
const BYTES_MAX = 16_000_000;
const DEPENDENCIES_MAX = 100;
type Analysis = Awaited<ReturnType<typeof analyzeComponent>>;
interface Entry {
  readonly source: string;
  readonly dependencies: ReadonlyMap<string, string | undefined>;
  readonly value: Analysis;
  readonly bytes: number;
}

// Reuse parsing, never filesystem freshness: every source and imported declaration
// is read again before reuse. Missing import candidates are dependencies too.
export class ComponentAnalysis {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  async read(file: string, source: string, read: (file: string) => Promise<string>) {
    const previous = this.entries.get(file);
    if (previous?.source === source && (await dependenciesMatch(previous.dependencies, read))) {
      return previous.value;
    }
    const dependencies = new Map<string, string | undefined>();
    let reusable = true;
    const value = await analyzeComponent(file, source, async (candidate) => {
      const text = await readOptional(candidate, read);
      if (dependencies.size < DEPENDENCIES_MAX) {
        dependencies.set(candidate, text);
      } else {
        reusable = false;
      }
      if (text === undefined) {
        throw Object.assign(new Error('Component declaration not found'), { code: 'ENOENT' });
      }
      return text;
    });
    this.remove(file);
    const bytes = 2 * (source.length + JSON.stringify(value).length + [...dependencies.values()].reduce((total, text) => total + (text?.length ?? 0), 0));
    if (reusable && bytes <= BYTES_MAX) {
      this.store(file, { source, dependencies, value, bytes });
    }
    return value;
  }

  private remove(file: string) {
    this.bytes -= this.entries.get(file)?.bytes ?? 0;
    this.entries.delete(file);
    assert(this.bytes >= 0, 'Component cache accounting stays nonnegative');
  }

  private store(file: string, entry: Entry) {
    assert(entry.bytes <= BYTES_MAX, 'One component fits the cache budget');
    for (const oldest of this.entries.keys()) {
      if (this.entries.size < ENTRIES_MAX && this.bytes + entry.bytes <= BYTES_MAX) {
        break;
      }
      this.remove(oldest);
    }
    this.entries.set(file, entry);
    this.bytes += entry.bytes;
    assert(this.entries.size <= ENTRIES_MAX, 'Component cache count stays bounded');
    assert(this.bytes <= BYTES_MAX, 'Component cache content stays within its memory budget');
  }
}

async function dependenciesMatch(dependencies: ReadonlyMap<string, string | undefined>, read: (file: string) => Promise<string>): Promise<boolean> {
  for (const [file, source] of dependencies) {
    if ((await readOptional(file, read)) !== source) {
      return false;
    }
  }
  return true;
}

async function readOptional(file: string, read: (file: string) => Promise<string>) {
  try {
    return await read(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function analyzeComponent(file: string, source: string, read: (file: string) => Promise<string>) {
  const renderTag = rootTag(source);
  return {
    fields: await componentSchema(file, source, read),
    slots: parseSlots(source),
    numericStyles: numericStyleBindings(source),
    slotText: defaultSlotInline(source),
    // A `...rest` spread on Astro.props: its instances take free-form attributes,
    // as Desktop's scan reads it (electron/properties/propDefaults.ts).
    hasRest: forwardsRest(source),
    ...(renderTag === undefined ? {} : { renderTag }),
  };
}
