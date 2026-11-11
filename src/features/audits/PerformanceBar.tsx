// The Speed card. The open page is measured on its own when Speed is shown, and
// again when the page or its files change (debounced; a result holds until then).
// Three states, each a calm card: measuring (the page, a progress shimmer and the
// step it is on), measured (a score ring, five metric tiles with a good, needs
// work or poor dot, and a footer saying the numbers are a dev-server
// approximation and when they were taken), and failed (why, and Retry). "All
// pages" measures every static page, up to a bound, and lists each one's score.
import { useEffect, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { performanceFindings, performanceScore, type Measurement } from '../../../shared/page/auditPerformance';
import type { AuditFinding } from '../../../shared/page/auditFindings';
import { RefreshIcon, WarningTriangleIcon } from '../../ui/Icons';
import { measureRoute } from './auditsBridge';
import { auditState, updateAuditState, useAuditState, type MeasuredPage } from './auditStore';
import type { AuditsPanelProps, MeasureTarget } from './AuditsPanel';

/** Pages one "All pages" covers: each takes several seconds in its own window. */
export const MEASURED_PAGES_MAX = 10;
const AUTO_DELAY_MS = 1_200;
/** After this long the step text moves from loading the page to reading its metrics. */
const LOADING_STEP_MS = 3_000;

export type Rating = 'good' | 'fair' | 'poor';

/** The five headline numbers, each with its thresholds (good up to, poor above) and what it means. */
export const METRICS = [
  { key: 'lcpMs', label: 'LCP', good: 2_500, poor: 4_000, hint: 'Largest Contentful Paint: when the biggest element appears. Good under 2.5 s.' },
  { key: 'cls', label: 'CLS', good: 0.1, poor: 0.25, hint: 'Cumulative Layout Shift: how much content jumps while loading. Good under 0.1.' },
  { key: 'tbtMs', label: 'TBT', good: 200, poor: 600, hint: 'Total Blocking Time: script work that blocks clicks and typing. Good under 200 ms.' },
  {
    key: 'transferBytes',
    label: 'Transfer',
    good: 2_000_000,
    poor: 5_000_000,
    hint: 'Everything downloaded. The dev server serves unbundled modules, so this runs high.',
  },
  { key: 'requests', label: 'Requests', good: 100, poor: 150, hint: 'Requests the page makes. The dev server serves one per module, so this runs high.' },
] as const;
type MetricKey = (typeof METRICS)[number]['key'];

export function rating(value: number | undefined, thresholds: { readonly good: number; readonly poor: number }): Rating {
  assert(thresholds.good <= thresholds.poor, 'rating: good is below poor');
  if (value === undefined || value <= thresholds.good) {
    return 'good';
  }
  return value <= thresholds.poor ? 'fair' : 'poor';
}

export function scoreRating(score: number): Rating {
  assert(score >= 0, 'scoreRating: a score is at least 0');
  return score >= 90 ? 'good' : score >= 50 ? 'fair' : 'poor';
}

/** A metric as people read it: 1.2 s, 0.03, 180 ms, 1.8 MB, 42. */
export function formatMetric(key: MetricKey, value: number | undefined): string {
  if (value === undefined) {
    return '–';
  }
  switch (key) {
    case 'lcpMs':
      return `${(value / 1000).toFixed(1)} s`;
    case 'cls':
      return value.toFixed(2);
    case 'tbtMs':
      return `${Math.round(value)} ms`;
    case 'transferBytes':
      return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.round(value / 1000)} KB`;
    case 'requests':
      return String(Math.round(value));
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}

/** "just now", "10 s ago", "3 min ago". */
export function measuredAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) {
    return 'just now';
  }
  return seconds < 60 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

/** A failure in words: the browser's network codes, said plainly. */
export function failureReason(message: string): string {
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_CONNECTION_RESET/.test(message)) {
    return 'Couldn’t reach the dev server.';
  }
  if (/destroyed|timed? ?out|ERR_TIMED_OUT/i.test(message)) {
    return 'The page took too long to load.';
  }
  if (/ERR_ABORTED|ERR_FAILED/.test(message)) {
    return 'The page stopped loading.';
  }
  return message.length > 140 ? `${message.slice(0, 139)}…` : message;
}

function metricsOf(measurement: Measurement): MeasuredPage['metrics'] {
  return { lcpMs: measurement.lcpMs, cls: measurement.cls, tbtMs: measurement.tbtMs, transferBytes: measurement.transferBytes, requests: measurement.requests };
}

async function measure(projectPath: string, devUrl: string, pages: readonly MeasureTarget[], stamp: number): Promise<void> {
  if (auditState().performance.running) {
    return;
  }
  updateAuditState((current) => ({ ...current, performance: { ...current.performance, running: true, problem: undefined, startedAt: Date.now() } }));
  const results: MeasuredPage[] = [];
  const findings: AuditFinding[] = [];
  let problem: string | undefined;
  for (const page of pages.slice(0, MEASURED_PAGES_MAX)) {
    const measured = await measureRoute(projectPath, devUrl, page.route).catch((error: unknown) => ({ ok: false as const, error: String(error) }));
    if (!measured.ok) {
      problem = failureReason(measured.error);
      continue;
    }
    results.push({ ...page, score: performanceScore(measured.value), metrics: metricsOf(measured.value) });
    findings.push(...performanceFindings(measured.value, page));
  }
  assert(results.length <= MEASURED_PAGES_MAX, 'measure: the pages are bounded');
  updateAuditState((current) => ({
    ...current,
    performance: { running: false, results, findings, problem: results.length === 0 ? problem : undefined, measuredAt: Date.now(), stamp },
  }));
}

export function PerformanceBar(props: { readonly measure: AuditsPanelProps['measure'] }) {
  const state = useAuditState();
  const performance = state.performance;
  const targets = props.measure();
  const current = targets.current;
  // A result holds until the audit runs again, which happens when a file changes.
  const stamp = state.report?.checkedAt ?? 0;
  const fresh = performance.stamp === stamp && current !== undefined && performance.results.some((result) => result.route === current.route);
  const devUrl = targets.devUrl;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const route = current?.route;
  useEffect(() => {
    if (devUrl === undefined || current === undefined || fresh || performance.problem !== undefined) {
      return undefined;
    }
    const timer = setTimeout(() => void measure(targets.projectPath, devUrl, [current], stamp), AUTO_DELAY_MS);
    return () => clearTimeout(timer);
    // `current` is rebuilt every render; its route is what decides a new measurement.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the route, not the object
  }, [devUrl, route, fresh, stamp, performance.problem, targets.projectPath]);
  if (devUrl === undefined) {
    return (
      <div className="audits-card">
        <p className="audits-card-note">Start the preview to measure this page’s speed.</p>
      </div>
    );
  }
  const run = (pages: readonly MeasureTarget[]): void => {
    updateAuditState((value) => ({ ...value, performance: { ...value.performance, problem: undefined } }));
    void measure(targets.projectPath, devUrl, pages, stamp);
  };
  const page = performance.results.find((result) => result.route === route) ?? performance.results[0];
  const pageName = route === undefined ? 'this page' : route;
  if (performance.running || (page === undefined && performance.problem === undefined)) {
    const elapsed = now - (performance.startedAt ?? now);
    return (
      <div className="audits-card audits-card-measuring" role="status">
        <div className="audits-card-head">
          <span className="audits-card-title">Measuring {pageName}</span>
        </div>
        <div className="audits-progress" aria-hidden="true">
          <span />
        </div>
        <p className="audits-card-note">{elapsed < LOADING_STEP_MS ? 'Loading the page in a hidden window…' : 'Collecting metrics…'}</p>
      </div>
    );
  }
  if (page === undefined) {
    return (
      <div className="audits-card audits-card-error" role="alert">
        <div className="audits-card-head">
          <WarningTriangleIcon size={14} />
          <span className="audits-card-title">Couldn’t measure {pageName}</span>
        </div>
        <p className="audits-card-note">{performance.problem}</p>
        <button className="audits-card-button" onClick={() => current !== undefined && run([current])}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="audits-card">
      <div className="audits-card-head">
        <ScoreRing score={page.score} />
        <span className="audits-card-title">{page.route === route ? 'This page' : page.route}</span>
        <button className="audits-card-button secondary" disabled={performance.running} onClick={() => run(targets.pages)}>
          All pages
        </button>
      </div>
      <div className="audits-tiles">
        {METRICS.map((metric) => {
          const value = page.metrics[metric.key];
          const level = rating(value, metric);
          return (
            <div key={metric.key} className="audits-tile" title={metric.hint}>
              <span className="audits-tile-label">
                <span className={`audits-rating ${level}`} aria-label={level === 'good' ? 'Good' : level === 'fair' ? 'Needs work' : 'Poor'} />
                {metric.label}
              </span>
              <span className="audits-tile-value">{formatMetric(metric.key, value)}</span>
            </div>
          );
        })}
      </div>
      {performance.results.length > 1 && (
        <div className="audits-card-pages">
          {performance.results.map((result) => (
            <div key={result.route} className="audits-card-page">
              <span className={`audits-score-value ${scoreRating(result.score)}`}>{result.score}</span>
              <span className="audits-card-page-route">{result.route}</span>
            </div>
          ))}
        </div>
      )}
      <div className="audits-card-foot">
        <span>Dev server · approximate · measured {performance.measuredAt === undefined ? '' : measuredAgo(performance.measuredAt, now)}</span>
        <button className="ghost audits-icon-button" aria-label="Measure again" title="Measure again" onClick={() => current !== undefined && run([current])}>
          <RefreshIcon size={12} />
        </button>
      </div>
    </div>
  );
}

const RING_RADIUS = 15;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function ScoreRing({ score }: { readonly score: number }) {
  const level = scoreRating(score);
  return (
    <span className={`audits-ring ${level}`} role="img" aria-label={`Score ${score} out of 100`}>
      <svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
        <circle cx="18" cy="18" r={RING_RADIUS} className="audits-ring-track" />
        <circle
          cx="18"
          cy="18"
          r={RING_RADIUS}
          className="audits-ring-value"
          strokeDasharray={`${(score / 100) * RING_LENGTH} ${RING_LENGTH}`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span className="audits-ring-score">{score}</span>
    </span>
  );
}
