// How the history panel says things.
//
//   node test/renderer/history/historyPanel.test.js
//
// The panel's job is to turn git's answers into sentences a designer can read,
// and all of that work happens in three small pure functions. They are worth
// testing because the failures are not crashes — they are a timeline that says
// "1 hours ago", or "You changed src/pages/index.astro and 4 other files",
// which is the panel failing at the only thing it is for.
//
// Time is passed in rather than read, so these are the same on any day.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'history-panel.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/history/HistoryPanel.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const { relativeTime, dayGroup, summarize } = require(bundlePath);

  // Local afternoon keeps the same-day fixture away from midnight in every timezone.
  const now = new Date(2026, 7, 18, 15).getTime();
  const ago = (ms) => new Date(now - ms).toISOString();
  const MIN = 60000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // --- Saying when ---------------------------------------------------------
  check('seconds ago is "just now"', relativeTime(ago(10 * 1000), now) === 'just now', relativeTime(ago(10 * 1000), now));
  check('one minute is singular', relativeTime(ago(MIN), now) === '1 minute ago', relativeTime(ago(MIN), now));
  check('several minutes are plural', relativeTime(ago(20 * MIN), now) === '20 minutes ago', relativeTime(ago(20 * MIN), now));
  // The singular is the one that gets missed, and "1 hours ago" is the kind of
  // thing that makes a careful interface look careless.
  check('one hour is singular', relativeTime(ago(HOUR), now) === '1 hour ago', relativeTime(ago(HOUR), now));
  check('several hours are plural', relativeTime(ago(5 * HOUR), now) === '5 hours ago', relativeTime(ago(5 * HOUR), now));
  check('a day back is "yesterday"', relativeTime(ago(DAY), now) === 'yesterday', relativeTime(ago(DAY), now));
  check('a few days back counts days', relativeTime(ago(3 * DAY), now) === '3 days ago', relativeTime(ago(3 * DAY), now));
  // Past a week "17 days ago" stops being something anyone can place, and a
  // date starts being one.
  check(
    'past a week it becomes a date',
    /\w/.test(relativeTime(ago(30 * DAY), now)) && !/ago/.test(relativeTime(ago(30 * DAY), now)),
    relativeTime(ago(30 * DAY), now),
  );
  check('a date from another year says the year', /2024/.test(relativeTime('2024-03-04T10:00:00Z', now)), relativeTime('2024-03-04T10:00:00Z', now));
  check('an unparseable date says nothing rather than "Invalid Date"', relativeTime('not a date', now) === '', relativeTime('not a date', now));

  // --- Day headings --------------------------------------------------------
  // Grouped by calendar day, not by elapsed hours: something committed at
  // 11pm and something at 1am are different days to a person, however few
  // hours apart they are.
  check('today is Today', dayGroup(ago(2 * HOUR), now) === 'Today', dayGroup(ago(2 * HOUR), now));
  check('yesterday is Yesterday', dayGroup(ago(DAY), now) === 'Yesterday', dayGroup(ago(DAY), now));
  check('older days say how many', dayGroup(ago(3 * DAY), now) === '3 days ago', dayGroup(ago(3 * DAY), now));
  check('past a week it is a date', !/ago|Today|Yesterday/.test(dayGroup(ago(20 * DAY), now)), dayGroup(ago(20 * DAY), now));
  check('an unparseable date groups as nothing', dayGroup('nonsense', now) === '');

  // --- Saying what changed -------------------------------------------------
  const entry = (label, kind = 'page') => ({ label, kind });
  check('nothing changed says so', summarize([]) === 'No files changed', summarize([]));
  check('a missing list does not crash', summarize(undefined) === 'No files changed');
  check('one file is named', summarize([entry('Home')]) === 'Home', summarize([entry('Home')]));
  check('two are both named', summarize([entry('Home'), entry('About')]) === 'Home and About', summarize([entry('Home'), entry('About')]));
  // Three or more: name the first and count the rest. The line is for
  // recognising a commit at a glance, not for listing it.
  check(
    'three are one name and a count',
    summarize([entry('Home'), entry('About'), entry('Contact')]) === 'Home and 2 other pages',
    summarize([entry('Home'), entry('About'), entry('Contact')]),
  );
  // Two distinct names are both spelled out, so the remainder in the counted
  // form is never one — there is no singular case to get wrong.
  check(
    'a repeated name collapses to the two-name form',
    summarize([entry('Home'), entry('About'), entry('About')]) === 'Home and About',
    summarize([entry('Home'), entry('About'), entry('About')]),
  );
  check(
    'four distinct names count three',
    summarize([entry('Home'), entry('About'), entry('Contact'), entry('Blog')]) === 'Home and 3 other pages',
    summarize([entry('Home'), entry('About'), entry('Contact'), entry('Blog')]),
  );
  // All pages reads as pages; anything else and "files" is the honest word.
  check(
    'a mixed commit says files, not pages',
    summarize([entry('Home'), entry('Card', 'component'), entry('styles.css', 'style')]) === 'Home and 2 other files',
    summarize([entry('Home'), entry('Card', 'component'), entry('styles.css', 'style')]),
  );
  // Astro writes a page and its layout in one go often enough that a commit
  // naming the same thing twice would look like a bug in the panel.
  check('the same label twice is counted once', summarize([entry('Home'), entry('Home')]) === 'Home', summarize([entry('Home'), entry('Home')]));

  if (failures.length) {
    console.error(`history-panel: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`history-panel: ${checked} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
