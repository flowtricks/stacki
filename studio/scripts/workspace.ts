import { access, lstat, readdir, realpath, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function writeStudioConfig(root: string, packageRoot: string, port: number, dependencyRoot?: string) {
  const files = await readdir(root);
  const configuration = files.find((file) => /^astro\.config\.(ts|mts|cts|js|mjs|cjs)$/.test(file));
  const integration = pathToFileURL(path.join(packageRoot, 'dist/integration.mjs')).href;
  const hosts = [process.env['STUDIO_PARENT_ORIGIN'], process.env['STUDIO_PREVIEW_ORIGIN']]
    .filter((value): value is string => !!value)
    .map((value) => new URL(value).hostname);
  const vite = dependencyRoot === undefined ? '' : draftViteConfig(dependencyRoot);
  const content = `${configuration ? `import config from './${configuration}';` : 'const config = {};'}
import studio from ${JSON.stringify(integration)};
export default { ...config, ${hosts.length ? `server: { ...config.server, allowedHosts: ${JSON.stringify(hosts)} },` : ''} ${vite} devToolbar: { enabled: false }, integrations: [...(config.integrations ?? []), studio(${JSON.stringify({ root, assets: path.join(packageRoot, 'dist'), port })})] };
`;
  await writeFile(path.join(root, 'astro.studio.config.ts'), content);
}

export async function draftDependencyRoot(workspace: string, source: string): Promise<string | undefined> {
  const draftModules = path.join(workspace, 'node_modules');
  try {
    if (!(await lstat(draftModules)).isSymbolicLink()) {
      return undefined;
    }
    // Only the project's own dependency directory can be admitted, including on a reopened draft.
    const sourceModules = path.join(await realpath(source), 'node_modules');
    if (!(await lstat(sourceModules)).isDirectory()) {
      return undefined;
    }
    return (await realpath(draftModules)) === sourceModules ? sourceModules : undefined;
  } catch (error: unknown) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function draftViteConfig(dependencyRoot: string): string {
  // Astro's islands request canonical module URLs. Add their directory after Vite resolves its
  // allow list so a site's explicit list or Vite's detected workspace root remains in effect.
  const vitePath = dependencyRoot.split(path.sep).join('/');
  return `vite: { ...config.vite, plugins: [...(config.vite?.plugins ?? []), {
    name: 'studio-draft-dependencies',
    apply: 'serve',
    configResolved({ server }) {
      const dependencyRoot = ${JSON.stringify(vitePath)};
      if (!server.fs.allow.includes(dependencyRoot)) {
        server.fs.allow.push(dependencyRoot);
      }
    },
  }] },`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
