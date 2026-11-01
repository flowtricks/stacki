import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const upstream = process.argv[2];
if (!upstream) {
  throw new Error('Pass the upstream Stacki directory');
}
const vendor = path.resolve('vendor/stacki');
const result = await build({
  entryPoints: ['vendor/stacki/src/features/style/StylePanel.tsx'],
  bundle: true,
  write: false,
  metafile: true,
  outfile: 'test-results/style-audit.js',
  packages: 'external',
  platform: 'browser',
  jsx: 'automatic',
});
const compared = [];
for (const file of Object.keys(result.metafile.inputs)) {
  const absolute = path.resolve(file);
  if (!absolute.startsWith(vendor + path.sep)) {
    continue;
  }
  const relative = path.relative(vendor, absolute);
  const same = (await readFile(absolute)).equals(await readFile(path.join(upstream, relative)));
  compared.push({ file: relative, same });
}
const styleDirectory = 'src/features/style';
const upstreamFiles = await readdir(path.join(upstream, styleDirectory), { recursive: true });
const localFiles = new Set(await readdir(path.join(vendor, styleDirectory), { recursive: true }));
console.log(
  JSON.stringify(
    {
      compared: compared.length,
      identical: compared.filter((entry) => entry.same).length,
      adapted: compared.filter((entry) => !entry.same).map((entry) => entry.file),
      missingStyleFiles: upstreamFiles.filter((file) => !localFiles.has(file)),
    },
    null,
    2,
  ),
);
const adapters = new Set([
  'src/features/style/embed/useEditorFoundation.ts',
  'src/features/style/embed/useEditorScanning.ts',
  'src/features/style/model/computedStyle.ts',
  'src/features/style/model/computedColor.ts',
  'src/ipc/variableEditBridge.ts',
  'src/ipc/assetBridge.ts',
  'src/features/style/stylePanelBridge.ts',
  'src/features/style/model/webflow.ts',
  'src/ui/AssetThumb.tsx',
  'src/features/style/BackgroundLayerFields.tsx',
  'src/features/style/StylePanel.tsx',
]);
if (upstreamFiles.some((file) => !localFiles.has(file)) || compared.some((entry) => !entry.same && !adapters.has(entry.file))) {
  throw new Error('Style parity changed outside the documented browser adapters');
}
