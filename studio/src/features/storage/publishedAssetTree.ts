import { MEDIA_EXT } from '../assets/assetStateTypes';
import { record, string, filePath } from '../../shared/validation';
export function publishedAssetTree(value: unknown) {
  const tree = record(value);
  const entries = tree['tree'];
  if (tree['truncated'] !== false || !Array.isArray(entries) || entries.length > 100_000) {
    throw new Error('Incomplete GitHub tree; cleanup is unavailable');
  }
  return entries.flatMap((input) => {
    const entry = record(input);
    const file = string(entry['path'], 1000);
    if (!/^(src|public)\//.test(file) || !MEDIA_EXT.test(file) || entry['type'] === 'tree') {
      return [];
    }
    if (entry['type'] !== 'blob' || !['100644', '100755'].includes(string(entry['mode'], 10))) {
      throw new Error('Linked assets prevent safe cleanup');
    }
    const sha = string(entry['sha'], 40);
    if (!/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error('Invalid published asset');
    }
    return [{ file: filePath(file), sha }];
  });
}
