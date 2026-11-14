// What a failed Git command said, made safe to show in the publish dialog.
//
// Why: without it every failure reads "Git fetch failed. Check repository access and
// retry.", and the cause (a promisor fetch, a rejected push, a missing ref) is only
// in stderr (issue #80). Stderr can carry credentials: the authorization header
// Studio passes through GIT_CONFIG_*, a token in a remote URL, or a header Git echoes
// under GIT_TRACE-like settings. So the tail is redacted before it leaves this module,
// and only a short last part of it is kept.
import assert from 'node:assert/strict';

export const PUBLISH_DIAGNOSTIC_LIMITS = {
  /** Stderr kept while a command runs: the end of it, where Git prints the fatal line. */
  stderrBytesKept: 4096,
  /** Characters of the redacted tail shown to the person. */
  detailCharsMax: 400,
} as const satisfies Record<string, number>;

const REDACTED = '[redacted]';

/** Keeps the last `stderrBytesKept` bytes of stderr as chunks arrive. */
export function createStderrTail() {
  let kept = Buffer.alloc(0);
  let truncated = false;
  return {
    append(chunk: Buffer): void {
      const joined = Buffer.concat([kept, chunk]);
      if (joined.length > PUBLISH_DIAGNOSTIC_LIMITS.stderrBytesKept) {
        truncated = true;
        kept = joined.subarray(joined.length - PUBLISH_DIAGNOSTIC_LIMITS.stderrBytesKept);
      } else {
        kept = joined;
      }
      assert(kept.length <= PUBLISH_DIAGNOSTIC_LIMITS.stderrBytesKept, 'The stderr tail stays within its limit');
    },
    text(): string {
      const text = kept.toString('utf8');
      // A cut window may start inside a line, possibly inside a secret that the patterns
      // below would only recognize whole; drop that partial first line.
      return truncated ? text.slice(text.indexOf('\n') + 1) : text;
    },
  };
}

/**
 * The redacted, single-line, bounded end of `stderr`, or '' when nothing is left to say.
 * `secrets` are exact values to remove wherever they appear (the installation token).
 */
export function gitDiagnosticDetail(stderr: string, secrets: readonly string[]): string {
  let text = stderr;
  for (const secret of secretForms(secrets)) {
    text = text.replaceAll(secret, REDACTED);
  }
  text = text
    // Terminal escapes and control characters, which a dialog would show as noise.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    // Header values Git or a helper may echo: Authorization, Proxy-Authorization, extraheader.
    .replace(/\b((?:proxy-)?authorization)\b\s*[:=]\s*[^\n]*/gi, `$1: ${REDACTED}`)
    .replace(/\b(extraheader)\b\s*[:=]?\s*[^\n]*/gi, `$1 ${REDACTED}`)
    // Credential schemes followed by a value.
    .replace(/\b(basic|bearer|token)\s+[A-Za-z0-9+/=._~-]{8,}/gi, `$1 ${REDACTED}`)
    // User information in a URL: https://x-access-token:secret@github.com/...
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`)
    // GitHub token formats and JSON Web Tokens, wherever they appear.
    .replace(/\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, REDACTED);
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ');
  if (line.length <= PUBLISH_DIAGNOSTIC_LIMITS.detailCharsMax) {
    return line;
  }
  const tail = '…' + line.slice(line.length - PUBLISH_DIAGNOSTIC_LIMITS.detailCharsMax + 1);
  assert(tail.length === PUBLISH_DIAGNOSTIC_LIMITS.detailCharsMax, 'A cut detail is exactly at its limit');
  return tail;
}

/** Each secret as given, URL-encoded, and inside the Basic header Studio builds from it. */
function secretForms(secrets: readonly string[]): readonly string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(Buffer.from('x-access-token:' + secret).toString('base64'));
  }
  // Longest first, so a form containing another is removed whole.
  return [...forms].sort((left, right) => right.length - left.length);
}
