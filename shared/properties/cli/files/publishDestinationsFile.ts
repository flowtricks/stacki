// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/publish-destinations.json`: the destinations beside production (publish.json), such as staging and review
// sites. It holds names only: labels, a Wrangler environment, a branch, an alias, a host's account and project ids,
// package.json script names and a public address. A deploy link is never stored here (each person adds it in the
// app), and the parser refuses any key it does not know.
import { DESTINATION_ID_PATTERN, DESTINATION_LIMITS, parsePublishDestinations, type PublishDestinations } from '../../publishDestinations';
import { PUBLISH_LIMITS } from '../../publishConfig';
import { arrayOf, field, literal, objectOf, text, variantOf, type FileSchema } from '../stackiSchema';

const SCRIPT = '^[a-zA-Z0-9][a-zA-Z0-9_:.-]*$';
const ENVIRONMENT = '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$';
const WORKER = '^[a-z0-9][a-z0-9-]{0,62}$';
const BRANCH = '^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,99}$';
const ALIAS = '^[a-z0-9](?:[a-z0-9-]{0,35}[a-z0-9])?$';
// No slashes or control characters, so a link never passes as a name.
const NAME = '^[^/\\\\\\p{Cc}]+$';
const DIRECTORY = '^[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_.-]+)*$';
const SITE_ORIGIN = '^https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$';
const SITE_URL_CHARS_MAX = 2_048;
const DIRECTORY_CHARS_MAX = 256;

const script = text(PUBLISH_LIMITS.identifierCharsMax, { charsMin: 1, pattern: SCRIPT });
const identifier = (description: string) => field(script, description, { required: true });
const branch = field(text(DESTINATION_LIMITS.branchCharsMax, { charsMin: 1, pattern: BRANCH }), 'The destination’s branch; never a production branch.', {
  required: true,
});

const hosting = variantOf('provider', {
  cloudflare: {
    accountId: identifier('The Cloudflare account.'),
    project: identifier('A Pages project of this destination’s own.'),
    branch: field(text(DESTINATION_LIMITS.branchCharsMax, { charsMin: 1, pattern: BRANCH }), 'The project’s production branch.', { required: true }),
    directory: field(text(DIRECTORY_CHARS_MAX, { charsMin: 1, pattern: DIRECTORY }), 'The build output folder.', { required: true }),
  },
  'cloudflare-workers': {
    accountId: identifier('The Cloudflare account.'),
    project: field(text(DESTINATION_LIMITS.workerNameCharsMax, { charsMin: 1, pattern: WORKER }), 'A Worker of this destination’s own.', { required: true }),
  },
  vercel: { organizationId: identifier('The Vercel team or user.'), projectId: identifier('A Vercel project of this destination’s own.') },
  netlify: { siteId: identifier('A Netlify site of this destination’s own.') },
});

const target = variantOf('kind', {
  'cloudflare-environment': {
    environment: field(text(63, { charsMin: 1, pattern: ENVIRONMENT }), 'An env.* section of the Wrangler config.', { required: true }),
  },
  'cloudflare-worker': {
    project: field(text(DESTINATION_LIMITS.workerNameCharsMax, { charsMin: 1, pattern: WORKER }), 'A Worker other than production’s.', { required: true }),
  },
  'cloudflare-pages': { branch },
  vercel: {},
  netlify: {
    alias: field(text(DESTINATION_LIMITS.netlifyAliasCharsMax, { charsMin: 1, pattern: ALIAS }), 'The draft deploy’s alias.', { required: true }),
  },
  host: { hosting: field(hosting, 'An account and project of its own, published as that project’s live site. Never production’s.', { required: true }) },
  'github-branch': { branch },
  script: { script: field(script, 'The package.json script that deploys this destination only.', { required: true }) },
  link: { branch },
});

const destination = objectOf({
  id: field(text(DESTINATION_LIMITS.idCharsMax, { charsMin: 1, pattern: DESTINATION_ID_PATTERN }), 'A fixed identity. Renaming never changes it.', {
    required: true,
  }),
  label: field(text(DESTINATION_LIMITS.labelCharsMax, { charsMin: 1, pattern: NAME }), 'What it is called in the Publish menu. No two alike.', {
    required: true,
  }),
  name: field(text(PUBLISH_LIMITS.hostNameCharsMax, { charsMin: 1, pattern: NAME }), 'An earlier preview build’s label for `staging`.', {
    legacy: true,
  }),
  target: field(target, 'How this destination deploys, by kind. Kinds without `hosting` use production’s account and project.', { required: true }),
  buildScript: field(script, 'The package.json script that builds it, where Stacki builds.', { required: true }),
  beforePublish: field(arrayOf(script, DESTINATION_LIMITS.hooksMax), 'Scripts run before this destination only.', { required: true }),
  afterPublish: field(arrayOf(script, DESTINATION_LIMITS.hooksMax), 'Scripts run after this destination only.', { required: true }),
  siteUrl: field(text(SITE_URL_CHARS_MAX, { charsMin: 1, pattern: SITE_ORIGIN }), 'The destination’s public address: a canonical https origin.'),
});

export const PUBLISH_DESTINATIONS_FILE: FileSchema = {
  id: 'publishDestinations',
  file: '.stacki/publish-destinations.json',
  description: 'The destinations beside production, such as staging. Names only, never credentials or deploy links.',
  requires: 'publish',
  metadataKind: 'publishDestinations',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    destinations: field(arrayOf(destination, DESTINATION_LIMITS.destinationsMax), 'The destinations besides production, in menu order.', {
      required: true,
      default: 'none',
    }),
  },
  empty: { version: 1, destinations: [] },
  // As publish.json: the parser's key order, and a refused document is left for the parser to refuse.
  serialize: (document) => {
    try {
      const destinations: PublishDestinations = parsePublishDestinations(document);
      return `${JSON.stringify(destinations, undefined, 2)}\n`;
    } catch {
      return `${JSON.stringify(document, undefined, 2)}\n`;
    }
  },
  commands: [],
  parserSources: ['shared/properties/publishDestinations.ts'],
  parserKeyExceptions: {},
};
