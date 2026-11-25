import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
// This is a conservative literal-reference scan, not proof that dynamic code or
// an external consumer never uses a URL. Only reviewed uploads can be removed.
export async function referencedAssets(root: string, files: readonly string[]) {
  const referenced = new Set<string>();
  const queue = ['src', 'public'];
  const textFiles: string[] = [];
  const text = /\.(astro|[cm]?[jt]sx?|vue|svelte|json|mdx?|css|scss|sass|less|html?|svg|xml|txt|ya?ml|webmanifest)$/i;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && text.test(entry.name)) {
      textFiles.push(entry.name);
    }
  }
  for (let index = 0; index < queue.length; index++) {
    if (index >= 1000) {
      throw new Error('Reference scan incomplete: too many directories');
    }
    const directory = queue[index];
    if (!directory) {
      continue;
    }
    for (const entry of await entriesIn(path.join(root, directory))) {
      const relative = directory + '/' + entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error('Reference scan cannot follow symbolic links');
      }
      if (entry.isDirectory()) {
        queue.push(relative);
      } else if (entry.isFile() && text.test(entry.name)) {
        textFiles.push(relative);
      }
      if (textFiles.length > 10_000) {
        throw new Error('Reference scan incomplete: too many files');
      }
    }
  }
  let bytes = 0;
  const names = files.map((file) => ({ file, name: path.basename(file).toLowerCase() }));
  for (const file of textFiles) {
    const filename = path.join(root, file);
    const info = await lstat(filename);
    bytes += info.size;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4_000_000 || bytes > 50_000_000) {
      throw new Error('Reference scan incomplete: source is too large or linked');
    }
    let source = (await readFile(filename, 'utf8')).toLowerCase();
    // Match percent-encoded spaces and JSON/JS character escapes as well.
    source = source.replace(/\\u([\da-f]{4})|\\x([\da-f]{2})/g, (_match, unicode: string | undefined, hex: string | undefined) =>
      String.fromCharCode(parseInt(unicode ?? hex ?? '', 16)),
    );
    for (const { file: asset, name } of names) {
      if (source.includes(name) || source.includes(encodeURIComponent(name).toLowerCase())) {
        referenced.add(asset);
      }
    }
  }
  return referenced;
}
async function entriesIn(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
