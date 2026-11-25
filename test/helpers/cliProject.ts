// Generated fixture projects for the Stacki CLI suites: a temporary Astro project, never a real one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created: string[] = [];

/** A new temporary project with an Astro config, one component, and the given files (project-relative path to text). */
export function makeProject(files: Readonly<Record<string, string>> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-cli-')));
  created.push(root);
  const base: Record<string, string> = { 'astro.config.mjs': 'export default {};\n', 'src/components/Card.astro': '<div>card</div>\n' };
  for (const [relative, text] of Object.entries({ ...base, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  return root;
}

export function readText(root: string, relative: string): string | undefined {
  const file = path.join(root, relative);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

/** A roles file: the admin `owner`, an `editor` who may edit guides, and a `viewer` who may only read. */
export const ROLES_FIXTURE = `${JSON.stringify(
  {
    version: 1,
    defaultRole: 'viewer',
    roles: [
      { id: 'admin', name: 'Admin', members: ['owner'] },
      { id: 'editor', name: 'Editor', members: ['ed'], access: ['cli:read', 'cli:guides', 'settings:editor'] },
      { id: 'viewer', name: 'Viewer', members: [], access: ['cli:read'] },
    ],
  },
  undefined,
  2,
)}\n`;

export function removeProjects(): void {
  for (const root of created.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
