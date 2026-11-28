// The name a destination's host is called by.
import type { OwnHosting } from '../../../shared/properties/publishDestinations';

// i18n-ignore: product names are never translated.
const NAMES = {
  cloudflare: 'Cloudflare',
  'cloudflare-workers': 'Cloudflare',
  vercel: 'Vercel',
  netlify: 'Netlify',
} as const satisfies Record<OwnHosting['provider'], string>;

export function hostProductName(provider: OwnHosting['provider']): string {
  return NAMES[provider];
}
