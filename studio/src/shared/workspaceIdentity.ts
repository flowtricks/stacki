import { string } from './primitiveValidation';

// Keep IDs separate from file paths so replacing a site cannot replay its old offline edits.
export function parseWorkspaceId(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const identifier = string(input, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(identifier)) {
    throw new Error('Invalid Studio workspace ID');
  }
  return identifier;
}

export function documentStorageName(origin: string, file: string, workspaceId?: string): string {
  const identifier = parseWorkspaceId(workspaceId);
  // Preserve existing keys for sites that have never configured a workspace identity.
  const scope = identifier === undefined ? '' : identifier + ':';
  return 'astro-studio:' + origin + ':' + scope + file;
}
