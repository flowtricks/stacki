#!/usr/bin/env node
// The test-timing scan: test code that synchronises on the clock instead of on what it tests.
//
// Why: every suite that failed Check on a loaded runner while passing on the maintainer's Mac in
// November 2026 did one of two things (docs/test-timing-audit.md). It paused for a fixed time and
// then read state that a slow runner had not reached yet (`await wait(1500)` behind a 400 ms
// save timer, firstStylesPanel), or it held a measured duration to an absolute number of
// milliseconds (`largeMs < 16`, `astroEditorScale` 278 ms > 250 ms). Both pass wherever the
// machine is fast and fail wherever it is not, so they cannot be fixed by retrying. The cure is
// known and has helpers: wait on the observable state (test/helpers/waitFor.js), drive the
// timing yourself (a held save the test releases), count operations, or scale a bound by a
// calibration measured in the same run (test/helpers/scaleFixtures.ts).
//
// Method (a grep, written down so anyone can re-run it by hand), per line, comment lines skipped:
//
//   fixed-pause   1. `await <name>(<number>)` or `await <name>(<identifier ending in Ms>)` where
//                    the callee's last segment starts with wait, sleep, delay, pause, tick,
//                    settle or nap: `await wait(900)`, `await page.waitForTimeout(500)`.
//                 2. `setTimeout(<resolve-like>, <not 0>)`: an inline or helper sleep,
//                    `new Promise((resolve) => setTimeout(resolve, 50))`. A zero delay is the next
//                    task, a boundary rather than a guess, and is not counted.
//   absolute-ms   On a line that asserts (assert, expect, check, ok): a duration-like name
//                 (ms, elapsed, took, duration, latency, or a name ending in Ms, Millis,
//                 Duration, Elapsed, Took or Latency) compared below a number literal, a number
//                 literal compared above one, or `performance.now()` / `Date.now()` compared
//                 below a number literal.
//
// Files: test/** and studio/test/** (.js, .ts, .mjs, .cjs, .tsx) that git tracks or would add,
// without fixtures and corpora (sample projects, not test code).
//
// The allowlist (scripts/gate/testTimingAllowlist.json) holds, per file and rule, how many such
// sites the file may keep, why, and until when. A count above its entry, a file with no entry,
// or an expired or malformed entry fails the gate; a count below its entry is reported so the
// entry can be lowered. New test code therefore cannot add either pattern silently, and the
// existing ones carry a date by which they are fixed or justified again.

import childProcess = require('node:child_process');
import fs = require('node:fs');
import path = require('node:path');
import { repositoryRoot } from '../lib/repoRoot';

export const TEST_TIMING_LIMITS = {
  entriesMax: 1000,
  countMax: 500,
  daysMax: 190,
  textCharsMax: 500,
  fileCharsMax: 1024 * 1024,
  filesMax: 5000,
  sourceBytesMax: 4 * 1024 * 1024,
} as const satisfies Record<string, number>;

export const TEST_TIMING_RULES = ['fixed-pause', 'absolute-ms'] as const;
export type TestTimingRule = (typeof TEST_TIMING_RULES)[number];

export interface TestTimingFinding {
  readonly rule: TestTimingRule;
  /** 1-based. */
  readonly line: number;
  readonly text: string;
}

export interface TestTimingEntry {
  readonly file: string;
  readonly rule: TestTimingRule;
  readonly count: number;
  readonly reason: string;
  readonly added: string;
  readonly expires: string;
}

export interface TestTimingVerdict {
  /** Each fails the gate. */
  readonly problems: readonly string[];
  /** Entries above what their file now holds: lower them. */
  readonly lowerable: readonly string[];
}

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
const PAUSE_CALL =
  /\bawait\s+(?:[A-Za-z_$][\w$]*\.)*(?:wait|sleep|delay|pause|tick|settle|nap)\w*\s*\(\s*(?:\d[\d_]*(?:\.\d+)?\s*[,)]|[A-Za-z_$][\w$.]*(?:Ms|MS|Millis|Milliseconds)\s*[,)])/gi;
// A zero delay is a task boundary (the next macrotask), not a guess at a duration, so it is not counted.
const PROMISE_SLEEP = /\bsetTimeout\(\s*(?:resolve|res|r|done|next|wake)\s*,(?!\s*0\s*\))/g;
const ASSERTING = /\b(?:assert|expect|check|ok)\b/;
const DURATION_NAME = String.raw`(?:\b(?:ms|elapsed|took|duration|latency)\b|[A-Za-z_$][\w$.]*(?:Ms|MS|Millis|Milliseconds|Duration|Elapsed|Took|Latency)\b)\)?`;
const DURATION_BELOW_NUMBER = new RegExp(String.raw`${DURATION_NAME}\s*<=?\s*\d`);
const NUMBER_ABOVE_DURATION = new RegExp(String.raw`\b\d[\d_.]*\s*>=?\s*${DURATION_NAME}`);
const CLOCK_BELOW_NUMBER = /(?:performance|Date)\.now\(\)[^;]*<=?\s*\d/;

/** Every fixed-pause and absolute-ms site in one test file's text. Pure. */
export function scanTestTiming(text: string): readonly TestTimingFinding[] {
  if (text.length > TEST_TIMING_LIMITS.sourceBytesMax) {
    throw new Error(`Assertion failed: scanTestTiming reads at most ${TEST_TIMING_LIMITS.sourceBytesMax} characters`);
  }
  const findings: TestTimingFinding[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (COMMENT_LINE.test(line)) {
      continue;
    }
    const pauses = (line.match(PAUSE_CALL) ?? []).length + (line.match(PROMISE_SLEEP) ?? []).length;
    for (let site = 0; site < pauses; site += 1) {
      findings.push({ rule: 'fixed-pause', line: index + 1, text: line.trim() });
    }
    if (ASSERTING.test(line)) {
      if (DURATION_BELOW_NUMBER.test(line) || NUMBER_ABOVE_DURATION.test(line) || CLOCK_BELOW_NUMBER.test(line)) {
        findings.push({ rule: 'absolute-ms', line: index + 1, text: line.trim() });
      }
    }
  }
  if (findings.length > lines.length * 4) {
    throw new Error('Assertion failed: scanTestTiming finds at most a few sites per line');
  }
  return findings;
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
  if (trimmed.length === 0 || trimmed.length > TEST_TIMING_LIMITS.textCharsMax) {
    return undefined;
  }
  return trimmed;
}

function isRule(value: unknown): value is TestTimingRule {
  return TEST_TIMING_RULES.some((rule) => rule === value);
}

/** One allowlist entry, or the reason it is malformed. Pure. */
function parseEntry(value: unknown, today: number): { readonly entry: TestTimingEntry } | { readonly problem: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { problem: 'an entry is an object' };
  }
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));
  const file = readText(record, 'file');
  const reason = readText(record, 'reason');
  const added = readText(record, 'added');
  const expires = readText(record, 'expires');
  const rule = record['rule'];
  const count = record['count'];
  if (file === undefined || reason === undefined || added === undefined || expires === undefined) {
    return { problem: `${String(record['file'])}: an entry names a file, a reason, the day it was added and the day it expires` };
  }
  if (!isRule(rule)) {
    return { problem: `${file}: rule is one of ${TEST_TIMING_RULES.join(', ')}` };
  }
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > TEST_TIMING_LIMITS.countMax) {
    return { problem: `${file} (${rule}): count is a whole number from 1 to ${TEST_TIMING_LIMITS.countMax}` };
  }
  const addedDay = dayNumber(added);
  const expiresDay = dayNumber(expires);
  if (addedDay === undefined || expiresDay === undefined) {
    return { problem: `${file} (${rule}): added and expires are YYYY-MM-DD days` };
  }
  if (addedDay > today) {
    return { problem: `${file} (${rule}): added on a day still to come (${added})` };
  }
  if (expiresDay - addedDay > TEST_TIMING_LIMITS.daysMax) {
    return { problem: `${file} (${rule}): an entry lasts at most ${TEST_TIMING_LIMITS.daysMax} days from the day it was added` };
  }
  if (expiresDay < today) {
    return { problem: `${file} (${rule}): expired on ${expires}; fix the sites (docs/test-timing-audit.md) or justify them again with a new reason` };
  }
  return { entry: { file, rule, count, reason, added, expires } };
}

/**
 * Judge what the scan found against the allowlist. `found` maps a repository-relative,
 * `/`-separated file to its findings; `today` is a YYYY-MM-DD day. Pure.
 */
export function judgeTestTiming(found: ReadonlyMap<string, readonly TestTimingFinding[]>, allowlistText: string, today: string): TestTimingVerdict {
  const todayNumber = dayNumber(today);
  if (todayNumber === undefined) {
    throw new Error('Assertion failed: judgeTestTiming takes today as a YYYY-MM-DD day');
  }
  if (allowlistText.length > TEST_TIMING_LIMITS.fileCharsMax) {
    return { problems: [`the allowlist is larger than ${TEST_TIMING_LIMITS.fileCharsMax} characters`], lowerable: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(allowlistText);
  } catch (error: unknown) {
    return { problems: [`the allowlist is not JSON: ${String(error)}`], lowerable: [] };
  }
  const entriesValue: unknown =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed))['entries'] : undefined;
  if (!Array.isArray(entriesValue) || entriesValue.length > TEST_TIMING_LIMITS.entriesMax) {
    return { problems: [`the allowlist is { "entries": [...] } with at most ${TEST_TIMING_LIMITS.entriesMax} entries`], lowerable: [] };
  }
  const problems: string[] = [];
  const lowerable: string[] = [];
  const allowed = new Map<string, TestTimingEntry>();
  for (const value of entriesValue) {
    const outcome = parseEntry(value, todayNumber);
    if ('problem' in outcome) {
      problems.push(outcome.problem);
      continue;
    }
    const key = `${outcome.entry.file}\u0000${outcome.entry.rule}`;
    if (allowed.has(key)) {
      problems.push(`${outcome.entry.file} (${outcome.entry.rule}): listed twice`);
      continue;
    }
    allowed.set(key, outcome.entry);
  }
  const seen = new Set<string>();
  for (const [file, findings] of found) {
    for (const rule of TEST_TIMING_RULES) {
      const sites = findings.filter((finding) => finding.rule === rule);
      const key = `${file}\u0000${rule}`;
      seen.add(key);
      const entry = allowed.get(key);
      const allowedCount = entry?.count ?? 0;
      if (sites.length > allowedCount) {
        const where = sites.map((site) => `    ${file}:${site.line}  ${site.text.slice(0, 160)}`).join('\n');
        problems.push(`${file}: ${sites.length} ${rule} site(s), ${allowedCount} allowed. ${remedy(rule)}\n${where}`);
      } else if (sites.length < allowedCount) {
        lowerable.push(`${file} (${rule}): ${sites.length} site(s) now, the allowlist says ${allowedCount}; lower it`);
      }
    }
  }
  for (const [key, entry] of allowed) {
    if (!seen.has(key)) {
      lowerable.push(`${entry.file} (${entry.rule}): no such test file any more; remove the entry`);
    }
  }
  assert(problems.length + lowerable.length >= 0, 'judgeTestTiming: a verdict lists what it found');
  return { problems, lowerable };
}

function remedy(rule: TestTimingRule): string {
  switch (rule) {
    case 'fixed-pause':
      return 'Wait on the state the test reads (test/helpers/waitFor.js waitFor, waitForSteady) or drive the timing (a held save the test releases), never a fixed pause.';
    case 'absolute-ms':
      return 'Count operations, compare two sizes measured in the same run, or scale the bound by measureSpeedFactor (test/helpers/scaleFixtures.ts), never an absolute number of milliseconds.';
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const SCANNED_EXTENSION = /\.(?:js|ts|mjs|cjs|tsx)$/;
const SKIPPED_PATH = /^(?:test\/(?:fixtures|corpus)\/|studio\/test\/fixtures\/)|\/node_modules\//;

/** The test files to scan: tracked or addable under test/ and studio/test/, without sample projects. */
export function testTimingFiles(root: string): readonly string[] {
  const listing = childProcess.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'test', 'studio/test'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = [...new Set(listing.split('\n').map((line) => line.trim()))]
    .filter((file) => SCANNED_EXTENSION.test(file) && !SKIPPED_PATH.test(file) && fs.existsSync(path.join(root, file)))
    .sort();
  assert(files.length <= TEST_TIMING_LIMITS.filesMax, `testTimingFiles: at most ${TEST_TIMING_LIMITS.filesMax} test files`);
  return files;
}

/** Scan the repository's test files. */
export function measureTestTiming(root: string): ReadonlyMap<string, readonly TestTimingFinding[]> {
  const found = new Map<string, readonly TestTimingFinding[]>();
  for (const file of testTimingFiles(root)) {
    const findings = scanTestTiming(fs.readFileSync(path.join(root, file), 'utf8'));
    if (findings.length > 0) {
      found.set(file, findings);
    }
  }
  return found;
}

export const TEST_TIMING_ALLOWLIST = path.join('scripts', 'gate', 'testTimingAllowlist.json');

function main(): void {
  const root = repositoryRoot();
  const found = measureTestTiming(root);
  if (process.argv.includes('--baseline')) {
    // Prints an allowlist holding today's counts, for an owner refreshing it on purpose.
    const day = new Date().toISOString().slice(0, 10);
    const expires = new Date(Date.now() + 180 * DAY_MS).toISOString().slice(0, 10);
    const entries = [...found].flatMap(([file, findings]) =>
      TEST_TIMING_RULES.flatMap((rule) => {
        const count = findings.filter((finding) => finding.rule === rule).length;
        return count === 0
          ? []
          : [{ file, rule, count, reason: 'Predates the test-timing scan; replace with a wait on state (docs/test-timing-audit.md).', added: day, expires }];
      }),
    );
    console.log(JSON.stringify({ entries }, undefined, 2));
    return;
  }
  const allowlistPath = path.join(root, TEST_TIMING_ALLOWLIST);
  const verdict = judgeTestTiming(
    found,
    fs.existsSync(allowlistPath) ? fs.readFileSync(allowlistPath, 'utf8') : '{"entries":[]}',
    new Date().toISOString().slice(0, 10),
  );
  for (const note of verdict.lowerable) {
    console.log(`test-timing: ${note}`);
  }
  if (verdict.problems.length > 0) {
    console.error(`test-timing: ${verdict.problems.length} problem(s) (${TEST_TIMING_ALLOWLIST}):\n  ${verdict.problems.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  const sites = [...found.values()].reduce((total, findings) => total + findings.length, 0);
  console.log(`test-timing: ${sites} allowed site(s) in ${found.size} file(s); nothing new`);
}

if (require.main === module) {
  main();
}
