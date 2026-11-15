// The failures of release.yml that are infrastructure, not code, and earn exactly one automatic
// rerun of the failed jobs (rerunPolicy.mts). Each entry is a signature seen in a real release run,
// with the version it hit. The list is deliberately short and strict: a signature that matched a
// real defect would rerun a broken release, and a rerun that fails again is never retried.
//
// Rule for changing this list: every entry has its own regression test in
// test/scripts/release/rerunPolicy.test.ts, with a log excerpt it must match and a near miss it
// must not. Add no entry without one.

export interface FlakeSignature {
  readonly id: string;
  // The job names it can explain; a Windows race does not explain a macOS failure.
  readonly jobPattern: RegExp;
  readonly logPattern: RegExp;
  readonly why: string;
}

export const KNOWN_FLAKES: readonly FlakeSignature[] = [
  {
    id: 'windows-ebusy-rmdir',
    jobPattern: /windows/i,
    logPattern: /EBUSY: resource busy or locked, rmdir/,
    why: 'Windows holds a handle briefly after a test removes its folder (1.4.2, studio/test/demoAssetMap).',
  },
  {
    id: 'macos-tooltip-escape',
    jobPattern: /mac/i,
    // The probe printed only this one failed check: Escape timing on a loaded macOS runner (1.4.2).
    logPattern: /app-ui-kit-tooltip: 1 of \d+ failed\n\s*Escape hides it\n/,
    why: 'The macOS runner sometimes misses the Escape key before the tooltip probe reads (1.4.2, renderer/apps/appUiKitTooltip).',
  },
  {
    id: 'npm-registry-network',
    jobPattern: /./,
    logPattern: /npm (?:ERR!|error) (?:code|errno) (?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|E500|E502|E503|E504)\b/,
    why: 'The npm registry dropped or refused a connection during install.',
  },
  {
    id: 'service-unavailable',
    jobPattern: /./,
    logPattern: /Response status code does not indicate success: 50[234]|(?:HTTP|status code) 503\b.*(?:github|actions|registry)/i,
    why: 'A GitHub or registry service answered 5xx (action download, cache or artifact service).',
  },
  {
    id: 'apt-archive-fetch',
    jobPattern: /linux/i,
    logPattern: /E: Failed to fetch https?:\/\/\S+\s+(?:\d{3}\s|Connection|Could not|Temporary failure)/,
    why: 'The Ubuntu mirror lost an archive file or a connection during apt-get (1.1.2, 1.1.4).',
  },
  {
    id: 'runner-lost',
    jobPattern: /./,
    logPattern: /lost communication with the server|The runner has received a shutdown signal|The hosted runner encountered an error/,
    why: 'GitHub lost the hosted runner mid-job.',
  },
];
