import path from 'node:path';

type Platform = NodeJS.Platform;
type Environment = Readonly<Record<string, string | undefined>>;

const pathAPI = (platform: Platform): typeof path.win32 => (platform === 'win32' ? path.win32 : path.posix);

export function comparablePath(value: string, platform: Platform = process.platform): string {
  const resolved = pathAPI(platform).resolve(value);
  return platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

export function sameFilesystemPath(first: string, second: string, platform: Platform = process.platform): boolean {
  return comparablePath(first, platform) === comparablePath(second, platform);
}

export function isPathWithin(root: string, candidate: string, platform: Platform = process.platform): boolean {
  const api = pathAPI(platform);
  const rootPath = comparablePath(root, platform);
  const candidatePath = comparablePath(candidate, platform);
  const relative = api.relative(rootPath, candidatePath);
  const isOutside = relative.startsWith(`..${api.sep}`) || relative === '..' || api.isAbsolute(relative);
  return relative === '' || !isOutside;
}

export function isPathDescendant(root: string, candidate: string, platform: Platform = process.platform): boolean {
  return !sameFilesystemPath(root, candidate, platform) && isPathWithin(root, candidate, platform);
}

function pathEnvironmentKey(environment: Environment, platform: Platform): string {
  if (platform !== 'win32') {
    return 'PATH';
  }
  return Object.keys(environment).find((key) => key.toLocaleLowerCase('en-US') === 'path') ?? 'Path'; // i18n-ignore: an environment variable name.
}

export function pathEnvironmentValue(environment: Environment, platform: Platform = process.platform): string {
  return environment[pathEnvironmentKey(environment, platform)] ?? '';
}

// Writes in place: `process.env` is the record child processes inherit, so a
// copy would change nothing they see.
export function setPathEnvironment(environment: Record<string, string | undefined>, value: string, platform: Platform = process.platform): void {
  // eslint-disable-next-line no-param-reassign -- process.env is written in place, by design.
  environment[pathEnvironmentKey(environment, platform)] = value;
}

export function mergeToolPaths(current: string, candidates: readonly string[], platform: Platform = process.platform): string {
  const delimiter = platform === 'win32' ? ';' : ':';
  const parts = current.split(delimiter).filter(Boolean);
  const comparable = (value: string): string => (platform === 'win32' ? value.toLocaleLowerCase('en-US') : value);
  const seen = new Set(parts.map(comparable));
  for (const candidate of candidates) {
    const key = comparable(candidate);
    if (candidate && !seen.has(key)) {
      seen.add(key);
      parts.push(candidate);
    }
  }
  return parts.join(delimiter);
}

export function commandNeedsShell(command: string, platform: Platform = process.platform): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
}

export function staticToolPathGuesses(home: string, environment: Environment, platform: Platform = process.platform): readonly string[] {
  if (platform !== 'win32') {
    return [];
  }
  const api = path.win32;
  const local = environment['LOCALAPPDATA'] ?? api.join(home, 'AppData', 'Local');
  const roaming = environment['APPDATA'] ?? api.join(home, 'AppData', 'Roaming');
  const programFiles = environment['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = environment['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const chocolatey = environment['ChocolateyInstall'] ?? 'C:\\ProgramData\\chocolatey';
  return [
    environment['NVM_SYMLINK'] ?? '',
    environment['PNPM_HOME'] ?? '',
    environment['FNM_DIR'] ?? '',
    environment['BUN_INSTALL'] ? api.join(environment['BUN_INSTALL'], 'bin') : '',
    api.join(programFiles, 'nodejs'),
    api.join(programFilesX86, 'nodejs'),
    api.join(programFiles, 'Git', 'cmd'),
    api.join(roaming, 'npm'),
    api.join(local, 'Volta', 'bin'),
    api.join(local, 'Programs', 'Git', 'cmd'),
    api.join(local, 'Microsoft', 'WinGet', 'Links'),
    api.join(home, '.bun', 'bin'),
    api.join(home, 'scoop', 'shims'),
    api.join(chocolatey, 'bin'),
  ].filter(Boolean);
}
