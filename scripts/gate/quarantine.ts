// The quarantine: a visible, committed, expiring list of suites whose failure the gate reports
// but does not fail on, read from scripts/gate/quarantine.json.
//
// Why it exists: a flaky suite that fails Check holds every release hostage (1.4.7's bump commit
// was red on two suites that pass alone). Why it is strict: a quarantine that nobody revisits is a
// deleted test. So an entry
//   - names a suite the gate knows, with an owner and a reason;
//   - proves the suite is flaky: at least two red runs, by URL, that a rerun or a later run
//     turned green;
//   - expires at most seven days after it was added, and an expired entry fails the gate, so
//     Check goes red until the suite is fixed or the entry is renewed with a fresh reason;
//   - never covers a correctness, safety or data-write suite (preflight, atomic writes, parsers,
//     round-trips, security): those stay blocking, whatever their record.
// A quarantined suite still runs on every platform and its output is printed in full.

export const QUARANTINE_LIMITS = {
  entriesMax: 20,
  daysMax: 7,
  redsMin: 2,
  textCharsMax: 500,
  fileCharsMax: 64 * 1024,
} as const satisfies Record<string, number>;

// Suites whose names say they guard correctness, safety or written data. Matched on the suite name
// (its path under test/ without the extension), case-insensitively.
export const PROTECTED_SUITE_PATTERN =
  /preflight|atomic|parse|roundtrip|round-trip|security|secret|credential|token|auth|boundary|contract|write|save|corpus|simulator/i;

export interface QuarantineEntry {
  readonly suite: string;
  readonly owner: string;
  readonly reason: string;
  readonly added: string;
  readonly expires: string;
  readonly reds: readonly string[];
}

export interface QuarantineVerdict {
  readonly entries: readonly QuarantineEntry[];
  // Each problem fails the gate.
  readonly problems: readonly string[];
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(text: string): number | undefined {
  const match = DAY.exec(text);
  if (match === null) {
    return undefined;
  }
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  return Math.floor(ms / DAY_MS);
}

function readText(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > QUARANTINE_LIMITS.textCharsMax) {
    return undefined;
  }
  return trimmed;
}

function readReds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > QUARANTINE_LIMITS.entriesMax) {
    return undefined;
  }
  const reds: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !/^https:\/\/github\.com\/flowtricks\/stacki\/actions\/runs\/\d+/.test(item)) {
      return undefined;
    }
    reds.push(item);
  }
  return reds;
}

/** Parses and judges scripts/gate/quarantine.json against the suites the gate knows and today's date (UTC). */
export function judgeQuarantine(text: string, knownSuites: ReadonlySet<string>, today: string): QuarantineVerdict {
  const todayNumber = dayNumber(today);
  if (todayNumber === undefined) {
    throw new Error('judgeQuarantine: today is YYYY-MM-DD');
  }
  if (text.length > QUARANTINE_LIMITS.fileCharsMax) {
    return { entries: [], problems: ['scripts/gate/quarantine.json: larger than its limit'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    return { entries: [], problems: [`scripts/gate/quarantine.json: not JSON (${String(error)})`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { entries: [], problems: ['scripts/gate/quarantine.json: expected an object with "entries"'] };
  }
  const list: unknown = Object.fromEntries(Object.entries(parsed))['entries'];
  if (!Array.isArray(list)) {
    return { entries: [], problems: ['scripts/gate/quarantine.json: "entries" is not a list'] };
  }
  if (list.length > QUARANTINE_LIMITS.entriesMax) {
    return { entries: [], problems: [`scripts/gate/quarantine.json: more than ${QUARANTINE_LIMITS.entriesMax} entries; fix suites instead`] };
  }
  const items: readonly unknown[] = list;
  const entries: QuarantineEntry[] = [];
  const problems: string[] = [];
  for (const [index, item] of items.entries()) {
    const label = `scripts/gate/quarantine.json entry ${index + 1}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`${label}: not an object`);
      continue;
    }
    const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(item));
    const suite = readText(record, 'suite');
    const owner = readText(record, 'owner');
    const reason = readText(record, 'reason');
    const added = readText(record, 'added');
    const expires = readText(record, 'expires');
    const reds = readReds(record['reds']);
    if (suite === undefined || owner === undefined || reason === undefined || added === undefined || expires === undefined || reds === undefined) {
      problems.push(`${label}: needs suite, owner, reason, added, expires (YYYY-MM-DD) and reds (run URLs)`);
      continue;
    }
    const entryProblems = entryProblemsFor({ suite, added, expires, reds }, knownSuites, todayNumber);
    if (entryProblems.length > 0) {
      problems.push(...entryProblems.map((problem) => `${label} (${suite}): ${problem}`));
      continue;
    }
    if (entries.some((entry) => entry.suite === suite)) {
      problems.push(`${label} (${suite}): listed twice`);
      continue;
    }
    entries.push({ suite, owner, reason, added, expires, reds });
  }
  return { entries, problems };
}

function entryProblemsFor(
  entry: Pick<QuarantineEntry, 'suite' | 'added' | 'expires' | 'reds'>,
  knownSuites: ReadonlySet<string>,
  todayNumber: number,
): readonly string[] {
  const problems: string[] = [];
  if (!knownSuites.has(entry.suite)) {
    problems.push('names no suite the gate runs');
  }
  if (PROTECTED_SUITE_PATTERN.test(entry.suite)) {
    problems.push('guards correctness, safety or written data, so it is never quarantined; fix it');
  }
  if (new Set(entry.reds).size < QUARANTINE_LIMITS.redsMin) {
    problems.push(`needs at least ${QUARANTINE_LIMITS.redsMin} different red runs proving it flaky`);
  }
  const addedNumber = dayNumber(entry.added);
  const expiresNumber = dayNumber(entry.expires);
  if (addedNumber === undefined || expiresNumber === undefined) {
    problems.push('added and expires are YYYY-MM-DD');
    return problems;
  }
  if (addedNumber > todayNumber) {
    problems.push('is added in the future');
  }
  if (expiresNumber - addedNumber > QUARANTINE_LIMITS.daysMax) {
    problems.push(`lasts more than ${QUARANTINE_LIMITS.daysMax} days`);
  }
  if (expiresNumber < todayNumber) {
    problems.push(`expired on ${entry.expires}: fix the suite or renew the entry with a new reason`);
  }
  return problems;
}
