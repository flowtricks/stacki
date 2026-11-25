// Goal: the container's start reports reach the Worker in the shape it parses, and can never delay or
// fail the start: a refusal, a network error and a flood are each logged and dropped.
// Method: a recording fake for the POST; reports read back through the real parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStartupReporter, STARTUP_REPORT_LIMITS } from '../src/features/startup/startupReporter';
import { parseStartupReport } from '../src/features/startup/startupStages';

function harness(answer: () => Promise<Response>) {
  const sent: { url: string; init: RequestInit }[] = [];
  const logs: string[] = [];
  const reporter = createStartupReporter({
    backend: 'https://studio.test',
    token: 'container-token',
    sinceStartMs: () => 1234.9,
    post: async (url, init) => {
      sent.push({ url, init });
      return answer();
    },
    log: (message) => logs.push(message),
  });
  return { reporter, sent, logs };
}

test('a report is one authenticated POST whose body the Worker parser accepts', async () => {
  const { reporter, sent, logs } = harness(async () => new Response(null, { status: 204 }));
  reporter.report('drafts');
  await reporter.settled();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, 'https://studio.test/studio/internal/startup');
  assert.equal(sent[0]?.init.method, 'POST');
  assert.deepEqual(sent[0]?.init.headers, { 'x-studio-token': 'container-token', 'Content-Type': 'application/json' });
  assert.deepEqual(parseStartupReport(JSON.parse(String(sent[0]?.init.body))), { ok: true, value: { stage: 'drafts', sinceStartMs: 1234 } });
  assert.deepEqual(logs, []);
});

test('a refusal is logged, not thrown', async () => {
  const { reporter, logs } = harness(async () => new Response('no', { status: 403 }));
  reporter.report('server');
  await reporter.settled();
  assert.deepEqual(logs, ['Start report for server refused (403)']);
});

test('a network failure is logged, not thrown', async () => {
  const { reporter, logs } = harness(async () => {
    throw new Error('fetch failed');
  });
  reporter.report('compile');
  await reporter.settled();
  assert.deepEqual(logs, ['Start report for compile failed: fetch failed']);
});

test('reports beyond the in-flight limit are dropped with a note, and room returns when they finish', async () => {
  const release: (() => void)[] = [];
  const { reporter, sent, logs } = harness(
    () =>
      new Promise<Response>((resolve) => {
        release.push(() => resolve(new Response(null, { status: 204 })));
      }),
  );
  for (let count = 0; count < STARTUP_REPORT_LIMITS.inFlightMax + 2; count += 1) {
    reporter.report('drafts');
  }
  assert.equal(sent.length, STARTUP_REPORT_LIMITS.inFlightMax);
  assert.equal(logs.length, 2);
  release.forEach((done) => done());
  await reporter.settled();
  reporter.report('ready');
  assert.equal(sent.length, STARTUP_REPORT_LIMITS.inFlightMax + 1);
  release.forEach((done) => done());
  await reporter.settled();
});
