import { stripPageExtension } from '../../lib/pageName';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';

// Route punctuation carries Astro semantics. Reject invalid filesystem segments
// instead of silently changing a dynamic route into a different, static URL.
export function routeName(text: string): string | undefined {
  const name = text.trim();
  if (name.length === 0 || name.length > BOUNDARY_LIMITS.pathLengthMax) {
    return undefined;
  }
  if (name === '.' || name === '..' || /[\\/<>:"|?*\u0000-\u001f]/u.test(name)) {
    return undefined;
  }
  return name;
}

export function pageRenameBase(original: string, text: string): string | undefined {
  const base = routeName(stripPageExtension(text.trim()));
  return base === stripPageExtension(original) ? undefined : base;
}
