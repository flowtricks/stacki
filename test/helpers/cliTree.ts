// A whole project tree as text, for byte-for-byte comparisons: every file under a root, keyed by relative path, excluding the CLI's own scratch (`.stacki/io`).
import fs from 'node:fs';
import path from 'node:path';

export function snapshotTree(root: string): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};
  const pending = [''];
  for (let visited = 0; pending.length > 0 && visited < 10_000; visited += 1) {
    const relative = pending.pop() ?? '';
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (child === '.stacki/io' || child === '.stacki') {
        // The CLI's scratch folder (locks, journal) and the folder that holds it are not part of the project's content.
        if (child === '.stacki') {
          pending.push(child);
        }
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(child);
        found[`${child}/`] = '';
      } else {
        found[child] = fs.readFileSync(path.join(root, child)).toString('base64');
      }
    }
  }
  return found;
}
