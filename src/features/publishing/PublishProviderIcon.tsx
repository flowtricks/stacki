import { githubIconPath } from '../../ui/iconPaths';
import { PlugIcon } from '../../ui/Icons';
import type { Hosting } from '../../../shared/properties/publishConfig';

export function PublishProviderIcon({ provider }: { readonly provider: Hosting['provider'] | 'github' | 'custom' }) {
  if (provider === 'custom') {
    // A host Stacki has no mark for: the Central plug, "bring your own".
    return <PlugIcon size={20} />;
  }
  return (
    <svg
      className="publish-provider-icon"
      data-provider={provider}
      width={20}
      height={20}
      viewBox={provider === 'netlify' ? NETLIFY_VIEW_BOX : '0 0 24 24'}
      fill={provider.startsWith('cloudflare') ? '#f38020' : 'currentColor'}
      aria-hidden="true"
      focusable="false"
    >
      <path d={PROVIDER_PATHS[provider === 'cloudflare-workers' ? 'cloudflare' : provider === 'github' ? 'none' : provider]} />
    </svg>
  );
}

// Simple Icons (CC0): https://github.com/simple-icons/simple-icons/tree/develop/icons.
// Bundled paths keep provider marks available without an external image request.
const PROVIDER_PATHS = {
  none: githubIconPath,
  cloudflare:
    'M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.52' +
    '05l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-' +
    '.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1' +
    '.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 ' +
    '0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 ' +
    '1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 ' +
    '.1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 ' +
    '.1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 ' +
    '0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 ' +
    '1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.04' +
    '3.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.88' +
    '67-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 ' +
    '.1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 ' +
    '0-2.6025-2.125-4.727-4.7344-4.727',
  vercel: 'm12 1.608 12 20.784H0Z',
  // The one mark not from Simple Icons: the owner supplied this SVG for the Netlify option, an approved exception to
  // taking icons only from the app's icon set. Path data is as supplied; its black fill is replaced by currentColor,
  // like Vercel's mark, so it reads on dark and light surfaces.
  netlify:
    'M58.1582 73.5895L119.252 92.1555C121.315 92.7885 122.585 92.4715 123.855 91.2015L141.311 73.9055C142.898 72.4795 142.898 69.9395 141.311 68.5085L123.855 51.2125C122.585 49.9425 121.315 49.6255 119.252 50.2585L58.1582 68.8245C55.6182 69.6175 55.6182 72.7905 58.1582 73.5845V73.5895ZM47.2082 81.8425L47.0482 114.848C47.0482 118.181 47.6812 119.924 49.2682 121.51L68.7873 141.186C70.3743 142.773 72.2773 142.773 73.7073 141.186L90.5263 124.367C92.1133 122.78 92.1133 121.034 90.5263 119.447L51.3312 80.2515C49.5842 78.5045 47.2043 79.4585 47.2043 81.8385L47.2082 81.8425ZM47.2082 60.5765C47.0482 62.9565 49.5882 63.9095 51.3353 62.1635L90.5303 22.9685C92.1172 21.3815 92.1172 19.4785 90.5303 18.0485L73.7113 1.0695C72.2852 -0.3565 70.3783 -0.3565 68.7913 1.0695L49.2723 20.7445C47.6852 22.3315 47.0522 23.6015 47.0522 25.6645L47.2122 60.5765H47.2082ZM22.9292 90.4085C21.3422 91.9955 19.5962 91.9955 18.0092 90.4085L1.19025 73.5895C-0.39675 72.1635 -0.39675 70.2565 1.19025 68.6695L18.0092 51.8505C19.5962 50.2635 21.3422 50.2635 22.9292 51.8505L39.7482 68.6695C41.3353 70.2565 41.3353 72.1595 39.7482 73.5895L22.9292 90.4085Z',
} as const;

// The supplied Netlify mark is drawn on its own grid.
const NETLIFY_VIEW_BOX = '0 0 143 143';
