// Studio promises that it sends no usage tracking. This check holds that promise
// where a machine can: what the bundle may contain, and that every launch point
// switches off the third-party tools' own reporting. It is pure so the tests can
// drive each failure with fixtures; noTrackingTree.ts reads the real tree.
//
// Patterns match URLs, senders, package specifiers and SDK entry points, never bare
// words: `segment` and `amplitude` are everyday identifiers, and the shared parsers
// legitimately carry the inert `usageCountsEnabled` preference field.
import { assert } from '../vendor/stacki/shared/core/assert';

export const NO_TRACKING_FILES_MAX = 20_000;
export const NO_TRACKING_SOURCE = 'scripts/noTracking.ts'; // It names what it forbids, so it cannot scan itself.

export interface TextFile {
  readonly path: string;
  readonly content: string;
}

export interface LaunchPoints {
  readonly containerScript: string;
  readonly desktopStudioLaunch: string;
  readonly devScript: string;
  readonly dockerfile: string;
  readonly telemetrySource: string;
}

export interface NoTrackingInput {
  /** The built output; undefined when this tree has no build. */
  readonly distribution: readonly TextFile[] | undefined;
  readonly launchPoints: LaunchPoints;
  readonly sharedSource: unknown;
  readonly source: readonly TextFile[];
}

const SHARED_SOURCE_FORBIDDEN = ['electron/app/autoUpdate.ts', 'electron/app/usageCounts.ts'] as const;
const SHARED_SOURCE_PREFIX_FORBIDDEN = 'services/';

const TRACKING_MARKERS = [
  { label: "Stacki's usage counter URL", pattern: /stacki-usage-counts/ },
  { label: "Stacki's usage counter sender", pattern: /\b(?:sendUsageCount|USAGE_COUNTS_URL)\b/ },
  { label: 'a sendBeacon call', pattern: /\bsendBeacon\b/ },
  { label: 'electron-updater', pattern: /electron-updater/ },
  {
    label: 'an analytics package',
    pattern:
      /['"`](?:node_modules\/)?(?:@amplitude\/[\w.-]+|@posthog\/[\w.-]+|@segment\/[\w.-]+|@sentry\/[\w.-]+|amplitude-js|analytics-node|ga-gtag|mixpanel|mixpanel-browser|plausible-tracker|posthog-js|posthog-node|react-ga|react-ga4)(?:\/[\w./-]*)?['"`]/,
  },
  {
    label: 'an analytics host',
    pattern: /\b(?:amplitude\.com|google-analytics\.com|googletagmanager\.com|mixpanel\.com|plausible\.io|posthog\.com|segment\.com|segment\.io|sentry\.io)\b/,
  },
  // Bundling erases package names, so built output is also matched on SDK entry points.
  { label: 'an analytics SDK call', pattern: /\bgtag\(|__SENTRY__|\b(?:amplitude|mixpanel|posthog|Sentry)\.init\(/ },
] as const;

// Every literal external host in the browser bundles, each with why it is there. A literal
// host is not a request: most below are never contacted. New entries need the same review.
const CLIENT_HOSTS_ALLOWED: Readonly<Record<string, string>> = {
  'aka.ms': "Links in the TypeScript compiler's diagnostic text.",
  'avatars.githubusercontent.com': "Signed-in collaborators' GitHub profile pictures.",
  'cms.example.com': 'Placeholder text in the CMS connection form.',
  'creativecommons.org': 'A licence notice on bundled icons.',
  'dash.bunny.net': "Opens Bunny's dashboard for the user to copy an API key; Studio never fetches it.",
  'dash.cloudflare.com': 'Validates Cloudflare sign-in links; Studio never fetches it.',
  'developer.mozilla.org': "A link in the TypeScript compiler's diagnostic text.",
  'evilmartians.com': "A link in PostCSS's deprecation warning.",
  'example.com': 'Placeholder text in link fields.',
  'fast.wistia.com': 'oEmbed endpoint, fetched only to preview a linked Wistia video.',
  'github.com': 'Repository links and sign-in, plus links in bundled diagnostic text.',
  'mths.be': 'A licence notice on the bundled cssesc package.',
  'reactjs.org': "React's error decoder link, shown only in error text.",
  'vimeo.com': 'oEmbed endpoint, fetched only to preview a linked Vimeo video.',
  'www.apache.org': 'A licence notice on bundled TypeScript code.',
  'www.dailymotion.com': 'oEmbed endpoint, fetched only to preview a linked Dailymotion video.',
  'www.loom.com': 'oEmbed endpoint, fetched only to preview a linked Loom video.',
  'www.smashingmagazine.com': 'A reference link in an accessibility warning.',
  'www.w3.org': 'XML and SVG namespace identifiers, never fetched.',
  'www.w3ctech.com': "A link in PostCSS's deprecation warning.",
  'www.youtube.com': 'oEmbed endpoint, fetched only to preview a linked YouTube video.',
};

// What runs in the browser. Server bundles legitimately hold provider API hosts.
const CLIENT_FILES = ['dist/index.html', 'dist/morph.js', 'dist/preview.js', 'dist/studio.css', 'dist/studio.js'] as const;

// Literal hosts only: a URL assembled at runtime cannot be seen here, and the markers above
// are what catch a bundled SDK. Hosts without a dot, such as localhost, are not external.
const LITERAL_HOST = /\b(?:https?|wss?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

// Mirrors STUDIO_TELEMETRY_DISABLED on purpose: removing an entry there must fail here.
const TELEMETRY_SETTINGS = [
  { name: 'ASTRO_TELEMETRY_DISABLED', value: '1' },
  { name: 'VERCEL_TELEMETRY_DISABLED', value: '1' },
  { name: 'WRANGLER_SEND_METRICS', value: 'false' },
] as const;
const LAUNCH_ENVIRONMENT = 'env: withStudioTelemetryDisabled(process.env)';
const LAUNCH_ENVIRONMENT_FORBIDDEN = 'env: process.env';

/** Every way this tree could carry tracking; an empty list passes. */
export function findTrackingFailures(input: NoTrackingInput): readonly string[] {
  assert(input.source.length > 0, 'The no-tracking check needs source files');
  assert(input.source.length <= NO_TRACKING_FILES_MAX, 'The no-tracking source scan stays bounded');
  const distribution = input.distribution ?? [];
  assert(distribution.length <= NO_TRACKING_FILES_MAX, 'The no-tracking build scan stays bounded');
  return [
    ...sharedSourceFailures(input.sharedSource),
    ...input.source.flatMap(markerFailures),
    ...distribution.flatMap(markerFailures),
    ...(input.distribution === undefined ? [] : clientHostFailures(input.distribution)),
    ...launchPointFailures(input.launchPoints),
  ];
}

function sharedSourceFailures(input: unknown): readonly string[] {
  const listed = sharedSourcePaths(input);
  if (listed === undefined) {
    return ['shared-source.json: expected files and adapters lists, and imports and modules maps.'];
  }
  const failures: string[] = [];
  for (const file of listed) {
    if (file.startsWith(SHARED_SOURCE_PREFIX_FORBIDDEN)) {
      failures.push(`shared-source.json: ${file} is under services/, which holds Desktop's usage counter.`);
    } else if (SHARED_SOURCE_FORBIDDEN.some((forbidden) => forbidden === file)) {
      failures.push(`shared-source.json: ${file} is Desktop-only and must not ship in Studio.`);
    }
  }
  return failures;
}

function sharedSourcePaths(input: unknown): readonly string[] | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const { adapters, files, imports, modules } = input;
  if (!isStringList(files)) {
    return undefined;
  }
  if (!isStringList(adapters)) {
    return undefined;
  }
  if (!isRecord(imports)) {
    return undefined;
  }
  if (!isRecord(modules)) {
    return undefined;
  }
  return [...files, ...adapters, ...Object.keys(imports), ...Object.keys(modules)];
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isStringList(input: unknown): input is readonly string[] {
  return Array.isArray(input) && input.every((value) => typeof value === 'string');
}

function markerFailures(file: TextFile): readonly string[] {
  assert(file.path.length > 0, 'Scanned files are named');
  if (file.path === NO_TRACKING_SOURCE) {
    return [];
  }
  return TRACKING_MARKERS.filter((marker) => marker.pattern.test(file.content)).map((marker) => `${file.path}: contains ${marker.label}.`);
}

function clientHostFailures(files: readonly TextFile[]): readonly string[] {
  const failures: string[] = [];
  for (const client of CLIENT_FILES) {
    const file = files.find((candidate) => candidate.path === client);
    if (file === undefined) {
      failures.push(`${client}: missing from the build, so its external hosts cannot be checked.`);
    } else {
      failures.push(...unreviewedHosts(file).map((host) => `${client}: names external host ${host}, which is not in the reviewed allowlist.`));
    }
  }
  return failures;
}

function unreviewedHosts(file: TextFile): readonly string[] {
  const hosts = new Set<string>();
  for (const match of file.content.matchAll(LITERAL_HOST)) {
    const host = match[1];
    assert(host !== undefined, 'A literal host match captures the host');
    hosts.add(host.toLowerCase());
  }
  return [...hosts].filter((host) => !Object.hasOwn(CLIENT_HOSTS_ALLOWED, host)).sort();
}

function launchPointFailures(points: LaunchPoints): readonly string[] {
  const failures = [
    ...spawnFailures('scripts/dev.ts', points.devScript),
    ...spawnFailures('scripts/container.ts', points.containerScript),
    ...spawnFailures('electron/previewServer/studioLocal.ts', points.desktopStudioLaunch),
  ];
  const lines = points.dockerfile.split('\n').map((line) => line.trim());
  for (const { name, value } of TELEMETRY_SETTINGS) {
    if (!points.telemetrySource.includes(`${name}: '${value}'`)) {
      failures.push(`shared/properties/studioTelemetry.ts: must set ${name} to ${value}.`);
    }
    if (!lines.includes(`ENV ${name}=${value}`)) {
      failures.push(`Dockerfile: must set ENV ${name}=${value}.`);
    }
  }
  return failures;
}

function spawnFailures(file: string, source: string): readonly string[] {
  assert(file.length > 0, 'Launch points are named');
  const failures: string[] = [];
  if (!source.includes(LAUNCH_ENVIRONMENT)) {
    failures.push(`${file}: must start Studio with ${LAUNCH_ENVIRONMENT}.`);
  }
  if (source.includes(LAUNCH_ENVIRONMENT_FORBIDDEN)) {
    failures.push(`${file}: ${LAUNCH_ENVIRONMENT_FORBIDDEN} would start a tool without the telemetry opt-outs.`);
  }
  return failures;
}
