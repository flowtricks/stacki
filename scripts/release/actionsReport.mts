// Where a release script reports: job outputs (GITHUB_OUTPUT) that later jobs read, the job summary
// (GITHUB_STEP_SUMMARY) a person reads, and annotations. Outside GitHub Actions the same calls
// print to the terminal, so a local run and a workflow run say the same things.
//
// Outputs are validated before they are written: a newline in a value would let one output forge
// another, so names are a fixed shape and values are single lines with a length bound.

import fs from 'node:fs';
import { assert } from '../policy/assert.mts';

export const REPORT_LIMITS = {
  outputValueCharsMax: 1_000,
  summaryCharsMax: 512 * 1024,
} as const satisfies Record<string, number>;

export interface Reporter {
  readonly output: (name: string, value: string) => void;
  readonly summary: (markdown: string) => void;
  readonly notice: (text: string) => void;
  readonly warning: (text: string) => void;
  readonly error: (text: string) => void;
}

const OUTPUT_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function assertOutput(name: string, value: string): void {
  assert(OUTPUT_NAME.test(name), `output name ${name} is lower_snake_case`);
  assert(!/[\r\n]/.test(value), `output ${name} is a single line`);
  assert(value.length <= REPORT_LIMITS.outputValueCharsMax, `output ${name} is bounded`);
}

/** Annotation text on one line: GitHub ends an annotation at the first newline. */
function annotation(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function systemReporter(environment: NodeJS.ProcessEnv): Reporter {
  const outputFile = environment['GITHUB_OUTPUT'];
  const summaryFile = environment['GITHUB_STEP_SUMMARY'];
  const inActions = environment['GITHUB_ACTIONS'] === 'true';
  return {
    output: (name, value) => {
      assertOutput(name, value);
      if (outputFile !== undefined && outputFile.length > 0) {
        fs.appendFileSync(outputFile, `${name}=${value}\n`);
      }
      console.log(`output ${name}=${value}`);
    },
    summary: (markdown) => {
      assert(markdown.length <= REPORT_LIMITS.summaryCharsMax, 'summary is bounded');
      if (summaryFile !== undefined && summaryFile.length > 0) {
        fs.appendFileSync(summaryFile, `${markdown}\n`);
      } else {
        console.log(markdown);
      }
    },
    notice: (text) => {
      console.log(inActions ? `::notice::${annotation(text)}` : text);
    },
    warning: (text) => {
      console.log(inActions ? `::warning::${annotation(text)}` : `WARNING: ${text}`);
    },
    error: (text) => {
      console.log(inActions ? `::error::${annotation(text)}` : `ERROR: ${text}`);
    },
  };
}

/** A reporter that records everything, for tests. */
export interface RecordedReport {
  readonly outputs: Map<string, string>;
  readonly summaries: string[];
  readonly messages: string[];
}

export function recordingReporter(): { readonly reporter: Reporter; readonly report: RecordedReport } {
  const report: RecordedReport = { outputs: new Map(), summaries: [], messages: [] };
  const reporter: Reporter = {
    output: (name, value) => {
      assertOutput(name, value);
      report.outputs.set(name, value);
    },
    summary: (markdown) => {
      report.summaries.push(markdown);
    },
    notice: (text) => {
      report.messages.push(`notice: ${text}`);
    },
    warning: (text) => {
      report.messages.push(`warning: ${text}`);
    },
    error: (text) => {
      report.messages.push(`error: ${text}`);
    },
  };
  return { reporter, report };
}
