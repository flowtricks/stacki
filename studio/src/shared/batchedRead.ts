import { assert } from '../../vendor/stacki/shared/core/assert';

// Both project roots are bounded at 100,000 files by the filesystem walker.
const ITEMS_MAX = 200_000;
const READS_MAX = 8;

// Keep filesystem latency from serializing a catalog without opening every file
// simultaneously. Each callback releases source bytes before its batch completes.
export async function batchedRead<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<readonly R[]> {
  assert(items.length <= ITEMS_MAX, 'Catalog input stays within both project root limits');
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += READS_MAX) {
    const batch = await Promise.all(items.slice(offset, offset + READS_MAX).map(read));
    results.push(...batch);
  }
  assert(results.length === items.length, 'Catalog reads preserve every input in order');
  return results;
}
