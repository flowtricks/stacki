import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { record, text } from '../../shared/core/boundary';
import type { PublishCommand } from '../../shared/properties/publishCommands';
import type { PackageManager } from '../../shared/properties/packageManager';

export function projectHasWrangler(root: string): boolean {
  const resolver = createRequire(path.join(root, 'package.json'));
  try {
    // Resolution from the site also supports dependencies hoisted by a workspace package manager.
    // Node caches resolved paths for the life of the process, so a Wrangler removed since the
    // last lookup still resolves; only a manifest that exists now counts.
    return existsSync(resolver.resolve('wrangler/package.json'));
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
      return false;
    }
    throw error;
  }
}

// A publish command, or a package manager installing a publishing tool.
export interface ExecutableCommand extends Omit<PublishCommand, 'executable'> {
  readonly executable: PublishCommand['executable'] | PackageManager;
}

export function resolvePublishExecutable(
  root: string,
  command: ExecutableCommand,
): {
  readonly executable: string;
  readonly arguments: readonly string[];
} {
  const local = path.join(root, 'node_modules', '.bin', command.executable);
  if (process.platform !== 'win32' && existsSync(local)) {
    return { executable: local, arguments: command.arguments };
  }
  const installed = installedPublishTool(root, command.executable);
  if (installed) {
    return {
      executable: process.platform === 'win32' ? 'node.exe' : 'node',
      arguments: [installed, ...command.arguments],
    };
  }
  if (process.platform !== 'win32') {
    return {
      executable: existsSync(local) ? local : command.executable,
      arguments: command.arguments,
    };
  }
  // Running the JS entry avoids cmd.exe interpolation of paths, arguments, and credentials.
  const directories = (process.env['PATH'] ?? process.env['Path'] ?? '').split(path.delimiter);
  if (directories.length > 256) {
    throw new Error('Tool search path exceeds 256 directories.');
  }
  const candidates = [
    path.join(root, 'node_modules', command.executable),
    ...directories.map((directory) => path.join(directory, 'node_modules', command.executable)),
  ];
  for (const directory of candidates) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) {
      return { executable: 'node.exe', arguments: [publishEntry(directory), ...command.arguments] };
    }
  }
  throw new Error(`Install ${command.executable} in this project's development dependencies.`);
}

function publishEntry(directory: string): string {
  const source = readFileSync(path.join(directory, 'package.json'), 'utf8');
  if (source.length > 65_536) {
    throw new Error('CLI package metadata exceeds 64 KiB.');
  }
  const input: unknown = JSON.parse(source);
  const metadata = record(input);
  const bin = metadata['bin'];
  const relative = text(typeof bin === 'string' ? bin : record(bin)[path.basename(directory)]);
  const canonical = realpathSync(directory);
  const entry = realpathSync(path.join(directory, relative));
  const within = path.relative(canonical, entry);
  if (path.isAbsolute(within) || within.startsWith('..')) {
    throw new Error('CLI entry must stay inside its installed package.');
  }
  return entry;
}

function installedPublishTool(root: string, executable: string): string | undefined {
  if (executable !== 'wrangler' && executable !== 'vercel') {
    return undefined;
  }
  // Desktop and Studio can share an installed CLI without downloading code during discovery.
  const resolver = createRequire(path.join(process.cwd(), 'package.json'));
  const directories = [
    root,
    process.cwd(),
    path.join(process.cwd(), 'studio'),
    path.dirname(process.argv[1] ?? process.cwd()),
  ];
  for (const directory of directories) {
    let manifest: string;
    try {
      manifest = resolver.resolve(`${executable}/package.json`, { paths: [directory] });
    } catch {
      continue;
    }
    // A cached resolution can outlive a removed package; look further instead.
    if (!existsSync(manifest)) {
      continue;
    }
    return publishEntry(path.dirname(manifest));
  }
  return undefined;
}
