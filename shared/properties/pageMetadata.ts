// Rendered social metadata is the source of truth when layouts delegate their
// defaults to another component or to a CMS. Never evaluate project code here.
import { pathText } from '../core/boundary';

export function parsePageType(input: unknown): string {
  const value = pathText(input);
  if (!/^[a-z][a-z0-9._:-]{0,127}$/i.test(value)) {
    throw new Error('Invalid Open Graph type');
  }
  return value;
}

export function parsePageImage(input: unknown): string {
  const value = pathText(input);
  if (/^\/(?!\/)/.test(value)) {
    if (!value.includes('\\')) {
      return value;
    }
  }
  const url = new URL(value);
  if (url.protocol !== 'http:') {
    if (url.protocol !== 'https:') {
      throw new Error('Page image must use HTTP or HTTPS');
    }
  }
  if (url.username || url.password) {
    throw new Error('Page image must not contain credentials');
  }
  return url.href;
}
