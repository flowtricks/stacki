import path from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Desktop's merge engine writes only into the validated, isolated merge checkout.
export function writeProjectText(file: string, source: string): void {
  assert(
    file.split(path.sep).join('/').includes('/.stacki/studio/state/merge-'),
    'Merge writes stay in their isolated checkout',
  );
  assert(source.length <= 8_000_000, 'Merge source is bounded');
  writeFileSync(file, source, 'utf8');
}
