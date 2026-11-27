// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/publish.json`: where and how the project publishes (GitHub, hosting, build script, hooks).
// It holds identifiers only (account, project and organisation ids, a GitHub username, a public site URL). Tokens and credentials are
// never stored here: the parser refuses a githubAccount that is not a username, and no key of this file carries a secret, so nothing
// is listed as unsettable. Credentials live outside the project.
import { PUBLISH_LIMITS, parsePublishConfig, type PublishConfig } from '../../publishConfig';
import { arrayOf, field, literal, objectOf, oneOf, text, variantOf, type FileSchema } from '../stackiSchema';

// The parser's own patterns (shared/properties/publishConfig.ts), restated so a registry check refuses what the parser refuses.
const IDENTIFIER = '^[a-zA-Z0-9][a-zA-Z0-9_:.-]*$';
const BRANCH = '^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,99}$';
// A relative folder: segments of letters, digits, _ . - joined by /, none of them . or .. .
const DIRECTORY = '^(?!(?:.*/)?\\.{1,2}(?:/|$))[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_.-]+)*$';
const GITHUB_USERNAME = '^(?:[a-zA-Z0-9][a-zA-Z0-9-]{0,38})?$';
// A canonical https origin with a domain: no port, path, query or credentials.
const SITE_ORIGIN = '^https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$';
// The parser bounds a build output folder at 256 characters and a published URL at 2048; neither number is exported.
// No slashes or control characters, so a link never passes as a name.
const HOST_NAME = '^[^/\\\\\\p{Cc}]+$';
const DIRECTORY_CHARS_MAX = 256;
const SITE_URL_CHARS_MAX = 2_048;

const identifier = text(PUBLISH_LIMITS.identifierCharsMax, { charsMin: 1, pattern: IDENTIFIER });

const cloudflarePages = {
  accountId: field(identifier, 'The Cloudflare account id.', { required: true }),
  project: field(identifier, 'The Cloudflare Pages project name.', { required: true }),
  branch: field(text(PUBLISH_LIMITS.identifierCharsMax, { charsMin: 1, pattern: BRANCH }), 'The production branch.', { required: true }),
  directory: field(text(DIRECTORY_CHARS_MAX, { charsMin: 1, pattern: DIRECTORY }), 'The build output folder, relative to the project, such as dist.', {
    required: true,
  }),
};
const cloudflareWorkers = {
  accountId: field(identifier, 'The Cloudflare account id.', { required: true }),
  project: field(identifier, 'The Cloudflare Workers project name.', { required: true }),
};
const vercel = {
  organizationId: field(identifier, 'The Vercel team or account id.', { required: true }),
  projectId: field(identifier, 'The Vercel project id.', { required: true }),
};

const netlify = {
  siteId: field(identifier, 'The Netlify site (project) id.', { required: true }),
};

const customDetails = {
  hostName: field(text(PUBLISH_LIMITS.hostNameCharsMax, { charsMin: 1, pattern: HOST_NAME }), 'What the host is called, shown in the Publish menu.'),
  siteUrl: field(text(SITE_URL_CHARS_MAX, { charsMin: 1, pattern: SITE_ORIGIN }), 'The public address: a canonical https origin.'),
};

export const PUBLISH_FILE: FileSchema = {
  id: 'publish',
  file: '.stacki/publish.json',
  description:
    'Publishing settings: GitHub account, hosting destination, build script, publish hooks and the published site address. Identifiers only, never credentials.',
  requires: 'publish',
  metadataKind: 'publish',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    defaultTarget: field(oneOf('all', 'github', 'hosting'), 'What Publish does by default.', { default: 'all' }),
    githubAccount: field(
      text(PUBLISH_LIMITS.identifierCharsMax, { pattern: GITHUB_USERNAME }),
      'The GitHub username to publish with, or empty for the signed-in one. A username, never a token or email.',
      {
        required: true,
        default: '',
      },
    ),
    hosting: field(
      variantOf('provider', { none: {}, cloudflare: cloudflarePages, 'cloudflare-workers': cloudflareWorkers, vercel, netlify }),
      'The hosting destination, by provider.',
      { required: true, default: 'none' },
    ),
    customHosting: field(
      variantOf('deploy', {
        github: customDetails,
        script: {
          script: field(identifier, 'The package.json script that deploys, a name and never a command.', { required: true }),
          ...customDetails,
        },
        link: customDetails,
      }),
      'A host Stacki has no integration for; hosting must stay none. github: the host deploys from GitHub. script: Stacki builds, then runs a script. link: Stacki sends a request to a deploy link, which each person adds in the app and which is never stored in this file.',
      { default: 'none' },
    ),
    buildScript: field(identifier, 'The package.json script that builds the site, a name and never a command.', { required: true, default: 'build' }),
    beforePublish: field(arrayOf(identifier, PUBLISH_LIMITS.hooksMax), 'package.json script names run before publishing, in order.', {
      required: true,
      default: 'none',
    }),
    afterPublish: field(arrayOf(identifier, PUBLISH_LIMITS.hooksMax), 'package.json script names run after publishing, in order.', {
      required: true,
      default: 'none',
    }),
    githubWorkflow: field(
      objectOf({ kind: field(oneOf('direct', 'pull-request'), 'Publish straight to the branch, or open a pull request for review.', { required: true }) }),
      'How GitHub publishing lands changes.',
      { default: 'direct' },
    ),
    publishedSite: field(
      objectOf({
        hosting: field(
          variantOf('provider', { cloudflare: cloudflarePages, 'cloudflare-workers': cloudflareWorkers, vercel, netlify }),
          'The hosting destination the address belongs to; it is ignored when it no longer equals the file hosting.',
          { required: true },
        ),
        url: field(
          text(SITE_URL_CHARS_MAX, { charsMin: 1, pattern: SITE_ORIGIN }),
          'The public address: a canonical https origin with a domain, no path, port or credentials.',
          { required: true },
        ),
        source: field(oneOf('manual', 'discovered'), 'Typed by a person, or found by the app from the hosting account.', { required: true }),
      }),
      'The remembered published address of the site.',
      { default: 'none' },
    ),
  },
  empty: { version: 1, githubAccount: '', hosting: { provider: 'none' }, buildScript: 'build', beforePublish: [], afterPublish: [] },
  // The app writes the parsed config in the parser's key order; the CLI writes the same bytes. A document the parser refuses is left as
  // written so the parser's own refusal is what the caller sees.
  serialize: (document) => {
    try {
      const config: PublishConfig = parsePublishConfig(document);
      return `${JSON.stringify(config, undefined, 2)}\n`;
    } catch {
      return `${JSON.stringify(document, undefined, 2)}\n`;
    }
  },
  commands: [],
  parserSources: ['shared/properties/publishConfig.ts', 'shared/properties/publishReview.ts', 'shared/properties/publishSite.ts'],
};
