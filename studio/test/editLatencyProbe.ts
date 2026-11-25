// Goal: time a real editor input through a verified canvas value, including debounce.
// Method: mark the input event and poll one computed property in the preview. Both
// clocks belong to this browser and are normalized by their time origins. A matching
// animation-frame callback is an observed value, never proof of a completed paint.
// Sample IDs correlate browser observations only. Request/response time includes
// transport and saving; it is not a server-only duration or a distributed edit trace.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Frame, Locator, Page } from 'playwright';
import { record, string } from '../src/shared/validation';

interface StyleObservation {
  readonly identifier: string;
  readonly selector: string;
  readonly property: string;
  readonly expected: string;
}

export async function measureStyleInput(page: Page, frame: Frame, input: Locator, value: string) {
  const identifier = randomUUID();
  assert.match(value, /^0\.\d{2}$/, 'Opacity samples use distinct, bounded decimal values');
  await input.evaluate((element, identifier) => {
    performance.clearResourceTimings();
    element.addEventListener('input', () => performance.mark(identifier), {
      capture: true,
      once: true,
    });
  }, identifier);
  await frame.evaluate(observeStyle, {
    identifier,
    selector: '#target',
    property: 'opacity',
    expected: value,
  });
  const saved = page.waitForResponse(
    (response) => {
      if (new URL(response.url()).pathname !== '/studio/api/source') {
        return false;
      }
      if (response.request().method() !== 'POST') {
        return false;
      }
      const raw = response.request().postData();
      assert.ok(raw, 'A source write has a request body');
      const payload: unknown = JSON.parse(raw);
      const data = record(payload);
      if (data['file'] !== 'src/components/Card.astro') {
        return false;
      }
      return new RegExp(`opacity:\\s*${value.replace('.', '\\.')}`).test(string(data['source']));
    },
    { timeout: 10_000 },
  );
  await input.fill(value);
  const response = await saved;
  assert.ok(response.ok(), 'The measured edit must be saved successfully');
  await response.finished();
  await frame.waitForFunction((identifier) => performance.getEntriesByName(identifier).length > 0, identifier, { timeout: 10_000 });
  const started = await page.evaluate(readMark, identifier);
  const observed = await frame.evaluate(readMark, identifier);
  const write = await page.evaluate(readWriteTiming, started);
  assert.ok(observed >= started, 'The expected value must follow this input');
  return {
    sampleId: identifier,
    expected: value,
    inputToObservedMs: observed - started,
    inputToRequestMs: write.started - started,
    inputToSaveResponseMs: write.finished - started,
  };
}

function observeStyle(observation: StyleObservation): void {
  const started = performance.now();
  const inspect = () => {
    const element = document.querySelector(observation.selector);
    if (element) {
      if (getComputedStyle(element).getPropertyValue(observation.property) === observation.expected) {
        performance.mark(observation.identifier);
        return;
      }
    }
    if (performance.now() - started < 10_000) {
      requestAnimationFrame(inspect);
    }
  };
  requestAnimationFrame(inspect);
}

function readMark(identifier: string): number {
  const entries = performance.getEntriesByName(identifier);
  const entry = entries[0];
  if (!entry || entries.length !== 1) {
    throw new Error('Expected exactly one measurement mark');
  }
  performance.clearMarks(identifier);
  return performance.timeOrigin + entry.startTime;
}

function readWriteTiming(started: number) {
  const entries = performance.getEntriesByType('resource').slice(-250);
  const write = entries.find((entry) => {
    if (new URL(entry.name).pathname !== '/studio/api/source') {
      return false;
    }
    return performance.timeOrigin + entry.startTime >= started;
  });
  if (!(write instanceof PerformanceResourceTiming)) {
    throw new Error('The measured input must have a corresponding source request');
  }
  return {
    started: performance.timeOrigin + write.startTime,
    finished: performance.timeOrigin + write.responseEnd,
  };
}

export async function measureTextInput(
  page: Page,
  frame: Frame,
  input: Locator,
  observation: { readonly selector: string; readonly text: string; readonly expected: string },
) {
  assert.ok(observation.text.length <= 100, 'A typing sample stays bounded');
  assert.ok(observation.expected.length <= 2000, 'Expected preview text stays bounded');
  const identifier = randomUUID();
  await input.evaluate((element, identifier) => {
    element.addEventListener(
      'input',
      () => {
        if (performance.getEntriesByName(identifier + '-first').length === 0) {
          performance.mark(identifier + '-first');
        }
        performance.clearMarks(identifier + '-last');
        performance.mark(identifier + '-last');
      },
      { capture: true, signal: AbortSignal.timeout(10_000) },
    );
  }, identifier);
  await frame.evaluate(
    ({ identifier, selector, expected }) => {
      const observer = new MutationObserver(() => {
        // Rich text can contain nonbreaking spaces with the same visible wording.
        const element = document.querySelector(selector);
        if (element instanceof HTMLElement && element.innerText.replace(/\s+/g, ' ').trim() === expected) {
          performance.mark(identifier);
          observer.disconnect();
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      setTimeout(() => observer.disconnect(), 10_000);
    },
    { identifier, selector: observation.selector, expected: observation.expected },
  );
  await input.pressSequentially(observation.text, { delay: 15 });
  await frame.waitForFunction((identifier) => performance.getEntriesByName(identifier).length > 0, identifier, { timeout: 10_000 });
  const first = await page.evaluate(readMark, identifier + '-first');
  const last = await page.evaluate(readMark, identifier + '-last');
  const observed = await frame.evaluate(readMark, identifier);
  assert.ok(observed >= last, 'The final text follows the last native input');
  return { firstInputToObservedMs: observed - first, lastInputToObservedMs: observed - last };
}
