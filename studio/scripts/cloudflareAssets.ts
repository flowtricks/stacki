import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function prepareCloudflareAssets(directory: string): Promise<void> {
  // Keep maps for local debugging without exceeding Cloudflare's static asset size limit.
  await writeFile(path.join(directory, '.assetsignore'), '*.map\n');
}
