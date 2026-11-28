import { record, string } from '../../shared/ipc/studioValidation';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import { parseRelease, releaseVersion, RELEASE_BYTES_MAX } from '../../shared/ipc/studioRelease';

export const RELEASE_REPOSITORY = 'flowtricks/stacki-releases';
export async function boundedText(response: Response, maximum: number): Promise<string> {
  if (!response.ok || !response.body) {
    throw new Error('Stacki release request failed');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = '';
  try {
    while (bytes <= maximum) {
      const chunk = await reader.read();
      if (chunk.done) {
        return text + decoder.decode();
      }
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw new Error('Invalid release response chunk');
      }
      bytes += value.byteLength;
      if (bytes > maximum) {
        throw new Error('Stacki release response exceeds its limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    throw new Error('Stacki release response exceeds its limit');
  } finally {
    await reader.cancel();
  }
}
export async function latestRelease() {
  const response = await fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`, {
    // i18n-ignore: a package name written into the project, not interface text.
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Stacki-Studio' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    return undefined;
  }
  const value = record(JSON.parse(await boundedText(response, 1_000_000)));
  const version = releaseVersion(string(value['tag_name'], 50).replace(/^v/, ''));
  const assets = value['assets'];
  if (!Array.isArray(assets) || assets.length > 100) {
    throw new Error('Invalid release assets');
  }
  if (!assets.some((asset: unknown) => record(asset)['name'] === `stacki-studio-${version}.json`)) {
    return undefined;
  }
  return { version, url: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}` };
}
export async function downloadRelease(input: unknown) {
  const version = releaseVersion(input);
  const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}`;
  const url = `${base}/stacki-studio-${version}.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const text = await boundedText(response, RELEASE_BYTES_MAX);
  await assertPublishedDigest(version, text);
  const release = parseRelease(JSON.parse(text));
  if (release.version !== version) {
    throw new Error('Downloaded a different Studio release');
  }
  return release;
}

// GitHub records a SHA-256 digest for each release asset and reports it apart from the download itself, so a download
// damaged or swapped on its way here does not install. It cannot answer for a release changed by whoever can publish
// one: that digest changes with the file. Only a digest that differs refuses. A release GitHub reports none for (older
// uploads), or a release record that cannot be read (offline, rate limited), installs as it did before this check.
async function assertPublishedDigest(version: string, text: string): Promise<void> {
  const expected = await publishedDigest(version).catch(() => undefined);
  if (expected === undefined) {
    return;
  }
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const actual = Array.from(hashed, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) {
    throw new ReferencedError('apps.error.downloadDigestMismatch');
  }
}

async function publishedDigest(version: string): Promise<string | undefined> {
  const response = await fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/v${version}`, {
    // i18n-ignore: a package name written into the project, not interface text.
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Stacki-Studio' },
    signal: AbortSignal.timeout(15_000),
  });
  const assets = record(JSON.parse(await boundedText(response, 1_000_000)))['assets'];
  if (!Array.isArray(assets) || assets.length > 100) {
    return undefined;
  }
  const asset = assets.map((entry: unknown) => record(entry)).find((entry) => entry['name'] === `stacki-studio-${version}.json`);
  const digest = asset?.['digest'];
  return typeof digest === 'string' ? /^sha256:([a-f0-9]{64})$/.exec(digest)?.[1] : undefined;
}
