const slashPath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');

export function projectRelativePath(projectPath: string, filePath: string, platform: NodeJS.Platform): string {
  const root = slashPath(projectPath);
  const file = slashPath(filePath);
  const comparable = (value: string): string => (platform === 'win32' ? value.toLocaleLowerCase('en-US') : value);
  const rootComparable = comparable(root);
  const fileComparable = comparable(file);
  if (fileComparable === rootComparable) {
    return '';
  }
  const prefix = `${rootComparable}/`;
  return fileComparable.startsWith(prefix) ? file.slice(root.length + 1) : file;
}
